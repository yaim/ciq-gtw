/**
 * Per-request JSON Schema compilation and argument validation (specification
 * sections 12.2, 21.5). Selects the meta-schema dialect from each tool schema's
 * ROOT `$schema` and compiles with the matching Ajv instance:
 *
 *  - a boolean schema, or an object schema with NO `$schema`, uses draft-07 (the
 *    backward-compatible default);
 *  - an exact draft-07 `$schema` URI (see {@link DRAFT_07_SCHEMA_IDS}) uses
 *    draft-07;
 *  - an exact draft 2020-12 `$schema` URI (see {@link DRAFT_2020_SCHEMA_IDS})
 *    uses draft 2020-12 (OpenCode 1.18.21 stamps its built-in tool schemas with
 *    this dialect);
 *  - a non-string `$schema`, or any other dialect URI, fails closed.
 *
 * Only the ROOT `$schema` is inspected — the input is already trusted plain JSON
 * from `safeJsonCopy`, so this adds no unsafe traversal. At most one fresh Ajv
 * instance per dialect is created per call (lazily), so a mixed draft-07 /
 * draft-2020-12 tool array compiles with one instance of each and no cross-request
 * retention.
 *
 * Both dialects share the same inert, self-contained options: NO type coercion,
 * NO applied defaults, NO property removal, and NO remote schema loading (an
 * unresolved remote `$ref` fails compilation). Compilation happens exactly once
 * per tool; the returned {@link CompiledToolset} reuses the compiled validators
 * for both prior-history arguments and every parsed upstream tool call.
 *
 * A malformed, unknown-dialect, or otherwise unsupported schema fails closed
 * (`{ ok: false }`); the thrown Ajv error is never inspected, serialized, logged,
 * or reflected.
 */
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
// ajv-formats is CJS with an ESM-style `export default`. At true Node ESM
// runtime the namespace `.default` is the plugin function, but under NodeNext +
// verbatimModuleSyntax TS types the interop binding as non-callable, so the
// runtime value is cast to a plain applicator over either Ajv dialect instance.
import * as ajvFormats from "ajv-formats";

const addFormats = ajvFormats.default as unknown as (ajv: unknown) => void;
import type { JsonValue, NormalizedTool } from "./types.js";

/** The exact draft-07 root `$schema` URIs recognized (with and without `#`). */
const DRAFT_07_SCHEMA_IDS: ReadonlySet<string> = new Set([
  "http://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema#",
]);

/** The exact draft 2020-12 root `$schema` URIs recognized (with and without `#`). */
const DRAFT_2020_SCHEMA_IDS: ReadonlySet<string> = new Set([
  "http://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema#",
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema#",
]);

type Dialect = "draft-07" | "2020-12";

/** The minimal Ajv surface used here — both dialect instances satisfy it. */
interface AjvCompiler {
  compile(schema: object | boolean): ValidateFunction;
}

/** The inert, self-contained Ajv options shared by BOTH dialect instances. */
const AJV_OPTIONS = {
  strict: false,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  // No `loadSchema`/`loadSchemaSync`: a remote `$ref` cannot be fetched and
  // fails compilation instead.
} as const;

/**
 * Select the meta-schema dialect from a tool schema's ROOT `$schema`. Returns
 * `null` (fail closed) for a non-string `$schema` or any unrecognized dialect
 * URI. A boolean schema, a non-object root, or an absent `$schema` defaults to
 * draft-07. Reads only own properties of already-trusted plain JSON.
 */
function selectDialect(schema: JsonValue): Dialect | null {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return "draft-07"; // boolean/other primitive root → draft-07 default
  }
  // Primitives, null, and arrays are excluded above; treat the rest as a plain
  // JSON object (`Array.isArray` does not narrow a `readonly` array member).
  const object = schema as { readonly [key: string]: JsonValue };
  if (!Object.hasOwn(object, "$schema")) return "draft-07";
  const declared = object["$schema"];
  if (typeof declared !== "string") return null; // non-string $schema fails closed
  if (DRAFT_07_SCHEMA_IDS.has(declared)) return "draft-07";
  if (DRAFT_2020_SCHEMA_IDS.has(declared)) return "2020-12";
  return null; // unknown dialect fails closed
}

/**
 * The schema to hand to Ajv. The dialect has already been selected from the root
 * `$schema`, so the keyword is redundant and — for a non-canonical allowlisted
 * URI form (e.g. draft-07 without the trailing `#`) — would make Ajv fail to
 * resolve a meta-schema by that exact key. Dropping the ROOT `$schema` lets the
 * chosen instance use its own default meta-schema for every accepted URI form.
 * A boolean or non-object root, or an object with no root `$schema`, is compiled
 * as-is. The one-level copy is built by own-key enumeration over already-trusted
 * plain JSON — no getter is invoked and the frozen input is never mutated.
 */
function schemaForCompilation(schema: JsonValue): object | boolean {
  if (typeof schema === "boolean") return schema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schema as object; // non-schema primitive → Ajv rejects it (fail closed)
  }
  const object = schema as { readonly [key: string]: JsonValue };
  if (!Object.hasOwn(object, "$schema")) return object;
  const stripped: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(object)) {
    if (key === "$schema") continue;
    stripped[key] = value;
  }
  return stripped;
}

/** Compiled, per-request validators keyed by exact tool name. */
export interface CompiledToolset {
  /** The exact set of declared tool names (the allowlist). */
  readonly names: ReadonlySet<string>;
  /** Whether `name` is a declared tool. */
  has(name: string): boolean;
  /**
   * Whether `args` satisfies the named tool's compiled schema. Returns `false`
   * for an unknown name or if validation throws — it never coerces, mutates, or
   * throws.
   */
  validateArguments(name: string, args: unknown): boolean;
}

export type CompileResult =
  { readonly ok: true; readonly toolset: CompiledToolset } | { readonly ok: false };

/**
 * Compile every tool's `parameters` schema once. Returns a {@link CompiledToolset}
 * or fails closed on the first malformed/unsupported schema.
 */
export function compileToolset(tools: readonly NormalizedTool[]): CompileResult {
  // At most one fresh instance per dialect, created lazily. A mixed draft-07 /
  // draft-2020-12 tool array therefore uses one instance of each; a single-dialect
  // array creates only that one instance. No instance is retained across calls.
  const instances = new Map<Dialect, AjvCompiler>();
  const ajvFor = (dialect: Dialect): AjvCompiler => {
    let ajv = instances.get(dialect);
    if (ajv === undefined) {
      ajv = dialect === "2020-12" ? new Ajv2020(AJV_OPTIONS) : new Ajv(AJV_OPTIONS);
      addFormats(ajv);
      instances.set(dialect, ajv);
    }
    return ajv;
  };

  const validators = new Map<string, ValidateFunction>();
  try {
    for (const tool of tools) {
      // `parameters` is already trusted plain JSON data (descriptor-safe copy);
      // an absent schema was normalized to an empty object (accept any args).
      const dialect = selectDialect(tool.parameters);
      if (dialect === null) return { ok: false }; // non-string / unknown-dialect $schema
      validators.set(tool.name, ajvFor(dialect).compile(schemaForCompilation(tool.parameters)));
    }
  } catch {
    return { ok: false };
  }

  const names: ReadonlySet<string> = new Set(tools.map((tool) => tool.name));
  return {
    ok: true,
    toolset: {
      names,
      has: (name) => names.has(name),
      validateArguments(name, args) {
        const validate = validators.get(name);
        if (validate === undefined) return false;
        try {
          return validate(args) === true;
        } catch {
          return false;
        }
      },
    },
  };
}
