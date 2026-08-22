# Architecture

A static, dependency-light browser widget. No build step, no backend, no package
manager. Leaflet is the only runtime dependency and it comes from a CDN.

## Running

```bash
python3 -m http.server 8000     # file:// will not work -- ES modules need HTTP
```

Then open `http://localhost:8000`.

Before handing off changes:

```bash
for f in app.js src/*.js; do node --input-type=module --check < "$f" || echo "FAIL $f"; done
git diff --check
```

Syntax checks pass on plenty of broken layouts, so look at the page too. Chrome is
at `/usr/bin/google-chrome-stable`:

```bash
google-chrome-stable --headless=new --no-sandbox --disable-dev-shm-usage \
  --window-size=1440,1000 --virtual-time-budget=12000 \
  --screenshot=/tmp/shot.png http://127.0.0.1:8000
```

Browsers cache ES modules aggressively. If a change does not appear, serve on a
different port rather than trusting a reload.

## Files

```
index.html            layout shell; every dynamic region is filled by src/ui.js
styles.css            theme, layout, and a local copy of Leaflet's structural rules
app.js                entry point: state, event wiring, refresh loop

src/sites.js          GENERATED -- site table (calibration + derived geometry)
src/api.js            Open-Meteo access, sampling, model-cell bookkeeping
src/physics.js        wave theory, directional exposure, tide analysis. Pure functions
src/scoring.js        the score, decomposed into inspectable factors
src/currentfield.js   coastline-aware current interpolation (see current-field.md)
src/charts.js         scrub track (tide, day/night), score bar, 48 h strip
src/ui.js             all rendering
src/map.js            Leaflet map, decluttered site pills on a canvas overlay

data/coastline.json   GENERATED -- OSM coastline (~27 KB, bake-time input only)
data/bathymetry.json  GENERATED -- GEBCO depth grid (~12 KB)

tools/bake-geodata.py rebuilds all three generated files
docs/                 this documentation
```

## Data flow

```
tools/bake-geodata.py  ──(once, offline)──>  data/*.json + src/sites.js
                                                    │
Open-Meteo (marine + weather) ──> api.js ──> sample() ──> scoring.js ──> ui.js
                                                    │                      │
                                              currentfield.js ──> map.js ──┘
```

`app.js` holds all mutable state in one `state` object. Everything else is either
a pure function or a render function that takes an explicit context object. There
is no framework and no observable/reactive layer: any state change calls
`render()`, which rebuilds the affected regions from scratch.

## Regenerating the static geodata

```bash
python3 tools/bake-geodata.py
```

Needs network, takes about a minute (opentopodata's public API allows one request
per second). Site calibration constants live at the top of that script, not in
`src/sites.js` — editing the generated file directly will be overwritten.

## Rendering decisions worth knowing

**Leaflet's CSS is duplicated locally.** The CDN stylesheet has failed
intermittently, and without those rules transformed tiles and markers fall into
normal document flow. The block at the top of `styles.css` is a deliberate
fallback. Do not remove it without vendoring the full Leaflet CSS.

**Site markers are drawn on canvas, not as Leaflet markers.** Four Tulamben sites
sit within ~600 m of each other and collided into an unreadable blob at default
zoom. The canvas layer runs a pairwise repulsion pass so pills push apart and
connect back to their true coordinate with a leader line. The canvas is
`role="img"` and explicitly not the accessible interface — the site list carries
the same information and is keyboard navigable.

**The canvas is kept in sync with the view by hand.** Leaflet moves its own
panes; ours only follows because we make it. Panning repositions the canvas *and*
repaints it — repositioning alone pins it to the viewport while the pixels on it
still belong to the previous view, so the pills appear to float free of the
coast. Zooming is worse: Leaflet scales its panes with a CSS transform for the
duration of the animation, so container coordinates are meaningless until it
lands. The canvas rides the same transform on `zoomanim` (the arithmetic
Leaflet's own vector renderer uses) and repaints at `zoomend`.

**The time bar is patched, not rebuilt.** `renderTimeBar` creates the range input
once and only writes its `value` afterwards; the header and the scrub track are
the parts whose innerHTML is replaced. Re-creating the input destroyed the
element under the pointer on the first `input` event, which turned every drag
into a single step — the whole track was unusable as a scrubber.

**The scrub track is HTML, not one SVG.** Text inside a full-width SVG has to be
stretched with `preserveAspectRatio="none"` and comes out visibly distorted, so
only the tide curve is SVG; day/night bands, midnight ticks, day names, high and
low labels and the cursor are absolutely positioned elements at percentages of
the track. The slider sits on top, fully transparent with a hairline thumb, so
the drawn cursor lands at the exact fraction of the track rather than wherever a
native thumb would.

**Tide lives in the time bar, not the site panel.** The eight sites resolve to
three marine cells whose sea level differs by at most 0.03 m against a ~1.1 m
range, so one curve is honest for the whole coast — and it belongs next to the
control that moves through time. Scoring still reads each site's own series.

**The current field solve is debounced.** It takes ~120 ms, which is too slow to
run on every slider tick, so scrubbing re-renders instantly and the field
catches up ~140 ms after the last change.

**Progressive disclosure uses native `<details>`.** Every score lever is
keyboard-reachable and screen-reader announced without extra scripting.

**Theming is token-only.** `styles.css` defines the dark palette on `:root` and
overrides *only* the custom properties inside
`@media (prefers-color-scheme: light)`. There is no in-app theme switch — the
device setting decides. The canvas map layer cannot read CSS, so it pulls
`--pill-bg`, `--pill-ink`, `--leader` and the quality colours via
`getComputedStyle` at draw time, and swaps basemap tiles and its speed ramp on
the `prefers-color-scheme` media-query change event.

## Constraints to preserve

- No build step. If something needs compiling, it does not belong here.
- Keep the calls in the browser. They are CORS-enabled and keyless; a backend
  is only warranted if secrets, caching, rate limiting, or a non-CORS provider
  forces one.
- Keep the safety disclaimer and the provenance panel visible. The honesty about
  model resolution is a feature, not boilerplate.
