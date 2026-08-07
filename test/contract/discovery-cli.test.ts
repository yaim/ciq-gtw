import { describe, expect, it } from "vitest";
import { exitCodeForBaseline } from "../../src/collectiviq/discovery-cli.js";
import {
  captureStructure,
  STRUCTURAL_CAPTURE_FORMAT,
} from "../../src/collectiviq/structural-capture.js";
import type {
  DiscoveryBaselineReport,
  DiscoveryObservation,
  DiscoveryStage,
  SseObservation,
} from "../../src/collectiviq/discovery.js";

function ok(stage: DiscoveryStage): DiscoveryObservation {
  return { stage, ok: true, status: 200, errorCode: null, structure: {} };
}

function sseOk(): DiscoveryObservation {
  const structure: SseObservation = {
    termination: "completed",
    events: [],
    correlation: { thread: "matched", run: "matched" },
  };
  return { stage: "sse_structure", ok: true, status: 200, errorCode: null, structure };
}

/** A fully complete baseline report that maps to exit code 0. */
function completeReport(): DiscoveryBaselineReport {
  return {
    session: "baseline",
    destinationOrigin: "https://api.prod.collectiviq.ai",
    evidenceFormatVersion: STRUCTURAL_CAPTURE_FORMAT,
    observations: [
      ok("available_llms"),
      {
        stage: "auth_error",
        ok: false,
        status: 401,
        errorCode: "upstream_authentication_failed",
        structure: {},
      },
      {
        stage: "validation_error",
        ok: false,
        status: 422,
        errorCode: "upstream_validation_failed",
        structure: {},
      },
      ok("single_thread_create"),
      ok("single_submit"),
      ok("combined_thread_create"),
      ok("combined_submit"),
      sseOk(),
      ok("messages_state"),
    ],
    notFound: null,
    notFoundRequested: false,
    cleanup: null,
    correlation: { thread: "matched", run: "matched" },
  };
}

function withObservation(
  report: DiscoveryBaselineReport,
  stage: DiscoveryStage,
  patch: Partial<DiscoveryObservation>,
): DiscoveryBaselineReport {
  return {
    ...report,
    observations: report.observations.map((o) => (o.stage === stage ? { ...o, ...patch } : o)),
  };
}

describe("strict baseline exit policy", () => {
  it("returns zero for a fully complete session", () => {
    expect(exitCodeForBaseline(completeReport())).toBe(0);
  });

  it("returns non-zero when a required positive stage failed", () => {
    for (const stage of [
      "single_thread_create",
      "single_submit",
      "combined_thread_create",
      "combined_submit",
      "messages_state",
    ] as const) {
      const report = withObservation(completeReport(), stage, { ok: false });
      expect(exitCodeForBaseline(report)).toBe(1);
    }
  });

  it("accepts a 403 model-inventory restriction but rejects other failures", () => {
    // A 2xx success and an authenticated 403 are both complete inventory outcomes.
    expect(exitCodeForBaseline(completeReport())).toBe(0);
    const forbidden = withObservation(completeReport(), "available_llms", {
      ok: false,
      status: 403,
      errorCode: "upstream_authentication_failed",
    });
    expect(exitCodeForBaseline(forbidden)).toBe(0);

    // 401, 429, 5xx, and transport/timeout failures (no status) all fail completeness.
    const rejected: Array<Partial<DiscoveryObservation>> = [
      { ok: false, status: 401, errorCode: "upstream_authentication_failed" },
      { ok: false, status: 429, errorCode: "upstream_quota_exceeded" },
      { ok: false, status: 500, errorCode: "upstream_unexpected_error" },
      { ok: false, status: null, errorCode: "upstream_network_error" },
      { ok: false, status: null, errorCode: "upstream_timeout" },
      // A malformed 2xx inventory (the structural gate rejected it) is reachable
      // through the runner and is not a valid success.
      { ok: false, status: 200, errorCode: "invalid_upstream_response" },
    ];
    for (const patch of rejected) {
      expect(exitCodeForBaseline(withObservation(completeReport(), "available_llms", patch))).toBe(
        1,
      );
    }
  });

  it("returns non-zero when the model-inventory observation is missing", () => {
    const report: DiscoveryBaselineReport = {
      ...completeReport(),
      observations: completeReport().observations.filter((o) => o.stage !== "available_llms"),
    };
    expect(exitCodeForBaseline(report)).toBe(1);
  });

  it("returns non-zero when the auth probe did not yield an authentication failure", () => {
    const report = withObservation(completeReport(), "auth_error", {
      ok: true,
      errorCode: null,
    });
    expect(exitCodeForBaseline(report)).toBe(1);
  });

  it("returns non-zero when the validation probe did not yield a validation failure", () => {
    const report = withObservation(completeReport(), "validation_error", {
      ok: true,
      errorCode: null,
    });
    expect(exitCodeForBaseline(report)).toBe(1);
  });

  it("returns non-zero when SSE evidence is incomplete", () => {
    const bad: SseObservation = {
      termination: "malformed-utf8",
      events: [],
      correlation: { thread: "not-observed", run: "not-observed" },
    };
    const report = withObservation(completeReport(), "sse_structure", { structure: bad });
    expect(exitCodeForBaseline(report)).toBe(1);
  });

  it("accepts timeout and event-limit as useful SSE terminations", () => {
    for (const termination of ["timeout", "event-limit", "eof"] as const) {
      const structure: SseObservation = {
        termination,
        events: [],
        correlation: { thread: "not-observed", run: "not-observed" },
      };
      const report = withObservation(completeReport(), "sse_structure", { structure });
      expect(exitCodeForBaseline(report)).toBe(0);
    }
  });

  it("returns non-zero when requested not-found evidence was not obtained", () => {
    const requested: DiscoveryBaselineReport = {
      ...completeReport(),
      notFoundRequested: true,
      notFound: null,
    };
    expect(exitCodeForBaseline(requested)).toBe(1);
    const noResponse: DiscoveryBaselineReport = {
      ...completeReport(),
      notFoundRequested: true,
      notFound: { stage: "not_found", ok: false, status: null, errorCode: null, structure: null },
    };
    expect(exitCodeForBaseline(noResponse)).toBe(1);
  });

  it("accepts a not-found HTTP response as obtained evidence", () => {
    const report: DiscoveryBaselineReport = {
      ...completeReport(),
      notFoundRequested: true,
      notFound: {
        stage: "not_found",
        ok: false,
        status: 404,
        errorCode: "upstream_unexpected_error",
        structure: {},
      },
      cleanup: {
        attempted: 2,
        succeeded: 2,
        failed: 0,
        remaining: 0,
        journalPersistenceFailed: 0,
        attempts: [],
      },
    };
    expect(exitCodeForBaseline(report)).toBe(0);
  });

  it("returns non-zero when cleanup left any failure or remaining owned thread", () => {
    expect(
      exitCodeForBaseline({
        ...completeReport(),
        cleanup: {
          attempted: 2,
          succeeded: 1,
          failed: 1,
          remaining: 1,
          journalPersistenceFailed: 0,
          attempts: [],
        },
      }),
    ).toBe(1);
    expect(
      exitCodeForBaseline({
        ...completeReport(),
        cleanup: {
          attempted: 2,
          succeeded: 1,
          failed: 1,
          remaining: 0,
          journalPersistenceFailed: 0,
          attempts: [],
        },
      }),
    ).toBe(1);
    expect(
      exitCodeForBaseline({
        ...completeReport(),
        cleanup: {
          attempted: 2,
          succeeded: 2,
          failed: 0,
          remaining: 0,
          journalPersistenceFailed: 0,
          attempts: [],
        },
      }),
    ).toBe(0);
  });

  it("returns non-zero when a cleanup DELETE succeeded but its journal removal failed", () => {
    // HTTP DELETEs all succeeded (failed: 0, remaining: 0) yet the journal removal
    // could not be persisted — still an incomplete, non-zero result.
    expect(
      exitCodeForBaseline({
        ...completeReport(),
        cleanup: {
          attempted: 2,
          succeeded: 2,
          failed: 0,
          remaining: 0,
          journalPersistenceFailed: 1,
          attempts: [
            {
              phase: "final-cleanup",
              ok: true,
              status: 200,
              errorCode: null,
              journalPersisted: false,
            },
            {
              phase: "final-cleanup",
              ok: true,
              status: 200,
              errorCode: null,
              journalPersisted: true,
            },
          ],
        },
      }),
    ).toBe(1);
  });
});

describe("structural capture placeholder namespace is collision-proof", () => {
  it("never lets a real 'field_N' or '__truncated__' key overwrite a generated marker", () => {
    // A safe key that collides with the placeholder namespace must itself be
    // demoted to a positional placeholder, so no output key is ambiguous.
    const captured = captureStructure({ field_0: "x", "a-unsafe-key": "y" }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(captured).length).toBe(2);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain('"x"');
    expect(serialized).not.toContain('"y"');
    for (const key of Object.keys(captured)) {
      expect(/^field_\d+$/.test(key)).toBe(true);
    }
  });
});
