const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db/pool');
const { sendMail, parseReplyAddress, NOTIFY_EMAIL } = require('../utils/mailer');
const { verifySvixSignature, stripQuotedReply, htmlToText } = require('../utils/resendWebhook');

// Resend "email.received" webhook: applicant replies to messages the admin
// sent from the Applications tab.
//
// Every admin reply carries Reply-To: app-<id>-<token>@REPLY_DOMAIN. That
// subdomain's MX record points at Resend, which POSTs here for each received
// email. We match the address to an application, fetch the body from the
// Receiving API (the webhook only carries metadata), keep the new text, and
// store it as an unread inbound message so the panel can show a badge. No
// email is sent for matched replies; the admin panel badge is the notification.
//
// If the application was soft-deleted (Delete / Clear All) the reply restores
// it. If it no longer exists at all (purged after a year, or the address is
// wrong) the reply is forwarded to NOTIFY_EMAIL so it is never lost.
//
// IMPORTANT: mounted in server.js BEFORE express.json() — signature
// verification needs the raw, unparsed request body.

const MAX_BODY_CHARS = 10000;

function tokensMatch(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Body isn't in the webhook; pull it from the Receiving API. Returns '' on failure.
async function fetchReceivedText(emailId) {
  try {
    const full = await fetchReceivedEmail(emailId);
    return full.text || htmlToText(full.html);
  } catch (err) {
    console.error(`[resend-webhook] Could not fetch body for ${emailId}:`, err.message);
    return '';
  }
}

function cleanReplyText(raw) {
  let text = stripQuotedReply(raw) || String(raw || '').trim() || '(empty message)';
  if (text.length > MAX_BODY_CHARS) text = text.slice(0, MAX_BODY_CHARS) + '…';
  return text;
}

// A reply we could not attach to an application: hand it to the inbox instead.
async function forwardOrphanReply(data, reason) {
  const text = cleanReplyText(await fetchReceivedText(data.email_id));
  await sendMail({
    to: NOTIFY_EMAIL,
    replyTo: data.from,
    subject: `Fwd: ${data.subject || '(no subject)'} — reply to a deleted application`,
    html: `
      <h2>Applicant reply with no matching application</h2>
      <p style="line-height:1.6;color:#444;">From <strong>${escapeHtml(data.from)}</strong>. ${escapeHtml(reason)}</p>
      <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #d4920b;background:#f8f6f2;white-space:pre-wrap;line-height:1.6;color:#1a1a18;">${escapeHtml(text)}</blockquote>
      <p style="margin-top:20px;color:#888;font-size:12px;">Reply to this email to answer them directly; it will not appear in the admin panel.</p>`
  });
  console.log(`[resend-webhook] Forwarded orphan reply ${data.email_id} from ${data.from} to ${NOTIFY_EMAIL} (${reason})`);
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

    // Webhook redelivery: already stored, skip the API fetch.
    const dup = await pool.query('SELECT 1 FROM application_messages WHERE resend_id = $1', [data.email_id]);
    if (dup.rows.length) return res.json({ received: true, duplicate: true });

    const { rows } = await pool.query(
      'SELECT id, full_name, email, reply_token, deleted_at FROM applications WHERE id = $1',
      [parsed.id]
    );
    const app = rows[0];
    if (!app || !tokensMatch(app.reply_token, parsed.token)) {
      const reason = app
        ? `The address did not match application #${parsed.id}.`
        : `Application #${parsed.id} no longer exists (deleted over a year ago).`;
      await forwardOrphanReply(data, reason);
      return res.json({ received: true, forwarded: true });
    }

    const text = cleanReplyText(await fetchReceivedText(data.email_id));

    // A reply to a hidden (Delete / Clear All) application brings it back.
    if (app.deleted_at) {
      await pool.query('UPDATE applications SET deleted_at = NULL WHERE id = $1', [app.id]);
      console.log(`[resend-webhook] Restored deleted application #${app.id} because the applicant replied`);
    }

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
