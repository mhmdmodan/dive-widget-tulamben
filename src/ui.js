// Rendering. Progressive disclosure is built on native <details> so every lever
// is keyboard reachable and screen-reader announced without extra scripting.

import { SITES } from "./sites.js";
import { quality, display } from "./scoring.js";
import { compass, KMH_TO_KN } from "./physics.js";
import { weatherLabel, weatherIcon, dailyFor, parseTime } from "./api.js";
import { timeScrub, scoreStrip, scoreBar, scoreKey } from "./charts.js";

export const units = { speed: "kn", length: "m" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (s, r = document) => r.querySelector(s);

export const speed = (kmh) => kmh == null ? "--"
  : units.speed === "kn" ? `${(kmh * KMH_TO_KN).toFixed(1)} kn` : `${kmh.toFixed(1)} km/h`;
export const speedKn = (kn) => kn == null ? "--"
  : units.speed === "kn" ? `${kn.toFixed(1)} kn` : `${(kn / KMH_TO_KN).toFixed(1)} km/h`;
export const len = (m) => m == null ? "--"
  : units.length === "m" ? `${Math.round(m)} m` : `${Math.round(m * 3.28084)} ft`;
export const lenRange = (a, b) => units.length === "m"
  ? `${Math.round(a)}–${Math.round(b)} m`
  : `${Math.round(a * 3.28084)}–${Math.round(b * 3.28084)} ft`;

const fmtTime = (t) => new Intl.DateTimeFormat("en-GB",
  { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Makassar" })
  .format(parseTime(t));
const fmtHM = (t) => t ? t.slice(11, 16) : "--";

/**
 * A rotated arrow showing where something is *going*, plus the bearing in
 * degrees. "From ESE" is neither granular nor quick to read; an arrow is both.
 * Wave and wind bearings are reported as the direction they come FROM, so the
 * glyph is turned 180 degrees to point along travel. Current is already a
 * "toward" bearing and is drawn as given.
 */
function dirArrow(deg, kind = "from") {
  if (deg == null) return '<span class="dir"><span class="dir-na">--</span></span>';
  const travel = kind === "from" ? (deg + 180) % 360 : deg;
  return `<span class="dir">
    <svg viewBox="0 0 24 24" class="dir-arrow" style="transform:rotate(${travel.toFixed(0)}deg)" aria-hidden="true">
      <path d="M12 3 L12 21 M12 3 L7 9 M12 3 L17 9" />
    </svg>
    <span class="dir-deg">${Math.round(deg)}\u00b0</span>
  </span>`;
}

/* ------------------------------------------------------------------- header */

export function renderStatus(el, { updated, error, stale }) {
  if (error) {
    el.className = "status error";
    el.innerHTML = `<span></span> ${esc(error)}`;
    return;
  }
  const mins = Math.round((Date.now() - updated) / 60000);
  el.className = `status ${stale ? "warn" : "ready"}`;
  el.innerHTML = `<span></span> Live model data · updated ${mins < 1 ? "just now" : `${mins} min ago`}`;
}

/* ---------------------------------------------------------------- time bar */

const fmtDate = (t) => `${+t.slice(8, 10)}/${+t.slice(5, 7)}`;

/**
 * The time bar owns "when": the selected hour, the scrub track with its day/night
 * banding and day labels, and the tide curve (which is the same everywhere on
 * this coast, so it belongs here rather than in a per-site panel).
 *
 * The slider element is created once and only has its value written afterwards.
 * Rebuilding it on every render is what made dragging impossible before: the
 * input under the pointer was destroyed on the first input event, so a drag
 * turned into a single step.
 */
export function renderTimeBar(el, ctx) {
  const { data, index, nowIdx, from, to, tideHeights, tide } = ctx;
  if (el.dataset.window !== `${from}:${to}`) {
    el.dataset.window = `${from}:${to}`;
    el.innerHTML = `
      <div class="tb-head"></div>
      <div class="scrub">
        <div class="scrub-view"></div>
        <input id="timeSlider" type="range" min="${from}" max="${to}" step="1" value="${index}"
               aria-label="Forecast hour" />
      </div>
      <p class="scrub-note"></p>`;
  }

  const t = data.time[index];
  const lead = index - nowIdx;
  const leadLabel = lead === 0 ? "now" : lead > 0 ? `+${lead} h` : `${lead} h`;
  const day = dailyFor(data, t);

  $(".tb-head", el).innerHTML = `
    <button class="tb-step" data-step="-1" aria-label="Previous hour">−</button>
    <div class="time-now">
      <strong>${esc(fmtTime(t))}</strong>
      <span class="time-date">${fmtDate(t)}</span>
      <span class="lead ${lead === 0 ? "is-now" : ""}">${leadLabel}</span>
    </div>
    <button class="tb-step" data-step="1" aria-label="Next hour">+</button>
    <button class="tb-jump" data-jump="now" ${lead === 0 ? "disabled" : ""}>Jump to now</button>
    <div class="tb-facts">
      <span class="tb-tide"><b>${esc(tide.phase)}</b> ${tide.height?.toFixed(2) ?? "--"} m
        <em>range ${tide.range?.toFixed(2) ?? "--"} m · ${tide.springFactor > 1.15 ? "springs" : tide.springFactor < 0.85 ? "neaps" : "mid-range"}</em></span>
      <span class="tb-sun">☀ ${fmtHM(day?.sunrise)} · ☾ ${fmtHM(day?.sunset)}</span>
    </div>`;

  $(".scrub-note", el).innerHTML =
    "Tide is sea level. Slack tide does not mean slack current here.";

  $(".scrub-view", el).innerHTML = timeScrub({
    times: data.time, heights: tideHeights, isDay: data.weather.hourly.is_day,
    from, to, selected: index, now: nowIdx,
  });

  const slider = $("#timeSlider", el);
  if (+slider.value !== index) slider.value = index;
  slider.setAttribute("aria-valuetext", `${fmtTime(t)}, tide ${tide.height?.toFixed(2) ?? "--"} m`);
}

/* --------------------------------------------------------------- site list */

export function renderSiteList(el, ctx) {
  const { results, selected, mode } = ctx;
  // Deliberately in coast order (Kubu in the north to Amed in the south), not
  // sorted by score. Ranking implied a precision the model does not have, and
  // buried the geography that actually helps you choose.
  el.innerHTML = `
    <div class="list-head">
      <h2>Sites</h2>
      <span class="list-sub">Kubu \u2192 Amed</span>
    </div>
    <ul class="site-list">
      ${SITES.map((s) => {
        const r = results.get(s.id);
        if (!r) return "";
        const dsp = display(r, mode);
        return `
        <li>
          <button class="site-row ${selected === s.id ? "sel" : ""}" data-site="${s.id}"
                  aria-pressed="${selected === s.id}">
            <span class="row-main">
              <span class="row-name">${esc(s.name)}</span>
              <span class="row-meta">${esc(s.area)} \u00b7 vis ${lenRange(r.vis.lo, r.vis.hi)}</span>
            </span>
            <span class="row-score ${dsp.cls}">${dsp.text}</span>
          </button>
        </li>`;
      }).join("")}
    </ul>`;
}

/* ----------------------------------------------------------------- weather */

export function renderWeather(el, ctx) {
  const { data, index, sample } = ctx;
  const s = sample;
  const day = dailyFor(data, data.time[index]);
  const gust = s.gust != null && s.gust > (s.wind ?? 0) * 1.35;
  el.innerHTML = `
    <div class="wx-head">
      <h2>Weather</h2>
      <span class="wx-cond icon-${weatherIcon(s.code)}">${esc(weatherLabel(s.code))}</span>
    </div>
    <div class="wx-grid">
      <div class="wx-cell"><small>Air</small><strong>${s.airTemp?.toFixed(0) ?? "--"}°C</strong>
        <span>feels ${s.feelsLike?.toFixed(0) ?? "--"}°</span></div>
      <div class="wx-cell"><small>Wind</small><strong>${speed(s.wind)}</strong>
        <span>from ${compass(s.windDir)}${gust ? ` · gusts ${speed(s.gust)}` : ""}</span></div>
      <div class="wx-cell"><small>Rain chance</small><strong>${s.precipProb ?? 0}%</strong>
        <span>${s.precip ? `${s.precip.toFixed(1)} mm this hour` : "dry now"}</span></div>
      <div class="wx-cell"><small>Cloud</small><strong>${s.cloud ?? "--"}%</strong>
        <span>UV ${s.uv?.toFixed(0) ?? "--"}${day ? ` · peak ${day.uvMax?.toFixed(0)}` : ""}</span></div>
    </div>
    <div class="wx-foot">
      <span>☀ ${fmtHM(day?.sunrise)}</span><span>☾ ${fmtHM(day?.sunset)}</span>
      <span>Rain last 24 h: <b>${s.rain24.toFixed(1)} mm</b></span>
    </div>
    <p class="wx-note">Weather is sampled from one inland-coast grid cell for the whole
      area. Land and sea breezes off Agung are not resolved at this scale.</p>`;
}

/* ------------------------------------------------------------- site detail */

function factorRow(f, open) {
  const pts = f.points < 0.4 ? "0" : `−${f.points.toFixed(1)}`;
  return `
  <details class="factor ${f.tone}" data-factor="${f.key}" ${open ? "open" : ""}>
    <summary>
      <span class="f-dot"></span>
      <span class="f-label">${esc(f.label)}</span>
      <span class="f-headline">${esc(f.headline)}</span>
      <span class="f-points">${pts}</span>
    </summary>
    <div class="f-body">
      <table class="f-inputs"><tbody>
        ${f.inputs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}
      </tbody></table>
      <ol class="f-chain">
        ${f.chain.map(([step, detail, value]) => `
          <li><div class="fc-head"><b>${esc(step)}</b><code>${esc(value)}</code></div>
              <p>${esc(detail)}</p></li>`).join("")}
      </ol>
    </div>
  </details>`;
}

export function renderSitePanel(el, ctx) {
  const { site, result, sample: s, data, index, from, to, nowIdx, cell, scores,
          isDay, openFactor, mode, bestWindow } = ctx;
  if (!site) {
    el.innerHTML = `<div class="panel-placeholder">
      <h2>Pick a site</h2><p>Choose any row on the left or a marker on the map.</p></div>`;
    return;
  }
  const dsp = display(result, mode);

  el.innerHTML = `
  <div class="panel-head">
    <div>
      <p class="eyebrow">${esc(site.area)} · ${site.entry === "boat" ? "boat access" : "shore entry"} · ${esc(len(site.depthM))} typical</p>
      <h2>${esc(site.name)}</h2>
    </div>
    <div class="score-ring ${dsp.cls}"><strong>${dsp.text}</strong>
      <span>${mode === "relative" ? "of best here" : "/ 100"}</span></div>
  </div>

  <div class="quality-row">
    <span class="quality-pill ${dsp.cls}">${esc(dsp.label)}</span>
    <span class="pill-ghost">${esc(result.difficulty.label)} for effort</span>
    <span class="pill-ghost conf-${result.confidence.tone}"
          title="Forecast lead time ${result.confidence.leadHours} h; ${result.confidence.coverage} of 4 forcing variables present">
      ${esc(result.confidence.label)} confidence</span>
  </div>

  <section class="block">
    <h3>Where the score went</h3>
    ${scoreBar(result, mode)}
    ${scoreKey(result, mode)}
    <div class="factors">${result.factors.map((f) => factorRow(f, f.key === openFactor)).join("")}</div>
    <p class="block-note">Each band above is the lever of the same colour below it.
      Open one to see its exact inputs and every step of the calculation. Site
      constants are hand calibration; everything else is live model data.</p>
  </section>

  <section class="block">
    <h3>What you can expect underwater</h3>
    <div class="metrics">
      <div class="metric ${result.vis.m >= 18 ? "good" : result.vis.m >= 10 ? "warn" : "bad"}">
        <small>Visibility</small><strong>${lenRange(result.vis.lo, result.vis.hi)}</strong>
        <span>ceiling here ${len(site.maxVis)}</span></div>
      <div class="metric ${result.difficulty.tone}">
        <small>Effort</small><strong>${esc(result.difficulty.label)}</strong>
        <span>current ${speedKn(result.factors[1].effKn)}</span></div>
      <div class="metric neutral">
        <small>Water</small><strong>${s.seaTemp?.toFixed(1) ?? "--"}°C</strong>
        <span>${s.seaTemp == null ? "" : s.seaTemp >= 28 ? "3 mm is plenty" : s.seaTemp >= 26 ? "3 mm, 5 mm if you feel cold" : "5 mm"}</span></div>
      <div class="metric neutral">
        <small>Surface</small><strong>${speed(s.wind)}</strong>
        <span>${Math.round(result.factors[3].onshore * 100)}% onshore</span></div>
    </div>
    <p class="block-note">Visibility is inferred from wave energy at the bed and runoff,
      not measured. The band widens with forecast lead time.</p>
  </section>

  <section class="block">
    <div class="block-head">
      <h3>Next 48 hours here</h3>
      ${bestWindow ? `<span class="best-window">Best: <b>${esc(bestWindow)}</b></span>` : ""}
    </div>
    ${scoreStrip(scores, { from, to, selected: index, now: nowIdx, isDay, mode, ceiling: result.ceiling })}
    <div class="strip-axis"><span>now</span><span>+24 h</span><span>+48 h</span></div>
    <p class="block-note">Dimmed hours are after dark. Tap any hour to jump to it.</p>
  </section>

  <details class="block provenance">
    <summary><h3>Where this data comes from</h3></summary>
    <p>${esc(site.desc)}</p>
    <table class="f-inputs"><tbody>
      <tr><th>Marine model cell</th><td>${cell.km.toFixed(1)} km ${compass(cell.bearing)} of the site</td></tr>
      <tr><th>Distinct cells for 8 sites</th><td>${data.distinctCells}</td></tr>
      <tr><th>Shore aspect</th><td>${site.shoreNormalDeg}° (${compass(site.shoreNormalDeg)}), from OSM coastline</td></tr>
      <tr><th>Distance to shore</th><td>${site.shoreDistM} m</td></tr>
      <tr><th>Sediment bed depth</th><td>${site.bedDepthM} m (hand-set; GEBCO cannot resolve it)</td></tr>
    </tbody></table>
    <p class="block-note">The marine model snaps each request to its nearest open-water cell,
      which on this coast is far offshore. Several sites share one cell, so differences between
      them come from the calibrated site constants above, not from separate forecasts. This is
      regional forcing plus local knowledge — treat it as a planning aid, not an observation.</p>
  </details>`;
}

/* ------------------------------------------------------ map conditions HUD */

export function renderHud(el, ctx) {
  const { sample: s } = ctx;
  // Direction only. Current *strength* is site-specific -- the same hour reads
  // 0.2 kn at Coral Garden and 1.2 kn at Amed Pyramids -- so a single number on
  // a map covering both was contradicting the site panel. Only direction is
  // regional enough to show once.
  el.innerHTML = `
    <div class="hud-row"><small>Current</small>
      <span class="hud-val">${dirArrow(s.currentDir, "toward")}</span></div>
    <div class="hud-row"><small>Swell</small>
      <span class="hud-val">${dirArrow(s.swellDir, "from")}<strong>${s.swellH?.toFixed(1) ?? "--"} m<em>${s.swellT?.toFixed(0) ?? "--"} s</em></strong></span></div>
    <div class="hud-row"><small>Wind</small>
      <span class="hud-val">${dirArrow(s.windDir, "from")}<strong>${speed(s.wind)}</strong></span></div>
    <p class="hud-note">Arrows point the way the water or air is travelling.
      Current strength varies site by site — it is in the panel below.</p>`;
}
