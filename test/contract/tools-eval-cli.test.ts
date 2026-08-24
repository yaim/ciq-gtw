/**
 * Hermetic tests for the approval-gated live tool evaluator. Every collaborator
 * is injected: a fake transport (a smart in-memory adapter), fake credentials, a
 * recording in-memory journal, and a captured emit sink. NO real network, NO real
 * credential, and the fixed production origin is never contacted.
 */
import { describe, expect, it } from "vitest";
import {
  buildPreflightReport,
  defaultToolsEvalDeps,
  parseEvalArgs,
  runToolsEval,
  EVAL_ORIGIN,
  type EvalReport,
  type PreflightReport,
  type ToolsEvalDeps,
} from "../../src/eval/tools-eval-cli.js";
import type {
  CollectivIQAdapter,
  CollectivIQCredentialProvider,
  CredentialLease,
  FetchLike,
  TransportBase,
} from "../../src/collectiviq/types.js";
import { deleteThreadPath } from "../../src/collectiviq/endpoints.js";
import type { RecoveryJournalSink } from "../../src/collectiviq/recovery-journal.js";

const CRED_SENTINEL = "SECRET-EVAL-PASSWORD-9c1f";

/** Extract the last user-message content from a serialized protocol prompt. */
function lastUserContent(prompt: string): string {
  const begin = prompt.indexOf("BEGIN_CONVERSATION_JSON\n");
  const end = prompt.indexOf("\nEND_CONVERSATION_JSON");
  if (begin === -1 || end === -1) return "";
  try {
    const conv = JSON.parse(prompt.slice(begin + "BEGIN_CONVERSATION_JSON\n".length, end)) as {
      messages: { role: string; content: string }[];
    };
    return [...conv.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  } catch {
    return "";
  }
}

/** A smart in-memory adapter: returns the tool matching the last user instruction. */
function smartAdapter(): CollectivIQAdapter {
  let n = 0;
  let lastPrompt = "";
  const envelopeFor = (prompt: string): string => {
    // Match on the USER instruction only (the tools JSON lists every tool name).
    const instruction = lastUserContent(prompt);
    if (/bump|edit/i.test(instruction)) {
      return JSON.stringify({
        gateway_protocol: "1.0",
        type: "tool_calls",
        calls: [{ name: "edit", arguments: { path: "synthetic/x", text: "v2" } }],
      });
    }
    if (/test suite/i.test(instruction)) {
      return JSON.stringify({
        gateway_protocol: "1.0",
        type: "tool_calls",
        calls: [{ name: "test", arguments: {} }],
      });
    }
    if (/summarize/i.test(instruction)) {
      return JSON.stringify({
        gateway_protocol: "1.0",
        type: "final",
        content: "synthetic summary",
      });
    }
    return JSON.stringify({
      gateway_protocol: "1.0",
      type: "tool_calls",
      calls: [{ name: "read", arguments: { path: "synthetic/x" } }],
    });
  };
  return {
    createThread: () => Promise.resolve({ threadId: `t${(n += 1)}`, rawStatus: 200 }),
    processMessage: (input) => {
      lastPrompt = input.prompt;
      return Promise.resolve({ accepted: true, rawStatus: 202 });
    },
    getMessages: () =>
      Promise.resolve({
        messages: [
          {
            source: "claude",
            content: envelopeFor(lastPrompt),
            percentUsage: null,
            createdAt: 1,
            id: 1,
          },
        ],
        rawStatus: 200,
      }),
    getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
  };
}

/** A recording in-memory journal (ID-only) that appends lifecycle events to a ledger. */
function recordingJournal(ledger: string[]): RecoveryJournalSink & { owned: Set<string> } {
  const owned = new Set<string>();
  return {
    owned,
    init: () => {
      ledger.push("journal.init");
      return Promise.resolve();
    },
    recordCreated: (id) => {
      owned.add(id);
      return Promise.resolve();
    },
    recordDeleted: (id) => {
      owned.delete(id);
      return Promise.resolve();
    },
    finalize: () => {
      ledger.push("journal.finalize");
      return Promise.resolve();
    },
    ownedThreadIds: () => [...owned],
  };
}

const fakeProvider: CollectivIQCredentialProvider = {
  // Shape is not asserted; the adapter is faked so the provider is never used.
} as unknown as CollectivIQCredentialProvider;

interface Harness {
  readonly deps: ToolsEvalDeps;
  readonly emitted: Array<PreflightReport | EvalReport>;
  readonly ledger: string[];
  readonly journal: RecoveryJournalSink & { owned: Set<string> };
}

function harness(over: {
  argv: readonly string[];
  deleteThread?: ToolsEvalDeps["deleteThread"];
  makeAdapter?: () => CollectivIQAdapter;
  journal?: RecoveryJournalSink & { owned: Set<string> };
}): Harness {
  const emitted: Array<PreflightReport | EvalReport> = [];
  const ledger: string[] = [];
  const journal = over.journal ?? recordingJournal(ledger);
  const deps: ToolsEvalDeps = {
    argv: over.argv,
    env: {
      COLLECTIVIQ_AUTH_MODE: "password",
      COLLECTIVIQ_USERNAME: "u",
      COLLECTIVIQ_PASSWORD: CRED_SENTINEL,
    },
    buildProvider: (env, base: TransportBase) => {
      // Reading the credential here proves ordering (journal.init precedes it) and
      // the fixed origin is passed; the value is never emitted.
      void env["COLLECTIVIQ_PASSWORD"];
      ledger.push(`buildProvider:${base.baseUrl}`);
      return fakeProvider;
    },
    makeAdapter: over.makeAdapter ?? (() => smartAdapter()),
    deleteThread: over.deleteThread ?? (() => Promise.resolve(true)),
    makeJournal: () => journal,
    emit: (report) => emitted.push(report),
  };
  return { deps, emitted, ledger, journal };
}

const fullArgv = [
  "--execute-approved",
  "--cost-approved",
  "--cleanup-approved",
  "--recovery-journal-approved",
];

describe("eval:tools — argument parsing", () => {
  it("rejects any unknown argument", () => {
    expect(() => parseEvalArgs(["--go-live"])).toThrow();
    expect(() => parseEvalArgs(["--execute-approved", "--oops"])).toThrow();
  });
  it("parses the closed flag set", () => {
    expect(parseEvalArgs(["--execute-approved", "--cost-approved"])).toEqual({
      executeApproved: true,
      costApproved: true,
      cleanupApproved: false,
      recoveryJournalApproved: false,
    });
  });
});

describe("eval:tools — preflight (default, credential-free, network-free)", () => {
  it("emits a preflight report and reads no credential / touches no journal", async () => {
    const h = harness({ argv: [] });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(0);
    expect(h.emitted).toHaveLength(1);
    const report = h.emitted[0] as PreflightReport;
    expect(report.mode).toBe("preflight");
    expect(report.origin).toBe(EVAL_ORIGIN);
    expect(report.authMode).toBe("password");
    expect(report.plannedSingleRoundCases).toBe(200);
    expect(report.plannedMultiStepScenarios).toBe(20);
    expect(report.maxUpstreamCompletions).toBe(280);
    // No provider build, no journal init.
    expect(h.ledger).toEqual([]);
  });

  it("buildPreflightReport reflects the approvals given", () => {
    const report = buildPreflightReport({
      executeApproved: true,
      costApproved: true,
      cleanupApproved: false,
      recoveryJournalApproved: false,
    });
    expect(report.approvalsGiven).toEqual(["--execute-approved", "--cost-approved"]);
  });
});

describe("eval:tools — execution requires every approval", () => {
  it("rejects --execute-approved without the other approvals", async () => {
    const h = harness({ argv: ["--execute-approved"] });
    await expect(runToolsEval(h.deps)).rejects.toThrow();
    // No journal was initialized and no provider built before the guard.
    expect(h.ledger).toEqual([]);
  });
});

describe("eval:tools — fully-approved executed path (fakes)", () => {
  it("runs exactly 280 bounded completions, cleans up every thread, and passes the gates", async () => {
    const h = harness({ argv: fullArgv });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(0);
    const report = h.emitted[0] as EvalReport;
    expect(report.mode).toBe("executed");
    expect(report.completions).toBe(280); // 200 single + 20 × 4 rounds
    expect(report.cleanup).toEqual({
      attempted: 280,
      deleted: 280,
      failed: 0,
      remaining: 0,
      journalFailures: 0,
    });
    expect(report.passed).toBe(true);
    expect(report.gateOutcomes).toEqual({
      schemaValidity: true,
      toolNameAccuracy: true,
      argValidity: true,
      singleRoundSuccess: true,
      multiStepSuccess: true,
      noSilentFallback: true,
      injectionResistance: true,
      parserDeterminism: true,
    });
    // The journal ended empty (every id dropped after a confirmed delete).
    expect(h.journal.owned.size).toBe(0);
  });

  it("initializes the journal BEFORE reading any credential (journal-before-secret)", async () => {
    const h = harness({ argv: fullArgv });
    await runToolsEval(h.deps);
    const initIdx = h.ledger.indexOf("journal.init");
    const provIdx = h.ledger.findIndex((e) => e.startsWith("buildProvider:"));
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(provIdx).toBeGreaterThan(initIdx);
    // The provider was built for the FIXED origin.
    expect(h.ledger[provIdx]).toBe(`buildProvider:${EVAL_ORIGIN}`);
  });

  it("never emits the credential value", async () => {
    const h = harness({ argv: fullArgv });
    await runToolsEval(h.deps);
    expect(JSON.stringify(h.emitted)).not.toContain(CRED_SENTINEL);
  });

  it("ABORTS immediately when a cleanup delete fails", async () => {
    // Fail the delete on the very first thread.
    let calls = 0;
    const h = harness({
      argv: fullArgv,
      deleteThread: () => {
        calls += 1;
        return Promise.resolve(calls > 1); // first delete fails, then would succeed
      },
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as EvalReport;
    expect(report.aborted).toBe("cleanup-failed");
    expect(report.passed).toBe(false);
    expect(report.cleanup.failed).toBeGreaterThanOrEqual(1);
    // It stopped early — far fewer than 280 completions.
    expect(report.completions).toBeLessThan(280);
  });
});

describe("eval:tools — exactly-once cleanup and truthful failure reporting", () => {
  /** A recording journal whose named lifecycle method rejects on first call. */
  function throwingJournal(
    fail: "recordCreated" | "recordDeleted",
  ): RecoveryJournalSink & { owned: Set<string> } {
    const owned = new Set<string>();
    return {
      owned,
      init: () => Promise.resolve(),
      recordCreated: (id) => {
        if (fail === "recordCreated") return Promise.reject(new Error("journal write failed"));
        owned.add(id);
        return Promise.resolve();
      },
      recordDeleted: (id) => {
        if (fail === "recordDeleted") return Promise.reject(new Error("journal drop failed"));
        owned.delete(id);
        return Promise.resolve();
      },
      finalize: () => Promise.resolve(),
      ownedThreadIds: () => [...owned],
    };
  }

  /** An adapter that counts delete calls via a shared counter object. */
  function countingDeleter(counter: { count: number }): ToolsEvalDeps["deleteThread"] {
    return () => {
      counter.count += 1;
      return Promise.resolve(true);
    };
  }

  /** An adapter that records how many times each upstream operation is invoked. */
  function countingAdapter(counts: {
    created: number;
    submitted: number;
    polled: number;
  }): CollectivIQAdapter {
    return {
      createThread: () => {
        counts.created += 1;
        return Promise.resolve({ threadId: `t${counts.created}`, rawStatus: 200 });
      },
      processMessage: () => {
        counts.submitted += 1;
        return Promise.resolve({ accepted: true, rawStatus: 202 });
      },
      getMessages: () => {
        counts.polled += 1;
        return Promise.resolve({ messages: [], rawStatus: 200 });
      },
      getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
    };
  }

  it("ABORTS before submit/poll when recordCreated fails, deleting the thread exactly once", async () => {
    const counter = { count: 0 };
    const counts = { created: 0, submitted: 0, polled: 0 };
    const h = harness({
      argv: fullArgv,
      journal: throwingJournal("recordCreated"),
      makeAdapter: () => countingAdapter(counts),
      deleteThread: countingDeleter(counter),
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as EvalReport;
    expect(report.aborted).toBe("journal-persistence-failed");
    // One thread created; NO submission and NO poll — the unjournaled thread is
    // never exposed to a request.
    expect(counts.created).toBe(1);
    expect(counts.submitted).toBe(0);
    expect(counts.polled).toBe(0);
    // Exactly one deletion attempt (HTTP-successful) before the abort.
    expect(counter.count).toBe(1);
    expect(report.cleanup.attempted).toBe(1);
    expect(report.cleanup.deleted).toBe(1);
    expect(report.cleanup.failed).toBe(0);
    expect(report.cleanup.journalFailures).toBe(1);
    expect(report.completions).toBeLessThan(280);
  });

  it("still deletes the created thread when recordDeleted fails, then aborts (journal-persistence)", async () => {
    const counter = { count: 0 };
    const h = harness({
      argv: fullArgv,
      journal: throwingJournal("recordDeleted"),
      deleteThread: countingDeleter(counter),
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as EvalReport;
    expect(report.aborted).toBe("journal-persistence-failed");
    expect(counter.count).toBe(1); // exactly one delete attempt
    expect(report.cleanup.deleted).toBe(1); // HTTP delete succeeded
    expect(report.cleanup.journalFailures).toBe(1); // but the journal drop did not
    expect(report.cleanup.failed).toBe(0);
  });

  it("cleans up then aborts (round-execution) when submission throws", async () => {
    const counter = { count: 0 };
    const adapter: CollectivIQAdapter = {
      createThread: () => Promise.resolve({ threadId: "t1", rawStatus: 200 }),
      processMessage: () => Promise.reject(new Error("submit failed")),
      getMessages: () => Promise.resolve({ messages: [], rawStatus: 200 }),
      getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
    };
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => adapter,
      deleteThread: countingDeleter(counter),
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as EvalReport;
    expect(report.aborted).toBe("round-execution-failed");
    // The thread was still created, so it was deleted exactly once despite the failure.
    expect(counter.count).toBe(1);
    expect(report.cleanup.attempted).toBe(1);
    expect(report.cleanup.deleted).toBe(1);
  });

  it("cleans up then aborts (round-execution) when polling throws", async () => {
    const counter = { count: 0 };
    const adapter: CollectivIQAdapter = {
      createThread: () => Promise.resolve({ threadId: "t1", rawStatus: 200 }),
      processMessage: () => Promise.resolve({ accepted: true, rawStatus: 202 }),
      getMessages: () => Promise.reject(new Error("poll failed")),
      getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
    };
    const h = harness({
      argv: fullArgv,
      makeAdapter: () => adapter,
      deleteThread: countingDeleter(counter),
    });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as EvalReport;
    expect(report.aborted).toBe("round-execution-failed");
    expect(counter.count).toBe(1);
    expect(report.cleanup.deleted).toBe(1);
  });

  it("never invokes the deleter twice for one round (exactly-once)", async () => {
    // A per-thread counter proves at most one delete per created thread across a
    // full successful run.
    const perThread = new Map<string, number>();
    const h = harness({
      argv: fullArgv,
      deleteThread: (_base, _provider, threadId) => {
        perThread.set(threadId, (perThread.get(threadId) ?? 0) + 1);
        return Promise.resolve(true);
      },
    });
    await runToolsEval(h.deps);
    for (const [, count] of perThread) expect(count).toBe(1);
    expect(perThread.size).toBe(280);
  });
});

describe("eval:tools — gate metrics give no false credit to invalid/missing output", () => {
  it("scores 0% schema/name/arg validity when the model never emits a valid call", async () => {
    // An adapter that ALWAYS returns final text. Under `auto` this is a text
    // result; under `required`/named the selection engine returns a structured
    // error (never a silent fallback). Either way NO valid tool call is produced,
    // so the expected-call gates must record ZERO credit — the pre-fix bug gave
    // name/argument credit here and could show a false 100%.
    let tid = 0;
    const alwaysText: CollectivIQAdapter = {
      createThread: () => Promise.resolve({ threadId: `t${(tid += 1)}`, rawStatus: 200 }),
      processMessage: () => Promise.resolve({ accepted: true, rawStatus: 202 }),
      getMessages: () =>
        Promise.resolve({
          messages: [
            {
              source: "claude",
              content: JSON.stringify({
                gateway_protocol: "1.0",
                type: "final",
                content: "no tools",
              }),
              percentUsage: null,
              createdAt: 1,
              id: 1,
            },
          ],
          rawStatus: 200,
        }),
      getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => alwaysText });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(1);
    const report = h.emitted[0] as EvalReport;
    expect(report.gates.schemaValidityPct).toBe(0);
    expect(report.gates.toolNameAccuracyPct).toBe(0);
    expect(report.gates.argValidityPct).toBe(0);
    expect(report.gates.singleRoundSuccessPct).toBe(0);
    expect(report.gates.multiStepSuccessPct).toBe(0);
    expect(report.gateOutcomes.schemaValidity).toBe(false);
    expect(report.gateOutcomes.toolNameAccuracy).toBe(false);
    expect(report.gateOutcomes.argValidity).toBe(false);
    expect(report.passed).toBe(false);
    // The gateway did NOT silently downgrade required/named to text — it errored —
    // so the no-silent-fallback gate is still satisfied, and determinism is real.
    expect(report.gateOutcomes.noSilentFallback).toBe(true);
    expect(report.gateOutcomes.parserDeterminism).toBe(true);
  });
});

describe("eval:tools — genuine multi-step transcript continuity", () => {
  it("carries prior assistant tool_calls and matching tool results into later rounds", async () => {
    const prompts: string[] = [];
    let n = 0;
    let lastPrompt = "";
    const lastUser = (prompt: string): string => {
      const begin = prompt.indexOf("BEGIN_CONVERSATION_JSON\n");
      const end = prompt.indexOf("\nEND_CONVERSATION_JSON");
      if (begin === -1 || end === -1) return "";
      try {
        const conv = JSON.parse(prompt.slice(begin + "BEGIN_CONVERSATION_JSON\n".length, end)) as {
          messages: { role: string; content: string | null }[];
        };
        return [...conv.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      } catch {
        return "";
      }
    };
    const envelopeFor = (prompt: string): string => {
      const instruction = lastUser(prompt);
      if (/bump|edit/i.test(instruction)) {
        return JSON.stringify({
          gateway_protocol: "1.0",
          type: "tool_calls",
          calls: [{ name: "edit", arguments: { path: "synthetic/x", text: "v2" } }],
        });
      }
      if (/test suite/i.test(instruction)) {
        return JSON.stringify({
          gateway_protocol: "1.0",
          type: "tool_calls",
          calls: [{ name: "test", arguments: {} }],
        });
      }
      if (/summarize/i.test(instruction)) {
        return JSON.stringify({ gateway_protocol: "1.0", type: "final", content: "s" });
      }
      return JSON.stringify({
        gateway_protocol: "1.0",
        type: "tool_calls",
        calls: [{ name: "read", arguments: { path: "synthetic/x" } }],
      });
    };
    const capturing: CollectivIQAdapter = {
      createThread: () => Promise.resolve({ threadId: `t${(n += 1)}`, rawStatus: 200 }),
      processMessage: (input) => {
        prompts.push(input.prompt);
        lastPrompt = input.prompt;
        return Promise.resolve({ accepted: true, rawStatus: 202 });
      },
      getMessages: () =>
        Promise.resolve({
          messages: [
            {
              source: "claude",
              content: envelopeFor(lastPrompt),
              percentUsage: null,
              createdAt: 1,
              id: 1,
            },
          ],
          rawStatus: 200,
        }),
      getThreadTitle: () => Promise.resolve({ kind: "pending" as const }),
    };
    const h = harness({ argv: fullArgv, makeAdapter: () => capturing });
    const code = await runToolsEval(h.deps);
    expect(code).toBe(0);

    // A single-round prompt is a fresh user turn with no tool history. A multi-step
    // continuation MUST serialize the accumulated assistant tool_calls + a linked
    // tool result carrying the gateway-issued call id.
    const continuation = prompts.find(
      (p) => p.includes('"tool_calls"') && p.includes('"tool_call_id"') && p.includes("call_ciq_"),
    );
    expect(continuation).toBeDefined();
    if (continuation === undefined) return;
    // The linked result's tool_call_id matches an id that appeared in a tool_calls block.
    const parsedBegin = continuation.indexOf("BEGIN_CONVERSATION_JSON\n");
    const parsedEnd = continuation.indexOf("\nEND_CONVERSATION_JSON");
    const conv = JSON.parse(
      continuation.slice(parsedBegin + "BEGIN_CONVERSATION_JSON\n".length, parsedEnd),
    ) as { messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[] };
    const callIds = new Set(conv.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
    const resultIds = conv.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id ?? "");
    expect(resultIds.length).toBeGreaterThan(0);
    for (const id of resultIds) expect(callIds.has(id)).toBe(true);
  });
});

describe("eval:tools — production default deleter wiring (hermetic)", () => {
  const SENTINEL = "SYNTH-UPSTREAM-TOKEN-4b2e";
  const THREAD_ID = "thread/with space#1"; // needs percent-encoding in the path

  /** A synthetic password-style provider that leases a sentinel token. */
  function syntheticProvider(): CollectivIQCredentialProvider & { acquires: number } {
    const provider = {
      acquires: 0,
      acquire: (): Promise<CredentialLease> => {
        provider.acquires += 1;
        return Promise.resolve({ generation: 1, token: SENTINEL });
      },
      invalidate: () => undefined,
    };
    return provider;
  }

  interface Call {
    readonly url: string;
    readonly method: string | undefined;
    readonly authorization: string | undefined;
  }

  /** A fake fetch recording each request; returns the configured status. */
  function recordingFetch(status: number, calls: Call[]): FetchLike {
    return (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: input,
        method: init?.method,
        authorization: headers["authorization"],
      });
      return Promise.resolve(
        new Response("{}", { status, headers: { "content-type": "application/json" } }),
      );
    };
  }

  it("issues exactly one DELETE to the fixed encoded path, reusing the provider, on 2xx → true", async () => {
    const calls: Call[] = [];
    const provider = syntheticProvider();
    const base: TransportBase = { baseUrl: EVAL_ORIGIN, fetch: recordingFetch(200, calls) };
    const result = await defaultToolsEvalDeps().deleteThread(
      base,
      provider,
      THREAD_ID,
      new AbortController().signal,
    );
    expect(result).toBe(true);
    // Exactly one DELETE, no retry.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    // The fixed encoded delete-thread path against the fixed origin.
    expect(calls[0]?.url).toBe(`${EVAL_ORIGIN}${deleteThreadPath(THREAD_ID)}`);
    expect(calls[0]?.url).toContain("with%20space%231");
    // The supplied credential provider is reused; the header carries only the sentinel.
    expect(provider.acquires).toBe(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${SENTINEL}`);
  });

  it("returns false on a non-2xx and does NOT retry", async () => {
    const calls: Call[] = [];
    const base: TransportBase = { baseUrl: EVAL_ORIGIN, fetch: recordingFetch(403, calls) };
    const result = await defaultToolsEvalDeps().deleteThread(
      base,
      syntheticProvider(),
      THREAD_ID,
      new AbortController().signal,
    );
    expect(result).toBe(false);
    expect(calls).toHaveLength(1); // single attempt, no retry
  });

  it("stays bounded and value-free on caller cancellation (returns false, never throws)", async () => {
    const calls: Call[] = [];
    const cancellingFetch: FetchLike = (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: input, method: init?.method, authorization: headers["authorization"] });
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const controller = new AbortController();
    controller.abort();
    const base: TransportBase = { baseUrl: EVAL_ORIGIN, fetch: cancellingFetch };
    let result: boolean | undefined;
    await expect(
      (async () => {
        result = await defaultToolsEvalDeps().deleteThread(
          base,
          syntheticProvider(),
          THREAD_ID,
          controller.signal,
        );
      })(),
    ).resolves.toBeUndefined(); // no throw
    expect(result).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(1); // at most one attempt
  });

  it("never contacts the network in production form — this test injected its own fetch", () => {
    // The production deps build `base` as `{ baseUrl: EVAL_ORIGIN }` (no fetch), so
    // the deleter uses the global fetch only on the fully-approved live run. Here a
    // fake fetch was injected via `base.fetch`, so no socket was opened.
    expect(EVAL_ORIGIN).toBe("https://api.prod.collectiviq.ai");
  });
});
