Golden test fixtures go here (JD in, expected CV out pairs) per the build
prompt section 10. `reference-output.docx` is the one confirmed-correct
output so far (the Accenture / consulting-tech CV), used to verify Phase 1's
renderer. It is an earlier version of Derin's own CV, so it is kept on his
computer and not in the repository (no test reads it). Test passes on
selection equality (same archetype, same bullet variants, same section
order), not exact prose equality.

## `real-jds/` (added Phase 5, 13 Sept 2026)

Six real, live job description texts pulled directly from Derin's own
`ireland-job-tracker` repo (`data/jobs.json`, public GitHub Pages data feed)
— not the tailored CVs he's applied with, which mirror the ad's own
language back and would inflate a match score if scored against
themselves. One file per archetype (`manifest.json` maps filename ->
archetype + source posting), including the actual live **Davy Business
Analyst** posting Derin was tailored for.

Ran all six through `CVScore.pickArchetype()`: 5 of 6 auto-picked the
intended archetype correctly, including the exact Davy posting. The one
miss — a real **Allianz Reinsurance Finance Analyst** ad — scored higher
on `consulting-tech` (31, from generic "AI/digital transformation"
corporate boilerplate) than `finance-ops` (10, from the ad's actual
finance-specific language). Not a bug: this is spec 5.2's scoring rule
working exactly as specified (sum of keyword weights, highest wins) on a
real ad where boilerplate outweighs substance — which is exactly the
scenario the manual override dropdown exists for. Flagged to Derin rather
than silently reweighting archetype keywords, since that's a scoring-policy
change, not a bug fix.
