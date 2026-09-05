const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db/pool');
const { parseReplyAddress } = require('../utils/mailer');
const { verifySvixSignature, stripQuotedReply, htmlToText } = require('../utils/resendWebhook');

// Resend "email.received" webhook: applicant replies to messages the admin
// sent from the Applications tab.
//
// Every admin reply carries Reply-To: app-<id>-<token>@REPLY_DOMAIN. That
// subdomain's MX record points at Resend, which POSTs here for each received
// email. We match the address to an application, fetch the body from the
// Receiving API (the webhook only carries metadata), keep the new text, and
// store it as an unread inbound message so the panel can show a badge. No
// email is sent for replies; the admin panel badge is the notification.
//
// IMPORTANT: mounted in server.js BEFORE express.json() — signature
// verification needs the raw, unparsed request body.

const MAX_BODY_CHARS = 10000;

function tokensMatch(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

async function fetchReceivedEmail(emailId) {
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }
  });
  if (!res.ok) throw new Error(`Resend receiving ${res.status}: ${await res.text()}`);
  return res.json();
}

router.post('/resend', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!process.env.RESEND_WEBHOOK_SECRET || !process.env.RESEND_API_KEY) {
    console.warn('[resend-webhook] Received event but RESEND_WEBHOOK_SECRET / RESEND_API_KEY is not configured.');
    return res.status(503).send('Webhook not configured');
  }
  if (!verifySvixSignature(req.body, req.headers, process.env.RESEND_WEBHOOK_SECRET)) {
    console.error('[resend-webhook] Signature verification failed');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (_) {
    return res.status(400).send('Invalid JSON');
  }
  if (!event || event.type !== 'email.received' || !event.data) {
    return res.json({ received: true, ignored: true });
  }

  const data = event.data;
  try {
    // Find our per-application address among the recipients.
    const candidates = [].concat(data.to || [], data.cc || [], data.received_for || []);
    let parsed = null;
    for (const addr of candidates) {
      parsed = parseReplyAddress(addr);
      if (parsed) break;
    }
    if (!parsed) {
      console.log(`[resend-webhook] Ignoring email ${data.email_id}: no application reply address in`, candidates);
      return res.json({ received: true, ignored: true });
    }

    const { rows } = await pool.query(
      'SELECT id, full_name, email, reply_token FROM applications WHERE id = $1',
      [parsed.id]
    );
    const app = rows[0];
    if (!app || !tokensMatch(app.reply_token, parsed.token)) {
      console.warn(`[resend-webhook] Ignoring email ${data.email_id}: application #${parsed.id} not found or token mismatch`);
      return res.json({ received: true, ignored: true });
    }

    // Webhook redelivery: already stored, skip the API fetch and the notification.
    const dup = await pool.query('SELECT 1 FROM application_messages WHERE resend_id = $1', [data.email_id]);
    if (dup.rows.length) return res.json({ received: true, duplicate: true });

    // Body isn't in the webhook; pull it from the Receiving API.
    let text = '';
    try {
      const full = await fetchReceivedEmail(data.email_id);
      text = full.text || htmlToText(full.html);
    } catch (err) {
      console.error(`[resend-webhook] Could not fetch body for ${data.email_id}:`, err.message);
      text = '';
    }
    text = stripQuotedReply(text) || text.trim() || '(empty message)';
    if (text.length > MAX_BODY_CHARS) text = text.slice(0, MAX_BODY_CHARS) + '…';

    const insert = await pool.query(
      `INSERT INTO application_messages (application_id, direction, subject, body_text, from_email, message_id, resend_id)
       VALUES ($1, 'in', $2, $3, $4, $5, $6)
       ON CONFLICT (resend_id) DO NOTHING
       RETURNING id`,
      [app.id, String(data.subject || '').slice(0, 300), text, String(data.from || '').slice(0, 200),
       String(data.message_id || '').slice(0, 300) || null, data.email_id]
    );
    if (insert.rows.length === 0) {
      return res.json({ received: true, duplicate: true }); // webhook redelivery
    }
    console.log(`[resend-webhook] Stored reply from ${data.from} on application #${app.id}`);

    res.json({ received: true });
  } catch (err) {
    console.error('[resend-webhook] Handler error:', err);
    res.status(500).send('Webhook handler failed');
  }
});

module.exports = router;
