/**
 * Deterministic canonicalization for consensus grouping (specification section
 * 12.3.1). Canonicalization is pure and stable: two logically equal tool-call
 * sets always map to the same key. It includes the tool name, the recursively
 * key-sorted argument JSON, and — unless parallel calls are enabled — the call
 * order. When parallel calls are enabled, order is irrelevant, so the per-call
 * keys are sorted to make the set-key order-independent.
 */

/** A minimal call shape for canonicalization (id is intentionally excluded). */
export interface CanonicalizableCall {
  readonly name: string;
  readonly argumentsJson: string;
}

/** Recursively key-sort a JSON value so equal objects serialize identically. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      // `defineProperty`, not `out[key] = …`: a plain assignment to the key
      // `"__proto__"` invokes the inherited prototype setter and silently drops
      // the key, which would let two logically distinct argument objects
      // canonicalize identically. An own data property preserves every key.
      Object.defineProperty(out, key, {
        value: sortKeys(record[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** Canonical JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Canonical key for one call: name + key-sorted arguments. */
export function canonicalCall(call: CanonicalizableCall): string {
  let args: unknown;
  try {
    // argumentsJson is always gateway-produced valid JSON, but stay defensive.
    args = JSON.parse(call.argumentsJson);
  } catch {
    args = call.argumentsJson;
  }
  return canonicalJson({ name: call.name, arguments: args });
}

/**
 * Canonical key for a whole call SET. When `parallelEnabled`, per-call keys are
 * sorted so ordering does not distinguish otherwise-equal sets; otherwise the
 * order is preserved as part of the key.
 */
export function canonicalCallSet(
  calls: readonly CanonicalizableCall[],
  parallelEnabled: boolean,
): string {
  const items = calls.map(canonicalCall);
  const ordered = parallelEnabled ? [...items].sort() : items;
  return JSON.stringify(ordered);
}
