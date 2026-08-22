# The current field

`src/currentfield.js`.

## What it is

Open-Meteo gives one current vector, sampled 15–21 km offshore. Drawing that as a
uniform arrow over the whole map is wrong everywhere near the shore — it puts
flow through headlands and ignores the coastline entirely.

Instead the coarse vector is treated as a **far-field boundary condition** and
redistributed so it obeys mass conservation around the real coastline:

```
u = U_far + grad(phi)        with     div(w * u) = 0
```

Solving for `phi` gives flow that follows the shore, accelerates around headlands
and slows inside bays. This is **interpolation, not a model** — the label in the
UI says so, and it should stay there.

## How it is solved

- Domain: the bathymetry bbox, on a 150 m grid — 147 x 163 = ~24k cells.
- `w` is a depth-derived steering weight, `min(1, sqrt(depth/30))`, zero on land.
  Depths past ~30 m all steer alike; shallower water tapers flow to zero at the
  shore. This is deliberately *not* transport conservation: `div(h u) = 0` with a
  1350 m strait next to a 10 m shelf makes nearshore velocities vanish, which is
  right for depth-integrated transport and wrong for what a diver feels.
- Right-hand side is `-div(w * U_far)` with face-averaged weights.
- Red-black SOR, `omega = 1.85`, 600 sweeps. Runs in ~120 ms.
- Boundary conditions: `phi = 0` on the domain edge (open ocean, flow may enter
  and leave), and zero flux at land, which falls out automatically because `w`
  is zero there.
- The result is capped at 3.5x the far-field speed to guard against the solver
  overshooting in near-dry cells.

Because the solve is too slow to run on every slider tick, it is debounced ~140 ms
behind the UI. Scrubbing hours stays instant; the current readout catches up.

## Does it do anything?

Verified against the live far field (0.194 m/s toward 166 deg):

```
offshore reference   0.99x     <- far field preserved, as it must be
liberty              0.94x
coral                0.91x
dropoff              0.96x
kubu                 1.01x
seraya               0.94x
batu                 1.00x
jemeluk              1.21x     <- inside the bay
pyramid              1.51x     <- on the Amed headland
```

The correction is modest along the straight Tulamben shore and large around the
Amed headland. That is the honest answer for this coast: Tulamben drops off so
steeply that there is barely any shallow shelf to deflect flow, which is also why
its currents genuinely run hard right along the shore. The interesting steering
is at Amed, and the solver finds it.

Sites 40–440 m offshore can land in a "dry" cell of the 450 m mask — Jemeluk Bay
does. `sampleNear()` spirals outward for the nearest wet cell and reports how far
it had to go.

## What it deliberately cannot do

**Potential flow has no separation.** There is no eddy behind a headland, no lee
recirculation, and no washing-machine at the Drop-Off. Those are exactly the
features divers care about most. A wake heuristic downstream of headlands could
be bolted on, but it would be illustration rather than prediction, and it would
make the picture look more authoritative than it is.

It also cannot see internal waves or tidal bores — the sudden cold upwelling and
down-currents at the Drop-Off are invisible to every public product.

## What it is used for

The field is **not drawn**. An earlier version animated it as particle
streamlines over the map; they were removed because they added atmosphere rather
than information — a near-uniform field along a straight coast produces a screen
full of parallel dashes, and the one place with real structure (the Amed
headland) is a corner of the map.

What survives is the number: the HUD reads current at the *selected site* off the
field rather than off the raw offshore value, which is the best local estimate
available here. The UI says so — "current is interpolated to this site; swell and
wind are regional".

If the field is ever dropped entirely, `data/bathymetry.json` and the bathymetry
half of the bake go with it, and the HUD falls back to `sample().current`.
