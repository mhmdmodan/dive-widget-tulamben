# Analysis and improvement plan

Written 2026-08-22, before the rework. This is the findings document that the
rework is based on. Measurements were taken against live Open-Meteo data on
that date; exact numbers will drift, the structural conclusions will not.

Status markers were added as the work landed: **[done]**, **[partial]**, **[skipped]**.

---

## 1. What the logic actually is, and whether it's sound

### The model in one line

`calculate()` started at **92** and subtracted four penalties:

| Term | Formula | Mean pts | Max pts |
|---|---|---|---|
| Swell | `max(0, swell x max(1,T/7) - 0.12) x 25 x waveSens` | **26.0** | 56 |
| Current | `max(0, cur - 0.25) x 13 x curSens` | 5.4 | 38 |
| Rain | `min(20, rain24 x 1.25 x runoff)` | **0.22** | 0.8 |
| Wind | `max(0, wind - 10) x 0.45 x exposure/100` | **0.80** | 2.6 |

(measured over all 8 sites x 48 h against live data)

The score was **~80% swell height, ~15% current, with rain and wind inert**.
Wind maxed out at 2.6 points — a 40 km/h gale, which makes a Tulamben shore
entry genuinely undiveable, cost 9 points. That term was mis-scaled by roughly
an order of magnitude at the top end.

### Why it nonetheless felt accurate

It was sound *as a ranking*, for a reason worth naming: swell really is the
dominant control on Tulamben conditions, and the per-site constants
(`waveSensitivity`, `runoff`, `maxVis`) encode genuine local knowledge — Seraya's
black sand is more sediment-prone than Coral Garden's, the Drop-Off gets more
flow. So the output was **one live regional variable x a hand-tuned site
ranking**. A legitimate and effective heuristic. It just wasn't the five-factor
model it presented itself as.

The tell was dynamic range: over 48 h Coral Garden never left 72–82 and
Drop-Off never left 72–84. Relative ordering barely moved. Closer to a static
site ranking with a swell-driven wobble than a forecast.

### Bugs confirmed against live data

**a. Marine data comes from 15–21 km offshore.** **[done]** The marine model snaps each
request to the nearest wet grid cell, and its land mask is coarse enough that
every site landed far out to sea:

```
liberty  -> 20.9 km @ 037 deg     seraya  -> 20.1 km @ 091 deg
coral    -> 21.0 km @ 037 deg     batu    -> 20.8 km @ 092 deg
dropoff  -> 21.0 km @ 036 deg     jemeluk -> 15.1 km @ 106 deg
kubu     -> 19.7 km @ 045 deg     pyramid -> 15.8 km @ 107 deg
```

Eight sites collapsed to **3 distinct wave values and 2 distinct current
values**. Liberty, Coral, Drop-Off and Kubu were literally the same cell.
`AGENTS.md` claimed "~8 km current / ~5 km wave" resolution — real displacement
is 2–4x that, so the doc was wrong on this point.

Visible consequence: Jemeluk and Amed Pyramids were served a **3.5 km/h current
from mid-Lombok-Strait**, and were the worst-scoring sites in the app (Pyramid
bottomed out at the clamp of 22). Jemeluk is a sheltered bay. Not a small error —
the app's most confident output was systematically inverted.

**b. Rain history silently truncated.** **[done]** `rainHistory()` looped
`max(0, i-24)…i`, but the weather request had no `past_days`, so index 0 was
midnight *today*. Tested at 11:25 WITA it summed **13 hours, not 25**. For a
6 am dive it summed 7. The overnight rain that drives morning runoff was
invisible — precisely when it matters most.

**c. Confidence used an absolute array index as if it were lead time.** **[done]**
`i <= 24 ? "Moderate"`. Open the app at 02:00 and you got "Moderate" out to
+22 h; open it at 20:00 and you got it for +4 h. Confidence degraded with
**time of day**.

**d. The slack-tide bonus was a knife-edge that mostly missed.** **[done]**
`|ssh[i+1] - ssh[i-1]| < 0.025` fired on **2 of 46 hours**, and missed two of
the four actual tidal turns by 0.005 m — on a series quantized to 0.01 m. The
threshold was 2.5 quanta wide. Rounding noise, not a signal.

Worth noting separately: **tide-height slack != current slack.** At Tulamben the
flow is Lombok Strait throughflow and internal tides, phase-shifted from local
sea level. Deriving current timing from sea-surface height here is physically
the wrong lever.

### Missing physics that mattered most

**Nothing used direction.** **[done]** The largest single gap. From the OSM coastline
(662 vertices, 4 ways), each site's seaward shore normal:

```
liberty  055     seraya  052     jemeluk 028
coral    029     batu    043     pyramid 356
dropoff  015     kubu    046
```

Test-day swell was **from 110–120 deg (ESE)**. Against those normals, Drop-Off
(015) and Pyramid (356) were at >90 deg obliquity — geometrically **shadowed**.
The app applied the full 0.8 m to every site equally. A `cos(theta)` exposure
gate with a shadow cutoff is the highest-value change available per line of code.

**Wave energy was modelled linearly, at the surface.** **[done]**
`energy = H x max(1, T/7)` ignores that what resuspends sediment is near-bed
orbital velocity, which from linear wave theory is `u_b = pi*H / (T*sinh(kd))`.
This depends strongly on **depth** and **period** — a 1.5 m/6 s wind chop does
almost nothing at 25 m, while a 1.0 m/14 s groundswell stirs the bottom.
Computing `u_b` against a ~0.1–0.2 m/s threshold for fine sand is a genuinely
better model, not just a retuned one.

**`wind_wave_height` was fetched-adjacent but never used.** **[done]** The code took
`swell_wave_height` (0.84 m on the test day) while total `wave_height` was
1.08 m — secondary partitions were being dropped. For shore-entry difficulty at
Tulamben, local wind wave is arguably the operative variable.

**Also cheap and high-signal:** moon phase -> spring/neap, which correlates
strongly with Lombok Strait current magnitude. Pure computation, no API. **[done]**

---

## 2. Higher-resolution current, streamlines, current-at-depth

### Coastline-aware surface current + particle streamlines — yes, realistically **[done]**

The honest framing: not downscaling, but **mass-conserving interpolation**. Take
the coarse offshore vector as a far-field boundary condition and solve a 2D
steady continuity problem on a land-masked grid:

```
div(h u) = 0 ,  u = grad(phi) ,  no-normal-flow at the coastline
```

Flow then follows the shore, accelerates around headlands, slows in bays.
Everything needed is available and small:

- **Coastline** — OSM via Overpass, 662 vertices for the whole domain. Pre-baked
  as static JSON.
- **Bathymetry** — GEBCO 2020 via `api.opentopodata.org` (verified; returned
  -85 m at Liberty, -162 m 2 km offshore). Domain is ~16x20 km; pre-baked once.
- **Solve** — 100 m grid is ~165x200 = 33k cells. SOR converges in tens of ms in
  JS. Real-time, no backend.
- **Render** — canvas particle advection over Leaflet, the standard
  windy.com / earth.nullschool technique.

**What it buys:** strictly more honest than the status quo. The old overlay drew
one uniform arrow that was wrong everywhere near shore. A continuity-respecting
field is wrong in a *physically constrained* way.

**What it cannot do — and this is on the label:** potential flow has no
separation, so it will never produce the washing-machine eddy at the Drop-Off or
lee recirculation behind headlands, which is exactly what divers care about.
Labelled "coastline-aware interpolation", never "a current model".

### Current at depth — **[skipped]** by decision

Recorded for future reference. Three routes:

1. **Open-Meteo** — surface only, no depth levels. Dead end.
2. **CMEMS** (`GLOBAL_ANALYSISFORECAST_PHY_001_024`) — real currents at ~50
   depth levels, 1/12 deg. Free but requires registration and is **not
   browser-CORS-friendly**: needs a backend plus cached cron pull. And at 1/12 deg
   (~9 km) it is still a mid-strait value, so you take on a backend for data
   that still does not resolve the site.
3. **Parameterised profile** — Ekman drift near the surface (~3% of wind speed,
   veering 20–45 deg), a log boundary layer near the bottom so flow drops in the
   last few metres, along-slope deflection on the wall. Plausible but not a
   forecast; would belong in the site panel as a chart, not as a map layer.

**Hard limit on any depth work:** GEBCO is ~450 m resolution. The Tulamben
drop-off falls away over ~100 m horizontally, so GEBCO smooths it into a ramp —
it reports -85 m at a point 108 m from shore, where the Liberty actually sits in
5–30 m. Fine for the regional slope that shapes the current field; **useless for
site depth**. There is no public high-resolution bathymetry for Bali, so site
depths are hardcoded from dive-guide knowledge.

**Not modellable from any public product:** the internal-wave / tidal-bore events
causing sudden cold upwelling and down-currents at the Drop-Off. Given an
explicit "this model cannot see" note rather than silent omission.

---

## 3. UI

### Measured problems

**Marker collision made half the map unreadable.** **[done]** Measured pixel positions at
default `fitBounds` zoom: **8 overlapping pairs**, 42 px icons as close as
**6 px apart**. Liberty/Coral/Drop-Off were one illegible blob; Jemeluk/Pyramid
another. Four of eight sites effectively invisible until zoomed.

**~40% of viewport was a placeholder.** **[done]** On load the right panel said "Select a
dive site". The most common question — *where should I dive today?* — had no
answer on screen, and couldn't be answered from the map because the numbers
collided.

**Three inconsistent encodings of the same variable.** **[done]** For Kubu on the test day:
swell 0.8 m rendered as an **amber** metric card, a **red** "Swell resuspension"
driver, and a **green/Good** 70 score. All three were the same number.

**Score had no decomposition.** **[done]** The ring said 70/100 and nothing said where the
other 30 went.

**Sea temperature was 12 px grey at the bottom of the panel.** **[done]** Water temp is a
top-three input to what you put on your body; it was the least prominent thing
on the page.

**Weather had no home.** **[done]** "Partly cloudy" was jammed into a shared `Tide · Weather`
overlay cell. No air temp, no rain timing, no sunrise/sunset (the dawn Liberty
dive is *the* dive here), no UV.

**Time slider was context-free.** **[done]** For a 48 h planning tool you want to *see* the
good window, not scrub 48 times hunting for it.

Minor: arrow and text used opposite direction conventions (label "WIND (FROM)
SE", arrow pointed NW) **[done]**; `state.index` was set once at load and never
refreshed, so "Now" went stale on a long-lived tab **[done]**; metric thresholds in
`renderSite()` were magic numbers duplicated from `calculate()` **[done]**.

### Changes

**Split the score into a stacked bar, not a number.** **[done]** Show the 92-point budget
draining, with the culprit named. Click any segment to expand the reasoning.
Replaces colour-coding-as-explanation.

**Separate the two questions the score conflates.** **[done]** Current was penalised as both
a visibility factor and a difficulty factor. Divers treat these differently — a
1.5 kn drift with 30 m vis is a *great* dive for some and disqualifying for
others. Two independent readouts: **Visibility** and **Difficulty/effort**, with
the headline score a visible combination of the parts.

**Add a ranked site list.** **[done]** Eight rows, score bar, best-window chip. Solves
marker collision for the primary use case and fills the placeholder space on
load. The map becomes the secondary view.

**Replace the slider with a 48 h heat strip.** **[done]** One row per site, colour by score,
day/night shading, tap to jump. "When should I go" becomes visual.

**Give weather its own block:** **[done]** air temp, rain timing, wind, cloud,
sunrise/sunset, UV — and promote **sea temp** into the headline metrics with a
wetsuit hint.

**Switch to a dark basemap** (CARTO `dark_matter`). **[done]** The light Voyager tiles
fought the dark chrome; coloured markers read much better on dark.

**Show the model-cell displacement honestly.** **[done]** *"nearest model cell: 21 km
offshore"* next to the current reading. Reframes the app correctly: regional
forcing plus local site knowledge, which is what it is and a respectable thing
to be.

**Units toggle** — knots for current, m/ft. **[done]** km/h for current is not how divers
talk.

---

## Build order

The unglamorous data fixes are worth more than any of the modelling.

1. Rain-history `past_days`, confidence lead-time, slack threshold — three small
   correctness fixes
2. Directional exposure via shore normals — highest physics value per line of code
3. Score decomposition UI + weather split + ranked list
4. Orbital-velocity wave model, wind term rescale
5. Streamline overlay — polish on top of a corrected base

The current field visualised in step 5 is fed by a value sampled 15–21 km
offshore. Fixing what the arrow *means* came before making the arrow prettier.


---

## Follow-up round (same day)

Feedback after the first rework, and what changed.

**Mobile and light mode.** **[done]** Full light palette driven by
`prefers-color-scheme` — tokens only, no in-app switch. Touch targets raised to
~44 px, HUD reflows two-up then one-up, sections reorder to map → sites → detail
→ weather.

**Direction arrows.** **[done]** "From ESE" was neither granular nor quick to
read. Current, swell and wind now show a rotated arrow pointing the way the
water or air travels, plus the exact bearing in degrees.

**Streamlines.** **[done]** Rewritten. They ran onto land (GEBCO's 450 m
coastline sits a few hundred metres off the drawn one — the render mask is now
eroded by a cell), and looked fast, dense and stubby. Three separate causes:
the timestep was normalised by the field *peak* rather than the regional speed,
so ordinary particles moved a third of a pixel per frame; canvas alpha is 8 bits,
so no fade is gentle enough for a long trail; and the tail alpha started near
zero, visually truncating trails to their head third. Now: stored position
history, two-pass stroke, inline Web Mercator projection, ~4 ms/frame at 850
particles. Zoom control moved to the left, legend to the right.

Worth recording: a long detour was spent chasing "short trails" that were
actually a **backgrounded tab** — browsers stop firing `requestAnimationFrame`
entirely when hidden, so every screenshot was a frozen snapshot. Check
`document.visibilityState` first next time.

**Ranking dropped.** **[done]** The site list is now in coast order. Ranking
implied a precision the model does not have. "Best next 48 h" moved to the
per-site strip in the detail panel.

**One score at a time.** **[done]** Showing an absolute score and a "% of best"
gauge together was the confusing part. A single header switch now flips the map
pills, site list and ring together through `display(result, mode)`. The score
bar follows: the hatched "out of reach" tail exists only in absolute mode. Bar
segments, key chips and lever accordions share one colour per factor.

## Third follow-up round

**Streamlines removed.** **[done]** The user's verdict was that they did not add
anything, and that is right: along a straight coast the field is close to
uniform, so the animation was a screen of parallel dashes. The solver stays —
`src/currentfield.js` still supplies the site-local current in the HUD, which is
the part that carried information. `src/map.js` lost roughly 150 lines: the
particle system, the second canvas, the rAF loop and its backgrounded-tab
handling all went with the rendering.

**Dragging the time slider.** **[done]** It was never a slider bug. Every render
rebuilt the time bar with `innerHTML`, which destroyed the `<input>` under the
pointer on the first `input` event — so a drag became one step. The input is now
created once and only has its `value` written; the header and scrub markup are
still replaced freely.

**The time bar became the scrub track.** **[done]** Selected date beside the
hour, day/night banding, a tick at each midnight, the day named between ticks,
and the tide curve underneath all of it — so scrubbing days and reading the tide
are the same gesture. Drawn as positioned HTML over one SVG path: text in a
full-width SVG has to be stretched and comes out distorted.

**Tide moved out of the site panel.** **[done]** Checked before moving it: the
eight sites resolve to three marine cells whose sea level differs by at most
0.03 m against a ~1.1 m range, so a single curve is honest for the whole coast.
Scoring still uses each site's own series — only the display is shared. The
slack-water caveat moved to the "How to read this" card.

**False high tides.** **[done]** The H/L labels were plain local maxima, which on
a mixed tide marks the flat shoulder as a high: the water sat at 0.62, 0.62,
0.63, 0.65 through one night before climbing to its real high at 07:00, and the
bar printed two highs where a tide table prints one. Replaced with a prominence
test — a turn counts only once the water has moved back 0.1 m — which also makes
the marks strictly alternate. The scan runs half a cycle either side of the
visible window so neither edge invents a turn.

Found while checking it: **`node --check <file>` parses as a script and misses
errors ES modules reject.** A duplicate `const` in one block passed the repo's
documented check and threw in the browser. The command in AGENTS.md is now
`node --input-type=module --check < "$f"`.

## Fourth round: one current, and tide out of the score

**Tide no longer scales current.** **[done]** The spring/neap multiplier was
removed. The source product already includes tidal currents, and daily tidal
range does not track daily current speed here (−0.02 at Tulamben, +0.17 at Amed
over 13 days). In practice it sat at its 0.70 floor most of the time, marking
every current down 30%. Effect at the hour it was removed: 0 points at five
sites, −2.5 at the Drop-Off, −3.4 at Batu Kelebit, −4.9 at Amed Pyramids.

**One current magnitude, not three.** **[done]** The app was reporting model
current, a potential-flow interpolation of it, and a hand-calibrated scored
value, and showing two of them at once: at Amed Pyramids the HUD read 2.6 kn
while the panel read 1.2 kn. The HUD now shows current *direction* only. Strength
lives in the site panel, where it is site-specific and derived the same way the
score is.

**"High water", not "High slack".** **[done]** The label described sea level
turning and implied the current had stopped. The unused `slackness` value went
with it. The time bar carries a one-line caveat: "Tide is sea level. Slack tide
does not mean slack current here."

**Consequences.** `src/currentfield.js` now has no runtime consumer and
`data/bathymetry.json` is no longer fetched. Both are kept for a possible
bake-time use — deriving `currentSensitivity` from geometry — but Jemeluk is a
warning: the 450 m mask amplifies current in a bay that is genuinely sheltered,
where the hand-set ×0.55 is closer to reality.
