// Server-to-server calls to the portal's application-invite API. The portal
// owns the invite (room, rent, deposit); the website only checks a token on
// /apply-now and, once the fee is paid, reports the applicant back so the
// portal sends the agreement. The portal's address is in utils/portal.js;
// APPLICATIONS_API_KEY is shared with the portal.

const { portalBaseUrl } = require('./portal');

const INVITE_TIMEOUT_MS = 8000;
const COMPLETE_TIMEOUT_MS = 20000;

// Portal answers that mean the invite can't be used (show the invitation
// message, or stop retrying the agreement).
const INVITE_REJECTIONS = new Set(['not_found', 'expired', 'used', 'cancelled', 'invalid_request']);
const COMPLETE_REJECTIONS = new Set(['invalid_request', 'invalid_dates', 'not_found', 'expired', 'cancelled', 'used']);

function portalConfig(env = process.env) {
  const baseUrl = portalBaseUrl(env);
  const apiKey = String(env.APPLICATIONS_API_KEY || '').trim();
  return { baseUrl, apiKey, enabled: !!(baseUrl && apiKey) };
}

// Invite tokens are opaque; this only keeps junk out of the portal URL.
function cleanToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : '';
}

// Today's date in New York as YYYY-MM-DD.
function todayInNewYork(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Start today or later (New York time), end after start. Returns the error
// message, or null when the dates are fine.
function leaseDatesError(start, end, today = todayInNewYork()) {
  if (!isIsoDate(start) || !isIsoDate(end)) return 'Please enter a valid start date and end date.';
  if (start < today) return 'The start date must be today or later.';
  if (end <= start) return 'The end date must be after the start date.';
  return null;
}

// One JSON request to the portal. Never throws: a missing config, a network
// error or a timeout comes back as { unavailable: true }.
async function callPortal(path, { method = 'GET', body, timeoutMs, fetchImpl, env } = {}) {
  const config = portalConfig(env);
  if (!config.enabled) return { unavailable: true, error: 'Portal is not configured (APPLICATIONS_API_KEY)' };
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const headers = { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await doFetch(config.baseUrl + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { httpStatus: res.status, data: data && typeof data === 'object' ? data : {} };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { unavailable: true, error: timedOut ? 'Portal timed out' : `Portal unreachable: ${err && err.message}` };
  }
}

function normalizeInvite(invite) {
  const rent = Number(invite.monthly_rent);
  return {
    roomLabel: String(invite.room_label || '').trim().slice(0, 100) || 'Your room',
    neighborhood: invite.neighborhood ? String(invite.neighborhood).trim().slice(0, 100) || null : null,
    monthlyRent: Number.isFinite(rent) && rent > 0 ? rent : null,
    expiresAt: invite.expires_at || null
  };
}

// Checks an invite token. status is one of valid, not_found, expired, used,
// cancelled, invalid_request or unavailable (portal down or not configured).
async function fetchInvite(token, opts = {}) {
  const clean = cleanToken(token);
  if (!clean) return { status: 'not_found', invite: null };
  const r = await callPortal(`/api/applications/invites/${encodeURIComponent(clean)}`, {
    timeoutMs: INVITE_TIMEOUT_MS, ...opts
  });
  if (r.unavailable) return { status: 'unavailable', invite: null, error: r.error };
  const status = r.data.status;
  if (r.httpStatus === 200 && status === 'valid' && r.data.invite && typeof r.data.invite === 'object') {
    return { status: 'valid', invite: normalizeInvite(r.data.invite) };
  }
  if ([400, 404, 410].includes(r.httpStatus) && INVITE_REJECTIONS.has(status)) {
    return { status, invite: null };
  }
  return { status: 'unavailable', invite: null, error: `Portal answered ${r.httpStatus}` };
}

// Reports a paid applicant to the portal, which sends the agreement. Only the
// applicant's own details go over; rent, deposit and room come from the
// invite on the portal side. outcome is 'sent', 'retry' (try again later) or
// 'failed' (the portal refused; retrying won't help).
async function completeApplication(payload, opts = {}) {
  const body = {
    token: payload.token,
    full_name: payload.full_name,
    email: payload.email,
    phone: payload.phone,
    start_date: payload.start_date,
    end_date: payload.end_date,
    website_application_id: String(payload.website_application_id)
  };
  const r = await callPortal('/api/applications/complete', {
    method: 'POST', body, timeoutMs: COMPLETE_TIMEOUT_MS, ...opts
  });
  if (r.unavailable) return { outcome: 'retry', status: 'unavailable', error: r.error };

  const d = r.data;
  const status = typeof d.status === 'string' ? d.status : null;
  const portalError = typeof d.error === 'string' ? d.error.slice(0, 300) : null;
  // A repeat answer can carry no id when the portal later removed that
  // agreement as a duplicate; it was still sent.
  if (r.httpStatus === 200 && d.ok && (status === 'sent' || status === 'already_sent')) {
    return {
      outcome: 'sent',
      status,
      agreementRequestId: d.agreement_request_id ? String(d.agreement_request_id) : null,
      emailDiffers: d.email_differs === true
    };
  }
  if ([400, 404, 410].includes(r.httpStatus) && COMPLETE_REJECTIONS.has(status)) {
    return { outcome: 'failed', status, error: portalError };
  }
  return {
    outcome: 'retry',
    status: status || `http_${r.httpStatus}`,
    error: portalError || `Portal answered ${r.httpStatus}`
  };
}

module.exports = {
  portalConfig,
  cleanToken,
  todayInNewYork,
  leaseDatesError,
  fetchInvite,
  completeApplication
};
