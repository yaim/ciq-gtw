import { afterEach, describe, expect, it } from "vitest";
import { startMockServer, replyJson, type MockServer } from "./support/mock-server.js";
import { makeAdapter } from "./support/adapter.js";
import { processAccepted, processDetailError } from "./fixtures/collectiviq/responses.js";
import { normalizeProcessMessage } from "../../src/collectiviq/validation.js";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("processMessage", () => {
  it("POSTs multipart/form-data with an automatic boundary and the expected fields", async () => {
    server = await startMockServer((_req, res) => replyJson(res, processAccepted));
    const adapter = makeAdapter(server.baseUrl);

    const result = await adapter.processMessage({
      threadId: "4242",
      prompt: "hello there",
      selectedLlms: ["gpt", "claude"],
      generateCombined: true,
    });
    expect(result.accepted).toBe(true);
    expect(result.rawStatus).toBe(200);

    const request = server.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/process_message");
    const contentType = request?.headers["content-type"];
    expect(typeof contentType).toBe("string");
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);

    const body = request?.text() ?? "";
    expect(body).toContain('name="prompt"');
    expect(body).toContain("hello there");
    expect(body).toContain('name="thread_id"');
    expect(body).toContain("4242");
    expect(body).toContain('name="selected_llms"');
    expect(body).toContain("gpt,claude");
    expect(body).toContain('name="generate_combined"');
    expect(body).toContain('name="llms_explicitly_set"');
    // The gateway always explicitly sets the models.
    expect(body).toMatch(/name="llms_explicitly_set"\r?\n\r?\ntrue/);
    // Out-of-scope fields must not be sent.
    expect(body).not.toContain('name="files"');
    expect(body).not.toContain('name="tier"');
    expect(body).not.toContain('name="response_format"');
    expect(body).not.toContain('name="client_timezone"');
  });

  it("sends generate_combined=false when combined output is not requested", async () => {
    server = await startMockServer((_req, res) => replyJson(res, processAccepted));
    const adapter = makeAdapter(server.baseUrl);
    await adapter.processMessage({
      threadId: "1",
      prompt: "p",
      selectedLlms: ["gpt"],
      generateCombined: false,
    });
    expect(server.requests[0]?.text()).toMatch(/name="generate_combined"\r?\n\r?\nfalse/);
  });

  it("treats a 2xx response carrying `detail` as a failure, not success", async () => {
    server = await startMockServer((_req, res) => replyJson(res, processDetailError, 200));
    const adapter = makeAdapter(server.baseUrl);
    await expect(
      adapter.processMessage({
        threadId: "1",
        prompt: "p",
        selectedLlms: ["gpt"],
        generateCombined: true,
      }),
    ).rejects.toMatchObject({ category: "unexpected_upstream" });
  });

  it("treats a 2xx response with `detail: null` as a failure (own property, any value)", async () => {
    server = await startMockServer((_req, res) => replyJson(res, { detail: null }, 200));
    const adapter = makeAdapter(server.baseUrl);
    await expect(
      adapter.processMessage({
        threadId: "1",
        prompt: "p",
        selectedLlms: ["gpt"],
        generateCombined: true,
      }),
    ).rejects.toMatchObject({ category: "unexpected_upstream" });
  });

  it("treats any own `detail` value as failure at the validator boundary", () => {
    // JSON cannot carry `undefined`, so assert the validator directly for the
    // full set of values the review requires be treated as failure.
    for (const detail of [null, undefined, "", 0, false, {}, [], { nested: 1 }]) {
      expect(() => normalizeProcessMessage({ detail }, 200)).toThrowError(
        expect.objectContaining({ category: "unexpected_upstream" }),
      );
    }
    // Absent `detail` remains success.
    expect(normalizeProcessMessage({ status: "accepted" }, 200)).toMatchObject({ accepted: true });
  });

  it("rejects an empty thread id before making any request", async () => {
    server = await startMockServer((_req, res) => replyJson(res, processAccepted));
    const adapter = makeAdapter(server.baseUrl);
    await expect(
      adapter.processMessage({
        threadId: "   ",
        prompt: "p",
        selectedLlms: ["gpt"],
        generateCombined: true,
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(server.requests).toHaveLength(0);
  });
});
