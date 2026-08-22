// Small dependency-free SVG charts. Each returns an SVG string.

import { quality, relQuality } from "./scoring.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Catmull-Rom through the points, emitted as cubic beziers. */
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * The scrub track that sits behind the time slider: day/night banding, a tick
 * and label per calendar day, the tide curve across the whole window, and
 * markers for "now" and the selected hour.
 *
 * Tide heads the app rather than the site panel because it is effectively
 * site-agnostic: the eight sites snap to three marine model cells whose sea
 * level differs by at most 0.03 m against a ~1.1 m range. Scoring still uses
 * each site's own series -- only this display is shared.
 *
 * Returns HTML, not one SVG. Text in a full-width SVG has to be stretched with
 * preserveAspectRatio="none" and comes out visibly distorted, so only the curve
 * is drawn as SVG and every label is positioned HTML.
 */
const MIN_SWING = 0.1;         // metres the water must fall back for a turn to count

export function timeScrub({ times, heights, isDay, from, to, selected, now }) {
  const span = Math.max(1, to - from);
  const pct = (i) => ((i - from) / span) * 100;
  const at = (v, lo = 1.5, hi = 98.5) => Math.min(hi, Math.max(lo, v));

  // Day/night bands, merged into runs so the DOM holds a handful of blocks
  // rather than one per hour.
  const bands = [];
  for (let i = from; i <= to; ) {
    const night = !isDay?.[i];
    let j = i;
    while (j + 1 <= to && (!isDay?.[j + 1]) === night) j++;
    if (night) bands.push(`<i class="band" style="left:${pct(i).toFixed(2)}%;width:${(pct(j + 1) - pct(i)).toFixed(2)}%"></i>`);
    i = j + 1;
  }

  // Midnight ticks, and a day label centred in each calendar day on screen.
  const ticks = [], days = [];
  const bounds = [from];
  for (let i = from + 1; i <= to; i++) if (times[i]?.slice(11, 13) === "00") bounds.push(i);
  bounds.push(to + 1);
  for (let n = 0; n < bounds.length - 1; n++) {
    const a = bounds[n], b = bounds[n + 1];
    if (n > 0) ticks.push(`<i class="tick" style="left:${pct(a).toFixed(2)}%"></i>`);
    const d = times[a];
    if (!d) continue;
    const date = `${+d.slice(8, 10)}/${+d.slice(5, 7)}`;
    const wd = new Date(`${d}:00+08:00`);
    const long = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "Asia/Makassar" }).format(wd);
    const short = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Asia/Makassar" }).format(wd);
    days.push(`<span class="scrub-day" style="left:${pct(a).toFixed(2)}%;width:${(pct(b) - pct(a)).toFixed(2)}%">
      <b class="d-long">${esc(long)}</b><b class="d-short">${esc(short)}</b> ${esc(date)}</span>`);
  }

  // Tide curve.
  const slice = [];
  for (let i = from; i <= to; i++) if (Number.isFinite(heights?.[i])) slice.push([i, heights[i]]);
  let curve = "", marks = "", cursorTop = 50;
  if (slice.length >= 3) {
    const lo = Math.min(...slice.map((s) => s[1]));
    const hi = Math.max(...slice.map((s) => s[1]));
    const range = Math.max(0.25, hi - lo);
    const padT = 30, padB = 30;
    const x = (i) => (pct(i) / 100) * 1000;
    const y = (v) => padT + (1 - (v - lo) / range) * (100 - padT - padB);
    const pts = slice.map(([i, v]) => [x(i), y(v)]);
    const line = smoothPath(pts);
    curve = `<svg class="scrub-tide" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="tideFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--aqua)" stop-opacity=".28"/>
        <stop offset="100%" stop-color="var(--aqua)" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${line}L1000,100L0,100Z" fill="url(#tideFill)"/>
      <path d="${line}" class="tide-line"/>
    </svg>`;

    // Turning points, by prominence rather than by "higher than its neighbours".
    // This is a mixed tide: it spends hours on a flat shoulder -- 0.62, 0.62,
    // 0.63, 0.65 through one night -- before climbing to the real high, and a
    // plain local-maximum test labels the shoulder "H", which no tide table
    // would. A turn is only a turn once the water has moved back by MIN_SWING,
    // which also makes the marks strictly alternate.
    //
    // The scan runs half a cycle either side of the window (the series is longer
    // than the slider): before it, so the first mark is a real turn rather than
    // wherever the window happens to open, and after it, so a high near the
    // right edge is still confirmed. Only marks inside the window are drawn.
    const scan = [];
    for (let i = Math.max(0, from - 12); i <= Math.min(heights.length - 1, to + 12); i++) {
      if (Number.isFinite(heights[i])) scan.push([i, heights[i]]);
    }
    // (peak/trough, not hi/lo -- those names are already the window's extremes.)
    let peak = scan[0], trough = scan[0], dir = 0;   // +1 rising to a high, -1 falling to a low
    const turns = [];
    for (const p of scan) {
      if (p[1] > peak[1]) peak = p;
      if (p[1] < trough[1]) trough = p;
      if (dir >= 0 && peak[1] - p[1] >= MIN_SWING) { turns.push([...peak, "H"]); dir = -1; trough = p; }
      else if (dir <= 0 && p[1] - trough[1] >= MIN_SWING) { turns.push([...trough, "L"]); dir = 1; peak = p; }
    }
    for (const [i, v, kind] of turns) {
      if (i < from || i > to) continue;
      marks += `<span class="tide-mark ${kind === "H" ? "hi" : "lo"}"
        style="left:${at(pct(i)).toFixed(2)}%;top:${y(v).toFixed(1)}%">${kind} ${esc(times[i].slice(11, 16))}</span>`;
    }
    if (Number.isFinite(heights?.[selected])) cursorTop = y(heights[selected]);
  }

  const nowMark = now >= from && now <= to
    ? `<i class="scrub-now" style="left:${pct(now).toFixed(2)}%"><b>now</b></i>` : "";

  return `<div class="scrub-days">${days.join("")}</div>
    <div class="scrub-plot">
      ${bands.join("")}${curve}${ticks.join("")}${marks}${nowMark}
      <i class="scrub-cursor" style="left:${pct(selected).toFixed(2)}%"><b style="top:${cursorTop.toFixed(1)}%"></b></i>
    </div>`;
}

/**
 * 48-hour score strip for one site. Each cell is an hour, coloured by score,
 * with night hours dimmed. Clickable to jump the whole app to that hour.
 */
export function scoreStrip(scores, { from, to, selected, now, isDay, compact, mode, ceiling }) {
  const cells = [];
  const rel = mode === "relative" && ceiling > 0;
  for (let i = from; i <= to; i++) {
    const s = scores[i];
    // Colour on whichever scale is active, so the strip cannot disagree with the
    // ring above it.
    const cls = s == null ? "poor"
      : rel ? relQuality(Math.round((s / ceiling) * 100)) : quality(s)[1];
    const c = [
      "strip-cell", cls,
      isDay?.[i] ? "" : "night",
      i === selected ? "sel" : "",
      i === now ? "now" : "",
    ].filter(Boolean).join(" ");
    const h = s == null ? 8 : rel ? Math.max(8, (s / ceiling) * 100) : Math.max(8, s);
    cells.push(`<button class="${c}" data-hour="${i}" tabindex="-1" aria-label="hour ${i}, score ${s ?? "n/a"}"><i style="height:${h}%"></i></button>`);
  }
  return `<div class="strip ${compact ? "compact" : ""}">${cells.join("")}</div>`;
}

/**
 * The score budget as a drained bar. Segment colours match the lever accordions
 * below it, so "Swell & sediment -12" in the key and the blue band in the bar
 * and the blue-edged accordion are visibly the same thing.
 *
 * In absolute mode the bar spans 0-100 and ends with a hatched tail for the
 * points this site can never reach. In relative mode it spans the site's own
 * ceiling, so that tail simply does not exist -- which is the whole point of the
 * mode.
 */
export function scoreBar(result, mode = "absolute") {
  const relative = mode === "relative";
  const seg = (w, cls, label, key) =>
    `<button class="bar-seg ${cls}" style="flex:${Math.max(0.0001, w)}" data-factor="${key}"
             title="${esc(label)}" aria-label="${esc(label)}"></button>`;

  const parts = [seg(result.score, "kept", `Kept: ${result.score} of ${result.base} available points`, "")];
  for (const f of result.factors) {
    if (f.points < 0.4) continue;
    parts.push(seg(f.points, `lost ${f.key}`, `${f.label}: minus ${f.points.toFixed(1)} points`, f.key));
  }
  if (!relative) {
    const spare = Math.max(0, 100 - result.base);
    if (spare > 0.4) {
      parts.push(seg(spare, "unreachable",
        `Out of reach at this site: ${spare.toFixed(0)} points. Its best-case visibility caps the score here.`, ""));
    }
  }
  return `<div class="score-bar" role="group" aria-label="Score composition">${parts.join("")}</div>`;
}

/** Legend under the bar. Same colours, same order, clickable to the same lever. */
export function scoreKey(result, mode = "absolute") {
  const items = [`<span class="key-item"><i class="kept"></i>kept <b>${result.score}</b></span>`];
  for (const f of result.factors) {
    if (f.points < 0.4) continue;
    items.push(`<button class="key-item" data-factor="${f.key}"><i class="${f.key}"></i>${esc(f.label)}
      <b>-${f.points.toFixed(0)}</b></button>`);
  }
  if (mode !== "relative") {
    const spare = Math.max(0, 100 - result.base);
    if (spare > 0.4) {
      items.push(`<span class="key-item" title="This site's best-case visibility caps its score">
        <i class="unreachable"></i>out of reach here <b>${Math.round(spare)}</b></span>`);
    }
  }
  return `<div class="bar-key">${items.join("")}</div>`;
}
