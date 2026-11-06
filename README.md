# ILR earned settlement modeller

A static page that shows when someone could qualify for indefinite leave to remain (ILR) on the 3, 5 and 10-year earned settlement routes. It compares three ways of counting a "year": tax year, calendar year and rolling 12 months.

It is illustrative only and is not immigration advice. The rules come from the government's consultation response *A Fairer Pathway to Settlement* (CP 1707, November 2026). They are announced policy, not yet Immigration Rules.

Past earnings can be entered in two ways:
- **Salary periods:** each pay change and its month.
- **HMRC tax-year totals:** a part-year figure from the route start to 5 April, one total for each complete tax year, a year-to-date figure and your current salary. In this mode, tax-year results are exact, and calendar-year and rolling results are estimates.

The full specification is in [REQUIREMENTS.md](REQUIREMENTS.md).

## Files

| File | What it does |
|---|---|
| `index.html` | Page structure and fixed content ("How we count", checklist, footer) |
| `styles.css` | Blue and white palette (CSS custom properties on `:root`) and layout |
| `config.js` | Thresholds, year counts, horizon, tax-year start and sources. **Edit this when the rules change.** |
| `engine.js` | Pure calculation functions with no DOM access: validation, monthly timeline, counted years, earliest date, lapses, explanations, CSV, share-link encoding |
| `ui.js` | Form, live results, SVG timeline and bar charts, local storage, share links, print |
| `tests/engine.test.js` | Acceptance tests (REQUIREMENTS.md section 12) and unit checks |
| `tests/engine.test.html` | Runs the same tests in a browser |

## Running locally

Open `index.html` in a browser. It works straight from disk, with no server needed.

The scripts are plain `<script defer>` files that share two globals, `ILR_RULES` and `ILREngine`, instead of ES modules. Browsers block ES modules on `file://` pages, which left the page with no interactivity. `config.js` and `engine.js` also export through `module.exports`, so Node can load them for the tests.

## Tests

```sh
node tests/engine.test.js
```

Or open `tests/engine.test.html` in a browser.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Settings → Pages** and choose **Deploy from a branch**.
3. Pick `main` and the `/ (root)` folder.

There is no build step. Everything a user types stays in their browser. Saved scenarios use `localStorage`, and share links put the inputs in the URL hash, which is never sent to the server.

## Updating the rules

Change the values in `config.js` (`routes`, `horizonYears`, `taxYearStartMonth`, `lastChecked`, `sources`), then re-run the tests. The acceptance tests assume the CP 1707 thresholds: £125,141, £50,271 and £12,571.
