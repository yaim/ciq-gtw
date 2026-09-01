# Documentation

## Purpose

Documentation is part of the product contract. Update it in the same change as behavior, architecture, operations, security, configuration, tests, or terminology.

## Ownership Map

| Subject | Current owner | Supporting guidance |
| --- | --- | --- |
| Product goals, non-goals, public/upstream contract, architecture, delivery phases, acceptance, risks, open questions | `.agent/docs/tech-software-spec.md` | Relevant `.agent/instructions/*.md` |
| Repository-wide agent workflow, routing, approval gates, and done definition | `AGENTS.md` | This file |
| Initialization and planned source layout | `.agent/docs/tech-software-spec.md` sections 7 and 26 | `.agent/instructions/project-initialization.md`, `.agent/instructions/project-map.md` |
| OpenAI compatibility implementation rules | `.agent/docs/tech-software-spec.md` sections 8–9, 14, and 20 | `.agent/instructions/openai-compatibility.md` |
| CollectivIQ provisional contract and discovery questions | `.agent/docs/tech-software-spec.md` sections 2.1, 10, 13, 32 phase 0, and 35 | `.agent/instructions/upstream-integration.md` |
| Grounded CollectivIQ upstream contract (OpenAPI source metadata, evidence states, request contracts, capability matrix, drift history, fixture references) | `.agent/docs/collectiviq-upstream-contract.md` | `.agent/instructions/upstream-integration.md`, `.agent/docs/tech-software-spec.md` sections 2.1 and 10 |
| Tool protocol and release policy | `.agent/docs/tech-software-spec.md` sections 11.2, 12, 21.4–21.5, and 30 | `.agent/instructions/tool-calling.md` |
| Security, privacy, retention, and deployment controls | `.agent/docs/tech-software-spec.md` sections 21–22 and 31 | `.agent/instructions/security.md` |
| Runtime config, observability, health, and lifecycle | `.agent/docs/tech-software-spec.md` sections 15–19, 23–24, 28, and 31 | `.agent/instructions/operations.md` |
| Test strategy and release evidence | `.agent/docs/tech-software-spec.md` sections 29–30 | `.agent/instructions/validation.md` |
| Operator setup, supported scope, local run, configuration, Docker usage | `README.md` | `.agent/instructions/operations.md`, `.agent/instructions/project-initialization.md` |
| Vulnerability reporting and supported security/deployment posture | `SECURITY.md` | `.agent/instructions/security.md` |
| Ephemeral task notes and handoffs | `.agent/sessions/` | `.agent/sessions/README.md` |

The specification still owns product decisions and detailed design. `README.md` and `SECURITY.md` now exist as current owner documents (rows above) and must be kept in sync with implemented reality; they must not claim unimplemented behavior. As further durable user/operator documents are introduced, update this map rather than letting ownership become implicit.

Still-expected owner documents from specification section 26:

- OpenCode smoke usage in `README.md`, added when the completion path exists;
- targeted runbooks for production operations during phase 4.

Do not create empty owner docs just to satisfy the planned tree.

## Documentation Rules

- Preserve normative force: use “must” for requirements and “may/should” only where the specification does.
- Distinguish verified behavior, planned design, provisional upstream assumptions, experimental features, supported opt-in beta features, and future possibilities. "Supported beta" means gated evidence exists but the feature is non-default and unproven in production; never restate it as "production-ready".
- Do not claim full OpenAI compatibility, true streaming, native tools, exact token usage, context windows, upstream idempotency, zero retention, or production tool readiness without evidence.
- Keep examples synthetic and secrets unmistakably fake. Never paste live prompts, answers, headers, thread IDs, or account data.
- Prefer one detailed owner and concise links elsewhere. Remove or update stale duplicated examples in the same change.
- Keep endpoint, environment-variable, error-code, metric, virtual-model, and state names exact and searchable.
- Update cross-references when paths/headings move.
- Do not describe a planned file, script, or endpoint as present until it exists and has been validated.

## Change Routing

- Public API change: update the specification, compatibility guide, examples, tests, and README when present.
- Upstream observation: update sanitized fixtures/tests and the provisional contract/open questions; mark what is verified.
- Configuration change: update schema, examples, operations/security guidance, Docker wiring, and README when present.
- Architecture change: update specification diagrams/pseudocode/structure and the project map.
- Tool behavior or release status: update protocol, adversarial tests, release evidence, labels, and limitations together.
- Security/retention/logging change: update threat/operational documentation and call out migration or deployment impact.
- Command/script change: update `package.json`, validation guidance, CI, and README together.

## Review Checklist

- Is the owning document updated rather than only an agent summary?
- Are planned and implemented states clearly separated?
- Do examples match actual schemas, config names, defaults, and commands?
- Are limitations and residual risks still prominent?
- Are new upstream claims supported by sanitized repeatable evidence?
- Are links and referenced files/headings valid?
- Is all content free of credentials and sensitive request/response data?
- Did the change introduce a new owner document that must be added to this map?
