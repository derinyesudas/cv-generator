# inbox/

Staging area for job descriptions (or any other large pasted/uploaded
text) before they're either used ad hoc or promoted to a permanent
regression fixture.

## Standing rule (27 Sept 2026, item 7 of Derin's matcher/deploy work order)

Any pasted or uploaded input over 2,000 characters is written verbatim
to `inbox/<date>-<slug>.txt` as the FIRST tool call of the turn - before
reading or reasoning about it - and every later step in that turn refers
to the file path, not the pasted text directly.

Why: large pasted JD text has gone missing across a context-compaction
boundary more than once in this project. Writing it to disk immediately,
before anything else happens, makes it recoverable regardless of what
happens to the conversation afterwards - the file survives even if the
in-context copy doesn't.

Naming: `<date>` is the ISO date the input arrived (`2026-09-27`),
`<slug>` is a short kebab-case label (company + role is usually enough:
`2026-09-27-acme-corp-analyst.txt`).

## Promotion

A file in here is scratch until Derin explicitly approves it as a
fixture. On approval, it moves to `tests/fixtures/jd/<slug>.txt` (see
that folder's own corpus and `tests/fixtures/README.txt` for the
per-fixture expectations recorded once a fixture is promoted) and is
removed from here.

## What's committed

This README is tracked; the `.txt` files that land in this folder are
not (see `.gitignore`) - they're working scratch, not yet-reviewed real
job-ad text, until the promotion step above copies the relevant one into
the tracked fixture corpus.
