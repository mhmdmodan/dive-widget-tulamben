# Repository Guidelines

## Purpose and Current State

This repository contains a dependency-light browser widget for planning dives between Kubu, Tulamben, and Amed, Bali. It is a planning aid, not a navigation or dive-safety product. The UI forecasts the next 48 hours, plots eight sites, and explains a heuristic quality score.

The application is static: `index.html` defines the UI, `styles.css` contains the responsive theme and local Leaflet structural fallback rules, and `app.js` owns data retrieval, dive-site metadata, scoring, and rendering. `README.md` contains basic usage and limitations. There is no build system, package manager, backend, or automated test suite.

## Running and Validation

Serve the directory over HTTP; do not rely on `file://`:

```bash
python -m http.server 8000
```

Open `http://localhost:8000`. Before handing off changes, run:

```bash
node --check app.js
git diff --check
```

Visual validation matters because Leaflet failures can pass syntax checks. Chrome is installed at `/usr/bin/google-chrome-stable`. A useful headless check is:

```bash
google-chrome-stable --headless=new --no-sandbox --disable-dev-shm-usage \
  --window-size=1440,1000 --virtual-time-budget=12000 \
  --screenshot=/tmp/tulamben.png http://127.0.0.1:8000
```

Also test approximately `390x844` for mobile.

## Live Data Architecture

The browser calls Open-Meteo directly. This works without a backend because Open-Meteo permits cross-origin browser requests and requires no secret API key.

- Marine endpoint: `marine-api.open-meteo.com/v1/marine`
- Weather endpoint: `api.open-meteo.com/v1/forecast`
- Map layer: CARTO Voyager, derived from OpenStreetMap and visibly attributed
- Map library: Leaflet 1.9.4 loaded from unpkg

`loadForecast()` requests four calendar days so 48 hours remain available even late in the current day. It requests all site coordinates in one marine call and central-area weather in a second call. Times are returned in `Asia/Makassar`; `forecastDate()` explicitly parses them as UTC+8. Reloading obtains a new model run. The app does not currently poll or display the source model’s update timestamp.

Do not move these calls behind a backend unless secrets, caching, rate limiting, telemetry, or a non-CORS provider makes one necessary.

## Scoring and Visibility Logic

`SITES` contains fixed coordinates and calibration metadata: typical maximum visibility, wave/current sensitivity, runoff sensitivity, exposure, and descriptive context. Forecast conditions are live; these calibration values are not.

`calculate()` begins near 92/100 and subtracts penalties for:

- swell energy (`swell height × period modifier`) and site sediment sensitivity;
- current above 0.25 km/h and site current sensitivity;
- prior 24-hour modeled rainfall and runoff sensitivity;
- wind above 10 km/h and exposure.

Near-slack modeled tide adds a small bonus. Scores are clamped to 22–96. Estimated visibility starts at each site’s `maxVis`, then applies swell, rain, and strong-current penalties. This is an inference, not measured turbidity. Do not describe it as an observed or scientifically validated visibility forecast.

Driver explanations use `good`, `neutral`, or `bad` sentiment. The detail panel maps those to green, amber, and red borders. Thresholds for metric cards are defined in `renderSite()` and should remain consistent with scoring changes.

## Coordinates and Geographic Caveats

Published coordinates were used for USAT Liberty, Tulamben Drop-Off, Kubu/Boga Wreck, Seraya Secrets, and Jemeluk. Coral Garden, Batu Kelebit, and Amed Pyramids use conservative offshore approximations because public references are inconsistent or describe entry points instead of underwater features. CARTO coastline geometry is generalized, so a valid nearshore underwater coordinate can visually touch the shoreline at low zoom.

If coordinates are changed, verify them against multiple sources and inspect the rendered map. Never silently substitute a dive-shop address or shore-entry coordinate for an underwater feature.

## Important Rendering Decisions

Leaflet’s external CSS failed intermittently in Chrome, causing transformed tiles and markers to flow as normal elements. Essential pane, tile, marker, control, attribution, and tooltip rules are therefore duplicated locally at the top of `styles.css`. Do not remove these fallback rules without first vendoring the complete Leaflet CSS or proving reliable loading.

Map overlays use `z-index: 1100` so they remain above Leaflet panes. The `ResizeObserver` calls `map.invalidateSize()` when responsive layout changes. Marker tooltips intentionally use a dark opaque background because the base map is light.

## Safety and Future Improvements

Preserve the visible safety disclaimer and confidence explanation. Open-Meteo states that coastal current/tide resolution is about 8 km and wave resolution about 5 km; neither resolves wreck-scale circulation or sediment. Same-day local reports remain more reliable.

High-value next steps are automatic data refresh with “last updated” status, observed-condition submissions, calibrated historical validation, separate weather sampling for Amed, a tide curve, marker clustering/labels for the dense Tulamben group, and automated browser interaction tests.
