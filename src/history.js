// Conditions have memory. Sediment does not fall out of the water column the
// moment the swell drops, and a river plume outlasts the rain that made it, so
// scoring the selected hour on that hour's forcing alone reports a clean
// afternoon after a rough morning -- exactly when it is worst.
//
// Both are modelled the same way: a state driven by an hourly source term that
// decays exponentially. The recursion runs over the whole loaded window, and
// the request already brings 72 h of past hours down with the forecast, so
// nothing has to be cached between page loads and no backend is involved.
//
// The past hours are the model's own hindcast, not observations. If the model
// had this morning wrong, the memory inherits that error -- it just stops
// compounding it into a falsely perfect afternoon.

import { clamp, stirSource } from "./physics.js";

/**
 * Settling time constant, hours. Sediment is the same calibration that sets how
 * easily the bed moves: fine, light material is both stirred sooner and slower
 * to fall back out. Coral Garden's cobble (0.85) clears in about 5 h, Seraya's
 * very fine black sand (1.35) takes nearly 7.
 *
 * Stokes settling puts fine sand (~125 um) on the seabed within the hour and
 * silt (~20 um) many hours later; the murk is the fine tail of the mix, so a
 * few hours is the right order of magnitude. The exact number is a calibration,
 * not a measurement -- see docs/scoring.md.
 */
export const settleHours = (site) => clamp(2.0 + 3.6 * site.sediment, 3, 9);

/** Runoff plume time constant, hours. Slower than sand: it is fines and fresh water. */
export const RUNOFF_HOURS = 30;

const cache = new WeakMap();

/**
 * Suspended-sediment and runoff state for one site across every loaded hour.
 * Memoised per forecast payload, so a full render costs one pass, not one per
 * hour per site.
 */
export function history(data, siteIndex, site) {
  let per = cache.get(data);
  if (!per) cache.set(data, (per = new Map()));
  const hit = per.get(site.id);
  if (hit) return hit;

  const n = data.time.length;
  const m = data.marine[siteIndex].hourly;
  const w = data.weather.hourly;

  const tau = settleHours(site);
  const decay = Math.exp(-1 / tau);
  const rainDecay = Math.exp(-1 / RUNOFF_HOURS);
  // Normalised so steady rain reads the same as the 24 h box sum it replaces.
  // Only bursts differ -- which is the whole point of the change.
  const rainNorm = (1 - rainDecay) * 24;

  const stir = new Array(n);
  const rain = new Float64Array(n);
  let c = 0, peakIdx = 0, peakExcess = 0, r = 0;

  for (let i = 0; i < n; i++) {
    const now = stirSource(site, {
      swellH: m.swell_wave_height?.[i], swellT: m.swell_wave_period?.[i],
      swellDir: m.swell_wave_direction?.[i],
      windWaveH: m.wind_wave_height?.[i], windWaveT: m.wind_wave_period?.[i],
      windWaveDir: m.wind_wave_direction?.[i],
      waveH: m.wave_height?.[i], waveT: m.wave_period?.[i], waveDir: m.wave_direction?.[i],
    }).excess;

    // Stirring is fast and settling is slow, so the state jumps to any stronger
    // forcing at once and only ever decays away from it. A symmetric filter
    // would smear the leading edge of a swell event that arrives in an hour.
    const carried = c * decay;
    if (now >= carried) { c = now; peakIdx = i; peakExcess = now; }
    else c = carried;

    stir[i] = { excess: c, now, peakExcess, tau, age: i - peakIdx };

    r = r * rainDecay + (w.rain?.[i] ?? w.precipitation?.[i] ?? 0);
    rain[i] = r * rainNorm;
  }

  const out = { stir, rain, tau };
  per.set(site.id, out);
  return out;
}
