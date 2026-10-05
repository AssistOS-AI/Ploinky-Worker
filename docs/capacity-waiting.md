# Capacity-aware tasks and recovery

Declared task model phases wait for capacity by default. HTTP 429 does not exhaust a retry counter and fail the task: the proxy holds the request, honors the full `Retry-After` delay (seconds or HTTP date), and retries when the queue permits. Provider limits and plan budgets still apply. No fallback is selected merely to bypass a capacity wait. Normal non-task proxy callers retain their configured finite retry policy unless they opt into capacity waiting.

## Separate queue time from model time

For task phases, `request.timeoutMs` limits an actual upstream generation attempt, not time in the local queue or provider cooldown. The client sends a capacity-wait flag and an upstream-attempt timeout, without a wall-clock deadline over the entire queued HTTP request. An explicit AbortSignal still cancels it. A real upstream generation timeout returns `upstream_timeout`; invalid credentials, invalid task data, malformed output and truncated output remain genuine failures. Waiting must not hide those errors.

Transient transport failures and 5xx responses are deferred with bounded backoff by capacity-aware clients. A proxy restart can interrupt the connection; the waiting phase can reconnect without replaying already completed phase code. Provider cooldown timestamps are logged as `deferred_until` and restored on restart, so restarting cannot erase a cooldown.

## State and persistence

A pending model phase reports `waiting`, its phase name and a waiting reason. The phase checkpoint contains the validated task, current variables and prior phase count. Server tasks store it under their existing persistent ID. Task completion is published immediately; it is not held behind another task that is still waiting.

On server startup, pending server tasks and checkpoints left by dead workers are recovered. A waiting model phase resumes with its saved variables; earlier file-writing phases are not replayed. An explicitly cancelled task is terminal and is not recovered. A library caller using `new Pworker(...)` receives checkpoints through `onProgress`; durable storage of a purely in-process library run remains the caller's responsibility. Server and CLI detached-task integrations persist their progress.

This is not an exactly-once provider-billing guarantee: a crash after the provider computed an answer but before receiving it can require another model request. A crash during arbitrary phase code is not automatically replayed as if it were a safe waiting checkpoint; its file effects may be ambiguous.

## Cancellation

For library tasks, use `worker.cancel(id)`. For server-owned HTTP tasks, use `client.cancelTask(id)` or `POST /v1/tasks/:id/cancel`. Removing one member of a shared model batch does not cancel the remaining members, and its phase code is not executed when the shared result arrives. Cancelling the entire waiting request removes it from the provider queue without consuming another rate slot. Cancellation does not undo file operations already performed.

## Tests

`test/capacity-wait.test.mjs` covers repeated 429 beyond the former retry limit, queue waits longer than the model deadline, cooldown/checkpoint recovery after restart, preservation of earlier file effects, independent task completion, batch-member cancellation, HTTP cancellation and permanent authentication errors. `test/queue-cancellation.test.mjs` covers cancellation during a queued 429 retry. All tests use stub providers, not paid model calls.
