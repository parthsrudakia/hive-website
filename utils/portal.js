// The Hive portal's address. The room sync (utils/roomSync.js) and the
// application invites (utils/portalApplications.js) both call it. A
// PORTAL_URL environment variable, when set, is used instead (local testing).
const PORTAL_URL = 'https://portal.hiveny.com';

function portalBaseUrl(env = process.env) {
  return String(env.PORTAL_URL || PORTAL_URL).trim().replace(/\/+$/, '');
}

module.exports = { PORTAL_URL, portalBaseUrl };
