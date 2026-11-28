'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  portalConfig,
  cleanToken,
  todayInNewYork,
  leaseDatesError,
  fetchInvite,
  completeApplication
} = require('../utils/portalApplications');

const ENV = { PORTAL_URL: 'https://portal.test/', APPLICATIONS_API_KEY: 'test-key' };
const TOKEN = 'inv_abcdefghijklmnop1234';

// A fetch double that answers with one status + JSON body and records calls.
function portal(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('reads the portal config and trims the trailing slash', () => {
  assert.deepEqual(portalConfig(ENV), { baseUrl: 'https://portal.test', apiKey: 'test-key', enabled: true });
  assert.equal(portalConfig({ PORTAL_URL: 'https://portal.test' }).enabled, false);
  assert.deepEqual(portalConfig({ APPLICATIONS_API_KEY: 'test-key' }), { baseUrl: 'https://portal.hiveny.com', apiKey: 'test-key', enabled: true });
  assert.equal(portalConfig({}).enabled, false);
});

test('only accepts plain token characters', () => {
  assert.equal(cleanToken(` ${TOKEN} `), TOKEN);
  assert.equal(cleanToken('short'), '');
  assert.equal(cleanToken('../../etc/passwd/aaaaaaaa'), '');
  assert.equal(cleanToken(['a', 'b']), '');
  assert.equal(cleanToken(undefined), '');
});

test('today is computed in New York time', () => {
  // 03:00 UTC on Nov 19 is still Nov 18 in New York.
  assert.equal(todayInNewYork(new Date('2026-11-19T03:00:00Z')), '2026-11-18');
  assert.equal(todayInNewYork(new Date('2026-11-19T06:00:00Z')), '2026-11-19');
});

test('lease dates: start today or later, end after start', () => {
  const today = '2026-11-18';
  assert.equal(leaseDatesError('2026-11-18', '2027-01-31', today), null);
  assert.match(leaseDatesError('2026-11-17', '2027-01-31', today), /today or later/);
  assert.match(leaseDatesError('2026-12-01', '2026-12-01', today), /after the start date/);
  assert.match(leaseDatesError('2026-12-01', '2026-11-30', today), /after the start date/);
  assert.match(leaseDatesError('2026-02-30', '2026-12-01', today), /valid start date/);
  assert.match(leaseDatesError('12/01/2026', '2027-01-01', today), /valid start date/);
  assert.match(leaseDatesError('', '', today), /valid start date/);
});

test('a valid invite returns the room, neighborhood and rent with the API key', async () => {
  const p = portal(200, {
    status: 'valid',
    invite: { room_label: 'Room 3', neighborhood: 'JSQ', monthly_rent: 1850, expires_at: '2026-12-02T00:00:00Z' }
  });
  const r = await fetchInvite(TOKEN, { fetchImpl: p.fetchImpl, env: ENV });
  assert.equal(r.status, 'valid');
  assert.deepEqual(r.invite, { roomLabel: 'Room 3', neighborhood: 'JSQ', monthlyRent: 1850, expiresAt: '2026-12-02T00:00:00Z' });
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].url, `https://portal.test/api/applications/invites/${TOKEN}`);
  assert.equal(p.calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(p.calls[0].init.method, 'GET');
});

test('expired, used, cancelled and unknown invites come back as their status', async () => {
  for (const [code, status] of [[410, 'expired'], [410, 'used'], [410, 'cancelled'], [404, 'not_found'], [400, 'invalid_request']]) {
    const p = portal(code, { status });
    const r = await fetchInvite(TOKEN, { fetchImpl: p.fetchImpl, env: ENV });
    assert.equal(r.status, status);
    assert.equal(r.invite, null);
  }
});

test('a portal outage or missing config is "unavailable", not an invalid invite', async () => {
  for (const [code, body] of [[500, {}], [503, { error: 'not configured' }], [401, { error: 'unauthorized' }], [200, { status: 'weird' }]]) {
    const p = portal(code, body);
    assert.equal((await fetchInvite(TOKEN, { fetchImpl: p.fetchImpl, env: ENV })).status, 'unavailable');
  }
  const down = await fetchInvite(TOKEN, { fetchImpl: async () => { throw new TypeError('fetch failed'); }, env: ENV });
  assert.equal(down.status, 'unavailable');
  let called = false;
  const unset = await fetchInvite(TOKEN, { fetchImpl: async () => { called = true; }, env: {} });
  assert.equal(unset.status, 'unavailable');
  assert.equal(called, false);
});

test('a malformed token is rejected without calling the portal', async () => {
  let called = false;
  const r = await fetchInvite('bad token', { fetchImpl: async () => { called = true; }, env: ENV });
  assert.equal(r.status, 'not_found');
  assert.equal(called, false);
});

const APPLICANT = {
  token: TOKEN,
  full_name: 'Dana Smith',
  email: 'dana@example.com',
  phone: '555-123-4567',
  start_date: '2026-12-01',
  end_date: '2027-05-31',
  website_application_id: 41,
  // Anything else on the application must never reach the portal.
  rent: 1,
  security_deposit: 1,
  room_id: 'room-x'
};

test('complete sends only the applicant details', async () => {
  const p = portal(200, { ok: true, status: 'sent', agreement_request_id: 'req-1', email_differs: false });
  const r = await completeApplication(APPLICANT, { fetchImpl: p.fetchImpl, env: ENV });
  assert.deepEqual(r, { outcome: 'sent', status: 'sent', agreementRequestId: 'req-1', emailDiffers: false });
  const { url, init } = p.calls[0];
  assert.equal(url, 'https://portal.test/api/applications/complete');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(init.body), {
    token: TOKEN,
    full_name: 'Dana Smith',
    email: 'dana@example.com',
    phone: '555-123-4567',
    start_date: '2026-12-01',
    end_date: '2027-05-31',
    website_application_id: '41'
  });
});

test('complete: a repeat call counts as sent and carries the email flag', async () => {
  const p = portal(200, { ok: true, status: 'already_sent', agreement_request_id: 'req-1', email_differs: true });
  const r = await completeApplication(APPLICANT, { fetchImpl: p.fetchImpl, env: ENV });
  assert.equal(r.outcome, 'sent');
  assert.equal(r.status, 'already_sent');
  assert.equal(r.emailDiffers, true);
});

test('complete: a repeat answer without an agreement id still counts as sent', async () => {
  const p = portal(200, { ok: true, status: 'already_sent', agreement_request_id: null, email_differs: false });
  const r = await completeApplication(APPLICANT, { fetchImpl: p.fetchImpl, env: ENV });
  assert.deepEqual(r, { outcome: 'sent', status: 'already_sent', agreementRequestId: null, emailDiffers: false });
});

test('complete: portal refusals are final', async () => {
  for (const [code, status] of [[400, 'invalid_dates'], [400, 'invalid_request'], [404, 'not_found'], [410, 'expired'], [410, 'cancelled'], [410, 'used']]) {
    const p = portal(code, { ok: false, status, error: 'nope' });
    const r = await completeApplication(APPLICANT, { fetchImpl: p.fetchImpl, env: ENV });
    assert.equal(r.outcome, 'failed', status);
    assert.equal(r.status, status);
  }
});

test('complete: busy, send failures, auth and outages are retried', async () => {
  for (const [code, body] of [[409, { status: 'in_progress' }], [502, { ok: false, status: 'send_failed', error: 'mail down' }], [500, {}], [503, {}], [401, {}]]) {
    const p = portal(code, body);
    const r = await completeApplication(APPLICANT, { fetchImpl: p.fetchImpl, env: ENV });
    assert.equal(r.outcome, 'retry', String(code));
  }
  const timeout = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  const r = await completeApplication(APPLICANT, { fetchImpl: timeout, env: ENV });
  assert.deepEqual(r, { outcome: 'retry', status: 'unavailable', error: 'Portal timed out' });
  assert.equal((await completeApplication(APPLICANT, { env: {} })).outcome, 'retry');
});
