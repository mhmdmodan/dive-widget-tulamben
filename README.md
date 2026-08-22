# Tulamben Dive Window

An interactive 48-hour planning forecast for dive sites from Kubu and Tulamben to Amed. It combines Open-Meteo marine and weather model data with site-specific heuristics to estimate dive quality and visibility.

## Run locally

No build step or API key is required. Serve the directory so browser module and network requests work correctly:

```bash
python -m http.server 8000
```

Open `http://localhost:8000`.

## Data and limitations

- Map: OpenStreetMap tiles displayed with Leaflet.
- Forecast: Open-Meteo weather and marine APIs.
- Visibility: inferred from swell energy, rain history, tide trend, current, wind, substrate, exposure, and runoff sensitivity.

Visibility is not directly forecast by the source models. Coastal wave, tide, and current output is coarser than an individual dive site and must not replace local operator advice or an on-site safety assessment.
