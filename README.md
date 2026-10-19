# CV Generator

Static site (GitHub Pages, no server). Paste a job ad, get a verdict on whether to apply, a one-page CV, a cover letter and form answers, as PDF or Word. Deploy steps: `DEPLOY.md`.

## How it writes

No AI, no network, no key. It selects, orders and trims sentences that already exist in `data/cv-generator-data.json`, with page fit measured offline or, for entries marked `_unmeasured`, wrap-simulated (`js/pagefit.js`).

- **Letter:** opening (wording picked by a fixed rule on company and role), why-this-role (quotes a line from the ad), up to three evidence paragraphs chosen by how well their tags match the ad (the third only if it fits one page), the approved gap sentence if needed, then the closing paragraph and signature.
- **Edit the text** (sidebar): type over the CV profile or the letter body. `js/edits.js` holds the edit; `js/verify.js` gate 6 rejects any figure or capitalised name not in the fact bank or the ad, and the never-claim, dash and one-page checks still run. "Back to automatic" drops the edit.

## Layout

- `index.html` is the deployable page; `index.test.html` is the same page plus a test hook that the Playwright suites in `tests/` drive.
- `js/` is loaded by script tags in order; `scripts/build-site.mjs` bundles them for Pages.
- Older build history is in git (`git log -p README.md`) and the claude.ai Project's decision log.

## Tests

Serve the repo root (`python3 -m http.server 8199`, and `8299` for e2e/PDF) and run the files in `tests/` with Node and Playwright. The suites predate the Claude step and do not cover it.
