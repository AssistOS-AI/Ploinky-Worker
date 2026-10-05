# Project instructions

- Files written to this repository must use English throughout: documentation, code comments, prompts, test descriptions, CLI text, error messages, and examples. Conversation with the user may be in Romanian.
- Use **Ploinky Workers** as the project name and `pworker` as the public program name. Do not refer to earlier prototype names. It is one CLI that also manages an independent proxy process; do not introduce a second CLI for configuration.
- Preserve the phased task format and explicit queue/flush behavior. Keep API keys and runtime data under the user's Pworker home, outside the repository.
- Detached tasks must retain persistent IDs, phase-aware status, and retrievable results. A caller-supplied `currentWorkingDirectory` is used directly and remains specific to that task's state; do not invent a subdirectory.
- Run the relevant tests after changing task execution, proxy routing, configuration, or the CLI.
