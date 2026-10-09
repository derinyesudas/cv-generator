# Working in this repo

Standing process rules for whichever Claude session is working in this
repo - narrower, repo-local rules that sit alongside (not instead of)
this project's own decision log and journal in its claude.ai Project.

## Large pasted/uploaded inputs (27 Sept 2026, item 7)

Any job description or other input pasted or uploaded into a session
that is over 2,000 characters is written verbatim to
`inbox/<date>-<slug>.txt` as the FIRST tool call of the turn - before
reading or reasoning about its content - and every later step in that
turn refers to the file path, not the pasted text directly.

Why: large pasted JD text has gone missing across a context-compaction
boundary more than once in this project's history. Writing it to disk
immediately, before anything else happens, makes it recoverable
regardless of what happens to the conversation afterwards.

See `inbox/README.md` for naming and the promotion path from `inbox/`
into the tracked fixture corpus at `tests/fixtures/jd/`.
