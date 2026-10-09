# Deploying

The live site is https://derinyesudas.github.io/cv-generator/.

## How a change goes live

1. A commit is pushed to `main` from the Windows clone, with Derin's own
   git login. No GitHub credential is ever given to Claude.
2. GitHub runs `.github/workflows/deploy-site.yml`. It builds `_site/` with
   `scripts/build-site.mjs` and publishes it.
3. A minute or two later the site serves the new version. The app bar shows
   the data file's version ("Data file v... loaded").

If the build finds a problem (a file the page needs is missing, or the
published data file fails the app's own validation), the run fails, shows
a red cross in the repository's Actions tab, and the live site stays as it
was.

## What is published

Only what the page loads: `index.html`, `favicon.svg`, `css/`, `fonts/`
and `lib/` (with their licence texts), the page's scripts combined into
one minified file (`js/bundle.js`), and `data/cv-generator-data.json`
without its `_` notes. Tests, notes, scripts and documentation stay in the
repository and are not published. The page asks for the bundle, the
stylesheet and the data file by a content stamp (`?v=`), so after a push a
browser never runs the new page with an older copy of any of them.

The minifier (esbuild, pinned version) is fetched with `npx` during the
build. If it can't be fetched, the build publishes the combined scripts
unminified and says so in the run's log; the site works the same.

## One-time setting

On github.com, in the repository: Settings > Pages > Build and deployment >
Source: **GitHub Actions**. Until this is set, GitHub publishes the whole
repository as it is, and the workflow cannot publish.

## Checking a build before pushing

`node scripts/build-site.mjs` builds `_site/` locally (nothing to install
beyond Node; the minifier is fetched by `npx`); serve that folder with any
static file server to try it.

## Private settings

Salary figures, the referee's name, the phone number, the detailed permission wording and the client names on the never-claim list are never in the repository (keys: salaryRanges, refereeName, contactPhone, permission, formAnswers, neverClaimExtra). They are
entered under "Change sections and settings > Private settings" and kept only
in that browser. A `private-overrides.json` file (shape:
`data/private-overrides.example.json`) can be imported there instead.
