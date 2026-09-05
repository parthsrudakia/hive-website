// Shared outbound-mail helpers (Resend HTTP API). Used by the public form
// routes, the admin reply flow, and the Stripe webhook handler, so everything
// sends from one place.

// All outbound mail is sent from the Hive domain (verified in Resend).
const MAIL_FROM = process.env.MAIL_FROM || 'Hive <parth.rudakia@hiveny.com>';
// Master recipient for submitted inquiry/application details.
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'parth.rudakia@hiveny.com';
// Subdomain whose MX record points at Resend Receiving. Admin replies set
// Reply-To to an address here, so applicant replies flow back into the panel.
const REPLY_DOMAIN = process.env.REPLY_DOMAIN || 'reply.hiveny.com';

// Low-level mail send via the Resend HTTP API. Throws on failure so callers can
// log it; callers wrap this so a failed send never blocks saving the inquiry.
// Resolves to the Resend email id (or null when mail is disabled).
async function sendMail({ to, subject, html, text, replyTo, headers }) {
  if (!to) return null;
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[mail] RESEND_API_KEY missing — "${subject}" to ${to} not sent.`);
    return null;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject,
      html,
      text: text || undefined,
      reply_to: replyTo || undefined,
      headers: headers && Object.keys(headers).length ? headers : undefined
    })
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
  console.log(`[mail] Sent "${subject}" to ${to}`);
  try {
    const data = await res.json();
    return (data && data.id) || null;
  } catch (_) {
    return null;
  }
}

// Branded wrapper for confirmation emails sent to the person who submitted a form.
function confirmationHtml(heading, bodyLines) {
  return `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a18;">
      <h2 style="color: #1a1a18;">${heading}</h2>
      ${bodyLines.map(l => `<p style="line-height: 1.6; color: #444;">${l}</p>`).join('')}
      <p style="line-height: 1.6; color: #444;">Warm regards,<br>Parth Rudakia<br>Hive · <a href="https://hiveny.com" style="color: #d4920b;">hiveny.com</a></p>
      <p style="margin-top: 20px; color: #888; font-size: 12px;">This is an automated confirmation from Hive. You can reply directly to this email to reach us.</p>
    </div>`;
}

// Per-application inbound address: app-<id>-<token>@REPLY_DOMAIN. The token
// keeps strangers from injecting "replies" into an application by guessing ids.
function replyAddress(app) {
  return `app-${app.id}-${app.reply_token}@${REPLY_DOMAIN}`;
}

// Inverse of replyAddress(). Accepts a bare address or "Name <addr>" form and
// ignores case/domain (Resend lowercases and may report the address under a
// forwarding alias). Returns { id, token } or null.
function parseReplyAddress(addr) {
  if (!addr) return null;
  const m = String(addr).match(/app-(\d+)-([0-9a-f]{8,32})@/i);
  if (!m) return null;
  return { id: parseInt(m[1], 10), token: m[2].toLowerCase() };
}

module.exports = { sendMail, confirmationHtml, replyAddress, parseReplyAddress, MAIL_FROM, NOTIFY_EMAIL, REPLY_DOMAIN };
