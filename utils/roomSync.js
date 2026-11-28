// ---------------------------------------------------------------------------
// Room sync: copies the portal's available rooms into the listings table so
// the public site shows real rooms. Run by GET /api/cron/room-sync (daily) and
// the "Sync rooms now" button in admin; public pages only ever read the
// database, never the portal or Drive.
//
//  - Source: GET {PORTAL_URL}/api/inventory (Bearer INVENTORY_API_KEY).
//  - Each room is upserted by portal_room_id with source 'portal'. Street
//    address, unit number and building name are never stored: the public
//    title is "Room 3 in Journal Square" and only the neighborhood is shown.
//  - Photos: the room's Google Drive folder (or single file) is listed with
//    the Drive API when GOOGLE_DRIVE_API_KEY is set, or otherwise read from
//    the folder's public page (no key needed, see listPublicDriveImages).
//    Either way the folder must be shared as "Anyone with the link", and
//    each image is copied once into
//    the listings bucket (utils/storage.js), keyed by its Drive file id in
//    room_sync_photos, so it is never copied twice. A run spends at most
//    TIME_BUDGET_MS copying; whatever is left goes on the next run.
//  - A room is saved but kept hidden (hidden_reason) when it has no photos or
//    an unknown neighborhood. Rooms in a comingSoon market are hidden at query
//    time instead (utils/listingVisibility.js), so their photos are ready.
//  - Rooms that leave the feed or are marked delete_listing get status
//    'rented'. An empty feed retires nothing (safeguard against a bad read).
//  - room_sync_state holds a lock (so the cron and the button never overlap)
//    and the last run's result for the admin panel.
// ---------------------------------------------------------------------------

const { neighborhoodForName } = require('./markets');
const { PORTAL_SOURCE, roomHiddenReason } = require('./listingVisibility');

const TIME_BUDGET_MS = 40 * 1000;
const LOCK_MINUTES = 10;
const MAX_PHOTOS_PER_ROOM = 12;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10 * 1000; // keeps a run inside a 60 s function limit
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
// Used when there is no API key: the public folder view and download link.
const DRIVE_PUBLIC_FOLDER = 'https://drive.google.com/embeddedfolderview';
const DRIVE_PUBLIC_DOWNLOAD = 'https://drive.usercontent.google.com/download';

// Image types a browser can show (and utils/storage.js can optimize). Others,
// such as iPhone HEIC files, are skipped and counted.
const WEB_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Portal amenity names that match the site's key amenity icons.
const KEY_AMENITIES = {
  'in-unit washer/dryer': 'In Unit Washer & Dryer',
  'in unit washer & dryer': 'In Unit Washer & Dryer',
  'fitness center': 'Gym',
  gym: 'Gym',
  pool: 'Pool',
  parking: 'Parking',
  lounge: 'Lounge'
};

function roomSyncConfig(env = process.env) {
  const portalUrl = (env.PORTAL_URL || '').trim().replace(/\/+$/, '');
  const inventoryKey = (env.INVENTORY_API_KEY || '').trim();
  const driveKey = (env.GOOGLE_DRIVE_API_KEY || '').trim();
  const missing = [
    !portalUrl && 'PORTAL_URL',
    !inventoryKey && 'INVENTORY_API_KEY'
  ].filter(Boolean);
  return { enabled: missing.length === 0, missing, portalUrl, inventoryKey, driveKey };
}

// Google Drive share links in the formats the portal holds:
//   drive.google.com/drive/folders/<id>, .../folders/<id>?usp=sharing,
//   .../drive/u/0/folders/<id>, .../file/d/<id>/view, .../open?id=<id>
// Returns { kind: 'folder' | 'file', id, resourceKey } or null.
function parseDriveLink(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed;
  try {
    parsed = new URL(url.trim().replace(/^(?!https?:\/\/)/i, 'https://'));
  } catch {
    return null;
  }
  if (!/(^|\.)drive\.google\.com$/i.test(parsed.hostname)) return null;
  const resourceKey = parsed.searchParams.get('resourcekey') || null;
  const folder = parsed.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (folder) return { kind: 'folder', id: folder[1], resourceKey };
  const file = parsed.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  if (file) return { kind: 'file', id: file[1], resourceKey };
  const openId = parsed.searchParams.get('id');
  if (/^\/open\/?$/.test(parsed.pathname) && openId && /^[A-Za-z0-9_-]{10,}$/.test(openId)) {
    return { kind: 'file', id: openId, resourceKey };
  }
  return null;
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when text names the room's street address, building or unit number.
function containsPrivateDetail(text, room) {
  if (!text) return false;
  const haystack = String(text).toLowerCase();
  for (const value of [room.street_address, room.building_name]) {
    const needle = String(value || '').trim().toLowerCase();
    if (needle && haystack.includes(needle)) return true;
  }
  const unit = String(room.unit_number || '').trim();
  if (unit) {
    const unitRe = new RegExp(`(\\bapt\\.?|\\bapartment|\\bunit|#)\\s*${escapeRegExp(unit)}(?![A-Za-z0-9])`, 'i');
    if (unitRe.test(String(text))) return true;
  }
  return false;
}

function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const roomNumberOf = room => String(room.room_number || '').trim().replace(/^room\s+/i, '');

function buildDescription(room, place, today) {
  const amenities = room.amenities || {};
  const lines = [];
  const first = [`Furnished private room in ${place.name}, ${place.market.name}.`];
  first.push(amenities.has_private_bathroom ? 'Private bathroom.' : 'Shared bathroom.');
  if (amenities.has_ac) first.push('Air conditioning.');
  const from = room.available_from && room.available_from > today ? formatDate(room.available_from) : null;
  first.push(from ? `Available from ${from}.` : 'Available now.');
  lines.push(first.join(' '));
  const unitList = (amenities.unit || []).filter(Boolean);
  const buildingList = (amenities.building || []).filter(Boolean);
  if (unitList.length) lines.push(`In the apartment: ${unitList.join(', ')}.`);
  if (buildingList.length) lines.push(`In the building: ${buildingList.join(', ')}.`);
  lines.push('Month-to-month, 30-day minimum stay, no broker fee. The monthly price includes services.');
  return lines.join('\n\n');
}

// The listing fields for one inventory room (photos and hidden_reason are
// settled later). Only public-safe values: no street, unit number or building.
function mapRoom(room, today) {
  const place = neighborhoodForName(room.neighborhood);
  const amenities = room.amenities || {};
  const roomNumber = roomNumberOf(room);
  const where = place ? place.name : 'the city';
  const title = roomNumber ? `Room ${roomNumber} in ${where}` : `Private room in ${where}`;
  const rent = room.rent || {};
  const price = Math.round(Number(rent.total ?? rent.base ?? 0)) || 0;

  const unitAmenities = (amenities.unit || []).filter(Boolean).map(String);
  const extras = [];
  if (amenities.has_private_bathroom) extras.push('Private bathroom');
  if (amenities.has_ac && !unitAmenities.some(a => /a\/c|air condition/i.test(a))) extras.push('Air conditioning');
  const buildingAmenities = (amenities.building || []).filter(Boolean).map(String);
  const keyAmenities = [...new Set(
    [...unitAmenities, ...buildingAmenities]
      .map(a => KEY_AMENITIES[a.trim().toLowerCase()])
      .filter(Boolean)
  )];

  let description = place ? buildDescription(room, place, today) : '';
  let descriptionNote = null;
  if (room.marketing_description && String(room.marketing_description).trim()) {
    if (containsPrivateDetail(room.marketing_description, room)) {
      descriptionNote = 'marketing description names the address, building or unit, so a generated one is used';
    } else {
      description = String(room.marketing_description).trim();
    }
  }

  return {
    portal_room_id: String(room.id),
    title,
    neighborhood: place ? place.name : String(room.neighborhood || '').trim() || 'Unknown',
    city: place ? place.market.name : 'Unknown',
    state: place ? place.market.state : 'NY',
    location: place ? place.market.name : null,
    bedrooms: 1,
    bathrooms: 1,
    private_bath: !!amenities.has_private_bathroom,
    property_type: 'room',
    price_monthly: price,
    status: room.listing_action === 'delete_listing' ? 'rented' : 'available',
    available_from: room.available_from || null,
    description,
    amenities: [...unitAmenities, ...extras],
    building_amenities: buildingAmenities,
    key_amenities: keyAmenities,
    known_neighborhood: !!place,
    description_note: descriptionNote
  };
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  return fetchImpl(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function fetchInventory(config, fetchImpl) {
  const res = await fetchWithTimeout(fetchImpl, `${config.portalUrl}/api/inventory`, {
    headers: { Authorization: `Bearer ${config.inventoryKey}` }
  });
  if (!res.ok) throw new Error(`inventory request failed (HTTP ${res.status})`);
  const body = await res.json();
  if (!body || !Array.isArray(body.rooms)) throw new Error('inventory response has no rooms list');
  return body.rooms;
}

// Error text from a Drive response, never including the request URL (it
// carries the API key).
async function driveError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body && body.error && body.error.message ? `: ${body.error.message}` : '';
  } catch { /* not JSON */ }
  if (res.status === 403 || res.status === 404) {
    return new Error(`Drive returned HTTP ${res.status} (is the folder shared as "Anyone with the link"?)${detail}`);
  }
  return new Error(`Drive returned HTTP ${res.status}${detail}`);
}

function driveHeaders(link) {
  return link.resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${link.id}/${link.resourceKey}` } : {};
}

// Image files behind a Drive link, sorted by name: [{ id, name, mimeType }].
async function listDriveImages(link, driveKey, fetchImpl) {
  const common = `supportsAllDrives=true&key=${encodeURIComponent(driveKey)}`;
  if (link.kind === 'file') {
    const res = await fetchWithTimeout(fetchImpl,
      `${DRIVE_API}/files/${link.id}?fields=id,name,mimeType&${common}`, { headers: driveHeaders(link) });
    if (!res.ok) throw await driveError(res);
    const file = await res.json();
    return /^image\//.test(file.mimeType || '') ? [file] : [];
  }
  const files = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${link.id}' in parents and mimeType contains 'image/' and trashed = false`);
    const res = await fetchWithTimeout(fetchImpl,
      `${DRIVE_API}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType)&orderBy=name&pageSize=100` +
      `&includeItemsFromAllDrives=true&${common}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      { headers: driveHeaders(link) });
    if (!res.ok) throw await driveError(res);
    const body = await res.json();
    files.push(...(body.files || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken && files.length < 500);
  return files;
}

async function downloadDriveFile(file, link, driveKey, fetchImpl) {
  const res = await fetchWithTimeout(fetchImpl,
    `${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(driveKey)}`,
    { headers: driveHeaders(link) });
  if (!res.ok) throw await driveError(res);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_PHOTO_BYTES) throw new Error(`photo ${file.name || file.id} is over 25 MB`);
  return buffer;
}

// --- Without an API key -----------------------------------------------------
// A folder shared as "Anyone with the link" has a public page that lists its
// files, and each file has a public download link. Neither is a documented
// API, so every answer is checked: a page without the file list, or a
// download that isn't an image, is reported and the room keeps what it has.

const NOT_PUBLIC_HINT = '(is the folder shared as "Anyone with the link"?)';

const decodeEntities = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Files on a public folder page: [{ id, name, mimeType }]. Subfolders and
// anything without a file type are left out. Returns null when the page
// isn't a folder listing at all.
function parsePublicFolderPage(html) {
  const page = String(html || '');
  if (!page.includes('flip-entries')) return null;
  const files = [];
  for (const block of page.split('<div class="flip-entry"').slice(1)) {
    const id = /^\s+id="entry-([A-Za-z0-9_-]{10,})"/.exec(block);
    const type = /flip-entry-list-icon"><img src="[^"]*\/type\/([a-z0-9.+-]+\/[a-z0-9.+-]+)"/i.exec(block);
    const title = /<div class="flip-entry-title">([^<]*)<\/div>/.exec(block);
    if (!id || !type) continue;
    files.push({ id: id[1], name: title ? decodeEntities(title[1]).trim() : id[1], mimeType: type[1].toLowerCase() });
  }
  return files;
}

const publicParams = link => `id=${encodeURIComponent(link.id)}` +
  (link.resourceKey ? `&resourcekey=${encodeURIComponent(link.resourceKey)}` : '');

const byNaturalName = (a, b) =>
  String(a.name).localeCompare(String(b.name), 'en', { numeric: true, sensitivity: 'base' });

// Same result as listDriveImages, read from the public page instead.
async function listPublicDriveImages(link, fetchImpl) {
  if (link.kind === 'file') {
    // A single file: its type is whatever the public download answers with.
    const res = await fetchWithTimeout(fetchImpl, `${DRIVE_PUBLIC_DOWNLOAD}?${publicParams(link)}&export=download`);
    const mimeType = String((res.headers && res.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase();
    if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
    if (!res.ok) throw new Error(`Drive returned HTTP ${res.status} ${NOT_PUBLIC_HINT}`);
    return /^image\//.test(mimeType) ? [{ id: link.id, name: link.id, mimeType }] : [];
  }
  const res = await fetchWithTimeout(fetchImpl, `${DRIVE_PUBLIC_FOLDER}?${publicParams(link)}`);
  if (!res.ok) throw new Error(`Drive returned HTTP ${res.status} ${NOT_PUBLIC_HINT}`);
  const files = parsePublicFolderPage(await res.text());
  if (!files) throw new Error(`the Drive folder page could not be read ${NOT_PUBLIC_HINT}`);
  return files.filter(f => /^image\//.test(f.mimeType)).sort(byNaturalName);
}

async function downloadPublicDriveFile(file, link, fetchImpl) {
  const key = link.kind === 'file' && link.resourceKey ? `&resourcekey=${encodeURIComponent(link.resourceKey)}` : '';
  const res = await fetchWithTimeout(fetchImpl,
    `${DRIVE_PUBLIC_DOWNLOAD}?id=${encodeURIComponent(file.id)}${key}&export=download`);
  if (!res.ok) throw new Error(`Drive returned HTTP ${res.status} ${NOT_PUBLIC_HINT}`);
  // A sign-in or warning page comes back as HTML with status 200.
  const type = String((res.headers && res.headers.get('content-type')) || '').toLowerCase();
  if (!type.startsWith('image/')) throw new Error(`Drive did not return an image for ${file.name || file.id}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_PHOTO_BYTES) throw new Error(`photo ${file.name || file.id} is over 25 MB`);
  return buffer;
}

// Photos for one room. Returns { images, note, pending }; images is null when
// this run couldn't check (keep what is stored).
async function syncRoomPhotos(room, existingImages, ctx) {
  if (!room.photos_url || !String(room.photos_url).trim()) return { images: [], note: null, pending: 0 };
  const link = parseDriveLink(room.photos_url);
  if (!link) return { images: null, note: 'photo link is not a Google Drive folder or file', pending: 0 };
  if (ctx.outOfTime()) return { images: null, note: 'not checked this run (time budget)', pending: 0 };

  let files;
  try {
    files = ctx.config.driveKey
      ? await listDriveImages(link, ctx.config.driveKey, ctx.fetchImpl)
      : await listPublicDriveImages(link, ctx.fetchImpl);
  } catch (err) {
    return { images: null, note: `could not list photos: ${err.message}`, pending: 0 };
  }
  const usable = files.filter(f => WEB_IMAGE_TYPES.includes(String(f.mimeType || '').toLowerCase()));
  ctx.stats.skippedTypes += files.length - usable.length;
  const chosen = usable.slice(0, MAX_PHOTOS_PER_ROOM);

  let pending = 0;
  const notes = [];
  for (const file of chosen) {
    if (ctx.photoMap.has(file.id)) continue;
    if (ctx.outOfTime()) { pending++; continue; }
    try {
      const buffer = ctx.config.driveKey
        ? await downloadDriveFile(file, link, ctx.config.driveKey, ctx.fetchImpl)
        : await downloadPublicDriveFile(file, link, ctx.fetchImpl);
      const url = await ctx.storeImage({ buffer, mimetype: file.mimeType, originalname: file.name || `${file.id}.jpg` });
      await ctx.pool.query(
        'INSERT INTO room_sync_photos (drive_file_id, url) VALUES ($1, $2) ON CONFLICT (drive_file_id) DO NOTHING',
        [file.id, url]
      );
      ctx.photoMap.set(file.id, url);
      ctx.stats.copied++;
    } catch (err) {
      notes.push(`could not copy a photo: ${err.message}`);
    }
  }
  if (files.length > usable.length) notes.push(`${files.length - usable.length} photo(s) skipped (not JPEG, PNG, WebP or GIF)`);
  const images = chosen.map(f => ctx.photoMap.get(f.id)).filter(Boolean);
  // A run that ran out of time keeps what was there if it has fewer so far.
  const keep = pending > 0 && existingImages.length > images.length;
  return { images: keep ? null : images, note: notes.join('; ') || null, pending };
}

const UPSERT_COLUMNS = [
  'portal_room_id', 'source', 'title', 'neighborhood', 'city', 'state', 'location',
  'bedrooms', 'bathrooms', 'private_bath', 'property_type', 'price_monthly', 'status',
  'available_from', 'description', 'amenities', 'building_amenities', 'key_amenities',
  'images', 'hidden_reason', 'min_stay', 'show_booking'
];

const UPSERT_SQL = `INSERT INTO listings (${UPSERT_COLUMNS.join(', ')}, synced_at, updated_at)
  VALUES (${UPSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')}, NOW(), NOW())
  ON CONFLICT (portal_room_id) DO UPDATE SET
  ${UPSERT_COLUMNS.filter(c => c !== 'portal_room_id').map(c => `${c} = EXCLUDED.${c}`).join(', ')},
  synced_at = NOW(), updated_at = NOW()`;

async function acquireLock(pool) {
  await pool.query('INSERT INTO room_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  const { rows } = await pool.query(
    `UPDATE room_sync_state SET running_since = NOW(), last_started_at = NOW()
      WHERE id = 1 AND (running_since IS NULL OR running_since < NOW() - INTERVAL '${LOCK_MINUTES} minutes')
      RETURNING id`
  );
  return rows.length > 0;
}

async function releaseLock(pool, result) {
  await pool.query(
    'UPDATE room_sync_state SET running_since = NULL, last_finished_at = NOW(), last_result = $1 WHERE id = 1',
    [JSON.stringify(result)]
  );
}

// One sync run. Dependencies are injectable for tests.
async function runRoomSync({
  pool = require('../db/pool'),
  fetchImpl = globalThis.fetch,
  storeImage = require('./storage').storeImage,
  env = process.env,
  now = () => Date.now(),
  budgetMs = TIME_BUDGET_MS,
  log = console
} = {}) {
  const config = roomSyncConfig(env);
  if (!config.enabled) return { ok: false, skipped: 'not configured', missing: config.missing };
  if (!(await acquireLock(pool))) return { ok: false, skipped: 'a sync is already running' };

  const startedAt = now();
  const result = {
    ok: false,
    started_at: new Date(startedAt).toISOString(),
    feed_count: 0,
    saved: 0,
    retired: 0,
    shown: 0,
    hidden: [],
    photos: { copied: 0, pending: 0, skipped_types: 0 },
    warnings: [],
    error: null
  };
  try {
    const rooms = await fetchInventory(config, fetchImpl);
    result.feed_count = rooms.length;
    const today = new Date(startedAt).toISOString().slice(0, 10);

    const { rows: existing } = await pool.query(
      `SELECT portal_room_id, images FROM listings WHERE source = '${PORTAL_SOURCE}'`
    );
    const existingImages = new Map(existing.map(r => [r.portal_room_id, r.images || []]));
    const { rows: photoRows } = await pool.query('SELECT drive_file_id, url FROM room_sync_photos');
    const ctx = {
      config,
      fetchImpl,
      storeImage,
      pool,
      photoMap: new Map(photoRows.map(r => [r.drive_file_id, r.url])),
      stats: { copied: 0, skippedTypes: 0 },
      outOfTime: () => now() - startedAt > budgetMs
    };

    // Rooms with no photos yet go first, so a short run shows the most rooms.
    const valid = rooms.filter(r => r && r.id);
    if (valid.length < rooms.length) result.warnings.push(`${rooms.length - valid.length} room(s) without an id were skipped`);
    valid.sort((a, b) =>
      (existingImages.get(String(a.id)) || []).length - (existingImages.get(String(b.id)) || []).length);

    for (const room of valid) {
      const listing = mapRoom(room, today);
      const stored = existingImages.get(listing.portal_room_id) || [];
      let images = stored;
      if (listing.status !== 'rented') {
        const photos = await syncRoomPhotos(room, stored, ctx);
        if (photos.images) images = photos.images;
        result.photos.pending += photos.pending;
        if (photos.note) {
          result.warnings.push(`${listing.title}: ${photos.note}`);
          log.warn(`[room-sync] ${listing.title}: ${photos.note}`);
        }
      }
      if (listing.description_note) result.warnings.push(`${listing.title}: ${listing.description_note}`);
      listing.images = images;
      listing.source = PORTAL_SOURCE;
      listing.min_stay = 30;
      listing.show_booking = true;
      listing.hidden_reason = !listing.known_neighborhood ? 'unknown_neighborhood'
        : listing.price_monthly <= 0 ? 'no_price'
          : images.length === 0 ? 'no_photos' : null;
      if (!listing.known_neighborhood) {
        result.warnings.push(`${listing.title}: neighborhood "${listing.neighborhood}" is not in utils/markets.js`);
      }

      await pool.query(UPSERT_SQL, UPSERT_COLUMNS.map(c => listing[c]));
      result.saved++;
      if (listing.status === 'rented') continue;
      const reason = roomHiddenReason(listing);
      if (reason) result.hidden.push({ room: listing.title, reason });
      else result.shown++;
    }

    // Rooms that left the feed are retired. An empty feed is treated as a bad
    // read: retiring everything would bring the placeholders back.
    if (valid.length === 0) {
      result.warnings.push('the inventory returned no rooms, so nothing was removed');
    } else {
      const { rowCount } = await pool.query(
        `UPDATE listings SET status = 'rented', synced_at = NOW(), updated_at = NOW()
          WHERE source = '${PORTAL_SOURCE}' AND status != 'rented' AND NOT (portal_room_id = ANY($1::text[]))`,
        [valid.map(r => String(r.id))]
      );
      result.retired = rowCount || 0;
    }

    result.photos.copied = ctx.stats.copied;
    result.photos.skipped_types = ctx.stats.skippedTypes;
    result.ok = true;
  } catch (err) {
    result.error = err.message;
    log.error('[room-sync] failed:', err.message);
  } finally {
    result.finished_at = new Date(now()).toISOString();
    try {
      await releaseLock(pool, result);
    } catch (err) {
      log.error('[room-sync] could not save the result:', err.message);
    }
  }
  log.log(`[room-sync] ${result.ok ? 'done' : 'failed'}: ${result.feed_count} in feed, ${result.shown} shown, ` +
    `${result.hidden.length} hidden, ${result.retired} removed, ${result.photos.copied} photo(s) copied, ` +
    `${result.photos.pending} pending`);
  return result;
}

module.exports = {
  TIME_BUDGET_MS,
  MAX_PHOTOS_PER_ROOM,
  roomSyncConfig,
  parseDriveLink,
  parsePublicFolderPage,
  containsPrivateDetail,
  mapRoom,
  runRoomSync
};
