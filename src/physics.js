// Physical helpers. Everything here is deterministic and unit-tested by eye against
// worked examples in docs/scoring.md -- no fetching, no DOM.

export const G = 9.80665;
export const KMH_TO_KN = 0.539957;
export const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
export const rad = (d) => (d * Math.PI) / 180;

/** Smallest absolute angle between two bearings, 0..180. */
export function angleDiff(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/**
 * Linear-wave wavenumber from period and depth. Guo (2002) explicit approximation
 * to omega^2 = g k tanh(kd), accurate to <0.2% over all depths -- no iteration needed.
 */
export function waveNumber(periodS, depthM) {
  if (!(periodS > 0) || !(depthM > 0)) return null;
  const w = (2 * Math.PI) / periodS;
  const x = (w * w * depthM) / G;                       // dimensionless depth
  const kd = x / Math.pow(1 - Math.exp(-Math.pow(x, 1.25)), 0.8);
  return { k: kd / depthM, kd };
}

/**
 * Near-bed wave orbital velocity amplitude (m/s), linear theory:
 *   u_b = pi * H / (T * sinh(kd))
 * This is what actually resuspends sediment, and it is why a long-period swell
 * clouds a 20 m site while a taller short-period chop does not.
 */
export function orbitalVelocity(heightM, periodS, depthM) {
  const w = waveNumber(periodS, depthM);
  if (!w || !(heightM > 0)) return 0;
  const s = Math.sinh(w.kd);
  if (!Number.isFinite(s) || s < 1e-6) return 0;
  return (Math.PI * heightM) / (periodS * s);
}

/** Critical near-bed velocity for motion (m/s). Finer, lighter sand moves sooner. */
export const criticalVelocity = (sediment) => 0.09 / Math.max(0.3, sediment);

/** Fetch (km) toward a bearing, linearly interpolated between the 10-degree bins. */
export function fetchAt(site, fromDeg) {
  const f = site.fetchKm, n = f.length;
  const x = (((fromDeg % 360) + 360) % 360) / (360 / n);
  const i = Math.floor(x), t = x - i;
  return f[i % n] * (1 - t) + f[(i + 1) % n] * t;
}

/**
 * Fraction of open-water wave energy that reaches this site from a given bearing.
 *
 *   openness  -- ray-cast fetch against the real coastline; a bearing that hits
 *                land within a couple of km delivers almost nothing.
 *   obliquity -- cos of the angle off the shore normal, square-rooted because
 *                refraction turns waves shoreward and softens pure cosine.
 *   wrap      -- a small diffraction/refraction term so a shadowed site gets a
 *                realistic trickle rather than a hard zero.
 */
export function directionalExposure(site, fromDeg) {
  if (fromDeg == null) return 1;
  const open = clamp(fetchAt(site, fromDeg) / 12, 0, 1);
  const theta = angleDiff(fromDeg, site.shoreNormalDeg);
  const c = Math.cos(rad(theta));
  const obliq = c > 0 ? Math.sqrt(c) : 0;
  const wrap = 0.12 * Math.max(0, Math.cos(rad(theta / 2)));
  return clamp(open * (obliq + wrap), 0.02, 1);
}

/** How much of the wind blows onshore here (0 offshore .. 1 straight in). */
export function onshoreFraction(site, windFromDeg) {
  if (windFromDeg == null) return 0.5;
  return Math.max(0, Math.cos(rad(angleDiff(windFromDeg, site.shoreNormalDeg))));
}

/**
 * Tide state at index i, derived adaptively from the series itself rather than a
 * fixed slope cutoff. `range` over the surrounding day doubles as a spring/neap
 * measure, which is the best available proxy for Lombok Strait current strength.
 */
export function tideState(series, i) {
  const h = series?.sea_level_height_msl;
  if (!Array.isArray(h)) return { height: null, phase: "Unknown", rate: null, springFactor: 1 };
  const at = (n) => h[clamp(n, 0, h.length - 1)];
  const height = at(i);
  if (height == null) return { height: null, phase: "Unknown", rate: null, springFactor: 1 };

  const rate = (at(i + 1) - at(i - 1)) / 2;             // m per hour, centred
  const win = [];
  for (let n = i - 12; n <= i + 12; n++) { const v = at(n); if (v != null) win.push(v); }
  const range = win.length ? Math.max(...win) - Math.min(...win) : 0;

  // Peak rate of a sinusoid of this range over a ~12.4 h cycle.
  const peakRate = (Math.PI * range) / 12.42 || 1;
  const frac = Math.abs(rate) / peakRate;

  // "High water", not "high slack": this describes sea level turning, and says
  // nothing about the current. Slack water for current does not line up with
  // high or low tide on this coast, so the wording must not imply it.
  let phase;
  if (frac < 0.22) phase = at(i + 1) < height || at(i - 1) < height ? "High water" : "Low water";
  else phase = rate > 0 ? "Rising" : "Falling";
  if (frac < 0.22 && at(i + 1) > height && at(i - 1) > height) phase = "Low water";

  // springFactor describes the tide itself (springs vs neaps) and is displayed
  // as such. It no longer scales the current score -- see docs/scoring.md.
  return { height, rate, range, phase, springFactor: clamp(range / 1.6, 0.7, 1.4) };
}

/** Hours until the next tidal turn, and whether it is a high or a low. */
export function nextTurn(series, i) {
  const h = series?.sea_level_height_msl;
  if (!Array.isArray(h)) return null;
  const slope = (n) => (h[n + 1] ?? 0) - (h[n] ?? 0);
  const s0 = slope(i);
  for (let n = i + 1; n < Math.min(h.length - 2, i + 26); n++) {
    if (Math.sign(slope(n)) !== Math.sign(s0)) {
      return { hours: n - i, type: s0 > 0 ? "high" : "low", height: h[n] };
    }
  }
  return null;
}

/** Moon phase 0..1 (0 = new, 0.5 = full). Conway-style approximation, +/- ~1 day. */
export function moonPhase(date) {
  const lp = 2551442800;                                // synodic month, ms
  const newMoon = Date.UTC(2000, 0, 6, 18, 14) ;
  return (((date.getTime() - newMoon) % lp) + lp) % lp / lp;
}

export function moonLabel(p) {
  const names = ["New", "Waxing crescent", "First quarter", "Waxing gibbous",
                 "Full", "Waning gibbous", "Last quarter", "Waning crescent"];
  return names[Math.round(p * 8) % 8];
}

export const compass = (deg) => deg == null ? "--" :
  ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"]
  [Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
