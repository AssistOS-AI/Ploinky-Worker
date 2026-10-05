# Declarative task contract

Ploinky Workers executes one task format: a direct JSON phase map whose first phase is `begin`. The same validator is used by file loading, compilation, library enqueueing and HTTP submission. Phase statements remain sandboxed; this change does not remove phase processing or confined file operations.

```json
{
  "begin": {"tier": null, "code": "this.value = this.input; this.next('finish')"},
  "finish": {"tier": null, "code": "this.end(this.value)"}
}
```

Use `.json` files. The optional `.mjs` container must contain exactly `export default ` followed by strict JSON, with an optional trailing semicolon. It is parsed as data, never imported. No imports, factories, top-level statements, functions, accessors, class instances or `{start, phases}` wrappers are accepted. A phase's `code` is a statement string, not a function or lambda expression. Ordinary callbacks within statements are not task declarations.

## Removed execution surfaces

- The old module registry, agent planner, lambda cache, call-tree executor, job runner, built-in lambda files and worker dispatcher have been removed.
- The sandbox no longer exports a module executor. Its remaining internal primitive runs wrappers generated from validated phase statements.
- The client no longer exposes `call`, `runJob`, lambda discovery or executable `run` methods. Its `run` property is only a budget-accounting identifier.
- `/v1/lambdas`, `/v1/run`, `/v1/jobs` and `/v1/calls` return HTTP 410. They do not load or execute anything.
- Invalid bodies sent to `POST /v1/tasks` return HTTP 400 before queueing. The accepted body is `{ "task": PHASE_MAP, "input": VALUE, "currentWorkingDirectory": PATH_OR_NULL }`.
- Natural-language CLI requests are compiled to validated phase JSON before execution. The compiler has a new cache namespace and does not reuse old executable modules.

Existing credentials, configuration, model logs and historical runtime data under the user home are not deleted. Old executor configuration keys no longer activate a runner. Budget accounting endpoints and provider proxy endpoints are not task executors and remain available.

## Verification

Run `npm test`. Contract tests verify rejection before model calls, no module-loading side effects, rejection of wrapped/function-valued tasks, removed client methods and sandbox module execution, strict JSON documentation examples, retired HTTP endpoints, and successful multi-phase execution with persistent results and confined files. These tests use stub providers and incur no model charges.

Verified on 2026-10-05: all 69 Worker tests passed; all three NLP predefined-task contract tests passed. After restarting the local proxy, POST requests to all four retired endpoint families returned 410, a lambda-form phase returned 400, and a two-phase model-free JSON task completed with result 42 and a persisted ID (`8e1d8d85-a17e-4016-ab3a-8bd0795d8c70`). No provider calls were needed for these checks.
