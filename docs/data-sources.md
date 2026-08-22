# Data sources

Everything is public, keyless, and CORS-enabled, which is why the widget needs no
backend.

## Live: Open-Meteo

| | endpoint | what it gives |
|---|---|---|
| Marine | `marine-api.open-meteo.com/v1/marine` | waves (3 partitions), surface current, sea level, SST |
| Weather | `api.open-meteo.com/v1/forecast` | air temp, wind, rain, cloud, UV, sunrise/sunset |

Both requests use `timezone=Asia/Makassar`, `past_days=2`, `forecast_days=4`, so
the two series are index-aligned. `api.js` asserts this on load rather than
trusting it — a silent misalignment would shift every reading by hours.

`past_days=2` matters: rainfall history is summed over the 24 hours *before* the
selected hour, and without past days that sum silently truncated to however many
hours had elapsed since local midnight.

All eight sites go in one marine request (Open-Meteo accepts comma-separated
coordinates and returns an array). Times are wall-clock strings parsed explicitly
as UTC+8.

### The resolution problem, stated plainly

The marine model snaps each request to its nearest **wet** grid cell. Its land
mask is coarse enough that on this coast every site resolves far offshore:

```
liberty  -> 20.9 km @ 037 deg     seraya  -> 20.1 km @ 091 deg
coral    -> 21.0 km @ 037 deg     batu    -> 20.8 km @ 092 deg
dropoff  -> 21.0 km @ 036 deg     jemeluk -> 15.1 km @ 106 deg
kubu     -> 19.7 km @ 045 deg     pyramid -> 15.8 km @ 107 deg
```

Eight sites collapse to **three distinct wave values and two distinct current
values**. Liberty, Coral Garden, the Drop-Off and Kubu are literally the same
cell.

This is not a bug to fix — no public product resolves this coastline. It is a
constraint to be honest about, so `api.js` records the displacement per site and
the site panel's provenance section reports it. What the widget actually is:
**regional forcing multiplied by local site calibration.** That is a respectable
thing to be, and stating it is more useful than implying site-level forecasts.

The weather model is no better: all eight sites resolve to a single cell at
(-8.330, 115.626). Per-site weather is not achievable at any public resolution,
so one central sample is used for the whole area and the weather panel says so.
Land and sea breezes off Agung are entirely unresolved.

Alternative wave models were checked. `gwam` puts a cell 10.6 km away rather than
20.9 km; `ewam` has no coverage; `meteofrance_wave` and `ecmwf_wam025` are no
closer. Running two models and using their spread as a confidence measure would
be a better basis than the current heuristic, and is the obvious next step.

## Baked: OSM coastline

Fetched once from Overpass, stored as `data/coastline.json` (~27 KB, 6 ways,
1213 vertices). Used for two things:

**Shore normals.** OSM winds coastline ways with land on the left, so the seaward
normal is the segment direction rotated 90 degrees clockwise. Averaged over every
segment within ~300 m of the site, inverse-distance weighted:

```
kubu     55 deg     seraya   47 deg
liberty  60 deg     batu     46 deg
coral    48 deg     jemeluk  22 deg
dropoff  19 deg     pyramid 356 deg
```

Cross-checked against an independent PCA of nearby vertices; the two methods
agree within a few degrees. All point north-to-northeast, correct for Bali's NE
coast.

**Directional fetch.** A 36-bin (10 degree) table per site, ray-cast out to
40 km. Along the shore normal every site reads 40 km; directly behind, 0.1–0.5 km.
This is what lets the model know that an ESE swell is partly blocked by the Amed
peninsula at Tulamben, while a NE swell arrives unobstructed.

## Baked: GEBCO bathymetry

`data/bathymetry.json` (~12 KB) — a 56x51 grid at 0.004 degrees (~445 m),
pulled from `api.opentopodata.org/v1/gebco2020`. Feeds the current-field solver's
land mask and depth weighting.

**GEBCO cannot resolve dive sites.** At ~450 m it reports −85 m at a point 108 m
from shore, where the Liberty actually sits in 5–30 m — the cell averages in the
deep water just offshore. It is adequate for the regional shelf and slope that
shape the current field, and useless for site depth. There is no public
high-resolution bathymetry for Bali, so `bedDepthM` and `depthM` are hand-set
from dive-guide knowledge in `tools/bake-geodata.py`.

## Considered and rejected

**CMEMS** (`GLOBAL_ANALYSISFORECAST_PHY_001_024`) has real currents at ~50 depth
levels. It requires registration, is not browser-CORS-friendly, and at 1/12
degree (~9 km) still returns a mid-strait value. Taking on a backend for data
that still does not resolve the site is a bad trade. Depth-resolved current was
explicitly scoped out; see `plan.md` for the alternatives if it is revisited.

## Rate limits and etiquette

Overpass and opentopodata are free community services. `tools/bake-geodata.py`
sleeps 1.1 s between requests and sets a real User-Agent. The bake is a one-off —
do not put either service in the browser request path.

Open-Meteo is refreshed every 10 minutes while the tab is open, and the "now"
index is re-checked every minute so a long-lived tab does not drift.
