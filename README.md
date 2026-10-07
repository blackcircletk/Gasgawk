# GasGawk

Compare fuel prices along a driving route between two locations.

Enter an origin and destination — GasGawk geocodes them (Nominatim), computes the driving route (OSRM), samples points along the route, looks up nearby gas stations with prices (CollectAPI `gasPrice/fromCoordinates`), and shows:

- A Leaflet map with the route, start/end markers, and custom gas-station pins color-coded by price tier (green = low, orange = mid, red = high) with a live price legend
- A Plotly chart of price vs. distance from start
- A sortable results table with gasoline / diesel / LPG prices
- Route distance, duration, and price statistics

## Run locally

```bash
npm install
cp .env.example .env   # then paste your CollectAPI token into .env
npm start
```

Open http://localhost:3000

## Deploy to Render

1. Push this repo to GitHub.
2. On [Render](https://render.com), create a **Web Service** from this repository.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Add the environment variable `COLLECTAPI_TOKEN` with your CollectAPI token (Render injects `PORT` automatically).

A `render.yaml` blueprint is included, so Render can also auto-configure the service from this file.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `COLLECTAPI_TOKEN` | Yes | Your CollectAPI token (sent as the `Authorization` header) |
| `PORT` | No | Server port; defaults to 3000, provided automatically by Render |

Never commit your real token — keep it in `.env` locally or Render's environment settings.

## Data sources

- Geocoding: [OpenStreetMap Nominatim](https://nominatim.org/)
- Routing: [OSRM public demo server](https://router.project-osrm.org/)
- Fuel prices: [CollectAPI gasPrice](https://collectapi.com/)

## Notes

- Station field names from CollectAPI are mapped defensively in `normalizeCollectApiStations()`; adjust there if the live response shape differs.
- The public OSRM demo server is rate-limited; for heavy use, run your own OSRM instance.
