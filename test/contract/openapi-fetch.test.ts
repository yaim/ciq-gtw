import { describe, expect, it } from "vitest";
import {
  fetchOpenApiDocument,
  OpenApiFetchError,
  OPENAPI_SOURCE_URL,
  type OpenApiFetch,
} from "../../scripts/openapi/fetch-openapi.js";

const encoder = new TextEncoder();

/** Build a Response with an explicit body stream and headers. */
function streamResponse(
  chunks: Uint8Array[],
  headers: Record<string, string>,
  onPull?: (index: number) => void,
): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.(i);
      const chunk = chunks[i];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      i += 1;
    },
  });
  return new Response(stream, { status: 200, headers });
}

/** A fetchImpl returning a fixed response and recording the URL it was called with. */
function fixedFetch(response: Response, seen: { url?: string }): OpenApiFetch {
  return (url) => {
    seen.url = url;
    return Promise.resolve(response);
  };
}

describe("fetchOpenApiDocument — origin and success", () => {
  it("always calls the fixed source URL and cannot be pointed elsewhere", async () => {
    const seen: { url?: string } = {};
    const body = encoder.encode('{"openapi":"3.1.0","paths":{"/a":{}}}');
    const response = streamResponse([body], { "content-type": "application/json" });
    const result = await fetchOpenApiDocument({ fetchImpl: fixedFetch(response, seen) });
    expect(seen.url).toBe(OPENAPI_SOURCE_URL);
    expect(result.pathCount).toBe(1);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.byteLength).toBe(body.byteLength);
  });

  it("accepts a JSON content type with a charset parameter", async () => {
    const seen: { url?: string } = {};
    const body = encoder.encode('{"paths":{}}');
    const response = streamResponse([body], { "content-type": "application/json; charset=utf-8" });
    await expect(
      fetchOpenApiDocument({ fetchImpl: fixedFetch(response, seen) }),
    ).resolves.toMatchObject({ pathCount: 0 });
  });
});

describe("fetchOpenApiDocument — content-type and length guards", () => {
  it("rejects a missing content type", async () => {
    const seen: { url?: string } = {};
    const response = streamResponse([encoder.encode("{}")], {});
    await expect(fetchOpenApiDocument({ fetchImpl: fixedFetch(response, seen) })).rejects.toThrow(
      OpenApiFetchError,
    );
  });

  it("rejects a non-JSON content type", async () => {
    const seen: { url?: string } = {};
    const response = streamResponse([encoder.encode("{}")], { "content-type": "text/html" });
    await expect(fetchOpenApiDocument({ fetchImpl: fixedFetch(response, seen) })).rejects.toThrow(
      OpenApiFetchError,
    );
  });

  it("rejects an over-declared Content-Length before reading the body", async () => {
    const seen: { url?: string } = {};
    const response = streamResponse([encoder.encode("{}")], {
      "content-type": "application/json",
      "content-length": "1000",
    });
    await expect(
      fetchOpenApiDocument({ fetchImpl: fixedFetch(response, seen), maxBytes: 10 }),
    ).rejects.toThrow(/content length/i);
  });
});

describe("fetchOpenApiDocument — size bounds", () => {
  it("rejects an oversized chunked body before fully buffering it", async () => {
    const seen: { url?: string } = {};
    const pulls: number[] = [];
    // Six 8-byte chunks (48 bytes) against a 12-byte cap. Rejection happens on
    // the second chunk (total 16 > 12); the stream's one-chunk prefetch may
    // pull a third, but the later chunks must never be pulled — proving the
    // body is not fully buffered before rejection.
    const chunks = Array.from({ length: 6 }, (_v, k) =>
      encoder.encode(String.fromCharCode(97 + k).repeat(8)),
    );
    const response = streamResponse(chunks, { "content-type": "application/json" }, (i) =>
      pulls.push(i),
    );
    await expect(
      fetchOpenApiDocument({ fetchImpl: fixedFetch(response, seen), maxBytes: 12 }),
    ).rejects.toThrow(OpenApiFetchError);
    expect(Math.max(...pulls)).toBeLessThan(chunks.length - 1);
  });

  it("accepts a body exactly at the limit and rejects one byte over", async () => {
    const okSeen: { url?: string } = {};
    const atLimit = streamResponse([encoder.encode('{"paths":{}}')], {
      "content-type": "application/json",
    });
    await expect(
      fetchOpenApiDocument({ fetchImpl: fixedFetch(atLimit, okSeen), maxBytes: 12 }),
    ).resolves.toMatchObject({ byteLength: 12 });

    const overSeen: { url?: string } = {};
    const over = streamResponse([encoder.encode('{"paths":{}} ')], {
      "content-type": "application/json",
    });
    await expect(
      fetchOpenApiDocument({ fetchImpl: fixedFetch(over, overSeen), maxBytes: 12 }),
    ).rejects.toThrow(OpenApiFetchError);
  });
});

describe("fetchOpenApiDocument — decode, timeout, cancellation", () => {
  it("rejects a body that is not valid UTF-8", async () => {
    const seen: { url?: string } = {};
    const response = streamResponse([new Uint8Array([0xff, 0xfe, 0xff])], {
      "content-type": "application/json",
    });
    await expect(fetchOpenApiDocument({ fetchImpl: fixedFetch(response, seen) })).rejects.toThrow(
      OpenApiFetchError,
    );
  });

  it("rejects malformed JSON", async () => {
    const seen: { url?: string } = {};
    const response = streamResponse([encoder.encode("{not json")], {
      "content-type": "application/json",
    });
    await expect(fetchOpenApiDocument({ fetchImpl: fixedFetch(response, seen) })).rejects.toThrow(
      OpenApiFetchError,
    );
  });

  it("times out via the overall deadline when the request never returns headers", async () => {
    const hangingFetch: OpenApiFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    await expect(fetchOpenApiDocument({ fetchImpl: hangingFetch, timeoutMs: 40 })).rejects.toThrow(
      /timed out/,
    );
  });

  it("honors a pre-aborted caller signal without hanging", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortAwareFetch: OpenApiFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    await expect(
      fetchOpenApiDocument({ fetchImpl: abortAwareFetch, signal: controller.signal }),
    ).rejects.toThrow(OpenApiFetchError);
  });
});
