import { describe, expect, it } from "vitest";
import {
  classifyCorrelation,
  extractCorrelationCandidates,
} from "../../src/collectiviq/correlation.js";

describe("correlation extraction", () => {
  it("extracts string and positive-integer candidates, normalizing ints to strings", () => {
    const c = extractCorrelationCandidates({
      thread_id: "t-1",
      run_id: 42,
      combined_run_id: "cr-9",
    });
    expect(c).toEqual({ threadId: "t-1", runId: "42", combinedRunId: "cr-9" });
  });

  it("rejects empty strings, non-positive/non-integer numbers, and wrong types", () => {
    expect(extractCorrelationCandidates({ thread_id: "" })).toEqual({
      threadId: null,
      runId: null,
      combinedRunId: null,
    });
    expect(extractCorrelationCandidates({ run_id: 0 }).runId).toBeNull();
    expect(extractCorrelationCandidates({ run_id: -3 }).runId).toBeNull();
    expect(extractCorrelationCandidates({ run_id: 1.5 }).runId).toBeNull();
    expect(extractCorrelationCandidates({ thread_id: true }).threadId).toBeNull();
    expect(extractCorrelationCandidates({ thread_id: null }).threadId).toBeNull();
  });

  it("finds candidates nested inside objects and arrays", () => {
    const c = extractCorrelationCandidates({
      data: { items: [{ thread_id: "deep-t" }], meta: { run_id: "deep-r" } },
    });
    expect(c.threadId).toBe("deep-t");
    expect(c.runId).toBe("deep-r");
  });

  it("never invokes an accessor-defined candidate property", () => {
    let invoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "thread_id", {
      get() {
        invoked = true;
        return "SECRET";
      },
      enumerable: true,
      configurable: true,
    });
    const c = extractCorrelationCandidates(hostile);
    expect(invoked).toBe(false);
    expect(c.threadId).toBeNull();
  });

  it("is cycle-safe and returns nulls rather than throwing", () => {
    const cyclic: Record<string, unknown> = { run_id: "r" };
    cyclic["self"] = cyclic;
    const c = extractCorrelationCandidates(cyclic);
    expect(c.runId).toBe("r");
  });
});

describe("correlation classification (value-free)", () => {
  const requested = { threadId: "t-1", runId: "r-1", combinedRunId: null };

  it("reports matched when the exact requested value was observed", () => {
    const report = classifyCorrelation(requested, new Set(["t-1"]), new Set(["r-1"]));
    expect(report).toEqual({ thread: "matched", run: "matched" });
  });

  it("reports not-matched when a candidate of that kind was observed but differed", () => {
    const report = classifyCorrelation(requested, new Set(["other"]), new Set(["other"]));
    expect(report).toEqual({ thread: "not-matched", run: "not-matched" });
  });

  it("reports not-observed when no candidate of that kind was seen", () => {
    const report = classifyCorrelation(requested, new Set(), new Set());
    expect(report).toEqual({ thread: "not-observed", run: "not-observed" });
  });

  it("reports not-observed when nothing was requested", () => {
    const report = classifyCorrelation(
      { threadId: null, runId: null, combinedRunId: null },
      new Set(["t-1"]),
      new Set(["r-1"]),
    );
    expect(report).toEqual({ thread: "not-observed", run: "not-observed" });
  });

  it("falls back to combinedRunId for the requested run value", () => {
    const report = classifyCorrelation(
      { threadId: null, runId: null, combinedRunId: "cr-7" },
      new Set(),
      new Set(["cr-7"]),
    );
    expect(report.run).toBe("matched");
  });

  it("never leaks a requested or observed identifier in its output", () => {
    const report = classifyCorrelation(requested, new Set(["t-1"]), new Set(["r-1"]));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("t-1");
    expect(serialized).not.toContain("r-1");
  });
});

describe("correlation run matches any requested candidate", () => {
  // A validated combined submission that returned BOTH run identifiers.
  const bothRuns = { threadId: null, runId: "provider-run", combinedRunId: "combined-run" };

  it("matches when the observed run set contains only runId", () => {
    const report = classifyCorrelation(bothRuns, new Set(), new Set(["provider-run"]));
    expect(report.run).toBe("matched");
  });

  it("matches when the observed run set contains only combinedRunId", () => {
    const report = classifyCorrelation(bothRuns, new Set(), new Set(["combined-run"]));
    expect(report.run).toBe("matched");
  });

  it("reports not-matched when neither candidate is observed but the set is non-empty", () => {
    const report = classifyCorrelation(bothRuns, new Set(), new Set(["some-other-run"]));
    expect(report.run).toBe("not-matched");
  });

  it("reports not-observed when the observed run set is empty", () => {
    const report = classifyCorrelation(bothRuns, new Set(), new Set());
    expect(report.run).toBe("not-observed");
  });

  it("matches equal runId/combinedRunId values (deduped naturally)", () => {
    const report = classifyCorrelation(
      { threadId: null, runId: "same-run", combinedRunId: "same-run" },
      new Set(),
      new Set(["same-run"]),
    );
    expect(report.run).toBe("matched");
  });

  it("never leaks a requested or observed run identifier in its output", () => {
    const report = classifyCorrelation(bothRuns, new Set(), new Set(["combined-run"]));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("provider-run");
    expect(serialized).not.toContain("combined-run");
  });
});
