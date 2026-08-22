# Tulamben Dive Window

A 48-hour planning forecast for dive sites from Kubu and Tulamben to Amed,
northeast Bali. It combines Open-Meteo marine and weather data with per-site
calibration and coastline geometry to estimate dive conditions, and shows its
working for every number it produces.

## Run locally

No build step, no API key, no backend:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## What it shows

- **All eight sites in coast order**, with one switch to read every score either
  absolutely (comparable between sites) or relative to that site's own ceiling,
  so you can tell "good day here" from "good site".
- **A score you can take apart.** Open any lever — swell, current, runoff, wind —
  to see its inputs, each step of the calculation, and the site constant involved.
- **Separate visibility and effort readings**, because a strong drift in clear
  water is a good dive for some people and a non-starter for others.
- **Weather separately from water**: air temperature, wind, rain, cloud, UV,
  sunrise and sunset.
- **A scrub bar you can drag through the next 48 hours**, banded by day and
  night, marked at each midnight and labelled with the day.
- **The tide curve built into that bar**, so you scrub the days and the tide
  together, with highs and lows labelled and the present marked. Tide heads the
  page because it is the same everywhere on this coast — under 0.03 m of
  difference between sites.
- **Arrows for current, swell and wind** showing travel direction and exact
  bearing.
- **Light and dark themes** following the device setting, and a layout built for
  phones.
- **A 48-hour strip** per site so the good window is visible rather than something
  you scrub for.

## How it works, briefly

Swell is gated by how much energy actually reaches each shore (ray-cast fetch
against the OSM coastline, plus refraction), then converted to near-bed orbital
velocity via linear wave theory — so period and depth matter, not just wave
height. Current is scaled by site topography and the observed tidal range.
Runoff, wind direction and fetch do the rest.

Full detail in [`docs/`](docs/): [scoring](docs/scoring.md),
[data sources](docs/data-sources.md), [the current field](docs/current-field.md),
[architecture](docs/architecture.md), and the [analysis this rework came from](docs/plan.md).

## Limitations, honestly

**This is a planning aid, not a safety forecast.**

- **Visibility is inferred, never observed.** There is no turbidity sensor
  anywhere in this pipeline.
- **The marine model's nearest wet grid cell is 15–21 km offshore.** Several
  sites share a single cell, so differences between them come from hand
  calibration rather than from separate forecasts. The app reports the
  displacement for each site rather than hiding it.
- **Weather is one grid cell for the whole coast.** Land and sea breezes off
  Agung are not resolved.
- **Site current is interpolation, not a model.** The offshore vector is
  redistributed around the real coastline and bathymetry; it respects mass
  conservation but cannot produce eddies or flow separation.
- **Internal waves and the sudden cold down-currents at the Drop-Off are
  invisible** to this and to every other public model.

Confirm with a local operator before you get in the water.
