// ---------------------------------------------------------------------------
// Which listings the public site shows. Every public listing query adds
// PUBLIC_LISTING_SQL to its WHERE clause, so the rules live in one place:
//
//  1. Rented listings are hidden (as before).
//  2. Rooms synced from the portal (source 'portal', utils/roomSync.js) are
//     hidden while the sync has a reason to hold them back (hidden_reason,
//     e.g. no photos yet) or while their market is marked comingSoon in
//     utils/markets.js. That flag is read here at startup, so deleting it is
//     the only change needed to show those rooms.
//  3. The old placeholder listings (source is not 'portal') are hidden as soon
//     as at least one portal room is live, and show again if none is. They
//     are never deleted.
// ---------------------------------------------------------------------------

const { MARKET_LIST } = require('./markets');

const PORTAL_SOURCE = 'portal';

const sqlString = value => `'${String(value).replace(/'/g, "''")}'`;

// Markets whose synced rooms stay hidden (utils/markets.js comingSoon).
function comingSoonMarketNames() {
  return MARKET_LIST.filter(market => market.comingSoon).map(market => market.name);
}

// SQL for "this row is a live portal room". `prefix` qualifies the columns
// (e.g. 'live.'), or is empty for the query's own table.
function liveRoomSql(prefix = '') {
  const comingSoon = comingSoonMarketNames();
  return [
    `${prefix}source = '${PORTAL_SOURCE}'`,
    `${prefix}status != 'rented'`,
    `${prefix}hidden_reason IS NULL`,
    ...(comingSoon.length
      ? [`COALESCE(${prefix}location, '') NOT IN (${comingSoon.map(sqlString).join(', ')})`]
      : [])
  ].join(' AND ');
}

function publicListingSql() {
  return [
    `status != 'rented'`,
    `(COALESCE(source, '') <> '${PORTAL_SOURCE}' OR (${liveRoomSql()}))`,
    `(COALESCE(source, '') = '${PORTAL_SOURCE}' OR NOT EXISTS (SELECT 1 FROM listings live WHERE ${liveRoomSql('live.')}))`
  ].join(' AND ');
}

const PUBLIC_LISTING_SQL = publicListingSql();

// Why a synced room isn't public right now, or null when it is. Mirrors the
// SQL above for one row (used by the admin sync panel).
function roomHiddenReason(listing) {
  if (listing.status === 'rented') return 'removed';
  if (listing.hidden_reason) return listing.hidden_reason;
  if (comingSoonMarketNames().includes(listing.location)) return 'coming_soon_market';
  return null;
}

module.exports = {
  PORTAL_SOURCE,
  PUBLIC_LISTING_SQL,
  publicListingSql,
  liveRoomSql,
  comingSoonMarketNames,
  roomHiddenReason
};
