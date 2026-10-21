# CV Generator

Static site (GitHub Pages, no server). Paste a job ad; get a verdict on whether to apply, a one-page CV, a cover letter and form answers, as PDF or Word. Deploy steps: `DEPLOY.md`.

## Using it

1. Paste the whole job ad (or press **Paste from clipboard**).
2. Read the **ready card** under the box: what was built, whether the ad rules you out, and whether each document passed every check. Anything to fix is marked 🔧.
3. Press **Download CV + cover letter (PDF)**. Read the letter once before sending.

Everything else on the page (the checks in detail, the section dropdowns, **Edit the text**, private settings) is optional.

## How it writes

No AI, no network, no key. It selects, orders and trims sentences that already exist in `data/cv-generator-data.json`. Nothing is composed at runtime.

- **Role type** (`js/score.js`): the job title weighs most (`archetypes[].titleKeywords`), then the ad's body words. An ad that matches nothing still gets a best-guess CV (`fallbackArchetype`) and says so.
- **Ad details** (`js/adinfo.js`): company, title, city, team, recipient and start date are read from the ad. A value the page filled in itself never blocks a download; one you typed does, so you see the problem.
- **CV** (`js/assemble.js`): profile, bullet wordings and skill terms are picked by how well their tags match the ad; analyst, consulting and graduate CVs lead with projects; part-time roles appear only when the ad asks for customer-facing or shift work (`conditionalInclude`) and are the first thing trimmed; experience lists relevant full-time work first, then newest first.
- **Letter** (`js/letterbuild.js`): an opening (several approved wordings, some per role type), one why paragraph chosen by the ad's themes, an optional quote of one duty line from the ad, two or three evidence paragraphs (alternative wordings of the same stories in `letterBlocks.evidenceVariants`), the approved gap sentence if needed, then a closing and sign-off. Where several wordings fit equally, a fixed rule on company and role picks one, so the same ad always gives the same letter but two applications rarely read alike. A letter never tells the same fact twice (`FACT_MARKERS`). Quote frames that say you have done the work are hand-pick only.
- **Checks** (`js/verify.js`): never-claim terms, dashes, provenance (every sentence traces to the data file), one-page fit, verbatim quotes, and a fact check on anything typed into **Edit the text**.
- Entries marked `_unmeasured` have no offline-measured height; page fit wrap-simulates them (`js/pagefit.js`).

## Layout

- `index.html` is the deployable page; `index.test.html` is the same page plus a test hook the Playwright suites drive.
- `js/` is loaded by script tags in order; `scripts/build-site.mjs` bundles and minifies them for Pages.
- Older build history is in git (`git log -p README.md`) and the claude.ai Project's decision log.

## Tests

`npm install` (Playwright), then serve the repo root on port 8199 and run with `PW_CHROMIUM` pointing at a Chrome or Chromium executable:

- `node tests/golden/run-golden-tests.mjs http://localhost:8199/` (390 checks)
- `node tests/pickers.test.mjs`, `node tests/theme.test.mjs`, `node tests/adinfo-ui.test.mjs`
- Plain Node, no browser: `node tests/adinfo.test.mjs`, `node tests/hardreq.test.mjs`

`tests/pdf.test.mjs` also needs Python with pdfplumber and a second server on port 8299.
