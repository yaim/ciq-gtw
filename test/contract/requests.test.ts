import { describe, expect, it } from "vitest";
import {
  buildCreateThreadRequest,
  buildGetMessagesRequest,
  buildProcessMessageRequest,
} from "../../src/collectiviq/requests.js";

describe("buildCreateThreadRequest", () => {
  it("encodes a urlencoded POST with the fixed fields and content type", () => {
    const spec = buildCreateThreadRequest({ title: "gateway request 01" });

    expect(spec.method).toBe("POST");
    expect(spec.path).toBe("/create_thread");
    expect(spec.bodyContentType).toBe("application/x-www-form-urlencoded");
    expect(spec.body).toBeInstanceOf(URLSearchParams);

    const body = spec.body as URLSearchParams;
    expect(body.get("thread_title")).toBe("gateway request 01");
    expect(body.get("is_title_from_user")).toBe("false");
    // No stray fields.
    expect([...body.keys()].sort()).toEqual(["is_title_from_user", "thread_title"]);

    // A POST body carries no query.
    expect("query" in spec).toBe(false);
  });
});

describe("buildProcessMessageRequest", () => {
  it("encodes a multipart POST with the fixed fields and no explicit content type", () => {
    const spec = buildProcessMessageRequest({
      threadId: "4242",
      prompt: "hello there",
      selectedLlms: ["gpt", "claude"],
      generateCombined: true,
    });

    expect(spec.method).toBe("POST");
    expect(spec.path).toBe("/process_message");
    expect(spec.body).toBeInstanceOf(FormData);

    const form = spec.body as FormData;
    expect(form.get("prompt")).toBe("hello there");
    expect(form.get("thread_id")).toBe("4242");
    expect(form.get("selected_llms")).toBe("gpt,claude");
    expect(form.get("generate_combined")).toBe("true");
    expect(form.get("llms_explicitly_set")).toBe("true");
    expect([...form.keys()].sort()).toEqual([
      "generate_combined",
      "llms_explicitly_set",
      "prompt",
      "selected_llms",
      "thread_id",
    ]);

    // Native FormData supplies the multipart boundary itself: no explicit
    // content type key, and no query on a POST.
    expect("bodyContentType" in spec).toBe(false);
    expect("query" in spec).toBe(false);
  });

  it("comma-joins selected llms and encodes generate_combined=false", () => {
    const spec = buildProcessMessageRequest({
      threadId: "1",
      prompt: "p",
      selectedLlms: ["gpt", "claude", "gemini"],
      generateCombined: false,
    });
    const form = spec.body as FormData;
    expect(form.get("selected_llms")).toBe("gpt,claude,gemini");
    expect(form.get("generate_combined")).toBe("false");
  });
});

describe("buildGetMessagesRequest", () => {
  it("encodes a GET with only thread_id in the query and no body", () => {
    const spec = buildGetMessagesRequest({ threadId: "thread/with space&weird=1" });

    expect(spec.method).toBe("GET");
    expect(spec.path).toBe("/get_messages");
    expect(spec.query).toBeInstanceOf(URLSearchParams);

    const query = spec.query as URLSearchParams;
    expect(query.get("thread_id")).toBe("thread/with space&weird=1");
    expect(query.has("since_id")).toBe(false);
    expect([...query.keys()]).toEqual(["thread_id"]);
    // On the wire the id is percent-encoded.
    expect(query.toString()).toBe("thread_id=thread%2Fwith+space%26weird%3D1");

    // A GET carries no body and no explicit content type (keys omitted, not undefined).
    expect("body" in spec).toBe(false);
    expect("bodyContentType" in spec).toBe(false);
  });
});
