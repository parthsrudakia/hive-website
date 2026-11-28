#!/usr/bin/env node
/*
 * Run the room sync once from a terminal, without the 40-second limit the
 * cron and the admin button use, so a first import can copy every photo in
 * one go. Same job as GET /api/cron/room-sync (see utils/roomSync.js).
 *
 *   node scripts/room-sync.js
 *
 * Needs INVENTORY_API_KEY, GOOGLE_DRIVE_API_KEY, DATABASE_URL and
 * the Supabase storage variables in the environment. It writes to whichever
 * database DATABASE_URL points at.
 */
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const pool = require('../db/pool');
const { runRoomSync } = require('../utils/roomSync');

(async () => {
  const result = await runRoomSync({ pool, budgetMs: 30 * 60 * 1000 });
  console.log(JSON.stringify(result, null, 2));
  await pool.end();
  process.exit(result.ok ? 0 : 1);
})();
