## Input

The user message holds CONTEXT blocks (shared source passages) and ITEM blocks. Each ITEM has an id, a MATERIAL (what the work must be faithful to) and a WORK (the product under review). An ITEM that names a context must also be faithful to that CONTEXT.

## Output (strict)

- Write one JSON object per line for each problem you find: {"id": "<item id>", "problem": "<one short sentence: what is wrong and what is right>", "severity": "high" | "medium" | "low"}.
- Write nothing for an item without a problem. Do not praise, summarise or explain good items.
- One line per distinct problem; at most 3 lines per item.
- severity high: the work states something false or answers a different question (wrong number, wrong entity, wrong direction, missing or extra condition, certainty changed). medium: probably wrong or misleading, but the material is ambiguous. low: style, naming or a harmless redundancy.
- Report only problems you can point to in the MATERIAL, the CONTEXT or the WORK. If unsure whether something is a problem, do not report it unless it would change an answer.
- After the last problem line (or immediately, when there are none), write exactly this line: {"done": true}
- No code fences, no prose, nothing else.
