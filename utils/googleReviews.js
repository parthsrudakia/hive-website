/**
 * Google Places API - Review Fetcher with Caching
 *
 * Fetches reviews from Google Places API and caches them
 * to avoid hitting the API on every page load.
 *
 * Required env vars:
 *   GOOGLE_PLACES_API_KEY - Your Google Cloud API key with Places API enabled
 *   GOOGLE_PLACE_ID       - Your Google Place ID (starts with ChIJ...)
 */

const https = require('https');

let cachedReviews = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours in ms

function fetchFromGoogle(placeId, apiKey) {
  return new Promise((resolve, reject) => {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=reviews,rating,user_ratings_total&reviews_sort=newest&key=${apiKey}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status === 'OK' && parsed.result) {
            resolve(parsed.result);
          } else {
            console.error('Google Places API error:', parsed.status, parsed.error_message);
            resolve(null);
          }
        } catch (e) {
          console.error('Failed to parse Google Places response:', e);
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.error('Google Places API request failed:', err);
      resolve(null);
    });
  });
}

async function getGoogleReviews() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;

  // If no API key or place ID configured, return empty
  if (!apiKey || !placeId) {
    console.log('Google Reviews: Missing GOOGLE_PLACES_API_KEY or GOOGLE_PLACE_ID env vars');
    return { reviews: [], rating: 0, totalReviews: 0 };
  }

  // Return cached data if still fresh
  const now = Date.now();
  if (cachedReviews && (now - cacheTimestamp) < CACHE_DURATION) {
    return cachedReviews;
  }

  // Fetch fresh data
  const result = await fetchFromGoogle(placeId, apiKey);

  if (result) {
    const reviews = (result.reviews || []).map(r => ({
      author: r.author_name,
      avatar: r.profile_photo_url || null,
      rating: r.rating,
      text: r.text,
      time: r.relative_time_description,
      timestamp: r.time
    }));

    cachedReviews = {
      reviews,
      rating: result.rating || 0,
      totalReviews: result.user_ratings_total || 0
    };
    cacheTimestamp = now;

    console.log(`Google Reviews: Fetched ${reviews.length} reviews (${result.rating} stars, ${result.user_ratings_total} total)`);
    return cachedReviews;
  }

  // If fetch failed but we have stale cache, use it
  if (cachedReviews) {
    console.log('Google Reviews: Using stale cache after fetch failure');
    return cachedReviews;
  }

  return { reviews: [], rating: 0, totalReviews: 0 };
}

module.exports = { getGoogleReviews };
