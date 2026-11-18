'use strict';

// Admin Paid Applications: the room and agreement columns.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');

const VIEW = path.join(__dirname, '..', 'views', 'admin', 'paid-applications.ejs');

function application(overrides) {
  return {
    full_name: 'Dana Smith',
    email: 'dana@example.com',
    phone: '555-123-4567',
    answers: {},
    amount_cents: 2000,
    paid_at: new Date('2026-11-18T15:00:00Z'),
    opened_at: new Date('2026-11-18T16:00:00Z'),
    identity_status: 'not_started',
    invite_token: 'inv_abcdefghijklmnop1234',
    invite_room_label: 'Room 3',
    invite_neighborhood: 'JSQ',
    invite_rent: '1850.00',
    lease_start: new Date(2026, 11, 1),
    lease_end: new Date(2027, 4, 31),
    agreement_status: null,
    agreement_attempts: 0,
    ...overrides
  };
}

test('shows the room, dates and each agreement state', async () => {
  const html = await ejs.renderFile(VIEW, {
    adminName: 'Admin',
    applications: [
      application({ id: 1, agreement_status: 'sent', agreement_sent_at: new Date('2026-11-18T15:01:00Z'), agreement_email_differs: true, email: 'other@example.com' }),
      application({ id: 2, agreement_status: 'failed', agreement_attempts: 1, agreement_error: 'Invite expired: send the agreement from the portal by hand.' }),
      application({ id: 3, agreement_status: 'pending', agreement_attempts: 2, agreement_error: 'Portal timed out' }),
      application({ id: 4, agreement_status: 'sending' }),
      application({ id: 5, invite_token: null, invite_room_label: null, invite_neighborhood: null, invite_rent: null, lease_start: null, lease_end: null })
    ]
  });
  assert.match(html, /<th>Room<\/th>\s*<th>Agreement<\/th>/);
  assert.match(html, /Room 3/);
  assert.match(html, /JSQ · \$1,850\/mo/);
  assert.match(html, /12\/01\/26 to 05\/31\/27/);
  assert.match(html, /<span class="pill">Sent<\/span>/);
  assert.match(html, /Email differs from invite/);
  assert.match(html, /not other@example\.com/);
  assert.match(html, /<span class="pill pill-failed">Failed<\/span>/);
  assert.match(html, /Invite expired: send the agreement from the portal by hand\./);
  assert.match(html, /2 attempts/);
  assert.match(html, /Portal timed out/);
  assert.match(html, /Sending/);
  assert.match(html, /No invite/);
  // Retry only for failed and pending rows.
  const retries = html.match(/action="\/admin\/paid-applications\/(\d+)\/retry-agreement"/g) || [];
  assert.deepEqual(retries.map(r => r.match(/\d+/)[0]), ['2', '3']);
  assert.equal((html.match(/Email differs from invite/g) || []).length, 1);
});
