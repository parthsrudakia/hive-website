// Parses the applicant's social link and only accepts profile URLs on the
// official Instagram or LinkedIn domains. Returns { platform, label, url }
// with a normalized https URL (query strings / tracking params dropped), or
// null when the input isn't an Instagram / LinkedIn profile link.
const RULES = [
  {
    platform: 'instagram',
    label: 'Instagram',
    host: /^(?:[a-z0-9-]+\.)*instagram\.com$/i,
    // /username — Instagram handles: letters, digits, dots, underscores, 1–30 chars.
    path: /^\/([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)\/?$/,
    build: (m) => `https://www.instagram.com/${m[1]}/`
  },
  {
    platform: 'linkedin',
    label: 'LinkedIn',
    host: /^(?:[a-z0-9-]+\.)*linkedin\.com$/i,
    // /in/slug (personal profile) or /pub/... (legacy public profile).
    path: /^\/(in|pub)\/([A-Za-z0-9%_.-]{2,120}(?:\/[A-Za-z0-9%_.-]+)*)\/?$/,
    build: (m) => `https://www.linkedin.com/${m[1]}/${m[2]}/`
  }
];

// Paths on these domains that are not profiles.
const RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'about', 'legal', 'company', 'feed', 'jobs', 'login', 'signup', 'share']);

function parseSocialLink(input) {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password) return null;

  for (const rule of RULES) {
    if (!rule.host.test(url.hostname)) continue;
    const m = url.pathname.match(rule.path);
    if (!m) return null;
    if (RESERVED.has(m[1].toLowerCase())) return null;
    return { platform: rule.platform, label: rule.label, url: rule.build(m) };
  }
  return null;
}

module.exports = { parseSocialLink };
