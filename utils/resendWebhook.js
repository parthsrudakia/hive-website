const crypto = require('crypto');

// Helpers for the Resend "email.received" webhook (routes/resendWebhook.js).

// Resend signs webhooks with the Svix scheme:
//   signed = `${svix-id}.${svix-timestamp}.${rawBody}`
//   sig    = base64(HMAC-SHA256(base64decode(secret without "whsec_"), signed))
// The svix-signature header may carry several space-separated "v1,<sig>"
// entries (key rotation); any one matching is enough. Implemented here so no
// extra dependency is needed.
const TOLERANCE_SEC = 5 * 60;

function verifySvixSignature(rawBody, headers, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !rawBody) return false;
  const get = k => headers[k] || headers[k.toLowerCase()] || '';
  const id = String(get('svix-id') || '');
  const ts = String(get('svix-timestamp') || '');
  const sigHeader = String(get('svix-signature') || '');
  if (!id || !ts || !sigHeader) return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowSec - parseInt(ts, 10)) > TOLERANCE_SEC) return false;

  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = crypto.createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${ts}.`), body]))
    .digest();

  return sigHeader.split(/\s+/).some(part => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    let given;
    try { given = Buffer.from(sig, 'base64'); } catch (_) { return false; }
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

// Signs a payload the way Resend/Svix would. Used by tests and local tooling.
function signSvix(rawBody, secret, { id = 'msg_test', ts = Math.floor(Date.now() / 1000) } = {}) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}

// Mail clients append the quoted original below a reply. Keep only the new
// text: cut at the first quote marker the common clients emit.
const CUT_PATTERNS = [
  /^On .{0,200}wrote:\s*$/,                 // Gmail / Apple Mail / Outlook (may wrap onto two lines)
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i, // Outlook
  /^_{5,}\s*$/,                             // Outlook divider before "From:"
  /^From:\s.*$/,                            // Outlook / Hotmail forwarded header block
  /^Sent from my (iPhone|iPad|Android|Galaxy).*$/i,
  /^>/                                      // Classic quoted lines
];

function stripQuotedReply(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (CUT_PATTERNS.some(re => re.test(line))) { cut = i; break; }
    // Gmail sometimes wraps "On <date>, <name>" and "<email> wrote:" onto two lines.
    if (/^On .{0,200}$/.test(line) && i + 1 < lines.length && /wrote:\s*$/.test(lines[i + 1].trim())) { cut = i; break; }
  }
  return lines.slice(0, cut).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Rough plain-text fallback when a received email has no text part.
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

module.exports = { verifySvixSignature, signSvix, stripQuotedReply, htmlToText };
