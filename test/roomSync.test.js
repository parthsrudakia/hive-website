'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDriveLink,
  mapRoom,
  containsPrivateDetail,
  runRoomSync,
  roomSyncConfig,
  MAX_PHOTOS_PER_ROOM
} = require('../utils/roomSync');
const visibility = require('../utils/listingVisibility');
const { MARKET_PAGES } = require('../utils/markets');

// --- Fictional fixture: none of these addresses, buildings or units exist. ---

const PORTAL_URL = 'https://portal.example.test';
const ENV = { PORTAL_URL, INVENTORY_API_KEY: 'inv-test-key', GOOGLE_DRIVE_API_KEY: 'drive-test-key' };
const NOW = Date.parse('2026-11-18T12:00:00Z');

const room = (overrides) => ({
  id: 'room-ues-1',
  unit: 'Example Tower Apt 4B',
  building_name: 'Example Tower',
  street_address: '100 Fictional Avenue',
  unit_number: '4B',
  neighborhood: 'UES',
  room_number: '2',
  status: 'available',
  available_from: '2026-11-01',
  rent: { base: 2000, services: 150, total: 2150 },
  amenities: {
    has_private_bathroom: true,
    has_ac: true,
    unit: ['In-Unit Washer/Dryer', 'High-Speed WiFi'],
    building: ['Fitness Center', 'Elevator']
  },
  photos_url: 'https://drive.google.com/drive/folders/FOLDERues0000001',
  marketing_description: null,
  facebook_ads: true,
  listing_action: 'no_action',
  ...overrides
});

const FEED = () => [
  room(),
  room({
    id: 'room-jsq-1', unit: '22 Sample Street Apt 3R', building_name: null, street_address: '22 Sample Street',
    unit_number: '3R', neighborhood: 'JSQ', room_number: 'Room 1', available_from: '2027-01-15',
    rent: { base: 1500, services: 150, total: 1650 },
    amenities: { has_private_bathroom: false, has_ac: false, unit: ['Dishwasher'], building: ['Lounge'] },
    photos_url: 'https://drive.google.com/drive/folders/FOLDERjsq0000001?usp=sharing'
  }),
  room({
    id: 'room-hob-1', unit: 'Riverside Lofts Apt 9C', building_name: 'Riverside Lofts', street_address: '7 Imaginary Place',
    unit_number: '9C', neighborhood: 'Hoboken', room_number: '3', photos_url: null
  }),
  room({
    id: 'room-odd-1', unit: 'Nowhere House Apt 1A', building_name: 'Nowhere House', street_address: '1 Nowhere Road',
    unit_number: '1A', neighborhood: 'Mystery Park', room_number: '1',
    photos_url: 'https://drive.google.com/drive/u/0/folders/FOLDERodd0000001'
  }),
  room({
    id: 'room-del-1', unit: 'Harbor View Apt 12F', building_name: 'Harbor View', street_address: '55 Pretend Plaza',
    unit_number: '12F', neighborhood: 'FiDi', room_number: '4', listing_action: 'delete_listing',
    photos_url: 'https://drive.google.com/drive/folders/FOLDERdel0000001'
  })
];

const PRIVATE_VALUES = [
  '100 Fictional Avenue', 'Example Tower', '4B',
  '22 Sample Street', '3R',
  '7 Imaginary Place', 'Riverside Lofts', '9C',
  '1 Nowhere Road', 'Nowhere House',
  '55 Pretend Plaza', 'Harbor View', '12F'
];

const DRIVE = {
  FOLDERues0000001: [
    { id: 'fileUES0000001', name: '01-living.jpg', mimeType: 'image/jpeg' },
    { id: 'fileUES0000002', name: '02-room.png', mimeType: 'image/png' },
    { id: 'fileHEIC000001', name: '03-bath.heic', mimeType: 'image/heic' }
  ],
  // The same Drive file can sit in two folders; it is still copied once.
  FOLDERjsq0000001: [
    { id: 'fileJSQ0000001', name: '01.jpg', mimeType: 'image/jpeg' },
    { id: 'fileUES0000001', name: '02.jpg', mimeType: 'image/jpeg' }
  ],
  FOLDERodd0000001: [{ id: 'fileODD0000001', name: '01.jpg', mimeType: 'image/jpeg' }],
  FOLDERdel0000001: [{ id: 'fileDEL0000001', name: '01.jpg', mimeType: 'image/jpeg' }]
};

// --- Fakes ---

function fakeFetch({ feed = FEED(), feedStatus = 200, drive = DRIVE, driveStatus = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers || {} });
    const json = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    });
    if (url === `${PORTAL_URL}/api/inventory`) {
      if (options.headers.Authorization !== `Bearer ${ENV.INVENTORY_API_KEY}`) return json(401, { error: 'unauthorized' });
      return json(feedStatus, feedStatus === 200 ? { as_of: '2026-11-18', count: feed.length, rooms: feed } : { error: 'down' });
    }
    const list = url.match(/\/drive\/v3\/files\?q=([^&]+)/);
    if (list) {
      const folder = decodeURIComponent(list[1]).match(/'([^']+)' in parents/)[1];
      if (driveStatus[folder]) return json(driveStatus[folder], { error: { message: 'File not found' } });
      return json(200, { files: drive[folder] || [] });
    }
    const media = url.match(/\/drive\/v3\/files\/([^?]+)\?alt=media/);
    if (media) return json(200, {});
    const meta = url.match(/\/drive\/v3\/files\/([^?]+)\?fields=/);
    if (meta) return json(200, { id: meta[1], name: 'single.jpg', mimeType: 'image/jpeg' });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, calls };
}

function fakeStore() {
  const stored = [];
  const storeImage = async (file) => {
    stored.push(file);
    return `https://example.supabase.co/storage/v1/object/public/listings/copy-${stored.length}.webp`;
  };
  return { storeImage, stored };
}

// In-memory stand-in for the statements runRoomSync issues.
function fakePool({ running = false } = {}) {
  const db = { listings: new Map(), photos: new Map(), state: null, running, queries: [] };
  db.query = async (sql, params = []) => {
    db.queries.push(sql);
    if (/^INSERT INTO room_sync_state/.test(sql)) return { rows: [] };
    if (/^UPDATE room_sync_state SET running_since = NOW\(\)/.test(sql)) {
      if (db.running) return { rows: [] };
      db.running = true;
      return { rows: [{ id: 1 }] };
    }
    if (/^UPDATE room_sync_state SET running_since = NULL/.test(sql)) {
      db.running = false;
      db.state = JSON.parse(params[0]);
      return { rows: [] };
    }
    if (/^SELECT portal_room_id, images FROM listings/.test(sql)) {
      return { rows: [...db.listings.values()].map(l => ({ portal_room_id: l.portal_room_id, images: l.images })) };
    }
    if (/^SELECT drive_file_id, url FROM room_sync_photos/.test(sql)) {
      return { rows: [...db.photos].map(([drive_file_id, url]) => ({ drive_file_id, url })) };
    }
    if (/^INSERT INTO room_sync_photos/.test(sql)) {
      if (!db.photos.has(params[0])) db.photos.set(params[0], params[1]);
      return { rows: [] };
    }
    if (/^INSERT INTO listings/.test(sql)) {
      const cols = sql.match(/INSERT INTO listings \(([^)]+)\)/)[1].split(',').map(c => c.trim());
      const row = {};
      params.forEach((value, i) => { row[cols[i]] = value; });
      const before = db.listings.get(row.portal_room_id) || { featured: false, sort_order: 0 };
      db.listings.set(row.portal_room_id, { ...before, ...row });
      return { rows: [] };
    }
    if (/^UPDATE listings SET status = 'rented'/.test(sql)) {
      let rowCount = 0;
      for (const l of db.listings.values()) {
        if (l.source === 'portal' && l.status !== 'rented' && !params[0].includes(l.portal_room_id)) {
          l.status = 'rented';
          rowCount++;
        }
      }
      return { rows: [], rowCount };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  };
  return db;
}

const quietLog = { log() {}, warn() {}, error() {} };

function run(overrides = {}) {
  const { fetchImpl } = overrides.fetch || fakeFetch();
  return runRoomSync({
    pool: overrides.pool,
    fetchImpl,
    storeImage: (overrides.store || fakeStore()).storeImage,
    env: overrides.env || ENV,
    now: overrides.now || (() => NOW),
    budgetMs: overrides.budgetMs,
    log: quietLog
  });
}

// --- Drive links ---

test('parses every Drive link format the portal holds', () => {
  const id = '1AbC_dEf-GhIjKlMn0';
  assert.deepEqual(parseDriveLink(`https://drive.google.com/drive/folders/${id}`), { kind: 'folder', id, resourceKey: null });
  assert.deepEqual(parseDriveLink(`https://drive.google.com/drive/folders/${id}?usp=sharing`), { kind: 'folder', id, resourceKey: null });
  assert.deepEqual(parseDriveLink(`https://drive.google.com/drive/u/0/folders/${id}`), { kind: 'folder', id, resourceKey: null });
  assert.deepEqual(parseDriveLink(`https://drive.google.com/file/d/${id}/view?usp=drive_link`), { kind: 'file', id, resourceKey: null });
  assert.deepEqual(parseDriveLink(`https://drive.google.com/open?id=${id}`), { kind: 'file', id, resourceKey: null });
  assert.deepEqual(parseDriveLink(`drive.google.com/drive/folders/${id}`), { kind: 'folder', id, resourceKey: null });
  assert.deepEqual(parseDriveLink(`https://drive.google.com/drive/folders/${id}?resourcekey=0-xyz`), { kind: 'folder', id, resourceKey: '0-xyz' });
});

test('rejects links that are not Drive folders or files', () => {
  for (const value of [null, '', 'not a link', 'https://example.com/folders/1AbC_dEf-GhIjKlMn0',
    'https://drive.google.com/drive/my-drive', 'https://evil.example/drive.google.com/folders/1AbC_dEf-GhIjKlMn0']) {
    assert.equal(parseDriveLink(value), null, String(value));
  }
});

// --- Mapping ---

test('maps a room to a listing', () => {
  const l = mapRoom(room(), '2026-11-18');
  assert.equal(l.portal_room_id, 'room-ues-1');
  assert.equal(l.title, 'Room 2 in Upper East Side');
  assert.equal(l.price_monthly, 2150);
  assert.equal(l.neighborhood, 'Upper East Side');
  assert.equal(l.city, 'New York');
  assert.equal(l.location, 'New York');
  assert.equal(l.state, 'NY');
  assert.equal(l.private_bath, true);
  assert.equal(l.property_type, 'room');
  assert.equal(l.status, 'available');
  assert.deepEqual(l.key_amenities, ['In Unit Washer & Dryer', 'Gym']);
  assert.deepEqual(l.building_amenities, ['Fitness Center', 'Elevator']);
  assert.ok(l.amenities.includes('Private bathroom') && l.amenities.includes('Air conditioning'));
  for (const phrase of ['Furnished private room in Upper East Side, New York.', 'Private bathroom.', 'Air conditioning.',
    'Available now.', 'In the apartment: In-Unit Washer/Dryer, High-Speed WiFi.', 'In the building: Fitness Center, Elevator.',
    'Month-to-month', 'no broker fee', 'includes services']) {
    assert.ok(l.description.includes(phrase), phrase);
  }
});

test('maps each neighborhood to its market and public name', () => {
  const cases = [
    ['JSQ', 'Journal Square', 'Jersey City', 'NJ'],
    ['Jersey City Heights', 'Jersey City Heights', 'Jersey City', 'NJ'],
    ['Historic Downtown', 'Historic Downtown', 'Jersey City', 'NJ'],
    ['UES', 'Upper East Side', 'New York', 'NY'],
    ['FiDi', 'Financial District', 'New York', 'NY'],
    ['Battery Park', 'Battery Park City', 'New York', 'NY'],
    ['Hoboken', 'Hoboken', 'Hoboken', 'NJ']
  ];
  for (const [label, name, market, state] of cases) {
    const l = mapRoom(room({ neighborhood: label }), '2026-11-18');
    assert.deepEqual([l.neighborhood, l.location, l.state], [name, market, state], label);
  }
  assert.equal(mapRoom(room({ neighborhood: 'Mystery Park' }), '2026-11-18').known_neighborhood, false);
});

test('a shared-bath room with a later date reads correctly', () => {
  const l = mapRoom(FEED()[1], '2026-11-18');
  assert.equal(l.title, 'Room 1 in Journal Square');
  assert.equal(l.private_bath, false);
  assert.ok(l.description.includes('Shared bathroom.'));
  assert.ok(!l.description.includes('Air conditioning'));
  assert.ok(l.description.includes('Available from January 15, 2027.'));
});

test('uses the marketing description when there is one', () => {
  const l = mapRoom(room({ marketing_description: 'Sunny corner room with a desk.' }), '2026-11-18');
  assert.equal(l.description, 'Sunny corner room with a desk.');
  assert.equal(l.description_note, null);
});

// --- Privacy ---

test('no address, unit number or building name in any mapped field', () => {
  for (const r of FEED()) {
    const text = JSON.stringify(mapRoom(r, '2026-11-18'));
    for (const value of PRIVATE_VALUES) assert.ok(!text.includes(value), `${r.id} leaks ${value}`);
    assert.ok(!text.includes(r.unit), `${r.id} leaks the unit label`);
  }
});

test('a marketing description that names the address, building or unit is not used', () => {
  for (const text of ['Lovely room at 100 Fictional Avenue.', 'Welcome to Example Tower!', 'Bright room in apt 4B.', 'Unit #4B has a view.']) {
    const l = mapRoom(room({ marketing_description: text }), '2026-11-18');
    assert.notEqual(l.description, text, text);
    assert.match(l.description_note, /names the address/);
  }
  assert.equal(containsPrivateDetail('Room 4 has a big window.', room()), false);
});

test('no address, unit number or building name anywhere in what a run stores', async () => {
  const pool = fakePool();
  await run({ pool });
  const stored = JSON.stringify([...pool.listings.values()]);
  for (const value of PRIVATE_VALUES) assert.ok(!stored.includes(value), `stored ${value}`);
  for (const r of pool.listings.values()) assert.equal(r.address, undefined);
});

// --- A full run: show and hide rules ---

test('saves every room and decides which are shown and why the rest are hidden', async () => {
  const pool = fakePool();
  const store = fakeStore();
  const result = await run({ pool, store });

  assert.equal(result.ok, true);
  assert.equal(result.feed_count, 5);
  assert.equal(result.saved, 5);
  const byId = id => pool.listings.get(id);
  assert.equal(byId('room-ues-1').hidden_reason, null);
  assert.equal(byId('room-ues-1').images.length, 2); // HEIC skipped
  assert.equal(byId('room-hob-1').hidden_reason, 'no_photos');
  assert.equal(byId('room-odd-1').hidden_reason, 'unknown_neighborhood');
  assert.equal(byId('room-del-1').status, 'rented');
  // Jersey City: photos copied and nothing held back by the sync itself, so
  // the room shows as soon as the comingSoon flag goes.
  assert.equal(byId('room-jsq-1').hidden_reason, null);
  assert.equal(byId('room-jsq-1').images.length, 2);

  assert.equal(result.shown, 1);
  assert.deepEqual(result.hidden.map(h => [h.room, h.reason]).sort(), [
    ['Room 1 in Journal Square', 'coming_soon_market'],
    ['Room 1 in the city', 'unknown_neighborhood'],
    ['Room 3 in Hoboken', 'no_photos']
  ]);
  assert.equal(result.photos.skipped_types, 1);
  assert.ok(result.warnings.some(w => w.includes('"Mystery Park"')));
  assert.equal(pool.state.ok, true, 'the result is saved for the admin panel');
  assert.equal(pool.running, false, 'the lock is released');
});

test('a hidden room shows once its photos arrive, and a removed room comes back', async () => {
  const pool = fakePool();
  const drive = { ...DRIVE, FOLDERues0000001: [] };
  await run({ pool, fetch: fakeFetch({ drive }) });
  assert.equal(pool.listings.get('room-ues-1').hidden_reason, 'no_photos');

  await run({ pool, fetch: fakeFetch({ feed: FEED().filter(r => r.id !== 'room-ues-1') }) });
  assert.equal(pool.listings.get('room-ues-1').status, 'rented', 'left the feed');

  await run({ pool });
  assert.equal(pool.listings.get('room-ues-1').status, 'available', 'back in the feed');
  assert.equal(pool.listings.get('room-ues-1').hidden_reason, null, 'photos arrived');
});

test('an empty feed removes nothing', async () => {
  const pool = fakePool();
  await run({ pool });
  const before = pool.queries.length;
  const result = await run({ pool, fetch: fakeFetch({ feed: [] }) });
  assert.equal(result.ok, true);
  assert.equal(result.retired, 0);
  assert.ok(result.warnings.some(w => /returned no rooms/.test(w)));
  assert.ok(!pool.queries.slice(before).some(q => /^UPDATE listings SET status = 'rented'/.test(q)));
  assert.equal(pool.listings.get('room-ues-1').status, 'available');
});

test('a failed inventory read changes nothing', async () => {
  const pool = fakePool();
  const result = await run({ pool, fetch: fakeFetch({ feedStatus: 500 }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 500/);
  assert.equal(pool.listings.size, 0);
  assert.ok(!pool.queries.some(q => /^(INSERT INTO listings|UPDATE listings)/.test(q)));
  assert.equal(pool.running, false);
});

test('does nothing when not configured', async () => {
  const pool = fakePool();
  const result = await run({ pool, env: {} });
  assert.deepEqual(result, { ok: false, skipped: 'not configured', missing: ['PORTAL_URL', 'INVENTORY_API_KEY'] });
  assert.equal(pool.queries.length, 0);
  assert.equal(roomSyncConfig({ PORTAL_URL: 'https://x.test/', INVENTORY_API_KEY: 'k' }).portalUrl, 'https://x.test');
});

test('never runs two syncs at once', async () => {
  const pool = fakePool({ running: true });
  const result = await run({ pool });
  assert.deepEqual(result, { ok: false, skipped: 'a sync is already running' });
  assert.ok(!pool.queries.some(q => /listings/.test(q)));
});

// --- Photos ---

test('copies each Drive photo once, across rooms and runs', async () => {
  const pool = fakePool();
  const store = fakeStore();
  const first = fakeFetch();
  await run({ pool, store, fetch: first });
  // fileUES0000001 sits in two folders: 4 web images in all, 4 copies (UES 2,
  // JSQ 1 new, odd 1). The delete_listing room is never fetched.
  assert.equal(store.stored.length, 4);
  assert.equal(first.calls.filter(c => /alt=media/.test(c.url)).length, 4);
  assert.ok(!first.calls.some(c => c.url.includes('FOLDERdel0000001')));
  assert.equal(pool.listings.get('room-jsq-1').images[1], pool.listings.get('room-ues-1').images[0]);

  const second = fakeFetch();
  await run({ pool, store, fetch: second });
  assert.equal(store.stored.length, 4, 'nothing copied again');
  assert.equal(second.calls.filter(c => /alt=media/.test(c.url)).length, 0);
});

test('keeps at most the first photos of a folder', async () => {
  const many = Array.from({ length: MAX_PHOTOS_PER_ROOM + 5 }, (_, i) => ({
    id: `fileMANY${String(i).padStart(6, '0')}`, name: `${i}.jpg`, mimeType: 'image/jpeg'
  }));
  const pool = fakePool();
  await run({ pool, fetch: fakeFetch({ drive: { ...DRIVE, FOLDERues0000001: many } }) });
  assert.equal(pool.listings.get('room-ues-1').images.length, MAX_PHOTOS_PER_ROOM);
});

test('without a Drive key the sync still runs and says why rooms have no photos', async () => {
  const pool = fakePool();
  const { fetchImpl, calls } = fakeFetch();
  const result = await runRoomSync({
    pool, fetchImpl, storeImage: fakeStore().storeImage, env: { ...ENV, GOOGLE_DRIVE_API_KEY: '' }, now: () => NOW, log: quietLog
  });
  assert.equal(result.ok, true);
  assert.ok(!calls.some(c => c.url.includes('googleapis')));
  assert.ok(result.warnings.includes('GOOGLE_DRIVE_API_KEY is not set: no photos were copied'));
  assert.ok(result.warnings.some(w => w.startsWith('Room 2 in Upper East Side: GOOGLE_DRIVE_API_KEY is not set')));
  assert.equal(pool.listings.get('room-ues-1').hidden_reason, 'no_photos');
});

test('a folder that is not shared is skipped with the reason, and the key never shows', async () => {
  const pool = fakePool();
  const result = await run({ pool, fetch: fakeFetch({ driveStatus: { FOLDERues0000001: 404 } }) });
  assert.equal(result.ok, true);
  const note = result.warnings.find(w => w.startsWith('Room 2 in Upper East Side'));
  assert.match(note, /HTTP 404 \(is the folder shared as "Anyone with the link"\?\)/);
  assert.ok(!JSON.stringify(result).includes(ENV.GOOGLE_DRIVE_API_KEY));
  assert.equal(pool.listings.get('room-ues-1').hidden_reason, 'no_photos');
  assert.equal(pool.listings.get('room-jsq-1').images.length, 2, 'other rooms carry on');
});

test('stops copying at the time budget and finishes on the next run', async () => {
  const pool = fakePool();
  const store = fakeStore();
  let t = NOW;
  // Each clock read moves 15 s on: the 40 s budget runs out part-way.
  const result = await run({ pool, store, now: () => (t += 15000) });
  assert.equal(result.ok, true);
  assert.ok(result.photos.pending > 0);
  const copiedFirst = store.stored.length;
  assert.ok(copiedFirst < 4);

  await run({ pool, store });
  assert.equal(store.stored.length, 4);
  assert.equal(pool.listings.get('room-ues-1').images.length, 2);
});

// --- What the public sees ---

test('the public filter hides placeholders only while a portal room is live', () => {
  const sql = visibility.PUBLIC_LISTING_SQL;
  assert.ok(sql.startsWith("status != 'rented'"));
  assert.match(sql, /COALESCE\(source, ''\) = 'portal' OR NOT EXISTS \(SELECT 1 FROM listings live WHERE live\.source = 'portal' AND live\.status != 'rented' AND live\.hidden_reason IS NULL/);
  assert.match(sql, /hidden_reason IS NULL/);
});

test('Jersey City rooms hide while the market is coming soon, and show when the flag goes', () => {
  const jc = MARKET_PAGES['jersey-city'];
  const listing = { status: 'available', hidden_reason: null, location: 'Jersey City' };
  assert.equal(jc.comingSoon, true);
  assert.equal(visibility.roomHiddenReason(listing), 'coming_soon_market');
  assert.match(visibility.publicListingSql(), /NOT IN \('Jersey City'\)/);

  delete jc.comingSoon; // the one-line change in utils/markets.js
  try {
    assert.equal(visibility.roomHiddenReason(listing), null);
    assert.doesNotMatch(visibility.publicListingSql(), /NOT IN/);
  } finally {
    jc.comingSoon = true;
  }
});

test('hidden reasons for the admin panel', () => {
  assert.equal(visibility.roomHiddenReason({ status: 'rented', location: 'New York' }), 'removed');
  assert.equal(visibility.roomHiddenReason({ status: 'available', hidden_reason: 'no_photos', location: 'New York' }), 'no_photos');
  assert.equal(visibility.roomHiddenReason({ status: 'available', hidden_reason: null, location: 'New York' }), null);
});
