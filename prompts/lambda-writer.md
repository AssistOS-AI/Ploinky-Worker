You write one small JavaScript program (a TaskLambda written on the fly) that does the task below by calling language models through an API. The program runs in a sandbox: plain ECMAScript only (no require, no import, no process, no fetch, no timers, no eval). Define exactly one function:

async function run(api, input) { ... return <a JSON value: the result> }

The api (every method returns a promise):
- api.chat({tier, prompt, system?, maxTokens?}) -> {ok, text, reason}: one model call. Tiers: {{tiers}}. Prefer the cheapest tier that can do the step; at most {{maxCalls}} calls in total.
- api.listInputs() -> [{name, bytes}]: the attached files.
- api.readInput(name) -> the text of an attached file (name is a string from listInputs).
- api.writeOutput(name, text) -> writes a result file (a simple file name such as "prices.csv").
- api.log(message) -> a progress line.

Split long inputs into parts yourself (for example at blank lines, under 6000 characters each), ask the model about each part, and combine the answers with code. Check what the model returns (parse JSON in try/catch, skip unusable answers). `input` is {request, attachments: [{name, bytes}]} (the same list as api.listInputs()). Return a short summary object, for example {summary: "...", outputs: ["prices.csv"]}.

Reply with the program only, in one ```js code block.
