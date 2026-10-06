# Ploinky Workers

Ploinky Workers is a single CLI and JavaScript library for deterministic, phased model tasks. The command is `pworker`. It manages an independent local proxy for remote and local model providers.

Start with the [HTML documentation](docs/index.html): [concepts](docs/concepts.html), [batching](docs/batching.html), and the [CLI guide](docs/guide.html). See [PWORKER.md](PWORKER.md) for the repository's technical reference.

Install from the open source repository with `git clone https://github.com/AssistOS-AI/Ploinky-Worker.git`, then run `cd Ploinky-Worker && npm link && pworker`. Node.js 22.13 or newer is required.

Run the test suite with `npm test`.


### Constant template files and compact Markdown fields

Markdown scalar fields accept `### tier:small`, `### batch:true`, and `###next:repair`. Templates and code remain fenced blocks. A template may include `${{lib/prompts/conventions.txt}}`: the file is read relative to the task working directory and expanded before batch grouping and deterministic request IDs are computed. Expansion freezes the contents at enqueue. Nested includes resolve relative to their containing file. Included files must be constant (no `${variable}`), stay inside the workspace, and have no cycles. Missing files are errors. Task input and model output are never expanded as includes. Keep the dynamic task argument last to retain compatible prefix batching.

For manually queued experiments, set `taskExecution.batchScheduling` to `"wave"`. Each flush waits for its active model and local phases to settle before dispatching the next collected model cohort. The collection timeout does not bypass this barrier; batch size/input limits still split requests. Other flushes remain independent. The default `"ready"` mode retains bounded collection windows for latency-sensitive work. Branches execute per task before collection. Compatible model phases can share a request even when their local code or next phase differs; each result executes its own task's continuation.

### Model-aware batch budgets

Configure `providers.<provider>.modelLimits.<model>` with `contextTokens`, `maxOutputTokens`, optionally `defaultOutputTokens`, and source/verification date. Model selection saves advertised catalog limits when both context and output limits are available; the model list displays them. DeepSeek Flash's documented capabilities are provided in the default configuration (verified 2026-10-06). Missing capabilities remain unknown rather than being invented.

For known models, batching has no implicit item or character cap. It accounts for the complete shared prompt, envelope, IDs and inputs, and reserves the configured output ceiling. Without a model tokenizer, UTF-8 byte length plus message overhead is used as a conservative token bound, explicitly not an exact token count. Response metadata records the model budget. Explicit `batching.<tier>.maxItems/maxInputChars` remain optional user policy overrides. Unknown models retain the legacy conservative fallback and should have their capabilities configured before large runs. An input that cannot fit is rejected intact; files are never split into cases. A larger output ceiling permits longer replies but does not force their generation.
