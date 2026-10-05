# Provider rate limits: analysis and behavior

This note records why `openference` answered HTTP 429 although the configured limits (`maxPerMinute: 15`) were respected, what was changed, and how to show the provider's behavior with `pworker stats`.

## Architecture: one sender per home

All upstream model requests are sent by one function, `forward()` in `lib/core.mjs`, inside `limiter.schedule()` of the provider. The CLI (`run`, `flush`, `queue`), detached `_execute-batch` workers and library users (for example the nlpFormaliser evaluator) reach models only through `createPworkerClient`, which talks HTTP to the proxy; the in-process transport is used only by code running inside the proxy itself (server-owned tasks). `test/rate-limits.test.mjs` checks this invariant: no other module posts to a provider's base URL, and the single send site runs inside the limiter. Catalog (`GET /models`) and health probes are the only other provider requests.

Because every limit lives in that one proxy, two proxies for the same home would each apply the full limits and double the effective rate. `pworker serve` therefore records `{pid, host, port}` in `<home>/server.json`; a second `serve` for the same home refuses while the first answers `/health`, and clients without `PWORKER_URL` or `PWORKER_PORT` use the recorded port. Before this change, a client autostart on another port (`PWORKER_PORT`, a project configuration, or `pworker serve --port`) could start a second proxy over the same home.

## What every attempt costs

Verified paths that send an attempt, each through the provider's limiter and counted when it is sent (`t_sent` in the request log):

- first attempts, 429 retries and 5xx retries of the proxy (`retry.max`, `retry.max5xx`): each retry re-enters `limiter.schedule()`;
- fallbacks down a tier chain or `config.fallback`: through the limiter of the fallback provider;
- prompted JSON tiers: each inner chat call (and its re-ask) goes through `forward()`;
- client retries (`waitForCapacity`, `retries`, `retryCut` budget retries, batch splits): each is a new HTTP request to the proxy, so it is queued and counted like any other request;
- a batch is one request for many task phases.

Not sent and not counted: cache hits, requests refused before sending (credit-balance models, a local server that may not start: logged with `not_sent: true`), and requests cancelled while queued.

## Root causes found

1. **Bursts inside a correct sliding window.** The limiter allowed up to 15 starts in any 60 seconds, but at up to `maxPerSecond: 5` with `maxConcurrent: 4`: 15 requests could leave within about three seconds. A provider that advertises 15 per minute but meters with a small burst (a token bucket that refills one request every 4 seconds) refuses most of such a burst although no 60-second window ever held more than 15 requests. The stub reproduction below shows exactly this: every 429 came while at most 15 requests had been sent in the previous minute.
2. **Retry herds.** After a 429 the provider was paused, and when the pause ended every waiting request (up to `maxConcurrent`) was released in the same millisecond, which met the same small burst again. Each refused attempt also counts at most providers.
3. **Resending before `Retry-After`.** For callers that do not wait for capacity, the pause was `min(Retry-After, retry.maxWaitMs)`, so a request was resent before the provider's cooldown ended; a final 429 (retries used up) did not pause the provider at all, so the next queued requests went out at once.
4. **Window edge jitter.** Our window is measured when we send; the provider measures when a request arrives. A request sent exactly 60.000 seconds after another can arrive less than 60 seconds after it when the first one was slower in transit (a new TLS connection against a reused one). The reproduction recorded 19 attempts within 59.999 seconds by send time at a configured 15 per minute, with no limiter bug: only a window of zero slack.
5. **Aborted attempts free their slot at once.** When a client stopped waiting (the evaluator's per-call deadline, a cancelled task), the proxy aborted the upstream request and freed the concurrency slot immediately, while the provider may keep computing the abandoned request. The client's retry then overlapped it, so the provider saw more concurrent requests than `maxConcurrent`. Run 030 recorded exactly this: "deferred already-aborted attempts after the client timed out".
6. **Completion time instead of send time.** Records carried only the completion time. The limiter was seeded from completion times after a restart, and the 429 inference of `/stats` ("calls in the previous minute") counted long generations (up to 240 seconds in runs 030 and 031) in the minute they ended, not the minute they were sent, so the evidence about the provider's real limit was skewed.
7. **Two proxies for one home** were possible (see above): each applied the limits on its own.

The nlpFormaliser evidence also points at provider-side capacity: run 030 was interrupted because GPT-OSS "still returned provider 429 despite lower concurrency" (two instead of five), and run 031's live observation (`live-capacity-observation.json`) saw 10 provider 429 responses for one waiting task in 295 seconds, about two attempts per minute, far below 15 per minute. That pattern is not explained by our own sending; it is consistent with a per-model capacity limit or with other traffic on the same key. The proxy cannot see traffic that does not pass through it, so the adaptive rate and the `429<lim` metric are the tools for it.

## What the proxy does now

- **Count at send time, every attempt.** Records carry `t_sent`; the limiter is seeded from send times after a restart; records never sent do not count against plan limits.
- **Full `Retry-After`, always.** Every 429 pauses the provider until its `Retry-After` (seconds or HTTP date; exponential backoff from `retry.baseMs` without one). A caller that does not wait for capacity is never resent before it: beyond `retry.maxWaitMs` it receives the 429 (or a fallback). The cooldown survives a restart.
- **Even pacing** (`limits.pacing: "even"`): one start every `60 s / maxPerMinute` (4 seconds at 15 per minute), so a provider metering with a small burst never sees a burst. This is the default for `openference`.
- **Safety margin and window slack**: `limits.safetyMargin` (a fraction, for example `0.1`) keeps that share of every rate free; `limits.windowSlackMs` (1500 for `openference`, 1000 for the other remote providers) widens the minute and hour windows against network jitter.
- **Adaptive rate (AIMD)**: a 429 multiplies the effective rates and concurrency by `limits.adaptive.decrease` (default 0.7, at most once per 5 seconds, never below `min`, default 0.2). Every `cooldownMs` (default 5 minutes) without a new 429 adds `increase` (default 0.1) until the configured rates are reached again. Each 429 record carries `rate_factor` (and `rate_adapted` when it lowered the factor); the factor survives a restart. `limits.adaptive: false` turns it off.
- **Under-limit evidence**: each 429 record carries `under_limit` (whether our own sending was within every configured rate when it came), `sent_60s` and `sent_1s`.
- **Held slots after an abort**: an attempt aborted after it was sent (client gone, duration cap) keeps its concurrency slot for `limits.abortHoldMs` (30 seconds for `openference`, 15 for the other remote providers) and is logged with status 499.
- **One proxy per home**, as described above.

Limits are per provider. A provider that limits per model (or a key shared with other tools) still lowers the adaptive rate of the whole provider; split such models into separate provider entries with their own limits if needed.

## Showing it with `pworker stats`

`pworker stats --provider openference --since 24h` prints, per model and per hour, the attempts sent, successes, 429s and the 429s that came while every configured rate was respected (`429<lim`), with the peak attempts within any 60 seconds. A row such as `sent 31, 429 15, 429<lim 15, peak/min 19` at a configured 15 per minute shows that the provider refused requests that our own sending did not exceed (and, with a peak above 15, that windows need slack). Example from a stub provider that advertises 15 per minute but meters a burst of three with one new request every 4 seconds (first `pacing: "burst"`, then `pacing: "even"`):

```
provider/model           sent  ok  429  429<lim  err  retry  tmout  cache  saved  in tok  out tok  q avg s  peak/min  avg/min  tiers
openference/Qwen3.8 27b    31  16   15       15    0     15      0      0     14    1060      212     11.7        19    10.33  small
```

With burst pacing, 25 attempts met 15 refusals (11 of them within the first six seconds, all while at most 15 requests had been sent in the previous minute), and the spent window then held the provider for most of a minute; with even pacing the same kind of work ran without a single 429. `--json` prints the same data for scripts and reports.
