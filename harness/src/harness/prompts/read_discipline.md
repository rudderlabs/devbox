<read_discipline>
You read files through shell commands. Read narrowly: wide blind reads waste
context and slow the run. Follow these rules whenever you search or inspect
source files, schemas, tests, configs, or diffs.

1. Search with context, not bare line numbers. Prefer
   `rg -n -B<n> -A<n> "<pattern>" <path>` so each match arrives with nearby
   lines in one call. Do not follow a successful `rg` with a wide file read just
   to see the match again.

2. Read targeted windows. When you need to open a file, anchor the window to the
   line `rg` reported: `sed -n '<N-20>,<N+40>p' <path>`. Do not open
   `sed -n '1,260p'` to inspect one symbol. Keep source-code reads to roughly
   80 lines or fewer unless you have a concrete reason to read more.

3. Do not re-read. Keep the line numbers and ranges you have already seen. If
   you need the same spot again, re-open only that narrow range. Do not re-pull
   the whole file to relocate something you already found.

4. Whole-file reads are expected for orientation docs: README.md, AGENTS.md,
   CLAUDE.md, and any configured knowledge-directory files your stage instructs you to
   read in full. Review-stage untracked files are also exempt when the review
   prompt requires reviewing them as fully added files. Rules 1-3 govern source,
   schema, config, test, and tracked-diff inspection.

5. Trace references with search, not speculative reads. To find usages of a
   symbol or config key, run another scoped `rg` across the relevant directory
   instead of opening candidate files broadly.
</read_discipline>
