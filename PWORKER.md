# Ploinky Workers

`pworker` is one CLI and library for phased tasks. Its HTTP proxy runs in a separate process and starts on first use. `pworker start` and `pworker stop` control it explicitly. Running `pworker` without arguments opens an interactive arrow-key menu.

Node.js 22.13 or newer is required. From this directory, run `npm link` and then `pworker`. Without installation, run `node bin/pworker.mjs`.

The [HTML documentation](docs/index.html) has separate pages for [concepts](docs/concepts.html), [batching](docs/batching.html), and the [CLI guide](docs/guide.html). Run `pworker --help` for a complete command and option reference; help does not start the proxy or write user configuration.

## Configuration

User data lives in `~/.pworker/` (or `PWORKER_HOME`): `config.json`, `keys/`, `tasks/`, `jobs/`, `data/`, `cache/`, and `logs/`. API keys live in `keys/<provider>.env` with mode 0600; `config.json` stores only the key variable name. The main menu's **Log in / connect provider** action accepts a built-in provider key, a custom OpenAI-compatible endpoint and optional key, or a configured local model that Pworker can start. It checks the provider's live model catalog before accepting the connection. **Configure tier** appears only after at least one provider is connected. Pick a provider and model from its live catalog; type to filter long model lists. Arrow keys move, Enter confirms, and Esc or **Back / Cancel** leaves any step. The tier mapping is saved only after its final confirmation.

The noninteractive equivalents are `pworker provider NAME --endpoint https://example.com/v1 --key KEY --rpm 60` and `pworker tier small --provider NAME --model MODEL_ID --batch`. Both validate the live model catalog before saving. Supplying `--key` on a command line may leave it in shell history; use the menu or edit the `.env` file directly when that matters.

The built-in providers are `openference`, `openai`, `zai`, `deepseek`, `grok`, `openrouter`, and the existing local models. The [OpenAI](https://platform.openai.com/docs/api-reference/models/object?lang=curl), [Z.AI](https://docs.z.ai/guides/capabilities/mcp-call), and [xAI](https://docs.x.ai/developers/rest-api-reference/inference) endpoints follow their official documentation. Remote providers become usable after their keys are configured. The tiers are `nano`, `micro`, `tiny`, `small`, `medium`, `good`, `best`, plus the `supertiny` alias. A tier is an ordered chain of `{upstream, model}` entries; the first available provider receives the request. Change a tier with `pworker tier small --provider openai --model MODEL_ID --batch`. The proxy enforces `providers.<name>.limits.maxPerMinute`. Use `pworker models [start|stop <name>]` to inspect or control local models; configure their GGUF files and executable in `providers`.

The proxy listens at `http://127.0.0.1:18080` by default and serves `/v1/chat/completions`, `/v1/models`, `/stats`, and `/health`. Files named `data/requests-YYYY-MM-DD.jsonl` record requests, models, statuses, `req_bytes`, and `res_bytes`. `/stats` reports totals over time windows and cache hits. Complete responses are cached under `cache/`; the key includes the effective model, prompt, and request parameters. An identical request to the same model can be served without another API call.

## Task files

A `.mjs` file exports an object containing phases. JSON cannot contain functions, so `code` can be a JavaScript string or, in a manually written module, a function. For a text request, the compiler writes a `.mjs` module with string-valued code to `~/.pworker/tasks/<sha256>.mjs`; an identical request reuses that file. Local modules are imported as JavaScript and must be trusted. Each phase's code runs separately in the sandbox without access to `process`, unrestricted file APIs, or the network. Confined file operations are available when a working directory is supplied.

```js
export default {
  begin: {
    tier: 'tiny',
    template: 'Convert to uppercase: $input',
    code: 'this.upper = result; this.next("finish")'
  },
  finish: {
    tier: null,
    template: '',
    code: 'this.end({ original: this.input, upper: this.upper })'
  }
};
```

`pworker run ./task.mjs --input 'hello'` executes a task file immediately. `pworker run 'a natural-language task' --input 'hello'` compiles and executes a text request. `pworker run - --input ...` reads the request from stdin. `this.next("phase")` selects the next phase, `this.end(value)` finishes the task, and `this.name = value` preserves a variable for subsequent phases. A final phase without `code` returns the model's answer. Execution is capped at 100 phases per task.

## Detached execution and status

Add `--async` to return a task ID without waiting for task execution:

```sh
pworker run ./task.mjs --input 'hello' --cwd /path/to/project --async
pworker --status
pworker --status TASK_ID
```

The first command returns JSON with `id` and `status`. `--status` lists all detached tasks; `--status TASK_ID` reports one task. A record has `queued`, `compiling`, `running`, `completed`, or `failed` status. While running, `phase` names the current task phase and `steps` counts phase executions. When complete, `result` contains the value and final task state; on failure, `error` explains the problem. Status and results are stored under `~/.pworker/jobs/`, so they remain available after the calling process exits. A stopped worker process is marked failed when status is next read. `pworker flush --async` sends the whole queued group to one detached worker, preserving prompt batching, and returns one ID per task.

## Task working directory and file operations

The caller chooses the exact directory with `--cwd DIR`, `--current-working-directory DIR`, or the `currentWorkingDirectory` field in the input object. The library also accepts `worker.enqueue(task, input, { currentWorkingDirectory: DIR })`. Pworker resolves the directory when the task starts, adds it to that task's state as `this.currentWorkingDirectory`, and does **not** create a subdirectory. Two tasks given the same directory can access the same files; their state variables remain separate.

Phase code can use `await this.readFile(path)`, `await this.writeFile(path, text)`, `await this.listFiles(path, recursive)`, `await this.moveFile(from, to)`, `await this.makeDirectory(path)`, and `await this.removeFile(path)`. `writeFile` creates parent directories and can replace an existing file; `removeFile` removes a regular file. Paths must remain inside `currentWorkingDirectory`, including after resolving symlinks. Writes to `.git`, `.pworker`, and `.agents` are refused. File sizes and total writes are bounded by the workspace limits. These methods are unavailable when no working directory is supplied. For example:

```js
export default {
  begin: {
    tier: null,
    code: 'await this.writeFile("result.txt", this.input); this.end(await this.readFile("result.txt"))'
  }
};
```

The library accumulates tasks and sends them on an explicit call:

```js
import { Pworker } from 'pworker';
import { createPworkerClient } from 'pworker/client';

const worker = new Pworker({
  client: createPworkerClient({ purpose: 'my-batch' }),
  config: { batching: { small: { enabled: true } } }
});
worker.enqueue(task, { input: 'one' });
worker.enqueue(task, { input: 'two' });
const results = await worker.flush();
```

In the CLI, `pworker queue ./task.mjs --input one` and subsequent `queue` commands accumulate entries in `~/.pworker/queue.json`. `pworker flush` executes them and retains failed entries. Use `pworker queue list` and `pworker queue clear` to inspect or empty the queue.

## Batching within one model request

This batching mode combines prompts; it does not use a provider's asynchronous Batch API. It applies **only** when a phase has `batch: true`, its tier has `batching.<tier>.enabled: true`, and its template contains exactly one `$variable` at the very end. Tasks must reach the same phase at the same time and share the same tier, prompt prefix, phase code, and transition. Pworker sends that prefix once, followed by a JSON list of `{id,input}` entries, and asks for `{results:{id: result}}`. It routes each result back by ID, then advances the tasks independently. A group of one uses an ordinary request. A missing ID or malformed response fails the entire group. Use batching only when the model reliably returns JSON and requests have no dependencies on one another. It can reduce request count, but does not guarantee lower cost or latency.

Example: `{ tier: 'small', template: 'Classify this text: $input', batch: true, code: 'this.end(result)' }`.

## Implementation status

The executor is deterministic and does not plan agentic loops while running. Compiling a text request makes an LLM call on the `good` tier; without an available provider, compilation cannot run, while model-free `.mjs` tasks can run offline.
