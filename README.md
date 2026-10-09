# CV Generator

Static site, no server, no API key, no AI at runtime — per
`CV-GENERATOR-BUILD-PROMPT.md`. Published on GitHub Pages by a small build
step (`scripts/build-site.mjs`, run by `.github/workflows/deploy-site.yml`
on every push to main) that publishes only the files the app loads, with
the page's scripts combined into one minified file and the data file
without its notes. See DEPLOY.md.

## Current state (8 Oct 2026)

Live at https://derinyesudas.github.io/cv-generator/. The
sections further down are the September build log, kept for history; the
running record is `build-status-and-decision-log.md` in the claude.ai
Project. What a session with the app looks like now (screen simplified on
8 Oct 2026, audit batch 3):

1. **Job ad.** Paste it. Company, role, city, team, recipient and start
   date fill themselves in from it (`js/adinfo.js`) under **Details from
   the ad**; each field says where its value came from, and anything the
   ad doesn't give is flagged there and in a pop-up notice. Team,
   recipient and start date are only ever taken word for word from the ad.
2. **Should you apply?** One verdict - Apply / Check before applying /
   Likely not eligible - summing up the eligibility check (`js/hardreq.js`)
   and the fit check (`js/fitcheck.js`), each reason listed once, with the
   role type underneath. Both checks still render in full under "Every
   check in detail". For eligibility the ad's own wording decides: "not
   required" and "preferable" mean optional, and a requirement the ad calls
   optional stays AMBER even in a regulated ("controlled function") role.
   A RED verdict blocks downloads until "Build anyway"; the letter then
   adds the approved gap sentence for up to two of the RED requirements
   (`hardRequirements.gapBlocks`).
3. **Change sections and settings** (collapsed; remembers being opened):
   the CV and letter section dropdowns (`js/picker.js`) - every approved
   version of each section, the automatic pick marked Recommended in the
   list, each option marked Fits / Fits, trims N / Too long / Blocked, and
   a section you changed marked "Your pick". Hovering an option shows the
   page with it in place; clicking uses it. Nothing is ever composed: a
   pick only changes which approved data-file entry is selected. Also here:
   the private settings form (referee name, salary per role type, kept only
   in the browser) and the audit trail export. The letter quotes
   one line from the ad (picked automatically, never a line where the
   employer talks about itself - "we", "our"), and prints it once, and
   carries two evidence paragraphs whenever both fit on the page, one of
   them always the TCS paragraph.
   No AI runs anywhere in the app (Derin, 3 Oct 2026: "I don't want
   claude for anything in the cv generator").
4. Download each document as PDF (`js/render-pdf.js`, laid out like
   LibreOffice renders the .docx - see `tests/pdf-compare.py`) or Word,
   both named by role and company. Each document says "Fits on one page"
   (the arithmetic is its tooltip); its checks still run every time but
   are shown only when one fails.
   The PDF and Word libraries are hosted with the site (`lib/`, exact
   copies of the pinned CDN versions - see `lib/README.md`) and load only
   when a download button is pressed (`js/libs.js`).
5. Light/dark theme switch in the app bar.

Tests (need `python3 -m http.server 8199` and, for the e2e/PDF ones,
`8299`, from the repo root): `tests/golden/run-golden-tests.mjs`,
`tests/hardreq.test.mjs`, `tests/adinfo.test.mjs`,
`tests/adinfo-ui.test.mjs`, `tests/pickers.test.mjs`, `tests/theme.test.mjs`,
`tests/pdf.test.mjs`.

## Status: post-review hardening pass complete, 1 of 2 blocking items done, 1 open (13 Sept 2026)

A senior-developer-style audit of Phases 1-5 found one severe live bug
(the `customer-ops` archetype crashed the app and silently left a stale
CV on screen under the wrong label), two confirmed-but-inert matching
bugs, and a major architectural issue (`data.style` mostly unread at
runtime, so the page-fit safety gate was measuring a document it didn't
actually control). The response to that review, and the fixes applied,
are:

- **New file `js/matcher.js`** — one matcher, used by the never-claim
  gate, qualification-demand extraction, tools-mentioned extraction, and
  keyword hit counting. Implements `data.matchRule`'s exact/stem syntax
  (trailing `*` = stem the word family, no `*` = exact word only).
  Replaces four previously-separate hand-rolled matching techniques,
  which is exactly how "aca" used to match inside "vacancy" and
  "academic" in one place while being safely exact-matched in another.
- **New file `js/validate.js`** — validates the data file on load
  (unknown fact ids, unknown section types, unknown skill categories,
  missing bullet groups, and the `_educationRule` hard rule that every
  profile variant must name the degree and its classification in its
  first sentence) and refuses to build anything if it finds a problem,
  showing every problem on screen. **Currently fails against the real
  data file** — see "Open item" below.
- **`js/assemble.js`** — section dispatch now keys off `sectionOrder`'s
  `type` slug (`profile`/`skills`/`experience`/`project`/`education`/
  `certifications`), never the display heading text. This is the direct
  fix for the `customer-ops` crash: a heading can be renamed freely now
  without breaking section building, and an actually-unknown type still
  throws loudly, on purpose, so the caller can show a visible error
  instead of a silent stale render.
- **`js/app.js`** (new — the two pages' identical inline `<script>` block,
  extracted into one file) — a failed build no longer silently leaves the
  previous archetype's CV on screen under the new archetype's label. Every
  successful build is stamped with the archetype id, a hash of the JD
  text, and the data file's `_version`; the preview refuses to render
  whenever that stamp doesn't match the live inputs, and shows a visible
  error banner instead. A JD that scores 0 against every archetype no
  longer silently falls back to the priority tie-break winner — it
  refuses to auto-pick and asks for a manual choice. The JD textarea is
  now debounced (250ms) so it doesn't re-run the whole pipeline on every
  keystroke. Adds an "export audit trail" button (JD text, archetype used,
  every selected bullet/profile variant id, fit numbers, data version) and
  a data-version footer.
- **`js/render-docx.js` and `js/preview.js`** — both now read every font
  size, colour, margin, spacing and bullet-style value from `data.style`
  at runtime via a `configure(style)` call, instead of carrying their own
  independently-hardcoded copies. This is the fix for the architectural
  finding: the page-fit gate's whole job is predicting the docx's page
  count, so if the two renderers' style values could ever drift, the
  gate would be measuring a different document than the one actually
  downloaded.
- **`js/verify.js`** — the never-claim gate now matches through
  `js/matcher.js` (required: `data.neverClaim` now uses stem syntax like
  `"reconcil*"`, which the old raw substring check couldn't interpret at
  all). Gate 1 and 2 findings now name the exact block, field, and (where
  resolvable) the data file's own JSON path, e.g. `skillLines.technical
  .terms[4]`, not just a fuzzy text snippet.
- **`tests/golden/run-golden-tests.mjs`** (new) — the collision test
  (every `neverClaim` term against every currently-approved string),
  the gate-fires test (a deliberately poisoned model must trip exactly
  its own gate), the `matchRule` spec cases, and the real-JD archetype
  pick, all in one runnable script. Currently: 0 collisions, all gate/
  matcher cases pass, 5 of 6 real JDs auto-pick correctly (the one known
  miss is the Reinsurance Finance Analyst case — see
  `tests/golden/README.md`).
- Fixed a stale path bug in `tests/golden/real-jds/manifest.json` (each
  entry's `file` field had a redundant `golden/` prefix left over from an
  earlier layout).
- A git repository now exists for this project (`git init`, this commit).

### Open item: `js/validate.js` currently refuses to start against the real data file

Two profile variants fail the `_educationRule` hard rule literally as
written ("every profileVariant must name the degree AND its
classification in its first sentence... a profile variant that does not
do this is a bug"): `prof-retail`'s first sentence never mentions the
degree at all (deliberately — see that archetype's own `_why`, "the
retail rule"), and `prof-customerops`'s first sentence mentions the TCS
role but puts the MSc/degree mention in its *second* sentence, not its
first. Both are real, previously-unenforced conflicts between the data
file's own stated hard rule and its own already-shipped content — not
something to silently patch by rewriting profile prose, since that's a
content decision, not a code fix. The app currently shows both problems
on screen and refuses to build any CV until one of the following is
decided: exempt these two archetypes from the rule explicitly in the
data file, or rewrite the two profile variants' opening sentences.

## Status: Phase 5 of the build order complete and verified

> "Scoring and assembly. Paste a JD, get the right archetype and variants."
> — build prompt, section 11, step 5.

New file: `js/score.js`. `js/assemble.js` now accepts an optional
`extraction` (that file's output) and uses it to implement build spec
section 5.3 exactly:

1. **Extraction (5.1)** — `CVScore.extractFromJD(data, jdText)` normalizes
   the JD text, counts hits for every tag used anywhere in the data file
   (skillLines terms, bulletVariants variants, profileVariants), pulls out
   the maximum "N years/yrs" figure, checks for the spec's fixed
   qualification-term list (2:1, ACCA, CFA, etc.), and splits named tools
   into "have" (matches something in Derin's own skillLines) versus
   "confirmed missing" (matches `data.neverClaim`'s named tools — Salesforce,
   Alteryx, SSIS, FinBERT).
2. **Archetype scoring (5.2)** — `CVScore.pickArchetype()` scores every
   archetype (`sum of keyword weights for terms present`, highest wins,
   ties broken by the `priority` field, ascending = more preferred). The
   page always shows the winner, its score, and the top-3 matched terms,
   with a dropdown to override it manually — the override takes precedence
   over the auto pick until cleared back to "Auto."
3. **Content selection (5.3)** — with an archetype (auto-picked or
   overridden) and an extraction in hand, `js/assemble.js` now:
   - **Profile**: picks the highest-tag-overlap paragraph among the
     variants tagged for that archetype (tie → first-listed).
   - **Bullets**: every bullet group listed for an included role/project is
     now included — **this is a real change from Phase 3/4**, which only
     showed groups with `priority ≤ 2` as a page-fit stopgap. For each
     group, the variant with the highest tag-overlap with the JD is chosen
     (tie → first-listed), and the resulting bullets are then ordered
     within the role by that same score, highest first.
   - **Skills**: the categories an archetype lists are unchanged, in its
     order. Within a category, terms are reordered — JD-hit terms first,
     then everything else in file order — but **never dropped** for
     lacking a hit. Only `trimPolicy` (Phase 6) can drop a skill term, and
     only for page overflow.
   - With no JD pasted yet, every one of the above falls back to
     first-listed / file order — the exact same code path as a JD that
     matched nothing, not a separate fallback branch.

### Correcting something I said before starting this phase

I'd previously told Derin that Phase 5 would "bring the skills section back
down to size" and let the page-fit gate pass without manual trimming.
Re-reading spec section 5.3 literally while building this shows that's
wrong: skills are only ever **reordered**, never dropped for lacking a JD
hit. Phase 5 does not resolve the page-overflow problem — only `trimPolicy`
execution (Phase 6) can, and that needs a JD-scored model to judge
relevance against, which now exists as of this phase's `extraction` object.
Flagging this plainly here since a docs section further down (now fixed)
previously said the opposite.

### A consequence worth being direct about: the example CV overflows *more* now

Including every bullet group per role (not just `priority ≤ 2`) means
`role-tcs` now prints all 6 of its bullet groups instead of 3. On the
`graduate-programme` example with no JD pasted, that pushes the measured
overflow from 16px (end of Phase 4) to 94px. This is the correct, spec-
faithful behaviour, not a regression to fix by hand — spec 5.3 says
nothing gets dropped for content-selection reasons, only for
`trimPolicy`-driven overflow handling, which is Phase 6. Pasting a JD
narrows this somewhat (the overflow shrank back to 15px against the
`analyst-bi`-matching test JD used for verification, purely because that
JD reordered the model, not because anything was cut) but does not
guarantee a fit. **The download button will often be correctly disabled
until Phase 6 exists** — that is expected, not a bug in this phase.

### How this was verified

Playwright against a local server, five scenarios: (1) no JD pasted — all
6 `role-tcs` bullet groups present, file order, gates all pass except page
fit (documented above); (2) a synthetic "Data Analyst" JD — correctly
auto-picked `analyst-bi` (score 47) with top-3 terms `data analyst (10)`,
`analytics (7)`, `power bi (7)` matching the JD's own strongest hits, and
confirmed the reordering also changed which bullet floated to the top of
`role-tcs` (the "data quality"-tagged accuracy bullet, not file-first); (3)
manually overriding the dropdown to `finance-ops` — confirmed the override
takes precedence and the readout shows what the auto pick would have been;
(4) a synthetic confidentiality/GDPR-flavoured JD — confirmed `role-tcs`'s
bullets reordered so the confidentiality- and records-tagged groups rose to
the top, including a **within-group variant swap** (the "Excel daily"
group's second variant, tagged with confidentiality/data protection,
outscored its own first-listed variant and was chosen instead); (5)
clearing the JD back to empty — confirmed the model reverts to exactly the
same order as scenario 1, byte-for-byte, proving there's no leftover state
between JD edits. All four Phase 4 safety gates ran correctly throughout
(never-claim, dash, and provenance stayed green across every scenario;
page fit failed whenever the model genuinely overflowed, as it should).

Same sandbox caveat as every earlier phase: verification ran against
`index.test.html` (local library copies instead of CDN); `index.html` is
unchanged apart from the same `js/score.js` wiring and still points at CDN.

**Still open**: `/tests/golden/` has a README describing JD-in/CV-out
golden tests (spec section 10) but no actual JD text yet — only
`reference-output.docx`. Phase 5 was verified with synthetic JDs built from
the data file's own keyword vocabulary. If Derin can supply the real Davy /
Stripe / Bank of Ireland / Accenture job descriptions he applied against,
those should replace the synthetic ones for a proper selection-equality
check.

## Earlier: Phase 4 of the build order (history, superseded above)

> "Safety gates. Provenance, never-claim, dashes. Prove a gate blocks by
> deliberately breaking something." — build prompt, section 11, step 4.

New file: `js/verify.js`. Four gates now run on every rebuild of the
preview (`index.html`'s `updatePreview()`), matching build spec section 8
exactly:

1. **Never-claim scan** — case-insensitive match against `data.neverClaim`
   (SQL, machine learning, any TCS client name, "References available on
   request.", etc.).
2. **Dash scan** — any em dash (—) or en dash (–) anywhere in the rendered
   text.
3. **Provenance check** — every piece of free text in the content model
   must trace back to a *live object reference* into the parsed data file
   and match it exactly (see below — this is the substantial part of this
   phase).
4. **Page fit** — reuses Phase 2's own measurement; folded into the same
   pass/fail report.

**The download button is now wired to all four.** It's disabled, with the
reason shown, whenever any gate fails — not just while the data file is
still loading. This is a real behaviour change from Phase 3: the example
CV still overflows by 16px (Phase 5's job - see below), so **the download
button is currently disabled on the example CV**, correctly. The three
content gates (never-claim, dash, provenance) all pass on it cleanly.

### How provenance is checked, and why it's stronger than an id string

Section 8.3 says: "Every sentence in the output must be traceable to an id
in the data file. Assemble the document as a list of `{id, text}` pairs
and assert that each text matches the data file exactly."

Rather than hand-maintaining a separate id string per fact (which could
itself drift from the truth, or just be typed wrong), every block builder
in `js/assemble.js` now attaches a `_prov` object to each block that stores
a **live JavaScript object reference** into the parsed data file — the
literal object `data.facts.roles[...]` or `data.bulletVariants[...].variants[...]`
points at, not a copy of its text. `js/verify.js` re-reads that reference
at verify time and compares it against what the block actually displays.
This catches two different things an id-string scheme would not:

- A block with **no** `_prov` entry for a text field it renders — this is
  exactly what would have caught Phase 3's finding #2 (hand-typed
  sentences with no data-file backing at all) automatically, instead of by
  reading every paragraph by hand.
- A block whose text has drifted from what's still at that reference —
  e.g. a future bug that mutates text after reading it from the data file.

A handful of fields are fixed UI chrome rather than claims about Derin —
the "Modules: " label prefix on the education module list is the one
example in the current model. Those are recorded as an explicit `prefix`
on the provenance entry (so they're still part of what gets checked, not
silently exempted), documented in `assemble.js`'s header comment. Section
headings are **not** treated as chrome, even though words like "PROFILE"
look like fixed labels — every heading is traced back to whichever
archetype's `sectionOrder` array it actually came from, because that array
is itself data-file content.

### Proving the gates actually block (per the build order's own instruction)

Ran a Playwright script that: loaded the real model, confirmed all three
content gates pass cleanly on it (no false positives from the new
instrumentation — worth checking on its own), then deliberately injected
four different broken blocks one at a time — an em dash inside otherwise
correctly-provenanced text, a banned term ("SQL") inside otherwise
correctly-provenanced text, a hand-typed sentence with no provenance at
all, and a sentence whose provenance points at text that no longer matches
it — and confirmed each broke exactly the gate it should have (and only
that gate stayed broken once the others were fixed), with the download
button disabled and the specific reason shown every time. Restored the
real model and confirmed the three content gates recovered. Finally,
built a temporarily-trimmed model that fits on one page with no tampering,
confirmed **all four** gates pass and the download button re-enables, and
completed a real download to prove the happy path still works end to end
with the gates wired in — not just that they block.

### What Phase 4 does not do

The spec's overflow behaviour ("offer to drop the lowest-priority included
bullet... and re-measure") isn't automated yet — that needs `trimPolicy`
actually executed against a JD-scored model, which is Phase 5/6 territory.
Today, an overflow just blocks the download and reports the size of the
overflow; Derin drops content by hand (the existing `excludeFactIds`
mechanism) the same way he did in Phase 3.

## Earlier: Phase 3 of the build order (history, superseded above)

> "Data file loaded. Same output, now driven by `cv-generator-data.json`." —
> build prompt, section 11.

**"Same output" turned out not to mean byte-identical, and that's the
important finding of this phase**, not a footnote. There is still no JD
input or scoring (that's Phase 5) — `js/assemble.js` builds the CV with an
explicitly fixed archetype (`graduate-programme`) instead of a detected one,
using rules taken directly from the spec's own stated defaults (see the
comment block at the top of that file). But once content had to come from
the data file instead of being retyped by hand, three real, previously
invisible problems surfaced. All three are fixed; none were papered over.

### 1. A genuine provenance bug: the BMS module list nearly printed in full

`edu-bms` carries all 13 modules for keyword matching, but
`CV-fact-bank.md` is explicit that this list must never print on a CV —
only the MSc modules print. Generic, data-driven code doesn't know that
distinction unless the data says so, and the first version of
`buildEducation()` printed both. Fixed by adding a `printModules` flag to
each education fact (`true` on `edu-msc`, `false` on `edu-bms`, both in
`cv-generator-data.json`) and defaulting to *not* print when the flag is
missing — the safe direction for a fact nothing has explicitly cleared for
output. This is exactly the class of mistake the data file's provenance
principle exists to catch, and it's worth being direct about: it would have
gone out the door if the PDF hadn't been read after generating it, not just
the paragraph list.

### 2. Some Phase 1/2 wording wasn't actually backed by the data file

A few sentences hand-typed into the original `build_accenture.js` don't
exist verbatim anywhere in `cv-generator-data.json` — meaning, under the
spec's own golden rule, they should never have been printable. Now that
everything is pulled from the file instead of retyped, the wording changed
in a few places:

- **Profile paragraph** now uses `prof-grad` (the first `profileVariants`
  entry matching `graduate-programme`), not the old hand-typed text, which
  was closer to `prof-consulting` (a second, also-valid match, but not the
  first-listed one — see assemble.js's tie-break comment).
- **TCS accuracy bullet** now reads "...in a financial services back
  office..." (`b-accuracy-fs`) — no stored variant matches the old
  hardcoded sentence exactly.
- **TallyPrime certification line** now reads "Computerised Accounting in
  TallyPrime with GST, Grade A++" (the data file's actual `display` text),
  not the shorter "TallyPrime with GST, Grade A++" that was hand-typed.

None of these are wrong — they're all genuine, approved data-file text —
but they're a visible reminder that the pre-JSON hand-built CV was, in a
few places, running slightly ahead of what the data file could actually
back up.

### 3. The browser-based page-fit measurement understated real overflow

The most substantial finding. With the fuller (unfiltered — see below)
skills section, the browser preview measured 936px and reported **"104px
to spare."** The actual downloaded `.docx`, converted to PDF, **spilled two
lines onto a second page.** Chrome's Times New Roman line-wrapping doesn't
match Word/LibreOffice's exactly, and that drift compounds across every
wrapped line in the document — so a comfortable-looking browser number is
not proof the real file fits.

Fixed at the time with a documented safety margin (`FIT_SAFETY_MARGIN_PX =
120` in `js/preview.js`): the "fits" verdict checked against 120px less
than the true 1039.9px A4 limit, while the dashed boundary line in the UI
still marked the real page edge. 120px was chosen because it was large
enough to have correctly flagged this specific case, not because it had
been derived from font-metric measurements — a screening margin, not a
proof.

**Superseded, 17 Sept 2026 (third review pass).** The guessed-margin
approach above is gone, not just retuned. Its actual flaw wasn't the
number 120 — it was measuring a browser's HTML mirror at all, when every
sentence this app can print already exists as fixed text in the data file
at a fixed column width. That means a block's real height isn't something
to predict from Chrome's font metrics (or any other guess); it's something
to measure ONCE, offline, against the real renderer (LibreOffice, via
`tests/golden/measure-blocks.js`), store on the fact that produced it, and
sum at generation time (`js/pagefit.js`). `js/preview.js` no longer
measures fit at all — it only renders the on-screen mirror for Derin to
look at. Cross-checked against five real, whole, trimmed documents:
predicted sums land a stable 12–15px under the true measured content
height (LibreOffice's own small rounding drift against the character-width
table), so the runtime gate holds back one real line's height as its only
allowance — not a guessed buffer, a measured one. `tests/golden/
page-fit-fixtures.json` (the five-CV calibration set this section
originally described) and the three-state fits/uncertain/overflow UI plan
it was collected for are both gone — the file's been deleted, not just
unused. Converting to PDF and looking at it — which the spec already has
Derin doing before sending anything — stays the real check regardless.

### Why the current example CV shows "overflows" (this is expected)

At the time, nothing filtered the SKILLS section down to what a specific
job ad actually asks for — `buildSkills()` printed *every* term in each
included category, an honest "no opinion yet" default, not a bug.

**Correction, added once Phase 5 was actually built**: the sentence that
used to be here said Phase 5 would "shrink the skills section back down to
a relevant subset." That was wrong — re-reading spec 5.3 literally, skills
are only ever *reordered* by JD overlap, never dropped for lacking a hit.
Phase 5 does not resolve this overflow; only `trimPolicy` execution (Phase
6) can. See the Phase 5 status section above for the full correction.

### What's actually new in the code

- `js/data.js` — loads `cv-generator-data.json` via `fetch()`.
- `js/assemble.js` — builds the content model from the loaded data plus an
  explicit archetype id (no scoring yet). Selection rules used where the
  spec doesn't have a scoring engine yet to decide (bullet-group priority
  ≤2, first-listed variant on ties, all terms in a selected skill category)
  are all taken directly from the spec's own stated defaults — see the
  file's header comment for the reasoning behind each one.
- `js/render-docx.js` / `js/preview.js` — `contact()` and its preview
  equivalent now accept the data file's `{text, link}` contact-item shape
  directly (the link is authoritative, no more regex-guessing at which
  items are hyperlinks) alongside the old plain-string form for backward
  compatibility.
- `js/content-accenture.js` — **removed.** Its whole purpose (proving the
  content-model idea) is superseded by real data-driven assembly; keeping a
  parallel hand-typed copy around risked exactly the kind of silent drift
  from the data file that finding #2 above just demonstrated.
- `cv-generator-data.json` gained: `facts.projects` (was singular
  `facts.project` — restructured so a second project is a new list entry,
  not a schema change, per Derin's request), `style.spacingAfter.certItem`
  / `certBody` (two spacing values that were bare numbers in the old
  hand-built content instead of coming from `style` like everything else),
  and `printModules` on both education facts.

### How this was verified

1. Loaded the real data file in a real Chromium browser via Playwright,
   built the model, and downloaded the `.docx` through the same
   `blocksToChildren()` path as Phase 2.
2. Read every paragraph out of the downloaded file with `python-docx` and
   checked it against the data file by hand — this is what caught the BMS
   module leak (finding #1) before it reached this document, not after.
3. Zero em/en dashes, confirmed with a regex scan.
4. Converted to PDF and actually looked at both the content and the page
   count — this is what caught finding #3. The measurement gap was found by
   checking the real output, not assumed away.
5. Forced a 40-bullet overflow again (same sanity check as Phase 2) to
   confirm the safety-margin change didn't break the "does the gate
   actually fire" property.

Same sandbox caveat as Phases 1–2: verification ran against
`index.test.html` (local library copies instead of CDN); the real
`index.html` is unchanged apart from the same data-loading wiring and still
points at CDN.

### Addendum, 13 Sept 2026: preview margins + a trimPolicy gap

Two follow-up items from feedback on the Phase 3 example CV, still inside
Phase 3's scope (no new phase, no scoring added):

**The preview had no visible page margins.** The actual `.docx` always had
correct margins (confirmed by measuring both the reference CV Derin sent
and this app's own generated PDF with PyMuPDF - both landed within a point
of the spec's 850/850/660/580-twip values). The problem was screen-only:
`#preview-container` had zero padding, so a screenshot showed text running
edge to edge even though the real file didn't. Fixed by adding a
`PAGE_MARGIN_PX` constant to `js/preview.js` - the same `MARGIN` object
`js/render-docx.js` already uses for the real file, just converted to
pixels - and a new `#preview-page` wrapper `div` that gets that padding
applied from JS (not hardcoded a second time in CSS, so it can't drift).
The dashed "A4 boundary" line moved inside that wrapper and its position
was adjusted to still mark the true text-height limit. Nothing about the
downloadable file changed; this only changes what the on-screen preview
looks like. Verified: repeated the same paragraph-count, dash-scan, and
PDF-conversion checks as the rest of Phase 3 - unchanged (still 37
paragraphs, zero dashes, margins still 850ish twips), confirming this was
additive and touched nothing that produces the actual file.

**`trimPolicy.order` had no step for dropping the whole CERTIFICATIONS
section.** Derin asked for the one-page rule to escalate: drop Blarney
first (already covered - it was already the lowest-priority optional role
under existing step 1), and *if Certifications aren't relevant to the
specific job description*, drop that whole section next, before cutting
individual bullets. Added as new step 2 in `cv-generator-data.json`'s
`trimPolicy.order` (old steps 2-5 renumbered to 3-6). **This is a data-file
policy addition only - not implemented in code.** Judging "relevant to the
JD" needs the matching engine (Phase 5/6), which doesn't exist yet. Writing
a fake relevance check now to make this "work" today would be exactly the
kind of made-up behavior the build spec exists to prevent, so it's
documented and deferred instead.

## What's not built yet

**Fit check (step 6)**: a BLOCKED/STRETCH/GOOD verdict with real findings
quoting the ad, the `w-sql` → `sqlRequired` mapping for the SQL-gap
cover-letter block, and — importantly — this is where `trimPolicy` actually
gets *executed* against the JD-scored model from Phase 5, which is what
will let the page-fit gate pass without manual trimming and what
"relevant to the JD" needs before the Certifications-drop trimPolicy step
can run. **Cover letter (step 7). Deployment (step 8)** — repo name is
locked in as `cv-generator` (GitHub Pages URL will be
`derinyesudas.github.io/cv-generator`); the deployment steps themselves
haven't been run yet.
