# Scoring

Lives in `src/scoring.js`, with the physics in `src/physics.js`. Every factor
returns the full chain that produced it, so the UI can open any lever and show
inputs, each transformation step, and the site constant involved. If you change a
number here, the explanation in the UI updates with it — there are no separately
maintained threshold tables.

## Two readings, deliberately

**Absolute score** answers *where is the best dive today*. It is comparable
across sites and is what the map pills, the site list and the score ring show.

**Relative score** answers *is this a good day here* — the absolute score as a
fraction of that site's own ceiling.

They are kept separate because a site's quality cap is real information. Seraya
Secrets is an 18 m muck site; on its finest day it is still an 18 m muck site.
Normalising that away would hide something a diver needs to know.

Only **one** of the two is on screen at a time. A single switch in the header
flips the map pills, the site list and the score ring together, via
`display(result, mode)` in `scoring.js` — one function decides what a score
reads as, so the surfaces cannot disagree. Showing both at once was the
confusing part: two numbers for one site invited the reader to work out the
relationship themselves.

The score bar follows the mode too. In absolute mode it spans 0–100 and ends in
a hatched tail for the points the site cannot reach; in relative mode it spans
the site's own ceiling, so that tail simply does not exist. Bar segments, the
key beneath, and the lever accordions all use the same per-factor colour, so
"Swell & sediment −12" is visibly the same object in all three places.

## Starting budget

Each site starts from a base set by how good it can ever be:

```js
siteBase(site) = clamp(68 + 27 * (maxVis - 17) / 14, 66, 96)
```

| site | maxVis | base / ceiling |
|---|---|---|
| Batu Kelebit | 31 m | 95 |
| Tulamben Drop-Off | 30 m | 93 |
| Jemeluk Bay | 28 m | 89 |
| Coral Garden / Amed Pyramids | 27 m | 87 |
| Kubu / Boga Wreck | 26 m | 85 |
| USAT Liberty | 25 m | 83 |
| Seraya Secrets | 18 m | 70 |

A perfect day anywhere still reads Good or better; a perfect day at Batu reads
better than a perfect day at Seraya, which is correct.

## The four factors

### Swell and sediment — usually the dominant term

What clouds a site is not wave height at the surface but **near-bed orbital
velocity**, which depends on height, period, *and* depth. Linear wave theory:

```
u_b = pi * H / (T * sinh(kd))          with  omega^2 = g k tanh(kd)
```

The wavenumber uses Guo's (2002) explicit approximation, accurate to <0.2% at all
depths with no iteration. This is why a 1.5 m / 6 s chop does almost nothing at a
20 m bed while a 1.0 m / 14 s groundswell stirs it.

Before that, wave height is gated by **directional exposure** — how much
open-water energy actually reaches this shore from that bearing:

```js
open   = clamp(fetchKm(bearing) / 12, 0, 1)   // ray-cast against the real coastline
obliq  = cos(theta) > 0 ? sqrt(cos(theta)) : 0 // theta = angle off the shore normal
wrap   = 0.12 * max(0, cos(theta / 2))         // diffraction round a headland
exposure = clamp(open * (obliq + wrap), 0.02, 1)
```

The square root softens pure cosine because refraction turns waves shoreward. The
`wrap` term stops a shadowed site reading as a hard zero. `fetchKm` is a 36-bin
table baked per site by ray-casting the OSM coastline out to 40 km.

This term is what makes the sites differ on the same forcing. Both wave
partitions (swell and wind wave) are evaluated and the more damaging one wins —
the old code silently dropped the wind wave.

Penalty: `min(48, suspended * 165)` where `suspended` is the settling state
below, and `u_crit = 0.09 / sediment` — finer, lighter substrate moves sooner.

#### Settling memory

Sediment does not fall out of the water column the moment the swell drops.
Scoring an hour on that hour's forcing alone reports a clean afternoon after a
rough morning — precisely when the water is worst. So the excess orbital velocity
is treated as a source term driving a state that decays:

```js
suspended[i] = max(source[i], suspended[i-1] * exp(-1 / tau))
```

`max` rather than a symmetric filter because the physics is asymmetric: stirring
reaches quasi-equilibrium within the hour, settling takes hours. A smoothing
filter would smear the leading edge of a swell event that arrives quickly.

```js
tau = clamp(2.0 + 3.6 * sediment, 3, 9)   // hours
```

Coral Garden's cobble (0.85) clears in about 5 h; Seraya's very fine black sand
(1.35) takes nearly 7. Stokes settling puts fine sand (~125 µm) on the bed within
the hour and silt (~20 µm) many hours later, and the murk is the fine tail of the
mix, so a few hours is the right order of magnitude — but the number is a
calibration, not a measurement. It is the single most useful thing to tune
against your own dives.

The same recursion runs forward, so a forecast hour inherits murk from a forecast
swell event 6 h before it. It runs over the whole loaded window from
`src/history.js`, memoised per payload: the request already carries 72 h of past
hours, so nothing is cached between page loads and no backend is involved.

Those past hours are the marine model's own hindcast, not observations. If the
model had this morning wrong, the memory inherits the error — it just stops
compounding it into a falsely perfect afternoon.

### Current

```js
effKn = modelKn * currentSensitivity
points = min(36, max(0, effKn - 0.3) * 26)
```

`currentSensitivity` is topographic amplification: headlands and walls speed flow
up, sheltered bays slow it.

**There is deliberately no tidal term.** An earlier version multiplied by a
spring/neap factor from the observed tidal range. Two things killed it. Open-Meteo's
current comes from MeteoFrance SMOC, which already includes tidal currents, so
scaling it by tidal range double-counts. And the relationship is not in the data:
over 13 days spanning 0.86–1.82 m of range, daily tidal range against daily mean
current correlates −0.02 at the Tulamben cell and +0.17 at the Amed cell. It was
also asymmetric in practice — the factor spent most of its time pinned at its 0.70
floor, quietly discounting every current by 30%.

Tide is still computed and displayed (height, range, springs/neaps); it just does
not enter the score. Note also that the model current never reverses here — 225 of
238 sampled hours ran the same way — so slack water is not something this data can
predict.

### Runoff

```js
plume[i] = plume[i-1] * exp(-1 / 30) + rain[i]        // hours
points   = min(26, (plume * (1 - exp(-1/30)) * 24) ^ 0.7 * 2.2 * runoff)
```

The `^0.7` compression reflects that the first few millimetres wash off the most
material. The rainfall itself is exponentially weighted rather than summed over a
flat 24 h box: a plume thins out gradually instead of every millimetre counting
in full for a day and then vanishing on the hour. The 30 h constant is slower than
sand's because a plume is fines and fresh water. The normalisation makes steady
rain read exactly the same number as the 24 h box sum it replaced — only bursts
differ, which is the point.

### Wind and surface

```js
onshore = max(0, cos(angle between wind bearing and shore normal))
points  = min(26, max(0, kmh - 8) * (0.15 + 0.55 * onshore) * fetchFactor)
```

Offshore wind flattens the water; onshore wind builds chop and makes a shore
entry harder. `fetchFactor` caps how rough it can get when there is not enough
open water to build. The old term maxed out at 2.6 points across every realistic
condition, which made it decorative.

## Derived outputs

**Visibility** attenuates multiplicatively, because turbidity sources compound:

```js
vis = maxVis * exp(-(3.0 * suspended + 0.030 * rainPoints + 0.10 * max(0, effKn - 0.8)))
```

The reported band widens with lead time, from ±15% at the current hour to ±40% at
+48 h. It is an inference from wave energy and runoff, never an observation.

Visibility does not feed the score, and the score does not feed visibility — that
would double-count. They are siblings off the same `suspended` state, which is
why they can never disagree: if the memory says the water is still clouded, both
the number and the score say so.

**Difficulty** is a separate question from clarity — a 1.5 kn drift in 30 m
visibility is a great dive for some divers and disqualifying for others:

```js
difficulty = 40 * waveHeightAtShore * entryWeight    // entryWeight: shore 1.0, boat 0.45
           + 30 * max(0, effKn - 0.3)
           + 0.8 * windPoints
```

## Calibration behaviour

Stress-tested via `evaluate()` against synthetic forcing (Liberty / Drop-Off /
Seraya / Batu / Jemeluk):

| scenario | Liberty | Drop-Off | Seraya | Batu |
|---|---|---|---|---|
| flat calm | 83 (100%) | 93 (100%) | 70 (100%) | 95 (100%) |
| 1.0 m 8 s onshore NE | 57 (69%) | 73 (78%) | 40 (57%) | 83 (87%) |
| 1.5 m 10 s onshore NE | 42 (51%) | 58 (62%) | 25 (36%) | 66 (69%) |
| 2.5 m 12 s onshore (storm) | 35 (42%) | 45 (48%) | 22 (31%) | 47 (49%) |
| spring tide, 3 km/h current | 51 (61%) | 57 (61%) | 32 (46%) | 59 (62%) |
| heavy rain, 80 mm | 56 (67%) | 72 (77%) | 39 (56%) | 83 (87%) |

Against live data over 48 h the factors separate the way local knowledge says
they should: swell drives the NE-facing Tulamben sites, current drives the
N-facing Amed headland sites.

## Known weaknesses

- Sites share marine grid cells (see `data-sources.md`), so per-site differences
  come from calibration, not from separate forecasts.
- `bedDepthM` and `sediment` are hand-set. They are the highest-leverage
  constants in the model and have never been validated against logged visibility.
- Tide height is a modelled sea surface, not a harmonic prediction, and slack
  water for *current* does not coincide with high or low water on this coast.
- Nothing here sees internal waves or the sudden cold down-currents at the
  Drop-Off. No public model does.
