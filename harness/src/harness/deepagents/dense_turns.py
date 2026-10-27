"""Shared turn-density prompt fragments for DeepAgents stages.

The edit-flavored ``DENSE_TURNS_EDIT_PROMPT`` is appended to the
implementation system prompt (it also covers edits and quality gates), and the
read-only ``DENSE_TURNS_READONLY_PROMPT`` is appended to the planning and
orientation system prompts. Keep the two in the same
voice when editing either.
"""

DENSE_TURNS_READONLY_PROMPT = """\

Work in dense turns — every model turn you save is wall-clock time:
- When your next inspections are independent — several file reads, several
  `rg` searches, a directory listing plus a targeted read — request them as
  MULTIPLE tool calls in ONE response instead of one call per turn.
- Chain related read-only shell steps that always run together into a single
  command (e.g. `rg -n "<pattern>" src && sed -n '<N-20>,<N+40>p' <file>`).
- Never spend a turn merely restating what a tool result showed; decide and
  act on it in the same response.
"""

DENSE_TURNS_EDIT_PROMPT = """\

Work in dense turns — every model turn you save is wall-clock time:
- When your next actions are independent — several edits you have already
  decided on, several file reads, a lint plus a targeted test — request them as
  MULTIPLE tool calls in ONE response instead of one call per turn.
- Chain related shell steps into a single `execute` call (e.g.
  `npx prettier -w <files> && npx eslint <files> && npx jest <paths>`). Run the
  full quality-gate suite once after your edits are complete, not after each
  individual edit.
- Prefer invoking repo tools directly on the changed files (`npx eslint <files>`,
  `npx jest <paths>`) over package scripts that ignore file arguments and scan
  the whole project.
- Trust tool results: a successful edit_file result means the edit applied — do
  not re-read the file just to confirm your own change, and do not re-run a
  gate that already passed on unchanged code.
"""
