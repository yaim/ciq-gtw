import { afterEach, describe, expect, it } from "vitest";
import { startMockServer, replyJson, type MockServer } from "./support/mock-server.js";
import { makeAdapter } from "./support/adapter.js";
import {
  processAccepted,
  processAccepted202,
  processDetailError,
  processEmptyRunId,
  processMissingRunId,
  processRunIdWrongType,
} from "./fixtures/collectiviq/responses.js";
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

  it("accepts the observed 202 shape and surfaces its combined_run_id", async () => {
    // 2026-08-11 password baselines (two verified-repeatable runs): the success
    // response is HTTP 202 with a run identifier and no top-level `detail`. That
    // identifier is the correlation key the poller matches messages against, so
    // it must reach the caller verbatim.
    server = await startMockServer((_req, res) => replyJson(res, processAccepted202, 202));
    const adapter = makeAdapter(server.baseUrl);
    const result = await adapter.processMessage({
      threadId: "synthetic-thread",
      prompt: "p",
      selectedLlms: ["gpt"],
      generateCombined: true,
    });
    expect(result.accepted).toBe(true);
    expect(result.rawStatus).toBe(202);
    expect(result.combinedRunId).toBe("synthetic-run");
  });

  it("rejects a 2xx success that carries no usable combined_run_id", async () => {
    // MUTATION GUARD. Without a run id the completion cannot prove which polled
    // message is its own, so continuing would risk returning an earlier turn's
    // answer. All three unusable forms fail closed identically, BEFORE any poll.
    for (const body of [processMissingRunId, processEmptyRunId, processRunIdWrongType]) {
      const current = await startMockServer((_req, res) => replyJson(res, body, 202));
      server = current;
      const adapter = makeAdapter(current.baseUrl);
      await expect(
        adapter.processMessage({
          threadId: "1",
          prompt: "p",
          selectedLlms: ["gpt"],
          generateCombined: true,
        }),
      ).rejects.toMatchObject({ category: "upstream_protocol" });
      await current.close();
      server = undefined;
    }
  });

  it("classifies an unusable run id at the validator boundary without leaking it", () => {
    // JSON cannot carry `undefined`, so assert the validator directly across the
    // full set of unusable values. A present-but-unusable run id is an upstream
    // PROTOCOL failure, distinct from the `detail` (unexpected_upstream) rule.
    const SENTINEL = "SENTINEL_RUN_ID_VALUE_QQ7";
    for (const combined_run_id of [undefined, null, "", 0, false, {}, [], [SENTINEL]]) {
      let caught: unknown;
      try {
        normalizeProcessMessage({ status: "processing", combined_run_id }, 202);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ category: "upstream_protocol" });
      expect(JSON.stringify(caught)).not.toContain(SENTINEL);
      expect(String((caught as Error).message)).not.toContain(SENTINEL);
    }
    // A non-empty string run id remains success and is passed through verbatim.
    expect(normalizeProcessMessage({ combined_run_id: "run-1" }, 202)).toEqual({
      accepted: true,
      combinedRunId: "run-1",
      rawStatus: 202,
    });
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
    expect(
      normalizeProcessMessage({ status: "accepted", combined_run_id: "run-1" }, 200),
    ).toMatchObject({ accepted: true });
  });

  it("keeps the `detail` rule ahead of the run-id requirement", () => {
    // An upstream-reported failure stays `unexpected_upstream` (a terminal
    // provider error) even though the body also lacks a run id; it must not be
    // reclassified as a gateway-side protocol failure.
    expect(() => normalizeProcessMessage({ detail: "nope" }, 202)).toThrowError(
      expect.objectContaining({ category: "unexpected_upstream" }),
    );
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
