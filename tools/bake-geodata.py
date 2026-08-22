#!/usr/bin/env python3
"""Rebuild the static geodata the widget ships with.

Outputs:
  data/coastline.json   OSM coastline for the domain (display + ray-casting)
  data/bathymetry.json  GEBCO 2020 depth grid (~450 m, the solver's land mask)
  src/sites.js          site table: calibration + derived shore normals and fetch

Run from the repo root. Needs network. Takes ~1 minute, almost all of it waiting
on opentopodata's 1 request/second public rate limit.

    python3 tools/bake-geodata.py

Nothing here runs in the browser -- the widget only ever reads the JSON output.
"""
import json, math, os, time, urllib.parse, urllib.request

BBOX = (-8.42, 115.52, -8.20, 115.72)      # S, W, N, E
STEP = 0.004                               # ~445 m, matching GEBCO's native grid
UA = {"User-Agent": "tulamben-dive-window/1.0 (static geodata bake)"}

# Hand calibration. Live models supply the regional forcing; these encode the
# local knowledge that a 5-20 km grid cell cannot resolve. bedDepthM is the depth
# of the mobile sediment that clouds the site, which is NOT the dive depth.
CAL = {
 "kubu": dict(name="Kubu / Boga Wreck", area="Kubu", lat=-8.2496, lon=115.5806, maxVis=26,
   depthM=22, bedDepthM=18, sediment=1.00, currentSensitivity=.80, runoff=.35, entry="shore",
   desc="A deeper wreck on a sloping volcanic shore. The bed is far enough down that only longer-period swell reaches it."),
 "liberty": dict(name="USAT Liberty", area="Tulamben", lat=-8.2744, lon=115.5932, maxVis=25,
   depthM=18, bedDepthM=12, sediment=1.25, currentSensitivity=.65, runoff=.55, entry="shore",
   desc="Shallow wreck on a black-sand shore entry. Fine volcanic sediment sits right on the wreck and is stirred by both swell and divers."),
 "coral": dict(name="Coral Garden", area="Tulamben", lat=-8.2765, lon=115.5949, maxVis=27,
   depthM=12, bedDepthM=8, sediment=.85, currentSensitivity=.55, runoff=.35, entry="shore",
   desc="Shallow reef on mixed volcanic substrate with more cobble and less fine sand than the Liberty, so it clears faster after swell."),
 "dropoff": dict(name="Tulamben Drop-Off", area="Tulamben", lat=-8.2778, lon=115.5965, maxVis=30,
   depthM=25, bedDepthM=10, sediment=.70, currentSensitivity=1.05, runoff=.45, entry="shore",
   desc="Steep wall running into blue water. Clearer offshore water reaches it first, but alongshore flow can build quickly and unpredictably."),
 "batu": dict(name="Batu Kelebit", area="Tulamben", lat=-8.2838, lon=115.6027, maxVis=31,
   depthM=20, bedDepthM=16, sediment=.75, currentSensitivity=1.15, runoff=.25, entry="boat",
   desc="Offshore reef reached by boat. Usually the clearest water in the area, with correspondingly more exposure to regional current."),
 "seraya": dict(name="Seraya Secrets", area="Seraya", lat=-8.2901, lon=115.6091, maxVis=18,
   depthM=14, bedDepthM=10, sediment=1.35, currentSensitivity=.70, runoff=.65, entry="shore",
   desc="Muck site over very fine black sand. Baseline visibility is deliberately low and it is the most sediment-sensitive site on this coast."),
 "jemeluk": dict(name="Jemeluk Bay", area="Amed", lat=-8.3370, lon=115.6603, maxVis=28,
   depthM=14, bedDepthM=10, sediment=.80, currentSensitivity=.55, runoff=.50, entry="shore",
   desc="Sheltered bay reef inside a headland. Local runoff and diver traffic usually matter more than anything happening offshore."),
 "pyramid": dict(name="Amed Pyramids", area="Amed", lat=-8.3342, lon=115.6538, maxVis=27,
   depthM=15, bedDepthM=12, sediment=.85, currentSensitivity=.90, runoff=.40, entry="shore",
   desc="Artificial reef structures on open sand, exposed to variable alongshore current sweeping around the Amed headland."),
}

def get(url, data=None, timeout=90):
    req = urllib.request.Request(url, data=data, headers=UA)
    return json.load(urllib.request.urlopen(req, timeout=timeout))

# ---------------------------------------------------------------- coastline
def bake_coastline():
    q = (f'[out:json][timeout:60];way["natural"="coastline"]'
         f'({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});out geom;')
    d = get("https://overpass-api.de/api/interpreter",
            urllib.parse.urlencode({"data": q}).encode())
    lines = [[[round(g["lat"], 6), round(g["lon"], 6)] for g in w["geometry"]]
             for w in d["elements"] if w["type"] == "way"]
    json.dump({"bbox": BBOX, "lines": lines},
              open("data/coastline.json", "w"), separators=(",", ":"))
    print(f"coastline.json: {len(lines)} ways, "
          f"{sum(len(l) for l in lines)} vertices, "
          f"{os.path.getsize('data/coastline.json')//1024} KB")
    return lines

# --------------------------------------------------------------- bathymetry
def bake_bathymetry():
    lats = [round(BBOX[0] + i*STEP, 6) for i in range(int((BBOX[2]-BBOX[0])/STEP)+1)]
    lons = [round(BBOX[1] + i*STEP, 6) for i in range(int((BBOX[3]-BBOX[1])/STEP)+1)]
    pts = [(a, b) for a in lats for b in lons]
    print(f"bathymetry: {len(lats)}x{len(lons)} = {len(pts)} points "
          f"({math.ceil(len(pts)/100)} requests at 1/s)")
    vals = []
    for k in range(0, len(pts), 100):
        loc = "|".join(f"{a},{b}" for a, b in pts[k:k+100])
        for attempt in range(4):
            try:
                d = get("https://api.opentopodata.org/v1/gebco2020?locations=" + loc, timeout=60)
                if d.get("status") != "OK":
                    raise RuntimeError(d.get("error"))
                vals += [x["elevation"] for x in d["results"]]
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(3 * (attempt + 1))
        print(f"  {len(vals)}/{len(pts)}", end="\r", flush=True)
        time.sleep(1.1)
    grid = [[int(vals[i*len(lons)+j] or 0) for j in range(len(lons))] for i in range(len(lats))]
    json.dump({"lat0": BBOX[0], "lon0": BBOX[1], "step": STEP,
               "nLat": len(lats), "nLon": len(lons), "elev": grid},
              open("data/bathymetry.json", "w"), separators=(",", ":"))
    wet = sum(1 for r in grid for v in r if v < 0)
    print(f"\nbathymetry.json: {100*wet//len(pts)}% wet, deepest {min(min(r) for r in grid)} m, "
          f"{os.path.getsize('data/bathymetry.json')//1024} KB")

# ------------------------------------------------- shore normals and fetch
def seaward_normal(p1, p2):
    """OSM winds coastline ways with LAND on the LEFT, so water is 90 deg clockwise."""
    la = math.radians((p1[0] + p2[0]) / 2)
    de, dn = (p2[1]-p1[1]) * math.cos(la), p2[0]-p1[0]
    n = math.hypot(de, dn)
    if n == 0:
        return None
    return (math.degrees(math.atan2(dn/n, -de/n)) + 360) % 360

def seg_dist_m(p, a, b):
    my, mx = 111320.0, 111320.0 * math.cos(math.radians(p[0]))
    px, py = (p[1]-a[1])*mx, (p[0]-a[0])*my
    bx, by = (b[1]-a[1])*mx, (b[0]-a[0])*my
    L2 = bx*bx + by*by
    t = 0.0 if L2 == 0 else max(0, min(1, (px*bx + py*by) / L2))
    return math.hypot(px - t*bx, py - t*by)

def bake_sites(lines):
    segs = [(l[i][1], l[i][0], l[i+1][1], l[i+1][0]) for l in lines for i in range(len(l)-1)]
    MAXKM, NBINS = 40.0, 36

    def ray(ox, oy, dx, dy, maxd):
        best = maxd
        for ax, ay, bx, by in segs:
            sx, sy = bx-ax, by-ay
            den = dx*sy - dy*sx
            if abs(den) < 1e-12:
                continue
            t = ((ax-ox)*sy - (ay-oy)*sx) / den
            u = ((ax-ox)*dy - (ay-oy)*dx) / den
            if 0 <= u <= 1 and 1e-6 < t < best:
                best = t
        return best

    out = []
    for sid, c in CAL.items():
        la, lo = c["lat"], c["lon"]
        cands = sorted(((seg_dist_m((la, lo), (l[i][0], l[i][1]), (l[i+1][0], l[i+1][1])),
                         (l[i][0], l[i][1]), (l[i+1][0], l[i+1][1]))
                        for l in lines for i in range(len(l)-1)), key=lambda x: x[0])
        nearest = cands[0][0]
        vx = vy = 0.0
        for dm, a, b in cands:
            if dm > max(300.0, nearest * 2.5):
                continue
            nb = seaward_normal(a, b)
            if nb is None:
                continue
            w = 1.0 / (1.0 + dm)
            vx += w * math.sin(math.radians(nb))
            vy += w * math.cos(math.radians(nb))
        normal = round((math.degrees(math.atan2(vx, vy)) + 360) % 360)

        mlat, mlon = 111.320, 111.320 * math.cos(math.radians(la))
        fetch = []
        for bnum in range(NBINS):
            brg = bnum * 360.0 / NBINS
            dx, dy = math.sin(math.radians(brg))/mlon, math.cos(math.radians(brg))/mlat
            n = math.hypot(dx, dy); dx, dy = dx/n, dy/n
            step_km = math.hypot(dx*mlon, dy*mlat)
            fetch.append(round(min(MAXKM, ray(lo, la, dx, dy, MAXKM/step_km) * step_km), 1))
        out.append((sid, c, normal, round(nearest), fetch))
        print(f"  {sid:9s} shore {round(nearest):4d} m  normal {normal:3d} deg")

    L = ["// GENERATED by tools/bake-geodata.py -- edit the calibration there, not here.",
         "// shoreNormalDeg / shoreDistM / fetchKm are derived from OSM coastline geometry;",
         "// everything else is hand calibration that the regional models cannot resolve.",
         "", "export const SITES = ["]
    for sid, c, normal, dist, fetch in out:
        L += [f'  {{',
              f'    id: "{sid}", name: "{c["name"]}", area: "{c["area"]}",',
              f'    lat: {c["lat"]}, lon: {c["lon"]}, entry: "{c["entry"]}",',
              f'    depthM: {c["depthM"]}, bedDepthM: {c["bedDepthM"]}, maxVis: {c["maxVis"]},',
              f'    sediment: {c["sediment"]}, currentSensitivity: {c["currentSensitivity"]}, runoff: {c["runoff"]},',
              f'    shoreNormalDeg: {normal}, shoreDistM: {dist},',
              f'    fetchKm: [{",".join(str(x) for x in fetch)}],',
              f'    desc: "{c["desc"]}"', f'  }},']
    L += ["];", "", "export const SITE_BY_ID = new Map(SITES.map(s => [s.id, s]));", ""]
    open("src/sites.js", "w").write("\n".join(L))
    print(f"src/sites.js: {len(out)} sites")

if __name__ == "__main__":
    os.makedirs("data", exist_ok=True)
    lines = bake_coastline()
    bake_sites(lines)
    bake_bathymetry()
