# Agent Sessions

This directory is for ephemeral agent collaboration artifacts such as scratch notes, temporary checklists, experiment results, and handoffs.

Use:

```text
.agent/sessions/<branch-or-task>/<worker-id>/
```

Rules:

- Never store secrets, credentials, authorization headers, production/customer data, repository source copied for convenience, unsanitized CollectivIQ responses, or prompt/response content here.
- Session artifacts are not product requirements or durable architecture records.
- Move durable decisions into `.agent/docs/tech-software-spec.md` or the appropriate owner document before completing the task.
- Do not make application code, tests, build scripts, or CI depend on this directory.
- Remove obsolete session artifacts when their useful conclusions have been captured elsewhere, subject to normal approval and change-safety rules.
