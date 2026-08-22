const SITES = [
  { id: "liberty", name: "USAT Liberty", area: "Tulamben", lat: -8.2744, lon: 115.5932, maxVis: 25, waveSensitivity: 1.25, currentSensitivity: .65, runoff: .55, exposure: 65, desc: "Shallow wreck and black-stone shore entry; pockets of fine sediment can be resuspended by swell and divers." },
  { id: "coral", name: "Coral Garden", area: "Tulamben", lat: -8.2765, lon: 115.5949, maxVis: 27, waveSensitivity: .85, currentSensitivity: .55, runoff: .35, exposure: 55, desc: "Shallow reef on mixed volcanic substrate, generally less sediment-sensitive than the Liberty." },
  { id: "dropoff", name: "Tulamben Drop-Off", area: "Tulamben", lat: -8.2778, lon: 115.5965, maxVis: 30, waveSensitivity: .7, currentSensitivity: 1.05, runoff: .45, exposure: 70, desc: "Steep wall exposed to alongshore flow; clearer offshore water is possible, but current can rise quickly." },
  { id: "kubu", name: "Kubu / Boga Wreck", area: "Kubu", lat: -8.2496, lon: 115.5806, maxVis: 26, waveSensitivity: 1.0, currentSensitivity: .8, runoff: .35, exposure: 70, desc: "A deeper wreck reached from a sloping volcanic shore, moderately exposed to swell and current." },
  { id: "seraya", name: "Seraya Secrets", area: "Seraya", lat: -8.2901, lon: 115.6091, maxVis: 18, waveSensitivity: 1.35, currentSensitivity: .7, runoff: .65, exposure: 62, desc: "Macro site over dark sand; deliberately lower baseline visibility and sensitive to sediment disturbance." },
  { id: "batu", name: "Batu Kelebit", area: "Tulamben", lat: -8.2838, lon: 115.6027, maxVis: 31, waveSensitivity: .8, currentSensitivity: 1.15, runoff: .25, exposure: 85, desc: "Offshore reef reached by boat. Often clear, with greater exposure to regional current and swell." },
  { id: "jemeluk", name: "Jemeluk Bay", area: "Amed", lat: -8.3370, lon: 115.6603, maxVis: 28, waveSensitivity: .65, currentSensitivity: .65, runoff: .5, exposure: 40, desc: "Sheltered bay reef; local runoff and diver activity can matter more than offshore swell." },
  { id: "pyramid", name: "Amed Pyramids", area: "Amed", lat: -8.3342, lon: 115.6538, maxVis: 27, waveSensitivity: .85, currentSensitivity: .9, runoff: .4, exposure: 58, desc: "Artificial reef structures on sand, exposed to variable alongshore current." }
];

const MARINE_FIELDS = ["wave_height","wave_direction","wave_period","swell_wave_height","swell_wave_direction","swell_wave_period","ocean_current_velocity","ocean_current_direction","sea_level_height_msl","sea_surface_temperature"];
const WEATHER_FIELDS = ["weather_code","precipitation","rain","cloud_cover","visibility","wind_speed_10m","wind_direction_10m"];
const state = { marine: [], weather: null, index: 0, selected: null, markers: new Map() };
const $ = (s) => document.querySelector(s);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const val = (series, key, i) => Number.isFinite(series?.hourly?.[key]?.[i]) ? series.hourly[key][i] : null;
const forecastDate = (localTime) => new Date(`${localTime}:00+08:00`);
const compass = (deg) => deg == null ? "—" : ["N","NE","E","SE","S","SW","W","NW"][Math.round(deg / 45) % 8];
const arrow = (deg) => `<span class="arrow" style="transform:rotate(${deg ?? 0}deg)">↑</span>`;

const map = L.map("map", { zoomControl: false }).setView([-8.298, 115.625], 12);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  maxZoom: 18,
  subdomains: "abcd",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  referrerPolicy: "strict-origin-when-cross-origin"
}).addTo(map);
map.fitBounds(L.latLngBounds(SITES.map(s => [s.lat, s.lon])).pad(.16));
new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(document.querySelector(".map-wrap"));

function quality(score) {
  return score >= 82 ? ["Excellent", "excellent"] : score >= 67 ? ["Good", "good"] : score >= 48 ? ["Fair", "fair"] : ["Poor", "poor"];
}

function weatherLabel(code) {
  if (code == null) return "Unknown";
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Mist / fog";
  if (code <= 67) return "Rain";
  if (code <= 82) return "Showers";
  return "Thunderstorms";
}

function tideAt(m, i) {
  const now = val(m, "sea_level_height_msl", i);
  const before = val(m, "sea_level_height_msl", Math.max(0, i - 1));
  const after = val(m, "sea_level_height_msl", Math.min(m.hourly.time.length - 1, i + 1));
  if (now == null || before == null || after == null) return { height: null, phase: "Unknown" };
  const slope = after - before;
  return { height: now, phase: Math.abs(slope) < .025 ? "Near slack" : slope > 0 ? "Rising" : "Falling" };
}

function rainHistory(i) {
  let total = 0;
  for (let n = Math.max(0, i - 24); n <= i; n++) total += val(state.weather, "rain", n) ?? val(state.weather, "precipitation", n) ?? 0;
  return total;
}

function calculate(site, m, i) {
  const wave = val(m, "wave_height", i) ?? 0;
  const swell = val(m, "swell_wave_height", i) ?? wave;
  const period = val(m, "swell_wave_period", i) ?? val(m, "wave_period", i) ?? 5;
  const current = val(m, "ocean_current_velocity", i) ?? 0;
  const wind = val(state.weather, "wind_speed_10m", i) ?? 0;
  const rain24 = rainHistory(i);
  const tide = tideAt(m, i);
  const energy = swell * Math.max(1, period / 7);
  const wavePenalty = Math.max(0, energy - .12) * 25 * site.waveSensitivity;
  const currentPenalty = Math.max(0, current - .25) * 13 * site.currentSensitivity;
  const rainPenalty = Math.min(20, rain24 * 1.25 * site.runoff);
  const windPenalty = Math.max(0, wind - 10) * .45 * site.exposure / 100;
  const slackBonus = tide.phase === "Near slack" ? 3 : 0;
  const score = Math.round(clamp(92 - wavePenalty - currentPenalty - rainPenalty - windPenalty + slackBonus, 22, 96));
  const visibility = clamp(site.maxVis - wavePenalty * .43 - rainPenalty * .52 - Math.max(0, current - 1) * 2.5, 4, site.maxVis);
  const coverage = [wave, swell, current, tide.height].filter(Number.isFinite).length;
  const confidence = coverage === 4 && i <= 24 ? "Moderate" : coverage >= 3 ? "Low–moderate" : "Low";
  const drivers = [];
  if (energy > .65) drivers.push(["bad", "Swell resuspension", `${swell.toFixed(1)} m at ${period.toFixed(0)} s can mobilize sediment; this site’s substrate sensitivity is ${site.waveSensitivity > 1.1 ? "high" : "moderate"}.`]);
  else drivers.push(["good", "Limited swell disturbance", `${swell.toFixed(1)} m swell suggests relatively little sediment resuspension.`]);
  if (rain24 > 2) drivers.push(["bad", "Recent rainfall", `${rain24.toFixed(1)} mm modeled over the prior 24 hours may add runoff and suspended material.`]);
  else drivers.push(["good", "Low runoff signal", `${rain24.toFixed(1)} mm modeled rain over the prior 24 hours.`]);
  drivers.push([tide.phase === "Near slack" ? "good" : "neutral", "Tide and flushing", `${tide.phase}${tide.height == null ? "" : ` at ${tide.height.toFixed(2)} m MSL`}; tide is used as a modest modifier because local effects are uncertain.`]);
  if (current > .8) drivers.push(["bad", "Strong water movement", `${current.toFixed(1)} km/h flow may increase effort and carry a sediment or plankton plume; water clarity is not directly modeled.`]);
  else drivers.push(["good", "Manageable modeled current", `${current.toFixed(1)} km/h flow is favorable for an easier dive, subject to localized currents.`]);
  return { score, visibility, wave, swell, period, current, wind, tide, rain24, confidence, drivers };
}

function markerIcon(site, result, selected = false) {
  const [, cls] = quality(result.score);
  return L.divIcon({ className: "", html: `<div class="site-marker ${cls} ${selected ? "selected" : ""}" title="${site.name}: ${result.score}/100">${result.score}</div>`, iconSize: [42,42], iconAnchor: [21,21] });
}

function render() {
  if (!state.marine.length || !state.weather) return;
  const i = state.index;
  const time = forecastDate(state.weather.hourly.time[i]);
  $("#selectedTime").textContent = new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Makassar", timeZoneName: "short" }).format(time);
  SITES.forEach((site, n) => {
    const result = calculate(site, state.marine[n], i);
    let marker = state.markers.get(site.id);
    if (!marker) {
      marker = L.marker([site.lat, site.lon]).addTo(map).on("click", () => { state.selected = site.id; render(); });
      marker.bindTooltip(site.name, { direction: "top", offset: [0,-20] });
      state.markers.set(site.id, marker);
    }
    marker.setIcon(markerIcon(site, result, state.selected === site.id));
  });
  renderOverlay(i);
  if (state.selected) renderSite(SITES.find(s => s.id === state.selected), i);
}

function renderOverlay(i) {
  const m = state.marine[0];
  const current = val(m, "ocean_current_velocity", i), currentDir = val(m, "ocean_current_direction", i);
  const wind = val(state.weather, "wind_speed_10m", i), windDir = val(state.weather, "wind_direction_10m", i);
  const swell = val(m, "swell_wave_height", i) ?? val(m, "wave_height", i), swellDir = val(m, "swell_wave_direction", i) ?? val(m, "wave_direction", i);
  const tide = tideAt(m, i), code = val(state.weather, "weather_code", i);
  $("#conditionsOverlay").innerHTML = `
    <div class="map-condition"><small>Current (toward)</small><strong>${arrow(currentDir)}${current?.toFixed(1) ?? "—"} km/h ${compass(currentDir)}</strong></div>
    <div class="map-condition"><small>Wind (from)</small><strong>${arrow((windDir ?? 0) + 180)}${wind?.toFixed(0) ?? "—"} km/h ${compass(windDir)}</strong></div>
    <div class="map-condition"><small>Swell (from)</small><strong>${arrow((swellDir ?? 0) + 180)}${swell?.toFixed(1) ?? "—"} m ${compass(swellDir)}</strong></div>
    <div class="map-condition"><small>Tide · Weather</small><strong>${tide.phase} · ${weatherLabel(code)}</strong></div>`;
}

function renderSite(site, i) {
  const m = state.marine[SITES.indexOf(site)], r = calculate(site, m, i), [label, cls] = quality(r.score);
  const frag = $("#siteTemplate").content.cloneNode(true);
  frag.querySelector(".site-location").textContent = site.area + " · selected site";
  frag.querySelector(".site-name").textContent = site.name;
  frag.querySelector(".score-value").textContent = r.score;
  frag.querySelector(".score-ring").style.borderColor = `var(--${cls})`;
  const pill = frag.querySelector(".quality-pill"); pill.textContent = label; pill.classList.add(cls);
  frag.querySelector(".confidence").textContent = `${r.confidence} confidence`;
  frag.querySelector(".site-description").textContent = site.desc;
  const currentDir = val(m, "ocean_current_direction", i), swellDir = val(m, "swell_wave_direction", i) ?? val(m, "wave_direction", i);
  const visTone = r.visibility >= 18 ? "good-factor" : r.visibility >= 10 ? "neutral-factor" : "bad-factor";
  const swellTone = r.swell < .5 ? "good-factor" : r.swell < 1 ? "neutral-factor" : "bad-factor";
  const currentTone = r.current < .6 ? "good-factor" : r.current < 1.2 ? "neutral-factor" : "bad-factor";
  const tideTone = r.tide.phase === "Near slack" ? "good-factor" : "neutral-factor";
  frag.querySelector(".metrics").innerHTML = `
    <div class="metric ${visTone}"><small>Estimated visibility</small><strong>${r.visibility.toFixed(0)}–${Math.ceil(r.visibility + 4)} m</strong><span>heuristic range</span></div>
    <div class="metric ${swellTone}"><small>Swell</small><strong>${r.swell.toFixed(1)} m</strong><span>${r.period.toFixed(0)} s · from ${compass(swellDir)}</span></div>
    <div class="metric ${currentTone}"><small>Current</small><strong>${r.current.toFixed(1)} km/h</strong><span>toward ${compass(currentDir)}</span></div>
    <div class="metric ${tideTone}"><small>Tide</small><strong>${r.tide.phase}</strong><span>${r.tide.height?.toFixed(2) ?? "—"} m MSL</span></div>`;
  frag.querySelector(".drivers").innerHTML = r.drivers.map(([tone,a,b]) => `<li class="${tone}-factor"><b>${a}.</b> ${b}</li>`).join("");
  frag.querySelector(".confidence-note p").textContent = `${r.confidence} confidence: physical forcing is forecast, but underwater visibility is inferred. Coastal model resolution, no turbidity sensor, and no same-day guide report limit certainty.`;
  frag.querySelector(".model-note").textContent = `Sea ${val(m,"sea_surface_temperature",i)?.toFixed(1) ?? "—"}°C · Updated from Open-Meteo marine and weather models. Current and tide resolution is approximately 8 km; waves approximately 5 km.`;
  const panel = $("#sitePanel"); panel.innerHTML = ""; panel.appendChild(frag);
}

async function loadForecast() {
  const latitudes = SITES.map(s => s.lat).join(","), longitudes = SITES.map(s => s.lon).join(",");
  const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${latitudes}&longitude=${longitudes}&hourly=${MARINE_FIELDS.join(",")}&timezone=Asia%2FMakassar&forecast_days=4`;
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=-8.298&longitude=115.625&hourly=${WEATHER_FIELDS.join(",")}&timezone=Asia%2FMakassar&forecast_days=4`;
  try {
    const [marineRes, weatherRes] = await Promise.all([fetch(marineUrl), fetch(weatherUrl)]);
    if (!marineRes.ok || !weatherRes.ok) throw new Error(`Forecast API returned ${marineRes.status}/${weatherRes.status}`);
    state.marine = await marineRes.json(); state.weather = await weatherRes.json();
    if (!Array.isArray(state.marine)) state.marine = [state.marine];
    if (state.marine.length !== SITES.length) throw new Error("Incomplete site forecast");
    const now = Date.now();
    state.index = state.weather.hourly.time.findIndex(t => forecastDate(t).getTime() >= now);
    if (state.index < 0) state.index = 0;
    const slider = $("#timeSlider"); slider.min = state.index; slider.max = Math.min(state.index + 48, state.weather.hourly.time.length - 1); slider.value = state.index; slider.disabled = false;
    $("#dataStatus").className = "status ready"; $("#dataStatus").innerHTML = "<span></span> Live model data";
    render();
  } catch (error) {
    console.error(error);
    $("#dataStatus").className = "status error"; $("#dataStatus").innerHTML = "<span></span> Forecast unavailable";
    $("#selectedTime").textContent = "Could not load data";
    $("#sitePanel").innerHTML = `<div class="panel-placeholder"><h2>Forecast unavailable</h2><p>Check the internet connection and reload. ${error.message}</p></div>`;
  }
}

$("#timeSlider").addEventListener("input", e => { state.index = +e.target.value; render(); });
$("#prevHour").addEventListener("click", () => { const s=$("#timeSlider"); s.value=Math.max(+s.min,+s.value-1); s.dispatchEvent(new Event("input")); });
$("#nextHour").addEventListener("click", () => { const s=$("#timeSlider"); s.value=Math.min(+s.max,+s.value+1); s.dispatchEvent(new Event("input")); });
loadForecast();
