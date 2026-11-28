'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// The cron route only: no database or network is reached in these cases.
const app = express();
app.use('/api', require('../routes/api'));

// Cleared after the routes load, because loading them reads .env.local.
for (const key of ['CRON_SECRET', 'PORTAL_URL', 'INVENTORY_API_KEY', 'GOOGLE_DRIVE_API_KEY']) delete process.env[key];

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('the room sync cron refuses to run without CRON_SECRET', async () => {
  const res = await fetch(`${baseUrl}/api/cron/room-sync`);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { error: 'CRON_SECRET is not configured' });
});

test('the room sync cron needs the right bearer token', async () => {
  process.env.CRON_SECRET = 'cron-test-secret';
  try {
    for (const auth of [undefined, 'Bearer wrong', 'cron-test-secret', 'Bearer cron-test-secretX']) {
      const res = await fetch(`${baseUrl}/api/cron/room-sync`, { headers: auth ? { Authorization: auth } : {} });
      assert.equal(res.status, 401, String(auth));
    }
  } finally {
    delete process.env.CRON_SECRET;
  }
});

test('the room sync cron says what is missing when the sync is not configured', async () => {
  process.env.CRON_SECRET = 'cron-test-secret';
  try {
    const res = await fetch(`${baseUrl}/api/cron/room-sync`, { headers: { Authorization: 'Bearer cron-test-secret' } });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'room sync is not configured (missing PORTAL_URL, INVENTORY_API_KEY)' });
  } finally {
    delete process.env.CRON_SECRET;
  }
});
