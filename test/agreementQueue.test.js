'use strict';

// The agreement step after payment (utils/tenantApplication.js), run against
// an in-memory stand-in for tenant_applications and a fake portal.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PORTAL_URL = 'https://portal.test';
process.env.APPLICATIONS_API_KEY = 'test-key';

// --- In-memory tenant_applications ---------------------------------------
let rows = [];
const STALE_MS = 5 * 60 * 1000;
const claimable = (r) => r.payment_status === 'paid' &&
  (r.agreement_status === 'pending' ||
   (r.agreement_status === 'sending' && Date.now() - r.agreement_claimed_at > STALE_MS));

const fakePool = {
  async query(sql, params = []) {
    if (/SET payment_status = 'paid'/.test(sql)) {
      const r = rows.find(x => x.stripe_session_id === params[1] && x.payment_status !== 'paid');
      if (!r) return { rows: [] };
      r.payment_status = 'paid';
      r.paid_at = new Date();
      if (r.invite_token) r.agreement_status = 'pending';
      return { rows: [{ id: r.id, full_name: r.full_name, email: r.email, phone: r.phone, answers: {}, identity_status: 'not_started' }] };
    }
    if (/^\s*SELECT id FROM tenant_applications/.test(sql)) {
      const [onlyId, preferSession, limit] = params;
      const found = rows
        .filter(r => claimable(r) && (onlyId == null || r.id === onlyId))
        .sort((a, b) => (b.stripe_session_id === preferSession) - (a.stripe_session_id === preferSession) || a.id - b.id)
        .slice(0, limit)
        .map(r => ({ id: r.id }));
      return { rows: found };
    }
    if (/SET agreement_status = 'sending'/.test(sql)) {
      const r = rows.find(x => x.id === params[0]);
      if (!r || !claimable(r)) return { rows: [] };
      r.agreement_status = 'sending';
      r.agreement_claimed_at = Date.now();
      return { rows: [{ id: r.id, full_name: r.full_name, email: r.email, phone: r.phone, invite_token: r.invite_token, lease_start: r.lease_start, lease_end: r.lease_end }] };
    }
    if (/SET agreement_status = 'sent'/.test(sql)) {
      const r = rows.find(x => x.id === params[0]);
      Object.assign(r, {
        agreement_status: 'sent', agreement_request_id: params[1], agreement_email_differs: params[2],
        agreement_sent_at: r.agreement_sent_at || new Date(), agreement_error: null,
        agreement_attempts: r.agreement_attempts + 1, agreement_claimed_at: null
      });
      return { rows: [] };
    }
    if (/SET agreement_status = \$2, agreement_error = \$3/.test(sql)) {
      const r = rows.find(x => x.id === params[0]);
      Object.assign(r, {
        agreement_status: params[1], agreement_error: params[2],
        agreement_attempts: r.agreement_attempts + 1, agreement_claimed_at: null
      });
      return { rows: [] };
    }
    throw new Error('unexpected query: ' + sql.slice(0, 80));
  }
};

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}
stub('../db/pool', fakePool);
const sentMail = [];
stub('../utils/mailer', {
  sendMail: async (m) => { sentMail.push(m); },
  confirmationHtml: () => '<p></p>',
  NOTIFY_EMAIL: 'team@example.com'
});
stub('../utils/storage', { signedPrivateUrl: async () => null });

const { finalizePaidApplication, processPendingAgreements, sendAgreementsAfterPayment } = require('../utils/tenantApplication');

// --- Fake portal ---------------------------------------------------------
let portalCalls = [];
let portalReply = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://portal.test/')) throw new Error('unexpected network call: ' + url);
  const body = JSON.parse(init.body);
  portalCalls.push({ url, headers: init.headers, body });
  const reply = await portalReply(body);
  if (reply.throws) throw new TypeError('fetch failed');
  return { status: reply.status, json: async () => reply.body };
};
const sentReply = (extra = {}) => () => ({ status: 200, body: { ok: true, status: 'sent', agreement_request_id: 'req-9', email_differs: false, ...extra } });

function application(overrides = {}) {
  return {
    id: 41,
    full_name: 'Dana Smith',
    email: 'dana@example.com',
    phone: '555-123-4567',
    payment_status: 'paid',
    stripe_session_id: 'cs_41',
    invite_token: 'inv_abcdefghijklmnop1234',
    lease_start: '2026-12-01',
    lease_end: '2027-05-31',
    agreement_status: 'pending',
    agreement_attempts: 0,
    agreement_claimed_at: null,
    agreement_error: null,
    agreement_request_id: null,
    agreement_sent_at: null,
    agreement_email_differs: null,
    ...overrides
  };
}

test.beforeEach(() => {
  rows = [];
  portalCalls = [];
  sentMail.length = 0;
  portalReply = sentReply();
});

test('payment queues the agreement only for invite applications', async () => {
  rows = [
    application({ id: 1, stripe_session_id: 'cs_1', payment_status: 'pending', agreement_status: null }),
    application({ id: 2, stripe_session_id: 'cs_2', payment_status: 'pending', agreement_status: null, invite_token: null })
  ];
  await finalizePaidApplication({ id: 'cs_1', payment_status: 'paid', currency: 'usd', amount_total: 2000 });
  await finalizePaidApplication({ id: 'cs_2', payment_status: 'paid', currency: 'usd', amount_total: 2000 });
  assert.equal(rows[0].agreement_status, 'pending');
  assert.equal(rows[1].agreement_status, null);
});

test('after payment the agreement is sent once, with only the applicant details', async () => {
  rows = [application({ payment_status: 'pending', agreement_status: null })];
  const session = { id: 'cs_41', payment_status: 'paid', currency: 'usd', amount_total: 2000 };
  await finalizePaidApplication(session);
  await sendAgreementsAfterPayment(session);
  // The webhook landing second (or a refresh) finalizes nothing and sends nothing.
  assert.equal(await finalizePaidApplication(session), null);
  await sendAgreementsAfterPayment(session);

  assert.equal(portalCalls.length, 1);
  assert.equal(portalCalls[0].url, 'https://portal.test/api/applications/complete');
  assert.equal(portalCalls[0].headers.Authorization, 'Bearer test-key');
  assert.deepEqual(portalCalls[0].body, {
    token: 'inv_abcdefghijklmnop1234',
    full_name: 'Dana Smith',
    email: 'dana@example.com',
    phone: '555-123-4567',
    start_date: '2026-12-01',
    end_date: '2027-05-31',
    website_application_id: '41'
  });
  assert.equal(rows[0].agreement_status, 'sent');
  assert.equal(rows[0].agreement_request_id, 'req-9');
  assert.ok(rows[0].agreement_sent_at);
  assert.equal(rows[0].agreement_attempts, 1);
});

test('a portal failure keeps the application pending, and a retry sends it once', async () => {
  rows = [application()];
  portalReply = () => ({ throws: true });
  let summary = await processPendingAgreements();
  assert.deepEqual(summary, { processed: 1, sent: 0, retry: 1, failed: 0 });
  assert.equal(rows[0].agreement_status, 'pending');
  assert.equal(rows[0].agreement_attempts, 1);
  assert.match(rows[0].agreement_error, /Portal unreachable/);

  portalReply = () => ({ status: 502, body: { ok: false, status: 'send_failed', error: 'Outlook said no' } });
  await processPendingAgreements();
  assert.equal(rows[0].agreement_status, 'pending');
  assert.equal(rows[0].agreement_error, 'Outlook said no');

  // The next run (cron, next finalize or admin Retry) goes through.
  portalReply = sentReply();
  summary = await processPendingAgreements({ limit: 20, budgetMs: 40000 });
  assert.equal(summary.sent, 1);
  assert.equal(rows[0].agreement_status, 'sent');
  assert.equal(rows[0].agreement_error, null);
  assert.equal(rows[0].agreement_attempts, 3);

  // Nothing left to do afterwards.
  summary = await processPendingAgreements({ limit: 20 });
  assert.equal(summary.processed, 0);
  assert.equal(portalCalls.length, 3);
});

test('portal refusals mark the application failed with a reason', async () => {
  const cases = [
    [410, 'expired', /^Invite expired: send the agreement from the portal by hand\.$/],
    [410, 'used', /already used by another application/],
    [410, 'cancelled', /cancelled/],
    [400, 'invalid_dates', /^Portal rejected the lease dates: start date is in the past$/]
  ];
  for (const [code, status, reason] of cases) {
    rows = [application()];
    portalReply = () => ({ status: code, body: { ok: false, status, error: 'start date is in the past' } });
    const summary = await processPendingAgreements();
    assert.equal(summary.failed, 1, status);
    assert.equal(rows[0].agreement_status, 'failed');
    assert.match(rows[0].agreement_error, reason);
  }
  // Failed rows are not retried on their own.
  portalCalls = [];
  assert.equal((await processPendingAgreements({ limit: 20 })).processed, 0);
  assert.equal(portalCalls.length, 0);
});

test('a busy invite (409) stays pending', async () => {
  rows = [application()];
  portalReply = () => ({ status: 409, body: { ok: false, status: 'in_progress' } });
  await processPendingAgreements();
  assert.equal(rows[0].agreement_status, 'pending');
});

test('two runs at once call the portal only once', async () => {
  rows = [application()];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  portalReply = async () => { await gate; return sentReply()(); };
  const first = processPendingAgreements();
  const second = processPendingAgreements();
  await new Promise(resolve => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.processed + b.processed, 1);
  assert.equal(portalCalls.length, 1);
  assert.equal(rows[0].agreement_status, 'sent');
});

test('a claim left by a crashed run is taken over after 5 minutes', async () => {
  rows = [application({ agreement_status: 'sending', agreement_claimed_at: Date.now() - 60 * 1000 })];
  assert.equal((await processPendingAgreements()).processed, 0);
  rows[0].agreement_claimed_at = Date.now() - 6 * 60 * 1000;
  assert.equal((await processPendingAgreements()).sent, 1);
});

test('the email-differs flag from the portal is stored', async () => {
  rows = [application()];
  portalReply = sentReply({ status: 'already_sent', email_differs: true });
  await processPendingAgreements();
  assert.equal(rows[0].agreement_status, 'sent');
  assert.equal(rows[0].agreement_email_differs, true);
});

test('the application just paid goes first, and onlyId limits the run', async () => {
  rows = [application({ id: 1, stripe_session_id: 'cs_1' }), application({ id: 2, stripe_session_id: 'cs_2' })];
  await processPendingAgreements({ preferSessionId: 'cs_2', limit: 1 });
  assert.deepEqual(portalCalls.map(c => c.body.website_application_id), ['2']);
  await processPendingAgreements({ onlyId: 2, limit: 5 });
  assert.equal(portalCalls.length, 1);
  assert.equal(rows[0].agreement_status, 'pending');
});

test('an application missing its invite or dates fails without calling the portal', async () => {
  rows = [application({ lease_end: null })];
  await processPendingAgreements();
  assert.equal(rows[0].agreement_status, 'failed');
  assert.equal(rows[0].agreement_error, 'Application has no invite or lease dates.');
  assert.equal(portalCalls.length, 0);
});
