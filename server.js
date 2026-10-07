const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const COLLECTAPI_TOKEN = process.env.COLLECTAPI_TOKEN;

if (!COLLECTAPI_TOKEN) {
  console.warn('Missing COLLECTAPI_TOKEN — fuel price lookups will fail until it is set.');
}

const OSRM_BASE = 'https://router.project-osrm.org';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const COLLECTAPI_BASE = 'https://api.collectapi.com';

const routeCache = new Map();
const fuelCache = new Map();

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function roundCoord(value, decimals = 4) {
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

function buildCoordCacheKey(lat, lng) {
  return `${roundCoord(lat, 3)},${roundCoord(lng, 3)}`;
}

function buildRouteCacheKey(start, end) {
  return `${roundCoord(start.lat, 5)},${roundCoord(start.lng, 5)}|${roundCoord(end.lat, 5)},${roundCoord(end.lng, 5)}`;
}

async function geocodePlace(query) {
  const url = new URL(`${NOMINATIM_BASE}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'GasGawk/1.0 (github.com/blackcircletk/Gasgawk)'
    }
  });

  if (!res.ok) {
    throw new Error(`Geocoding failed: ${res.status}`);
  }

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No geocoding result for "${query}"`);
  }

  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    displayName: data[0].display_name
  };
}

async function getRoute(start, end) {
  const cacheKey = buildRouteCacheKey(start, end);
  if (routeCache.has(cacheKey)) return routeCache.get(cacheKey);

  const coords = `${start.lng},${start.lat};${end.lng},${end.lat}`;
  const url = `${OSRM_BASE}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OSRM route failed: ${res.status}`);
  }

  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
    throw new Error(`OSRM route error: ${data.code || 'unknown'}`);
  }

  const route = data.routes[0];
  const value = {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    geometry: route.geometry
  };

  routeCache.set(cacheKey, value);
  return value;
}

function sampleRouteByDistance(lineCoords, stepKm = 7) {
  const stepMeters = stepKm * 1000;
  const samples = [];

  if (!Array.isArray(lineCoords) || lineCoords.length < 2) return samples;

  const cum = [{ coord: lineCoords[0], meters: 0 }];
  let total = 0;

  for (let i = 1; i < lineCoords.length; i++) {
    const [lng1, lat1] = lineCoords[i - 1];
    const [lng2, lat2] = lineCoords[i];
    total += haversineMeters(lat1, lng1, lat2, lng2);
    cum.push({ coord: lineCoords[i], meters: total });
  }

  let target = 0;
  let idx = 1;

  while (target <= total) {
    while (idx < cum.length && cum[idx].meters < target) idx++;

    if (idx >= cum.length) break;

    const prev = cum[idx - 1];
    const curr = cum[idx];
    const segmentMeters = curr.meters - prev.meters || 1;
    const ratio = (target - prev.meters) / segmentMeters;

    const lng = prev.coord[0] + (curr.coord[0] - prev.coord[0]) * ratio;
    const lat = prev.coord[1] + (curr.coord[1] - prev.coord[1]) * ratio;

    samples.push({
      lat,
      lng,
      distanceFromStartKm: +(target / 1000).toFixed(2)
    });

    target += stepMeters;
  }

  const last = lineCoords[lineCoords.length - 1];
  const finalDistanceKm = +(total / 1000).toFixed(2);
  const hasLast =
    samples.length &&
    Math.abs(samples[samples.length - 1].distanceFromStartKm - finalDistanceKm) < 0.1;

  if (!hasLast) {
    samples.push({
      lat: last[1],
      lng: last[0],
      distanceFromStartKm: finalDistanceKm
    });
  }

  return samples;
}

async function fetchFuelFromCoordinates(lat, lng) {
  const cacheKey = buildCoordCacheKey(lat, lng);
  if (fuelCache.has(cacheKey)) return fuelCache.get(cacheKey);

  if (!COLLECTAPI_TOKEN) {
    throw new Error('COLLECTAPI_TOKEN is not configured on the server.');
  }

  const url = new URL(`${COLLECTAPI_BASE}/gasPrice/fromCoordinates`);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lng', String(lng));

  const res = await fetch(url, {
    headers: {
      // CollectAPI expects "apikey <token>"; keep raw value if it already has a scheme
      Authorization: COLLECTAPI_TOKEN.includes(' ')
        ? COLLECTAPI_TOKEN
        : `apikey ${COLLECTAPI_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) {
    throw new Error(`CollectAPI failed: ${res.status}`);
  }

  const data = await res.json();
  fuelCache.set(cacheKey, data);
  return data;
}

function parseNumericPrice(value) {
  if (value == null) return null;
  const num = parseFloat(String(value).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(num) ? num : null;
}

function normalizeCollectApiStations(apiResponse, samplePoint) {
  const rawList =
    apiResponse?.result ||
    apiResponse?.data ||
    apiResponse?.stations ||
    [];

  if (!Array.isArray(rawList)) return [];

  return rawList.map((item, index) => {
    const lat = parseFloat(item.lat ?? item.latitude ?? samplePoint.lat);
    const lng = parseFloat(item.lng ?? item.lon ?? item.longitude ?? samplePoint.lng);

    return {
      sourceId: item.id ?? item.stationId ?? null,
      name: item.station ?? item.name ?? `Station ${index + 1}`,
      brand: item.brand ?? item.company ?? item.distributor ?? '',
      lat,
      lng,
      sampleDistanceKm: samplePoint.distanceFromStartKm,
      prices: {
        gasoline: parseNumericPrice(item.gasoline ?? item.benzin ?? item.unleaded ?? item.price),
        diesel: parseNumericPrice(item.diesel ?? item.motorin),
        lpg: parseNumericPrice(item.lpg)
      },
      raw: item
    };
  }).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

function distancePointToSegmentMeters(pLat, pLng, aLat, aLng, bLat, bLng) {
  const x = pLng;
  const y = pLat;
  const x1 = aLng;
  const y1 = aLat;
  const x2 = bLng;
  const y2 = bLat;

  const A = x - x1;
  const B = y - y1;
  const C = x2 - x1;
  const D = y2 - y1;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;
  if (lenSq !== 0) param = dot / lenSq;

  let xx, yy;
  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }

  return haversineMeters(y, x, yy, xx);
}

function projectStationToRoute(station, routeCoords) {
  let cumulative = 0;
  let best = {
    minDistance: Infinity,
    distanceAlongMeters: 0
  };

  for (let i = 1; i < routeCoords.length; i++) {
    const [aLng, aLat] = routeCoords[i - 1];
    const [bLng, bLat] = routeCoords[i];

    const segMeters = haversineMeters(aLat, aLng, bLat, bLng);
    const distToSeg = distancePointToSegmentMeters(
      station.lat,
      station.lng,
      aLat,
      aLng,
      bLat,
      bLng
    );

    if (distToSeg < best.minDistance) {
      best = {
        minDistance: distToSeg,
        distanceAlongMeters: cumulative
      };
    }

    cumulative += segMeters;
  }

  return {
    ...station,
    distanceFromRouteMeters: Math.round(best.minDistance),
    distanceFromStartKm: +(best.distanceAlongMeters / 1000).toFixed(2)
  };
}

function dedupeStations(stations) {
  const map = new Map();

  for (const s of stations) {
    const key = s.sourceId
      ? `id:${s.sourceId}`
      : `${(s.name || '').trim().toLowerCase()}|${roundCoord(s.lat, 4)}|${roundCoord(s.lng, 4)}`;

    const existing = map.get(key);

    if (!existing) {
      map.set(key, s);
      continue;
    }

    const currentPrice = s.prices.gasoline ?? Number.POSITIVE_INFINITY;
    const existingPrice = existing.prices.gasoline ?? Number.POSITIVE_INFINITY;

    if (currentPrice < existingPrice) {
      map.set(key, s);
    }
  }

  return [...map.values()];
}

async function fetchFuelBatched(samples, concurrency = 3) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < samples.length) {
      const current = samples[index++];
      try {
        const apiData = await fetchFuelFromCoordinates(current.lat, current.lng);
        const stations = normalizeCollectApiStations(apiData, current);
        results.push(...stations);
      } catch (err) {
        console.error('Fuel fetch error:', err.message);
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, tokenConfigured: Boolean(COLLECTAPI_TOKEN) });
});

app.post('/api/fuel-along-route', async (req, res) => {
  try {
    const {
      origin,
      destination,
      sampleKm = 7,
      fuelType = 'gasoline'
    } = req.body || {};

    if (!origin || !destination) {
      return res.status(400).json({ error: 'origin and destination are required' });
    }

    const start = await geocodePlace(origin);
    const end = await geocodePlace(destination);

    const route = await getRoute(start, end);
    const routeCoords = route.geometry.coordinates;
    const samples = sampleRouteByDistance(routeCoords, Number(sampleKm) || 7);

    const rawStations = COLLECTAPI_TOKEN
      ? await fetchFuelBatched(samples, 3)
      : [];

    const deduped = dedupeStations(rawStations);
    const projected = deduped
      .map(station => projectStationToRoute(station, routeCoords))
      .filter(station => station.prices[fuelType] != null)
      .sort((a, b) => a.distanceFromStartKm - b.distanceFromStartKm);

    const chart = {
      x: projected.map(s => s.distanceFromStartKm),
      y: projected.map(s => s.prices[fuelType]),
      text: projected.map(
        s => `${s.name}${s.brand ? ` (${s.brand})` : ''}<br>${fuelType}: ${s.prices[fuelType]}`
      )
    };

    res.json({
      warning: COLLECTAPI_TOKEN
        ? null
        : 'COLLECTAPI_TOKEN is not configured on the server — showing the route only, without station prices.',
      origin: start,
      destination: end,
      route: {
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        geometry: route.geometry
      },
      samples,
      stations: projected,
      chart
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`GasGawk running on port ${PORT}`);
});
