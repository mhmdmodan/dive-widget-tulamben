// Condition scoring. Every factor returns not just a number of points but the
// full chain that produced it, so the UI can let a user open any lever and see
// the inputs, the transformation, and the site constant that shaped it.

import {
  clamp, orbitalVelocity, criticalVelocity, directionalExposure, onshoreFraction,
  fetchAt, compass, KMH_TO_KN, angleDiff,
} from "./physics.js";

const P = {
  stirGain: 165,     // points per m/s of excess near-bed orbital velocity
  stirCap: 48,
  curGain: 26,       // points per knot of excess site-adjusted current
  curCap: 36,
  rainCap: 26,
  windCap: 26,
  floor: 8,
};

/**
 * A site's starting budget, set by how good it can ever be. Seraya on its finest
 * day is still an 18 m muck site and should not read the same as the Drop-Off on
 * its finest day. Keeping this in the absolute score preserves real information;
 * the separate `relative` reading is what answers "is this a good day *here*".
 */
export function siteBase(site) {
  return clamp(68 + 27 * ((site.maxVis - 17) / 14), 66, 96);
}

const f1 = (n, d = 1) => (n == null || !Number.isFinite(n) ? "--" : n.toFixed(d));

/* ------------------------------------------------------------------ factors */

function swellFactor(site, s) {
  // Take the more damaging of the swell and wind-wave partitions rather than
  // silently dropping one, then gate it by how much actually reaches this shore.
  const parts = [
    { name: "swell", h: s.swellH, t: s.swellT, dir: s.swellDir },
    { name: "wind wave", h: s.windWaveH, t: s.windWaveT, dir: s.windWaveDir },
  ].filter((p) => p.h > 0 && p.t > 0);
  if (!parts.length) parts.push({ name: "sea", h: s.waveH ?? 0, t: s.waveT ?? 6, dir: s.waveDir });

  let best = null;
  for (const p of parts) {
    const exposure = directionalExposure(site, p.dir);
    const hEff = p.h * exposure;
    const ub = orbitalVelocity(hEff, p.t, site.bedDepthM);
    if (!best || ub > best.ub) best = { ...p, exposure, hEff, ub };
  }

  const uCrit = criticalVelocity(site.sediment);
  const excess = Math.max(0, best.ub - uCrit);
  const points = Math.min(P.stirCap, excess * P.stirGain);
  const theta = best.dir == null ? null : angleDiff(best.dir, site.shoreNormalDeg);
  const shadowed = best.exposure < 0.2;

  return {
    key: "swell",
    label: "Swell & sediment",
    points,
    ub: best.ub,
    uCrit,
    hEff: best.hEff,
    exposure: best.exposure,
    tone: points > 14 ? "bad" : points > 5 ? "warn" : "good",
    headline: shadowed
      ? `Largely shadowed - ${f1(best.h, 2)} m ${best.name} from ${compass(best.dir)} arrives at ${f1(best.hEff, 2)} m`
      : `${f1(best.hEff, 2)} m of ${f1(best.t, 0)} s ${best.name} reaching a ${site.bedDepthM} m bed`,
    inputs: [
      ["Offshore " + best.name, `${f1(best.h, 2)} m at ${f1(best.t, 0)} s from ${compass(best.dir)}`],
      ["This shore faces", `${site.shoreNormalDeg}° (${compass(site.shoreNormalDeg)})`],
      ["Angle off shore normal", theta == null ? "--" : `${f1(theta, 0)}°`],
      ["Open-water fetch that way", `${f1(fetchAt(site, best.dir ?? 0), 0)} km`],
      ["Sediment bed depth", `${site.bedDepthM} m`],
    ],
    chain: [
      ["Directional exposure",
       `Coastline ray-casting plus refraction gives this shore ${Math.round(best.exposure * 100)}% of the open-water energy from ${compass(best.dir)}.`,
       `x${f1(best.exposure, 2)}`],
      ["Wave height at the site",
       `${f1(best.h, 2)} m offshore becomes ${f1(best.hEff, 2)} m here.`,
       `${f1(best.hEff, 2)} m`],
      ["Near-bed orbital velocity",
       `Linear wave theory: u = πH / (T·sinh kd) at ${site.bedDepthM} m. Longer periods reach deeper, which is why period matters as much as height.`,
       `${f1(best.ub, 3)} m/s`],
      ["Sediment threshold",
       `This site's substrate starts moving at ${f1(uCrit, 3)} m/s (calibration: ${site.sediment}, higher = finer and lighter).`,
       `${f1(excess, 3)} m/s over`],
      ["Penalty", `${f1(excess, 3)} m/s excess × ${P.stirGain}, capped at ${P.stirCap}.`, `-${f1(points)}`],
    ],
  };
}

function currentFactor(site, s) {
  const modelKn = (s.current ?? 0) * KMH_TO_KN;
  const effKn = modelKn * site.currentSensitivity;
  const points = Math.min(P.curCap, Math.max(0, effKn - 0.3) * P.curGain);
  return {
    key: "current",
    label: "Current",
    points,
    effKn,
    tone: effKn > 1.2 ? "bad" : effKn > 0.6 ? "warn" : "good",
    headline: `About ${f1(effKn, 1)} kn expected here`,
    inputs: [
      ["Regional model current", `${f1(modelKn, 2)} kn toward ${compass(s.currentDir)}`],
      ["Site exposure to flow", `×${site.currentSensitivity}`],
    ],
    chain: [
      ["Regional value",
       "Sampled from a grid cell well offshore, so it describes the strait rather than the shoreline.",
       `${f1(modelKn, 2)} kn`],
      ["Site amplification",
       `Headlands and walls speed flow up; sheltered bays slow it. This site is calibrated at ×${site.currentSensitivity}.`,
       `×${site.currentSensitivity}`],
      ["Not scaled by tide",
       "The current model already includes tidal currents, and over a spring-neap cycle the tidal range does not track the current speed here. Tide is reported, not applied.",
       "×1.00"],
      ["Penalty", `Everything above ${0.3} kn costs ${P.curGain} points per knot, capped at ${P.curCap}.`, `-${f1(points)}`],
    ],
  };
}

function rainFactor(site, s) {
  const r = s.rain24 ?? 0;
  const points = Math.min(P.rainCap, Math.pow(r, 0.7) * 2.2 * site.runoff);
  return {
    key: "rain",
    label: "Runoff",
    points,
    tone: points > 10 ? "bad" : points > 3 ? "warn" : "good",
    headline: r < 0.5 ? "No meaningful runoff" : `${f1(r)} mm fell in the last 24 h`,
    inputs: [
      ["Rain, previous 24 h", `${f1(r)} mm`],
      ["Site runoff sensitivity", `×${site.runoff}`],
    ],
    chain: [
      ["Rainfall history",
       "Summed over the full 24 h before the selected hour, using observed past hours where the model has them.",
       `${f1(r)} mm`],
      ["Runoff response",
       `Compressed as mm^0.7 because the first few mm wash the most material off the land. Site sensitivity ×${site.runoff}.`,
       `-${f1(points)}`],
    ],
  };
}

function windFactor(site, s) {
  const w = s.wind ?? 0;
  const onshore = onshoreFraction(site, s.windDir);
  const fetchFactor = clamp(fetchAt(site, s.windDir ?? 0) / 20, 0.3, 1);
  const points = Math.min(P.windCap, Math.max(0, w - 8) * (0.15 + 0.55 * onshore) * fetchFactor);
  return {
    key: "wind",
    label: "Wind & surface",
    points,
    onshore,
    tone: points > 10 ? "bad" : points > 4 ? "warn" : "good",
    headline: w < 8 ? "Light wind, glassy surface likely"
      : onshore > 0.5 ? `${f1(w, 0)} km/h blowing onshore` : `${f1(w, 0)} km/h, mostly offshore`,
    inputs: [
      ["Wind", `${f1(w, 0)} km/h from ${compass(s.windDir)}`],
      ["Onshore component", `${Math.round(onshore * 100)}%`],
      ["Fetch that way", `${f1(fetchAt(site, s.windDir ?? 0), 0)} km`],
    ],
    chain: [
      ["Onshore or offshore",
       `This shore faces ${site.shoreNormalDeg}°. Wind from ${compass(s.windDir)} is ${Math.round(onshore * 100)}% onshore. Offshore wind flattens the surface; onshore wind builds chop and makes a shore entry harder.`,
       `${Math.round(onshore * 100)}% on`],
      ["Fetch limit",
       "Chop needs open water to build, so a short fetch caps how rough it can get.",
       `×${f1(fetchFactor, 2)}`],
      ["Penalty", `Everything above 8 km/h, weighted by direction, capped at ${P.windCap}.`, `-${f1(points)}`],
    ],
  };
}

/* ------------------------------------------------------------------- public */

/** Best score this site could reach under ideal forcing. Preserves the real
 *  ceiling: a muck site never becomes a wall dive, and that is worth showing. */
export function siteCeiling(site) {
  const calm = {
    swellH: 0.08, swellT: 5, swellDir: site.shoreNormalDeg,
    windWaveH: 0, windWaveT: 0, waveH: 0.08, waveT: 5,
    current: 0.15, currentDir: 0, wind: 4, windDir: (site.shoreNormalDeg + 180) % 360, rain24: 0,
  };
  const fs = [swellFactor(site, calm), currentFactor(site, calm),
              rainFactor(site, calm), windFactor(site, calm)];
  return Math.round(clamp(siteBase(site) - fs.reduce((a, f) => a + f.points, 0), P.floor, 100));
}

export function evaluate(site, s, tide, leadHours = 0) {
  const factors = [
    swellFactor(site, s),
    currentFactor(site, s),
    rainFactor(site, s),
    windFactor(site, s),
  ];
  const penalty = factors.reduce((a, f) => a + f.points, 0);
  const base = siteBase(site);
  const score = Math.round(clamp(base - penalty, P.floor, 100));

  const ceiling = site._ceiling ?? (site._ceiling = siteCeiling(site));
  const relative = clamp(score / ceiling, 0, 1);

  // Visibility attenuates multiplicatively -- turbidity sources compound.
  const swell = factors[0], cur = factors[1], rain = factors[2];
  const atten = 3.0 * Math.max(0, swell.ub - swell.uCrit)
              + 0.030 * rain.points
              + 0.10 * Math.max(0, cur.effKn - 0.8);
  const vis = clamp(site.maxVis * Math.exp(-atten), 3, site.maxVis);
  // Band widens with lead time: +/-15% now, growing to +/-40% at 48 h.
  const spread = 0.15 + 0.25 * clamp(leadHours / 48, 0, 1);

  // Difficulty is a separate question from clarity. A 1.5 kn drift in 30 m vis is
  // a great dive for some divers and disqualifying for others. What makes a dive
  // hard here is surf at the entry, flow, and surface chop.
  const entryWeight = site.entry === "shore" ? 1 : 0.45;
  const difficulty = clamp(
    40 * swell.hEff * entryWeight
    + 30 * Math.max(0, cur.effKn - 0.3)
    + 0.8 * factors[3].points, 0, 100);

  // Confidence is a function of real lead time and data coverage. The previous
  // version compared an absolute array index against 24, which made confidence
  // depend on the time of day the page was opened.
  const coverage = [s.swellH, s.swellT, s.current, tide.height].filter(Number.isFinite).length;
  const confidence = coverage < 3 ? { label: "Low", tone: "bad" }
    : leadHours <= 12 ? { label: "Moderate", tone: "good" }
    : leadHours <= 30 ? { label: "Low\u2013moderate", tone: "warn" }
    : { label: "Low", tone: "warn" };

  return {
    score, ceiling, relative, factors, penalty, base,
    confidence: { ...confidence, leadHours, coverage },
    vis: { m: vis, lo: Math.max(2, vis * (1 - spread)), hi: vis * (1 + spread) },
    difficulty: {
      value: difficulty,
      label: difficulty > 45 ? "Demanding" : difficulty > 22 ? "Moderate" : "Easy",
      tone: difficulty > 45 ? "bad" : difficulty > 22 ? "warn" : "good",
    },
    tide,
  };
}

export const QUALITY = [
  [80, "Excellent", "excellent"],
  [64, "Good", "good"],
  [45, "Fair", "fair"],
  [0,  "Poor", "poor"],
];
export const quality = (score) => QUALITY.find(([t]) => score >= t).slice(1);

/**
 * Relative-mode quality bands. A site at 90%+ of its own ceiling is having about
 * as good a day as it can, whatever its absolute number.
 */
export const relQuality = (pct) =>
  pct >= 90 ? "excellent" : pct >= 75 ? "good" : pct >= 55 ? "fair" : "poor";

/**
 * One place that decides what a score *reads* as, so the map pills, the site
 * chips and the ring can never disagree about the active mode.
 */
export function display(result, mode) {
  if (mode === "relative") {
    const v = Math.round(result.relative * 100);
    return { value: v, text: `${v}%`, cls: relQuality(v), label: relLabel(v) };
  }
  const [label, cls] = quality(result.score);
  return { value: result.score, text: String(result.score), cls, label };
}

const relLabel = (pct) =>
  pct >= 90 ? "About as good as it gets here"
  : pct >= 75 ? "A good day for this site"
  : pct >= 55 ? "Below what this site can offer"
  : "Well below this site's best";
