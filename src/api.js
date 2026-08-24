// Open-Meteo access. Called directly from the browser: the endpoints are
// CORS-enabled and keyless, so there is nothing here that needs a backend.

import { SITES } from "./sites.js";

const TZ = "Asia%2FMakassar";
const PAST_DAYS = 3;      // warm-up for the settling and runoff memories in history.js
const FCST_DAYS = 4;

const MARINE = ["wave_height","wave_direction","wave_period",
  "swell_wave_height","swell_wave_direction","swell_wave_period",
  "wind_wave_height","wind_wave_direction","wind_wave_period",
  "ocean_current_velocity","ocean_current_direction",
  "sea_level_height_msl","sea_surface_temperature"];

const WEATHER = ["temperature_2m","apparent_temperature","weather_code","precipitation",
  "rain","precipitation_probability","cloud_cover","wind_speed_10m","wind_direction_10m",
  "wind_gusts_10m","uv_index","is_day"];

const DAILY = ["sunrise","sunset","uv_index_max","precipitation_sum","weather_code"];

const EARTH_KM = 6371;
export function haversineKm(aLat, aLon, bLat, bLon) {
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(bLat - aLat), dLon = r(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}
export function bearing(aLat, aLon, bLat, bLon) {
  const r = (d) => (d * Math.PI) / 180;
  const y = Math.sin(r(bLon - aLon)) * Math.cos(r(bLat));
  const x = Math.cos(r(aLat)) * Math.sin(r(bLat)) -
            Math.sin(r(aLat)) * Math.cos(r(bLat)) * Math.cos(r(bLon - aLon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Times come back as local wall-clock strings; Makassar is a fixed UTC+8. */
export const parseTime = (t) => new Date(`${t}:00+08:00`);

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(body.reason || "API error");
  return body;
}

export async function loadForecast() {
  const lat = SITES.map((s) => s.lat).join(",");
  const lon = SITES.map((s) => s.lon).join(",");
  const common = `&timezone=${TZ}&past_days=${PAST_DAYS}&forecast_days=${FCST_DAYS}`;

  const [marineRaw, weather] = await Promise.all([
    getJSON(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}` +
            `&hourly=${MARINE.join(",")}${common}`),
    getJSON(`https://api.open-meteo.com/v1/forecast?latitude=-8.298&longitude=115.625` +
            `&hourly=${WEATHER.join(",")}&daily=${DAILY.join(",")}${common}`),
  ]);

  const marine = Array.isArray(marineRaw) ? marineRaw : [marineRaw];
  if (marine.length !== SITES.length) throw new Error("Incomplete site forecast");

  // The marine model snaps every request to its nearest wet grid cell. On this
  // coast that is 15-21 km offshore, and several sites collapse onto one cell.
  // Record it so the UI can say so rather than implying site-level resolution.
  const cells = marine.map((m, n) => {
    const s = SITES[n];
    return {
      lat: m.latitude, lon: m.longitude,
      km: haversineKm(s.lat, s.lon, m.latitude, m.longitude),
      bearing: bearing(s.lat, s.lon, m.latitude, m.longitude),
      key: `${m.latitude.toFixed(3)},${m.longitude.toFixed(3)}`,
    };
  });
  const distinctCells = new Set(cells.map((c) => c.key)).size;

  const time = weather.hourly.time;
  // Both requests use identical past/forecast windows, so indices line up. Guard
  // anyway -- a silent misalignment would shift every reading by hours.
  if (marine[0].hourly.time.length !== time.length ||
      marine[0].hourly.time[0] !== time[0]) {
    throw new Error("Marine and weather series are misaligned");
  }

  return { marine, weather, cells, distinctCells, time, pastHours: PAST_DAYS * 24 };
}

const pick = (h, key, i) => {
  const v = h?.[key]?.[i];
  return Number.isFinite(v) ? v : null;
};

/** Flat snapshot of every forcing variable at hour `i` for one site. */
export function sample(data, siteIndex, i) {
  const m = data.marine[siteIndex].hourly;
  const w = data.weather.hourly;

  let rain24 = 0;
  for (let n = Math.max(0, i - 23); n <= i; n++) {
    rain24 += pick(w, "rain", n) ?? pick(w, "precipitation", n) ?? 0;
  }

  return {
    waveH: pick(m, "wave_height", i), waveT: pick(m, "wave_period", i),
    waveDir: pick(m, "wave_direction", i),
    swellH: pick(m, "swell_wave_height", i), swellT: pick(m, "swell_wave_period", i),
    swellDir: pick(m, "swell_wave_direction", i),
    windWaveH: pick(m, "wind_wave_height", i), windWaveT: pick(m, "wind_wave_period", i),
    windWaveDir: pick(m, "wind_wave_direction", i),
    current: pick(m, "ocean_current_velocity", i),
    currentDir: pick(m, "ocean_current_direction", i),
    seaTemp: pick(m, "sea_surface_temperature", i),
    sea_level_height_msl: m.sea_level_height_msl,

    airTemp: pick(w, "temperature_2m", i), feelsLike: pick(w, "apparent_temperature", i),
    code: pick(w, "weather_code", i), cloud: pick(w, "cloud_cover", i),
    precip: pick(w, "precipitation", i), precipProb: pick(w, "precipitation_probability", i),
    wind: pick(w, "wind_speed_10m", i), windDir: pick(w, "wind_direction_10m", i),
    gust: pick(w, "wind_gusts_10m", i), uv: pick(w, "uv_index", i),
    isDay: pick(w, "is_day", i) === 1,
    rain24,
  };
}

/** Marine hourly block for a site, in the shape tideState() expects. */
export const marineSeries = (data, siteIndex) => data.marine[siteIndex].hourly;

/** Index of the hour containing `now`, clamped into range. */
export function nowIndex(data, now = Date.now()) {
  const t = data.time;
  for (let i = 0; i < t.length; i++) {
    if (parseTime(t[i]).getTime() + 3600e3 > now) return i;
  }
  return Math.max(0, t.length - 1);
}

export function dailyFor(data, timeStr) {
  const day = timeStr.slice(0, 10);
  const d = data.weather.daily;
  const n = d?.time?.indexOf(day);
  if (n == null || n < 0) return null;
  return {
    sunrise: d.sunrise[n], sunset: d.sunset[n],
    uvMax: d.uv_index_max[n], precipSum: d.precipitation_sum[n], code: d.weather_code[n],
  };
}

export const WEATHER_CODES = {
  0: ["Clear", "sun"], 1: ["Mainly clear", "sun"], 2: ["Partly cloudy", "cloud"],
  3: ["Overcast", "cloud"], 45: ["Fog", "fog"], 48: ["Rime fog", "fog"],
  51: ["Light drizzle", "drizzle"], 53: ["Drizzle", "drizzle"], 55: ["Heavy drizzle", "drizzle"],
  61: ["Light rain", "rain"], 63: ["Rain", "rain"], 65: ["Heavy rain", "rain"],
  80: ["Light showers", "rain"], 81: ["Showers", "rain"], 82: ["Violent showers", "rain"],
  95: ["Thunderstorm", "storm"], 96: ["Thunderstorm, hail", "storm"], 99: ["Thunderstorm, hail", "storm"],
};
export const weatherLabel = (code) => (WEATHER_CODES[code] ?? ["Unknown", "cloud"])[0];
export const weatherIcon = (code) => (WEATHER_CODES[code] ?? ["Unknown", "cloud"])[1];
