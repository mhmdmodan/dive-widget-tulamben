// Map layer: a theme-aware basemap and decluttered site pills drawn on a canvas
// overlay, so the four Tulamben sites that sit within ~600 m of each other stay
// readable instead of stacking into a blob.
//
// The canvas is a visual aid only. The site list carries the same information
// and is the keyboard-navigable interface.

import { SITES } from "./sites.js";
import { display } from "./scoring.js";

const TILES = {
  dark: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  light: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
};

const prefersLight = () => !matchMedia("(prefers-color-scheme: dark)").matches;

export class DiveMap {
  constructor(el, { onSelect }) {
    this.onSelect = onSelect;
    this.results = new Map();
    this.selected = null;
    this.mode = "absolute";
    this.labels = [];
    this.zooming = false;
    this.light = prefersLight();

    this.map = L.map(el, { zoomControl: false, attributionControl: true })
      .setView([-8.298, 115.625], 12);
    L.control.zoom({ position: "bottomleft" }).addTo(this.map);
    this.tiles = L.tileLayer(this.light ? TILES.light : TILES.dark, {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      referrerPolicy: "strict-origin-when-cross-origin",
    }).addTo(this.map);
    this.map.fitBounds(L.latLngBounds(SITES.map((s) => [s.lat, s.lon])).pad(0.18));

    const pane = this.map.createPane("fx");
    pane.style.zIndex = 460;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "fx-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label",
      "Dive sites on the northeast Bali coast. The site list carries the same information.");
    pane.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.canvas.style.pointerEvents = "auto";
    this.canvas.addEventListener("click", (e) => this.hit(e));
    this.canvas.addEventListener("mousemove", (e) => this.hover(e));

    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.light = prefersLight();
      this.tiles.setUrl(this.light ? TILES.light : TILES.dark);
      this.drawMarkers();
    });

    // Leaflet moves its own panes; ours only follows because we make it.
    // Panning must repaint, not just reposition: repositioning alone pins the
    // canvas to the viewport while its pixels still belong to the previous view,
    // so the pills appear to float free of the coast. Mid-zoom, container
    // coordinates mean nothing -- Leaflet is running a CSS transform -- so the
    // canvas rides the same transform and repaints when the zoom lands.
    this.map.on("move", () => { if (!this.zooming) { this.reposition(); this.drawMarkers(); } });
    this.map.on("zoomstart", () => { this.zooming = true; });
    this.map.on("zoomanim", (e) => this.animateZoom(e));
    this.map.on("zoomend viewreset", () => {
      this.zooming = false;
      this.reposition();
      this.drawMarkers();
    });
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  resize() {
    const size = this.map.getSize();
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (this._w === size.x && this._h === size.y && this._dpr === dpr) return;
    this._w = size.x; this._h = size.y; this._dpr = dpr;
    this.canvas.width = size.x * dpr;
    this.canvas.height = size.y * dpr;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.dpr = dpr;
    this.map.invalidateSize({ pan: false });
    this.reposition();
    this.drawMarkers();
  }

  /** Keep the canvas pinned to the map origin as Leaflet pans. */
  reposition() {
    L.DomUtil.setPosition(this.canvas, this.map.containerPointToLayerPoint([0, 0]));
  }

  /**
   * Ride Leaflet's zoom animation instead of fighting it: place and scale the
   * canvas so its pixels land where the animation is taking the tiles. Leaflet's
   * own vector renderer does the same thing with the same private helper.
   * setPosition() at zoomend replaces the transform outright, clearing the scale.
   */
  animateZoom(e) {
    const m = this.map;
    const scale = m.getZoomScale(e.zoom, m.getZoom());
    const p0 = m.project(m.containerPointToLatLng([0, 0]), m.getZoom());
    const offset = p0.multiplyBy(scale).subtract(m._getNewPixelOrigin(e.center, e.zoom));
    L.DomUtil.setTransform(this.canvas, offset, scale);
  }

  setResults(results, selected, mode) {
    this.results = results;
    this.selected = selected;
    this.mode = mode || "absolute";
    this.drawMarkers();
  }

  /**
   * Anchor dots stay at true coordinates; pills are pushed apart by a few rounds
   * of pairwise repulsion and joined back with a leader line.
   */
  layout() {
    const wide = this.mode === "relative" ? 50 : 44;
    const pts = SITES.map((s) => {
      const p = this.map.latLngToContainerPoint([s.lat, s.lon]);
      return { site: s, ax: p.x, ay: p.y, x: p.x, y: p.y - 22, w: wide, h: 25 };
    });
    for (let it = 0; it < 60; it++) {
      let moved = false;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i], b = pts[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const mx = (a.w + b.w) / 2 + 6, my = (a.h + b.h) / 2 + 4;
          const ox = mx - Math.abs(dx), oy = my - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            moved = true;
            if (ox / mx < oy / my) { const s = (dx >= 0 ? 1 : -1) * ox / 2; a.x -= s; b.x += s; }
            else { const s = (dy >= 0 ? 1 : -1) * oy / 2; a.y -= s; b.y += s; }
          }
        }
      }
      if (!moved) break;
    }
    this.labels = pts;
    return pts;
  }

  drawMarkers() {
    const ctx = this.ctx, d = this.dpr;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const css = getComputedStyle(document.documentElement);
    const pillBg = css.getPropertyValue("--pill-bg").trim() || "rgba(8,22,29,.92)";
    const pillInk = css.getPropertyValue("--pill-ink").trim() || "#04141a";
    const leader = css.getPropertyValue("--leader").trim() || "rgba(190,225,235,.42)";

    ctx.save();
    ctx.scale(d, d);
    for (const p of this.layout()) {
      const r = this.results.get(p.site.id);
      if (!r) continue;
      const dsp = display(r, this.mode);
      const col = css.getPropertyValue(`--${dsp.cls}`).trim() || "#7cc";
      const sel = this.selected === p.site.id;

      if (Math.hypot(p.x - p.ax, p.y - p.ay) > 3) {
        ctx.strokeStyle = leader;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.ax, p.ay); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(p.ax, p.ay, sel ? 4.5 : 3, 0, 7); ctx.fill();
      ctx.strokeStyle = pillBg; ctx.lineWidth = 1.5; ctx.stroke();

      const w = p.w, h = p.h, x = p.x - w / 2, y = p.y - h / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h / 2);
      ctx.fillStyle = sel ? col : pillBg;
      ctx.fill();
      ctx.lineWidth = sel ? 2 : 1.4;
      ctx.strokeStyle = col;
      ctx.stroke();

      ctx.font = "700 12.5px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = sel ? pillInk : col;
      ctx.fillText(dsp.text, p.x, p.y + 0.5);
    }
    ctx.restore();
  }

  pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    for (const p of this.labels) {
      if (Math.abs(x - p.x) < p.w / 2 + 2 && Math.abs(y - p.y) < p.h / 2 + 2) return p.site;
      if (Math.hypot(x - p.ax, y - p.ay) < 10) return p.site;
    }
    return null;
  }

  hit(e) { const s = this.pick(e); if (s) this.onSelect(s.id); }
  hover(e) { this.canvas.style.cursor = this.pick(e) ? "pointer" : ""; }
}
