'use strict';

// Invite-only /apply-now, the session POST and the agreement cron, through
// the real app with a fake database, Stripe, storage and portal.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'apply-test-secret';
process.env.PORTAL_URL = 'https://portal.test';
process.env.APPLICATIONS_API_KEY = 'test-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake';
process.env.STRIPE_APPLICATION_FEE_PRICE_ID = '';
process.env.CRON_SECRET = 'cron-test-secret';

const VALID = 'inv_valid_abcdefghijklmnop';
const EXPIRED = 'inv_expired_abcdefghijklm';
const USED = 'inv_used_abcdefghijklmnopq';
const DOWN = 'inv_down_abcdefghijklmnopq';

// --- Fakes ---------------------------------------------------------------
const queries = [];
const fakePool = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/rate_limits/.test(sql)) return { rows: [{ hits: 1, expires_at: new Date(Date.now() + 60000) }] };
    if (/SELECT DISTINCT COALESCE/.test(sql)) return { rows: [{ city: 'New York' }] };
    if (/INSERT INTO tenant_applications/.test(sql)) return { rows: [{ id: 41 }] };
    return { rows: [] };
  }
};
const stripeCalls = [];
const fakeStripe = () => ({
  checkout: {
    sessions: {
      create: async (opts) => { stripeCalls.push(opts); return { id: 'cs_test_41', client_secret: 'cs_secret_41' }; },
      retrieve: async () => ({ id: 'cs_test_41', payment_status: 'unpaid' })
    }
  },
  webhooks: { constructEvent: () => { throw new Error('not used'); } },
  identity: { verificationSessions: {} }
});

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}
stub('../db/pool', fakePool);
stub('stripe', fakeStripe);
stub('../utils/storage', {
  storeImage: async () => '/images/x.jpg',
  storePrivateFile: async () => 'pending/id.jpg',
  signedPrivateUrl: async () => null,
  storageEnabled: false,
  PRIVATE_BUCKET: 'private'
});
stub('../utils/mailer', {
  sendMail: async () => { throw new Error('no mail in tests'); },
  confirmationHtml: () => '',
  replyAddress: () => 'reply@example.com',
  parseReplyAddress: () => null,
  MAIL_FROM: 'test@example.com',
  NOTIFY_EMAIL: 'team@example.com',
  REPLY_DOMAIN: 'example.com'
});
stub('../utils/googleReviews', { getGoogleReviews: async () => ({ reviews: [], rating: 0, totalReviews: 0 }) });

// The portal: only https://portal.test is answered; the test's own requests
// to the local server go through the real fetch; anything else fails.
const realFetch = globalThis.fetch;
const portalCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1:')) return realFetch(url, init);
  if (!u.startsWith('https://portal.test/')) throw new Error('unexpected network call: ' + u);
  portalCalls.push({ url: u, headers: init.headers });
  const json = (status, body) => ({ status, json: async () => body });
  if (u.endsWith('/' + VALID)) {
    return json(200, { status: 'valid', invite: { room_label: 'Room 3', neighborhood: 'JSQ', monthly_rent: 1850, expires_at: '2026-12-02T00:00:00Z' } });
  }
  if (u.endsWith('/' + EXPIRED)) return json(410, { status: 'expired' });
  if (u.endsWith('/' + USED)) return json(410, { status: 'used' });
  if (u.endsWith('/' + DOWN)) throw new TypeError('fetch failed');
  return json(404, { status: 'not_found' });
};

const { todayInNewYork } = require('../utils/portalApplications');
const app = require('../server');

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
test.beforeEach(() => {
  queries.length = 0;
  portalCalls.length = 0;
  stripeCalls.length = 0;
});

function dayFromToday(days) {
  const d = new Date(`${todayInNewYork()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function applicationForm(overrides = {}) {
  const fields = {
    invite: VALID,
    first_name: 'Dana',
    last_name: 'Smith',
    email: 'dana@example.com',
    phone: '555-123-4567',
    birthdate: '1995-04-02',
    ssn_last4: '1234',
    social_profile: 'https://linkedin.com/in/dana',
    emergency_contact_name: 'Pat Smith',
    emergency_contact_phone: '555-765-4321',
    emergency_contact_email: 'pat@example.com',
    emergency_contact_relationship: 'Parent',
    start_date: dayFromToday(10),
    end_date: dayFromToday(190),
    ...overrides
  };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) form.append(k, v);
  form.append('id_front', new Blob([Buffer.from('front')], { type: 'image/jpeg' }), 'front.jpg');
  form.append('id_back', new Blob([Buffer.from('back')], { type: 'image/jpeg' }), 'back.jpg');
  return form;
}

const postSession = (form) => fetch(`${baseUrl}/apply-now/session`, { method: 'POST', body: form });
const inserts = () => queries.filter(q => /INSERT INTO tenant_applications/.test(q.sql));

test('without an invite the form is not shown', async () => {
  const res = await fetch(`${baseUrl}/apply-now`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.match(html, /Applications are by invitation\. <a href="\/contact">Contact us<\/a> to view a room\./);
  assert.doesNotMatch(html, /id="apply-form"/);
  assert.doesNotMatch(html, /js\.stripe\.com/);
  assert.equal(portalCalls.length, 0);
});

test('expired, used and unknown invites show the invitation message', async () => {
  for (const token of [EXPIRED, USED, 'inv_unknown_abcdefghijklm', 'bad']) {
    const res = await fetch(`${baseUrl}/apply-now?invite=${token}`);
    const html = await res.text();
    assert.equal(res.status, 200, token);
    assert.match(html, /Applications are by invitation\./, token);
    assert.doesNotMatch(html, /id="apply-form"/, token);
  }
});

test('a portal outage asks the applicant to try again later', async () => {
  const res = await fetch(`${baseUrl}/apply-now?invite=${DOWN}`);
  const html = await res.text();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.match(html, /couldn&#39;t check your invite right now|couldn't check your invite right now/);
  assert.doesNotMatch(html, /Applications are by invitation/);
  assert.doesNotMatch(html, /id="apply-form"/);
});

test('a valid invite shows the room, neighborhood, rent, dates and the email note', async () => {
  const res = await fetch(`${baseUrl}/apply-now?invite=${VALID}`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.match(html, /<div class="invite-name">Room 3<\/div>/);
  assert.match(html, /JSQ · \$1,850\/month/);
  assert.match(html, /Your agreement will be sent to the email this invite was sent to\./);
  assert.match(html, new RegExp(`<input type="hidden" name="invite" value="${VALID}">`));
  assert.match(html, new RegExp(`name="start_date" id="start_date" required min="${todayInNewYork()}"`));
  assert.match(html, /name="end_date"/);
  assert.match(html, /id="apply-form"/);
  assert.equal(portalCalls.length, 1);
  assert.equal(portalCalls[0].headers.Authorization, 'Bearer test-key');
});

test('the session POST needs an invite', async () => {
  const res = await postSession(applicationForm({ invite: null }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Applications are by invitation/);
  assert.equal(inserts().length, 0);
  assert.equal(stripeCalls.length, 0);
});

test('the session POST checks the invite again on the server', async () => {
  for (const token of [EXPIRED, USED, 'inv_unknown_abcdefghijklm']) {
    const res = await postSession(applicationForm({ invite: token }));
    assert.equal(res.status, 400, token);
    assert.match((await res.json()).error, /no longer valid/);
  }
  const down = await postSession(applicationForm({ invite: DOWN }));
  assert.equal(down.status, 503);
  assert.equal(inserts().length, 0);
  assert.equal(stripeCalls.length, 0);
});

test('the session POST rejects bad lease dates', async () => {
  const cases = [
    [{ start_date: dayFromToday(-1) }, /today or later/],
    [{ end_date: dayFromToday(10) }, /after the start date/],
    [{ end_date: dayFromToday(5) }, /after the start date/],
    [{ start_date: '2026-02-30' }, /valid start date/],
    [{ end_date: '' }, /fill in all required fields/]
  ];
  for (const [overrides, message] of cases) {
    const res = await postSession(applicationForm(overrides));
    assert.equal(res.status, 400, JSON.stringify(overrides));
    assert.match((await res.json()).error, message);
  }
  assert.equal(inserts().length, 0);
  assert.equal(portalCalls.length, 0);
});

test('a valid application stores the invite, dates and room, then opens Checkout', async () => {
  const start = dayFromToday(0);
  const end = dayFromToday(180);
  const res = await postSession(applicationForm({ start_date: start, end_date: end }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { clientSecret: 'cs_secret_41' });
  const [insert] = inserts();
  assert.ok(insert, 'row inserted');
  assert.match(insert.sql, /invite_token, lease_start, lease_end/);
  assert.deepEqual(insert.params.slice(5), [VALID, start, end, 'Room 3', 'JSQ', 1850]);
  assert.equal(stripeCalls.length, 1);
  assert.equal(stripeCalls[0].customer_email, 'dana@example.com');
});

test('the agreement cron needs CRON_SECRET', async () => {
  const none = await fetch(`${baseUrl}/api/cron/application-agreements`);
  assert.equal(none.status, 401);
  const wrong = await fetch(`${baseUrl}/api/cron/application-agreements`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
  const ok = await fetch(`${baseUrl}/api/cron/application-agreements`, { headers: { Authorization: 'Bearer cron-test-secret' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, processed: 0, sent: 0, retry: 0, failed: 0 });
  assert.ok(queries.some(q => /SELECT id FROM tenant_applications/.test(q.sql)));
});
