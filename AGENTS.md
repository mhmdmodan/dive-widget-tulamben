# Repository Guidelines

## Purpose and current state

A dependency-light browser widget for planning dives between Kubu, Tulamben and
Amed, Bali. It is a planning aid, not a navigation or dive-safety product.

The app is static: no build system, package manager, backend, or automated test
suite. Leaflet from a CDN is the only runtime dependency.

**Read `docs/` before changing behaviour.** It is short and current:

- `docs/architecture.md` — file map, how to run and validate, rendering decisions
- `docs/scoring.md` — the score, factor by factor, with calibration tables
- `docs/data-sources.md` — APIs, the model-resolution problem, baked geodata
- `docs/current-field.md` — the current interpolation behind the site readout
- `docs/plan.md` — the analysis that drove the 2026-08 rework

## Running and validation

```bash
python3 -m http.server 8000        # file:// will not work; ES modules need HTTP
for f in app.js src/*.js; do node --input-type=module --check < "$f" || echo "FAIL $f"; done
git diff --check
```

**Check in module mode, not `node --check <file>`.** Plain `node --check` parses
as a script and silently accepts things ES modules reject — a duplicate `const`
in the same block passed it and then blew up in the browser. Redirect the file
into `--input-type=module --check` instead.

Visual validation matters — Leaflet and layout failures pass syntax checks.
Chrome is at `/usr/bin/google-chrome-stable`; also check around 390x844.

Browsers cache ES modules hard. If an edit does not show up, serve on a different
port rather than trusting a reload. This wastes real time otherwise.

## Things that will bite you

**`src/sites.js` is generated.** Edit the calibration in
`tools/bake-geodata.py` and re-run it. Editing the generated file directly will
be silently overwritten.

**Marine and weather series must stay index-aligned.** Both requests use the same
`past_days`/`forecast_days`. `api.js` asserts alignment on load; if you change one
request's window, change both.

**Bearing conventions.** Wave and wind directions are "from"; current direction is
"toward". `shoreNormalDeg` points seaward, so a wave bearing near the shore normal
is head-on. An inverted `angleDiff` once flipped every directional calculation and
produced a plausible-looking but entirely wrong result — if sites stop
differentiating, check this first.

**Leaflet's structural CSS is duplicated in `styles.css`.** The CDN stylesheet has
failed intermittently. Do not remove that block without vendoring the full CSS.

**Markers must be redrawn on every `move`, not just repositioned.**
`reposition()` pins the canvas to the viewport; the pixels on it were projected
for the old view, so pills float in screen space while the basemap slides under
them. During a zoom the canvas rides Leaflet's own animation transform
(`zoomanim`) and repaints at `zoomend`; container coordinates are meaningless in
between.

**Never re-create the time slider.** `renderTimeBar` builds the `<input
type="range">` once and writes only its `value` on later renders. Rebuilding the
element on every render destroyed the input under the pointer on the first
`input` event, so dragging the track advanced exactly one hour and stopped. The
header and scrub markup are replaced freely; the input is not.

**The scrub geometry and the slider must agree.** Every mark on the track is
positioned at `(i - from) / (to - from)` of the width, so the input is styled to
a 2 px transparent thumb — a normal thumb inset would offset the value mapping
from the drawn cursor by half a thumb width at each end.

**CARTO basemaps live at `dark_all` / `light_all`,** not
`rastertiles/dark_matter` (404).

**Theming is token-only.** Override custom properties inside
`@media (prefers-color-scheme: light)` and nothing else; there is no in-app
theme switch, by design. The canvas layer reads `--pill-bg`, `--pill-ink`,
`--leader` and the quality colours via `getComputedStyle`, so any new
map-drawn colour needs a token, not a literal.

**`src/currentfield.js` is dormant.** Streamlines were removed, and then the HUD
stopped reading site-local speed off it, so nothing calls it at runtime and
`data/bathymetry.json` is no longer fetched by the app. Both are kept for a
possible bake-time use (deriving `currentSensitivity` from geometry instead of by
hand) — but note Jemeluk, where the 450 m mask *amplifies* current in a bay the
hand calibration correctly damps.

**Only one current magnitude on screen.** The map HUD shows current *direction*
only. Strength is site-specific — the same hour reads 0.2 kn at Coral Garden and
1.2 kn at Amed Pyramids — and when the HUD showed an interpolated speed while the
panel showed the scored one, the two disagreed by up to 2.2x on the same screen.
Direction is regional enough to show once; strength is not.

**Tide does not enter the score.** It is displayed only. See docs/scoring.md for
why the spring/neap multiplier was removed, and never write "slack" where the
data only supports "high water".

## Data architecture

The browser calls Open-Meteo directly — CORS-enabled, keyless. Do not move this
behind a backend unless secrets, caching, rate limiting, telemetry, or a
non-CORS provider makes one necessary.

Static geodata (`data/coastline.json`, `data/bathymetry.json`, `src/sites.js`) is
baked offline by `tools/bake-geodata.py`. Overpass and opentopodata are free
community services; keep them out of the browser request path.

## Scoring

`src/scoring.js`, physics in `src/physics.js`. Each factor returns its inputs and
the full derivation chain, and the UI renders that directly — so explanations
cannot drift from the numbers. There is no separate threshold table to keep in
sync; if you add a factor, give it the same `{points, tone, headline, inputs,
chain}` shape and it will document itself.

Two readings are maintained on purpose: an **absolute** score comparable across
sites, and a **relative** score against that site's own ceiling. Do not collapse
them — a site's quality cap is real information, and Seraya is an 18 m muck site
on its best day. But show only **one at a time**: the header switch drives every
surface through `display(result, mode)`. Putting both on screen at once is what
made this confusing the first time round.

The site list is in **coast order, not ranked**. Ranking implied a precision the
model does not have and buried the geography that actually helps you choose.
"Best next 48 h" lives with the per-site strip in the detail panel.

## Coordinates and geographic caveats

Published coordinates are used for USAT Liberty, Tulamben Drop-Off, Kubu/Boga
Wreck, Seraya Secrets and Jemeluk. Coral Garden, Batu Kelebit and Amed Pyramids
use conservative offshore approximations because public references are
inconsistent or describe entry points rather than underwater features.

If coordinates change, re-run the bake (shore normals and fetch are derived from
them) and inspect the map. Never substitute a dive-shop address or shore-entry
coordinate for an underwater feature.

## Safety

Preserve the visible disclaimer and the per-site provenance panel. The honesty
about model resolution is a feature. Specifically, do not describe estimated
visibility as observed or validated, and do not describe the site current
readout as a model or a forecast — it is coastline-aware interpolation of a value
sampled 15–21 km offshore.

## Worthwhile next steps

- Validate `bedDepthM` and `sediment` against logged visibility. These are the
  highest-leverage constants in the model and are currently unvalidated guesses.
- Use multi-model spread (e.g. `gwam` alongside the default) as a real confidence
  measure instead of the current heuristic.
- Observed-condition submissions, so the estimate can be checked against reality.
- Automated browser interaction tests.
