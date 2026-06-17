const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/listings', async (req, res) => {
  try {
    const { location, bedrooms, price_min, price_max } = req.query;
    let query = `SELECT * FROM listings WHERE status != 'rented'`;
    const params = [];
    let paramIndex = 1;

    if (location) {
      query += ` AND (LOWER(city) LIKE $${paramIndex} OR LOWER(neighborhood) LIKE $${paramIndex} OR LOWER(state) = $${paramIndex + 1})`;
      params.push(`%${location.toLowerCase()}%`, location.toLowerCase());
      paramIndex += 2;
    }

    if (bedrooms !== undefined && bedrooms !== '') {
      query += ` AND bedrooms = $${paramIndex}`;
      params.push(parseInt(bedrooms));
      paramIndex++;
    }

    if (price_min) {
      query += ` AND price_monthly >= $${paramIndex}`;
      params.push(parseInt(price_min));
      paramIndex++;
    }

    if (price_max) {
      query += ` AND price_monthly <= $${paramIndex}`;
      params.push(parseInt(price_max));
      paramIndex++;
    }

    query += ` ORDER BY sort_order ASC, created_at DESC`;

    const { rows: listings } = await pool.query(query, params);
    res.json({ listings, total: listings.length });
  } catch (err) {
    console.error('Error fetching listings:', err);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// --- Transit lookup from address ---
router.get('/transit', async (req, res) => {
  const { address } = req.query;
  if (!address || address.trim().length < 5) {
    return res.status(400).json({ error: 'Please provide a valid address.' });
  }

  try {
    // Step 1: Geocode the address using OpenStreetMap Nominatim
    const geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
    const geoResponse = await fetch(geocodeUrl, {
      headers: { 'User-Agent': 'HiveListings/1.0 (admin transit lookup)' }
    });
    const geoData = await geoResponse.json();

    if (!geoData || geoData.length === 0) {
      return res.json({ transit: '', message: 'Could not geocode address. Enter transit info manually.' });
    }

    const lat = parseFloat(geoData[0].lat);
    const lon = parseFloat(geoData[0].lon);

    // Step 2: Query Overpass API for nearby transit stations (subway, rail, light_rail, tram)
    // Search within 1200 meters (~0.75 miles)
    const overpassQuery = `
      [out:json][timeout:10];
      (
        node["railway"="station"](around:1200,${lat},${lon});
        node["railway"="subway_entrance"](around:1200,${lat},${lon});
        node["station"="subway"](around:1200,${lat},${lon});
        node["railway"="halt"](around:1200,${lat},${lon});
        node["railway"="tram_stop"](around:1200,${lat},${lon});
        node["public_transport"="stop_position"]["subway"="yes"](around:1200,${lat},${lon});
        node["public_transport"="station"](around:1200,${lat},${lon});
      );
      out body;
    `;
    const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;
    const overpassResponse = await fetch(overpassUrl, {
      headers: { 'User-Agent': 'HiveListings/1.0 (admin transit lookup)' }
    });
    const overpassData = await overpassResponse.json();

    if (!overpassData.elements || overpassData.elements.length === 0) {
      return res.json({ transit: '', message: 'No transit stations found nearby. Enter transit info manually.' });
    }

    // Step 3: Deduplicate by station name, calculate distances, sort by distance
    const stationMap = new Map();

    for (const el of overpassData.elements) {
      const name = el.tags?.name;
      if (!name) continue;

      const stLat = el.lat;
      const stLon = el.lon;
      const dist = haversineMeters(lat, lon, stLat, stLon);

      // Collect subway/rail line info if available
      const lines = el.tags?.['railway:line'] || el.tags?.line || el.tags?.ref || '';
      const network = el.tags?.network || '';
      const operator = el.tags?.operator || '';

      if (!stationMap.has(name) || stationMap.get(name).dist > dist) {
        stationMap.set(name, { name, dist, lines, network, operator });
      }
    }

    // Sort by distance and take closest stations
    const stations = Array.from(stationMap.values())
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 6);

    // Step 4: Format as human-readable text
    const transitLines = stations.map(s => {
      const walkMin = Math.round(s.dist / 80); // ~80m per minute walking
      const walkStr = walkMin <= 1 ? '1 min walk' : `${walkMin} min walk`;
      let info = s.name;
      if (s.lines) info += ` (${s.lines})`;
      info += ` — ${walkStr}`;
      return info;
    });

    const transitText = transitLines.join(', ');
    res.json({ transit: transitText, stations: stations.length });

  } catch (err) {
    console.error('Transit lookup error:', err);
    res.json({ transit: '', message: 'Transit lookup failed. Enter transit info manually.' });
  }
});

// Haversine distance in meters
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = router;
