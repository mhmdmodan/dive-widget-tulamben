// Entry point: load data, wire controls, keep everything in sync.

import { SITES, SITE_BY_ID } from "./src/sites.js";
import { loadForecast, sample, marineSeries, nowIndex, parseTime } from "./src/api.js";
import { tideState, KMH_TO_KN } from "./src/physics.js";
import { evaluate } from "./src/scoring.js";
import { DiveMap } from "./src/map.js";
import * as ui from "./src/ui.js";

const $ = (s) => document.querySelector(s);
const HORIZON = 48;
const REFRESH_MS = 10 * 60 * 1000;

const state = {
  data: null,
  index: 0, nowIdx: 0, selected: SITES[0].id,
  openFactor: null, updated: 0, error: null,
  scoreMode: localStorage.getItem("scoreMode") === "relative" ? "relative" : "absolute",
  scoreCache: new Map(),
};

let diveMap = null;

/* ----------------------------------------------------------------- compute */

function resultAt(site, i) {
  const n = SITES.indexOf(site);
  const s = sample(state.data, n, i);
  const tide = tideState(marineSeries(state.data, n), i);
  return { r: evaluate(site, s, tide, i - state.nowIdx), s, tide };
}

/** Score series for one site over the whole loaded window, memoised. */
function scoreSeries(site) {
  const key = `${site.id}:${state.nowIdx}`;
  if (state.scoreCache.has(key)) return state.scoreCache.get(key);
  const out = new Array(state.data.time.length).fill(null);
  for (let i = state.nowIdx; i <= Math.min(state.data.time.length - 1, state.nowIdx + HORIZON); i++) {
    out[i] = resultAt(site, i).r.score;
  }
  state.scoreCache.set(key, out);
  return out;
}

/** Longest run of near-peak hours in the horizon, as a readable label. */
function bestWindow(site) {
  const s = scoreSeries(site);
  const from = state.nowIdx, to = Math.min(s.length - 1, from + HORIZON);
  let peak = -1;
  for (let i = from; i <= to; i++) if (s[i] != null && s[i] > peak) peak = s[i];
  if (peak < 0) return null;
  const cut = peak - 4;
  let best = null, run = null;
  for (let i = from; i <= to + 1; i++) {
    const good = i <= to && s[i] != null && s[i] >= cut;
    if (good && !run) run = { a: i, b: i };
    else if (good) run.b = i;
    else if (run) { if (!best || run.b - run.a > best.b - best.a) best = run; run = null; }
  }
  if (!best) return null;
  // A site whose score barely moves will match the whole horizon; quoting that
  // back as a "window" is noise.
  if (best.b - best.a > (to - from) * 0.6) return "consistently good";
  const f = (i) => new Intl.DateTimeFormat("en-GB",
    { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Makassar" })
    .format(parseTime(state.data.time[i]));
  return best.a === best.b ? f(best.a) : `${f(best.a)} – ${f(best.b).split(", ").pop()}`;
}

/* ------------------------------------------------------------------ render */

function render() {
  const { data, index } = state;
  if (!data) return;
  const from = state.nowIdx;
  const to = Math.min(data.time.length - 1, from + HORIZON);
  state.index = Math.max(from, Math.min(to, index));

  const results = new Map();
  for (const site of SITES) results.set(site.id, resultAt(site, state.index).r);

  const site = SITE_BY_ID.get(state.selected);
  const { r: result, s, tide } = resultAt(site, state.index);
  const siteIdx = SITES.indexOf(site);

  ui.renderStatus($("#dataStatus"), { updated: state.updated, error: state.error });
  ui.renderTimeBar($("#timeBar"), {
    data, index: state.index, nowIdx: state.nowIdx, from, to, tide,
    // Tide is shown once for the whole coast: the eight sites resolve to three
    // marine cells whose sea level differs by at most 0.03 m against a ~1.1 m
    // range. Taking the selected site's own series keeps the curve and the
    // numbers beside it consistent with what scoring used.
    tideHeights: marineSeries(data, siteIdx).sea_level_height_msl,
  });

  ui.renderSiteList($("#siteList"), {
    results, selected: state.selected, mode: state.scoreMode });

  ui.renderWeather($("#weather"), { data, index: state.index, sample: s });

  ui.renderSitePanel($("#sitePanel"), {
    site, result, sample: s, data, index: state.index, from, to, nowIdx: state.nowIdx,
    cell: data.cells[siteIdx], scores: scoreSeries(site),
    isDay: data.weather.hourly.is_day, openFactor: state.openFactor,
    mode: state.scoreMode, bestWindow: bestWindow(site),
  });

  ui.renderHud($("#hud"), { sample: s });

  diveMap?.setResults(results, state.selected, state.scoreMode);
}

/* ------------------------------------------------------------------- wiring */

function selectSite(id) {
  if (!SITE_BY_ID.has(id)) return;
  state.selected = id;
  state.openFactor = null;
  render();
  $("#sitePanel")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function setIndex(i) {
  state.index = i;
  render();
}

document.addEventListener("input", (e) => {
  if (e.target.id === "timeSlider") setIndex(+e.target.value);
});

document.addEventListener("change", (e) => {
  if (e.target.id === "scoreMode") {
    // One switch drives the map pills, the site list and the ring together, so
    // there is only ever one number on screen meaning one thing.
    state.scoreMode = e.target.checked ? "relative" : "absolute";
    localStorage.setItem("scoreMode", state.scoreMode);
    render();
  }
});

document.addEventListener("click", (e) => {
  const step = e.target.closest("[data-step]");
  if (step) return setIndex(state.index + +step.dataset.step);

  if (e.target.closest('[data-jump="now"]')) return setIndex(state.nowIdx);

  const row = e.target.closest("[data-site]");
  if (row) return selectSite(row.dataset.site);

  const hour = e.target.closest("[data-hour]");
  if (hour) return setIndex(+hour.dataset.hour);

  const seg = e.target.closest(".bar-seg[data-factor], .key-item[data-factor]");
  if (seg && seg.dataset.factor) {
    state.openFactor = seg.dataset.factor;
    render();
    document.querySelector(`details.factor[data-factor="${state.openFactor}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }

  const unit = e.target.closest("[data-unit]");
  if (unit) {
    const [k, v] = unit.dataset.unit.split(":");
    ui.units[k] = v;
    document.querySelectorAll(`[data-unit^="${k}:"]`)
      .forEach((b) => b.classList.toggle("on", b.dataset.unit === unit.dataset.unit));
    render();
  }
});

document.addEventListener("keydown", (e) => {
  // e.target can be `document` itself, which has no .matches.
  if (e.target instanceof Element && e.target.matches("input, textarea, select")) return;
  if (e.key === "ArrowLeft") { setIndex(state.index - 1); e.preventDefault(); }
  if (e.key === "ArrowRight") { setIndex(state.index + 1); e.preventDefault(); }
});

// Keep the open factor sticky as the user scrubs hours.
document.addEventListener("toggle", (e) => {
  const d = e.target.closest("details.factor");
  if (!d) return;
  state.openFactor = d.open ? d.dataset.factor : (state.openFactor === d.dataset.factor ? null : state.openFactor);
}, true);

/* -------------------------------------------------------------------- boot */

async function boot() {
  try {
    // coastline.json and bathymetry.json are bake-time inputs only (shore normals
    // and fetch tables are already compiled into src/sites.js), so neither is
    // fetched here.
    const data = await loadForecast();

    state.data = data;
    state.updated = Date.now();
    state.nowIdx = nowIndex(data);
    state.index = state.nowIdx;

    const modeBox = $("#scoreMode");
    if (modeBox) modeBox.checked = state.scoreMode === "relative";

    diveMap = new DiveMap($("#map"), { onSelect: selectSite });
    window.__diveMap = diveMap;        // debug handle; harmless in production
    render();

    // Keep "now" honest on a long-lived tab, and pull a fresh model run.
    setInterval(() => {
      const n = nowIndex(state.data);
      if (n !== state.nowIdx) {
        const wasNow = state.index === state.nowIdx;
        state.nowIdx = n;
        state.scoreCache.clear();
        if (wasNow) state.index = n;
        render();
      }
    }, 60_000);

    setInterval(refresh, REFRESH_MS);
  } catch (err) {
    console.error(err);
    state.error = err.message || "Forecast unavailable";
    ui.renderStatus($("#dataStatus"), { error: state.error });
    $("#sitePanel").innerHTML =
      `<div class="panel-placeholder"><h2>Forecast unavailable</h2>
       <p>${err.message}</p><button onclick="location.reload()" class="retry">Retry</button></div>`;
  }
}

async function refresh() {
  try {
    const data = await loadForecast();
    state.data = data;
    state.updated = Date.now();
    state.nowIdx = nowIndex(data);
    state.scoreCache.clear();
    state.error = null;
    render();
  } catch (err) {
    console.warn("refresh failed", err);
  }
}

boot();
