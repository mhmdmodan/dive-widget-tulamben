// Coastline-aware surface current field.
//
// This is NOT a hydrodynamic model. It takes the single coarse offshore vector
// that Open-Meteo provides and redistributes it so that it obeys mass
// conservation around the real coastline and bathymetry:
//
//     u = U_far + grad(phi)      with     div(w * u) = 0
//
// where w is a depth-derived steering weight. Solving for phi gives flow that
// follows the shore, speeds up around headlands and slows inside bays -- the
// kinematic skeleton of the real thing.
//
// What it deliberately cannot do: potential flow has no separation, so there is
// no eddy behind a headland and no washing-machine at the Drop-Off. Those are
// exactly the features divers care about, which is why this is labelled
// interpolation in the UI and never called a forecast.

const RES_M = 150;                     // solver cell size
const ITERS = 600;
const OMEGA = 1.85;                    // SOR relaxation

export class CurrentField {
  constructor(bathy) {
    this.b = bathy;
    const { lat0, lon0, step, nLat, nLon } = bathy;
    this.lat0 = lat0; this.lon0 = lon0;
    this.lat1 = lat0 + step * (nLat - 1);
    this.lon1 = lon0 + step * (nLon - 1);

    const midLat = (lat0 + this.lat1) / 2;
    this.mPerDegLat = 111320;
    this.mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180);

    this.nx = Math.round(((this.lon1 - lon0) * this.mPerDegLon) / RES_M);
    this.ny = Math.round(((this.lat1 - lat0) * this.mPerDegLat) / RES_M);
    this.dx = ((this.lon1 - lon0) * this.mPerDegLon) / this.nx;
    this.dy = ((this.lat1 - lat0) * this.mPerDegLat) / this.ny;

    const n = this.nx * this.ny;
    this.depth = new Float32Array(n);
    this.w = new Float32Array(n);       // steering weight, 0 on land
    this.phi = new Float32Array(n);
    this.ux = new Float32Array(n);
    this.uy = new Float32Array(n);
    this.buildMask();
  }

  idx(i, j) { return i * this.nx + j; }          // i = lat row, j = lon col
  latOf(i) { return this.lat0 + (i / this.ny) * (this.lat1 - this.lat0); }
  lonOf(j) { return this.lon0 + (j / this.nx) * (this.lon1 - this.lon0); }

  /** Bilinear sample of the GEBCO grid (metres, negative = below sea level). */
  elevAt(lat, lon) {
    const { lat0, lon0, step, nLat, nLon, elev } = this.b;
    const y = (lat - lat0) / step, x = (lon - lon0) / step;
    const i = Math.floor(y), j = Math.floor(x);
    if (i < 0 || j < 0 || i >= nLat - 1 || j >= nLon - 1) return 0;
    const ty = y - i, tx = x - j;
    return elev[i][j] * (1 - tx) * (1 - ty) + elev[i][j + 1] * tx * (1 - ty)
         + elev[i + 1][j] * (1 - tx) * ty + elev[i + 1][j + 1] * tx * ty;
  }

  buildMask() {
    for (let i = 0; i < this.ny; i++) {
      for (let j = 0; j < this.nx; j++) {
        const e = this.elevAt(this.latOf(i), this.lonOf(j));
        const d = Math.max(0, -e);
        const k = this.idx(i, j);
        this.depth[k] = d;
        // Depths past ~30 m all steer alike; shallower water tapers the flow to
        // zero at the shore. Not transport conservation -- a steering weight.
        this.w[k] = d <= 0 ? 0 : Math.min(1, Math.sqrt(d / 30));
      }
    }

    // GEBCO's 450 m coastline sits up to a few hundred metres away from the
    // coastline the basemap draws, so particles advected right up to the mask
    // edge visibly run onto land. Erode the water mask by one cell and keep the
    // eroded band as `wDraw` -- the solver still uses the full mask, only
    // particle seeding and sampling respect the tighter boundary.
    this.wDraw = new Float32Array(this.w);
    for (let i = 0; i < this.ny; i++) {
      for (let j = 0; j < this.nx; j++) {
        const k = this.idx(i, j);
        if (this.w[k] <= 0) continue;
        for (let di = -1; di <= 1 && this.wDraw[k]; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= this.ny || jj >= this.nx ||
                this.w[this.idx(ii, jj)] <= 0) { this.wDraw[k] = 0; break; }
          }
        }
      }
    }
  }

  isWater(lat, lon) { return this.elevAt(lat, lon) < 0; }

  /**
   * Solve for a field whose far-field matches (uxFar, uyFar) in m/s.
   * Red-black SOR; ~600 sweeps on a 150 m grid runs in a few tens of ms.
   */
  solve(uxFar, uyFar) {
    const { nx, ny, dx, dy, w, phi } = this;
    phi.fill(0);

    // Right-hand side: -div(w * U_far), using face-averaged weights.
    const b = new Float32Array(nx * ny);
    const wE = (i, j) => (j + 1 < nx ? 0.5 * (w[this.idx(i, j)] + w[this.idx(i, j + 1)]) : 0);
    const wN = (i, j) => (i + 1 < ny ? 0.5 * (w[this.idx(i, j)] + w[this.idx(i + 1, j)]) : 0);

    for (let i = 1; i < ny - 1; i++) {
      for (let j = 1; j < nx - 1; j++) {
        const k = this.idx(i, j);
        if (w[k] <= 0) continue;
        const fe = wE(i, j) * uxFar, fw = wE(i, j - 1) * uxFar;
        const fn = wN(i, j) * uyFar, fs = wN(i - 1, j) * uyFar;
        b[k] = -((fe - fw) / dx + (fn - fs) / dy);
      }
    }

    const dx2 = dx * dx, dy2 = dy * dy;
    for (let it = 0; it < ITERS; it++) {
      for (let colour = 0; colour < 2; colour++) {
        for (let i = 1; i < ny - 1; i++) {
          for (let j = 1 + ((i + colour) & 1); j < nx - 1; j += 2) {
            const k = this.idx(i, j);
            if (w[k] <= 0) continue;
            const e = wE(i, j), ww = wE(i, j - 1), nn = wN(i, j), ss = wN(i - 1, j);
            const diag = (e + ww) / dx2 + (nn + ss) / dy2;
            if (diag < 1e-9) continue;
            const sum = (e * phi[k + 1] + ww * phi[k - 1]) / dx2
                      + (nn * phi[k + nx] + ss * phi[k - nx]) / dy2;
            const next = (sum - b[k]) / diag;
            phi[k] += OMEGA * (next - phi[k]);
          }
        }
      }
      // Open boundary: phi = 0 on the domain edge lets flow enter and leave.
      for (let j = 0; j < nx; j++) { phi[this.idx(0, j)] = 0; phi[this.idx(ny - 1, j)] = 0; }
      for (let i = 0; i < ny; i++) { phi[this.idx(i, 0)] = 0; phi[this.idx(i, nx - 1)] = 0; }
    }

    // u = U_far + grad(phi), zeroed on land.
    let peak = 0;
    for (let i = 0; i < ny; i++) {
      for (let j = 0; j < nx; j++) {
        const k = this.idx(i, j);
        if (this.w[k] <= 0) { this.ux[k] = 0; this.uy[k] = 0; continue; }
        const jm = Math.max(0, j - 1), jp = Math.min(nx - 1, j + 1);
        const im = Math.max(0, i - 1), ip = Math.min(ny - 1, i + 1);
        const gx = (phi[this.idx(i, jp)] - phi[this.idx(i, jm)]) / ((jp - jm) * dx);
        const gy = (phi[this.idx(ip, j)] - phi[this.idx(im, j)]) / ((ip - im) * dy);
        const vx = uxFar + gx, vy = uyFar + gy;
        this.ux[k] = vx; this.uy[k] = vy;
        const m = Math.hypot(vx, vy);
        if (m > peak) peak = m;
      }
    }
    // Guard against the solver over-shooting in near-dry cells.
    const cap = Math.hypot(uxFar, uyFar) * 3.5;
    if (peak > cap && cap > 0) {
      for (let k = 0; k < this.ux.length; k++) {
        const m = Math.hypot(this.ux[k], this.uy[k]);
        if (m > cap) { const s = cap / m; this.ux[k] *= s; this.uy[k] *= s; }
      }
    }
    this.peak = Math.min(peak, cap || peak);
    return this;
  }

  /**
   * Bilinear velocity sample in m/s at a geographic point.
   * `eroded` gates on the tightened shore band and is what particle rendering
   * uses; site readouts pass false so they see the true water mask.
   */
  sample(lat, lon, eroded = true) {
    const y = ((lat - this.lat0) / (this.lat1 - this.lat0)) * this.ny;
    const x = ((lon - this.lon0) / (this.lon1 - this.lon0)) * this.nx;
    const i = Math.floor(y), j = Math.floor(x);
    if (i < 0 || j < 0 || i >= this.ny - 1 || j >= this.nx - 1) return null;
    const ty = y - i, tx = x - j;
    const at = (a, bb) => { const k = this.idx(a, bb); return [this.ux[k], this.uy[k], this.w[k]]; };
    const [x00, y00, w00] = at(i, j), [x10, y10, w10] = at(i, j + 1);
    const [x01, y01, w01] = at(i + 1, j), [x11, y11, w11] = at(i + 1, j + 1);
    const wsum = (1 - tx) * (1 - ty) * w00 + tx * (1 - ty) * w10
               + (1 - tx) * ty * w01 + tx * ty * w11;
    if (wsum < 0.02) return null;                       // effectively land
    // Reject anything inside the eroded shore band as well, so trails stop short
    // of the drawn coastline rather than running over it.
    if (eroded) {
      const dw = this.wDraw;
      const drawn = (1 - tx) * (1 - ty) * dw[this.idx(i, j)] + tx * (1 - ty) * dw[this.idx(i, j + 1)]
                  + (1 - tx) * ty * dw[this.idx(i + 1, j)] + tx * ty * dw[this.idx(i + 1, j + 1)];
      if (drawn <= 0) return null;
    }
    return {
      ux: x00 * (1 - tx) * (1 - ty) + x10 * tx * (1 - ty) + x01 * (1 - tx) * ty + x11 * tx * ty,
      uy: y00 * (1 - tx) * (1 - ty) + y10 * tx * (1 - ty) + y01 * (1 - tx) * ty + y11 * tx * ty,
    };
  }

  /**
   * Like sample(), but if the point falls on land in the 450 m bathymetry mask
   * it spirals outward for the nearest wet cell. Necessary because sites sit
   * 40-440 m offshore and GEBCO cannot resolve that -- Jemeluk Bay in
   * particular reads as dry land at native resolution.
   */
  sampleNear(lat, lon, maxCells = 12) {
    const direct = this.sample(lat, lon, false);
    if (direct) return { ...direct, offsetCells: 0 };
    const dLat = (this.lat1 - this.lat0) / this.ny;
    const dLon = (this.lon1 - this.lon0) / this.nx;
    for (let r = 1; r <= maxCells; r++) {
      for (let a = 0; a < 16; a++) {
        const th = (a / 16) * 2 * Math.PI;
        const v = this.sample(lat + Math.cos(th) * r * dLat, lon + Math.sin(th) * r * dLon, false);
        if (v) return { ...v, offsetCells: r };
      }
    }
    return null;
  }

  /** Speed in m/s at a site, for the "what the interpolation says here" readout. */
  speedAt(lat, lon) {
    const v = this.sampleNear(lat, lon);
    return v ? Math.hypot(v.ux, v.uy) : null;
  }

  /** Convert m/s velocity to degrees/second for particle advection. */
  toDegPerSec(ux, uy) {
    return [ux / this.mPerDegLon, uy / this.mPerDegLat];
  }
}

/** Far-field vector from Open-Meteo's speed (km/h) and "toward" direction. */
export function farField(speedKmh, towardDeg) {
  const s = (speedKmh ?? 0) / 3.6;
  const t = ((towardDeg ?? 0) * Math.PI) / 180;
  return [s * Math.sin(t), s * Math.cos(t)];          // east, north (m/s)
}
