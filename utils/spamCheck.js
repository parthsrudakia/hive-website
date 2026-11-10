// ---------------------------------------------------------------------------
// Content check for public form submissions, run after the bot checks in
// utils/formGuard.js. Those catch scripted posts; this catches spam that gets
// past them, such as a landlord inquiry that is really a casino link.
//
// Only the free-text fields are checked (not email, which always contains a
// domain). A field is flagged when it has:
//
//  1. A web address: http(s)://, www., or a bare domain such as example.com.
//     Email addresses written inside the text are ignored.
//  2. A common spam word, matched as a whole word so ordinary text that
//     happens to contain one (e.g. "Seoul") is not flagged.
//
// Callers keep flagged submissions instead of dropping them, so a false
// positive never loses a real inquiry.
// ---------------------------------------------------------------------------

const TEXT_FIELDS = ['message', 'property_location', 'referral_source', 'full_name', 'subject'];

// Endings that mark a bare domain. Matched in lowercase or all caps only, so a
// missing space after a full stop ("NJ.Top floor") is not read as a domain.
const TLDS = ['com', 'net', 'org', 'io', 'xyz', 'top', 'ru', 'info', 'biz', 'online',
              'site', 'club', 'shop', 'store', 'live', 'icu', 'vip', 'cn', 'cc'];

const URL_RE = /https?:\/\/\S+/i;
const WWW_RE = /(?<![a-z0-9.-])www\.\S+/i;
const DOMAIN_RE = new RegExp(
  `(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]+\\.)+(?:${TLDS.join('|')}|${TLDS.join('|').toUpperCase()})(?![A-Za-z0-9-])`
);
const EMAIL_RE = /[^\s@]+@[^\s@]+/g;

// [word, pattern]: the pattern adds plurals where they make sense. "betting"
// stays as given so "your best bet" is not flagged.
const SPAM_WORDS = [
  ['casino', 'casinos?'],
  ['betting', 'betting'],
  ['crypto', 'crypto(?:currency|currencies)?'],
  ['bitcoin', 'bitcoins?'],
  ['forex', 'forex'],
  ['seo', 'seo'],
  ['backlink', 'backlinks?'],
  ['guest post', 'guest[\\s-]*post(?:s|ing)?'],
  ['viagra', 'viagra'],
  ['porn', 'porn'],
  ['escort', 'escorts?']
].map(([word, pattern]) => ({ word, re: new RegExp(`(?<![a-z])(?:${pattern})(?![a-z])`, 'i') }));

function clip(s) {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function findLink(text) {
  const m = text.match(URL_RE) || text.match(WWW_RE) || text.replace(EMAIL_RE, ' ').match(DOMAIN_RE);
  return m ? m[0] : null;
}

// Returns a short reason (e.g. "web address in message: example.com") for the
// first problem found, or null when the submission looks clean.
function checkSpam(fields) {
  const body = fields || {};
  for (const field of TEXT_FIELDS) {
    const value = body[field];
    if (value == null) continue;
    const text = String(value);

    const link = findLink(text);
    if (link) return `web address in ${field}: ${clip(link)}`;

    const hit = SPAM_WORDS.find(({ re }) => re.test(text));
    if (hit) return `spam word in ${field}: ${hit.word}`;
  }
  return null;
}

module.exports = { checkSpam };
