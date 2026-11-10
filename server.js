require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const pool = require('./db/pool');
const { safeJson, buildSeo } = require('./utils/seo');
const { marketUrl } = require('./utils/markets');

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');

// Trust Railway's reverse proxy (needed for secure cookies over HTTPS)
app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.safeJson = safeJson;
app.locals.marketUrl = marketUrl;

// Private application, API, webhook, and admin responses must never become
// search results, even if a crawler discovers one of their URLs elsewhere.
app.use((req, res, next) => {
  if (/^\/(admin|api|webhooks)(\/|$)/.test(req.path)) {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  next();
});

// Stripe webhooks must be mounted BEFORE the body parsers: signature
// verification needs the raw request body, which express.json() would consume.
app.use('/webhooks', require('./routes/stripeWebhook'));
// Resend inbound-mail webhook (applicant replies to admin messages). Also needs
// the raw body for signature verification, so it's mounted here as well.
app.use('/webhooks', require('./routes/resendWebhook'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessions
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'hive-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Auto-migrate: add any new columns on startup (idempotent)
(async () => {
  try {
    const migrations = [
      `ALTER TABLE listings ALTER COLUMN bathrooms TYPE NUMERIC(3,1)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS floor VARCHAR(50)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS min_stay INTEGER DEFAULT 30`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS pet_policy TEXT`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS smoking_allowed BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS events_allowed BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS building_amenities TEXT[] DEFAULT '{}'`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS highlights TEXT`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS video_url VARCHAR(500)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS bed_type VARCHAR(50)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS address VARCHAR(300)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS transit TEXT`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS floor_plan_image VARCHAR(500)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS location VARCHAR(100) DEFAULT 'New York'`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS location_description TEXT`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS show_booking BOOLEAN DEFAULT TRUE`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS property_type VARCHAR(50)`,
      `ALTER TABLE listings ADD COLUMN IF NOT EXISTS key_amenities TEXT[] DEFAULT '{}'`,
      `CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        guest_name VARCHAR(200),
        check_in DATE NOT NULL,
        check_out DATE NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS applications (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(200) NOT NULL,
        email VARCHAR(200) NOT NULL,
        phone VARCHAR(50),
        about TEXT,
        social_media TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS landlord_inquiries (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(200) NOT NULL,
        email VARCHAR(200) NOT NULL,
        phone VARCHAR(100),
        property_location VARCHAR(300),
        num_units VARCHAR(50),
        property_type VARCHAR(50),
        message TEXT,
        referral_source VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      // Paid tenant applications ($20 fee, collected via Stripe Checkout).
      // `answers` holds the (to-be-finalized) application form fields as JSON so
      // new questions can be added without further migrations.
      `CREATE TABLE IF NOT EXISTS tenant_applications (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(200) NOT NULL,
        email VARCHAR(200) NOT NULL,
        phone VARCHAR(50),
        answers JSONB DEFAULT '{}'::jsonb,
        amount_cents INTEGER NOT NULL DEFAULT 2000,
        currency VARCHAR(10) NOT NULL DEFAULT 'usd',
        payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        stripe_session_id VARCHAR(255),
        stripe_payment_intent VARCHAR(255),
        paid_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS tenant_applications_session_idx ON tenant_applications (stripe_session_id)`,
      // Stripe Identity verification of the applicant's government ID.
      // `identity_status` mirrors the VerificationSession status ('not_started'
      // until the applicant opens the hosted flow), updated by the webhook.
      `ALTER TABLE tenant_applications ADD COLUMN IF NOT EXISTS identity_session_id VARCHAR(255)`,
      `ALTER TABLE tenant_applications ADD COLUMN IF NOT EXISTS identity_status VARCHAR(30) NOT NULL DEFAULT 'not_started'`,
      `ALTER TABLE tenant_applications ADD COLUMN IF NOT EXISTS identity_verified_at TIMESTAMP`,
      `ALTER TABLE tenant_applications ADD COLUMN IF NOT EXISTS identity_last_error TEXT`,
      `CREATE INDEX IF NOT EXISTS tenant_applications_identity_idx ON tenant_applications (identity_session_id)`,
      // Which listing an /apply inquiry came from (via the listing page's "Join the waitlist"),
      // so the admin Applications tab can link straight to the property.
      `ALTER TABLE applications ADD COLUMN IF NOT EXISTS listing_id INTEGER`,
      // Admin <-> applicant email thread. `reply_token` makes the per-application
      // inbound address (app-<id>-<token>@REPLY_DOMAIN) unguessable.
      `ALTER TABLE applications ADD COLUMN IF NOT EXISTS reply_token VARCHAR(32)`,
      // Soft delete: Delete / Clear All hide rows; a late applicant reply restores
      // them; rows hidden for over a year are purged when the tab is opened.
      `ALTER TABLE applications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`,
      // General /contact messages land in the Applications tab too. `source`
      // says which form a row came from ('application' | 'contact') and
      // `subject` holds the contact form's subject line.
      `ALTER TABLE applications ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'application'`,
      `ALTER TABLE applications ADD COLUMN IF NOT EXISTS subject VARCHAR(300)`,
      // When the admin first opened the application popup (NULL = never opened,
      // shown as "New"). Backfilled once, when the column is first added, so
      // rows from before this shipped count as already opened.
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'applications' AND column_name = 'opened_at') THEN
           ALTER TABLE applications ADD COLUMN opened_at TIMESTAMP;
           UPDATE applications SET opened_at = created_at;
         END IF;
       END $$`,
      // Same "New until seen" marker for the paid-applications and landlord-inquiry tabs.
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'tenant_applications' AND column_name = 'opened_at') THEN
           ALTER TABLE tenant_applications ADD COLUMN opened_at TIMESTAMP;
           UPDATE tenant_applications SET opened_at = created_at;
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'landlord_inquiries' AND column_name = 'opened_at') THEN
           ALTER TABLE landlord_inquiries ADD COLUMN opened_at TIMESTAMP;
           UPDATE landlord_inquiries SET opened_at = created_at;
         END IF;
       END $$`,
      // Landlord inquiries flagged by utils/spamCheck: saved, emailed with a
      // tagged subject but not confirmed to the sender, and hidden on the
      // admin tab unless the Spam toggle is on.
      `ALTER TABLE landlord_inquiries ADD COLUMN IF NOT EXISTS is_spam BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE landlord_inquiries ADD COLUMN IF NOT EXISTS spam_reason TEXT`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'bookings' AND column_name = 'opened_at') THEN
           ALTER TABLE bookings ADD COLUMN opened_at TIMESTAMP;
           UPDATE bookings SET opened_at = created_at;
         END IF;
       END $$`,
      `CREATE TABLE IF NOT EXISTS application_messages (
        id SERIAL PRIMARY KEY,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        direction VARCHAR(3) NOT NULL,
        subject VARCHAR(300),
        body_text TEXT,
        from_email VARCHAR(200),
        message_id VARCHAR(300),
        resend_id VARCHAR(100),
        read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS application_messages_resend_idx ON application_messages (resend_id)`,
      `CREATE INDEX IF NOT EXISTS application_messages_app_idx ON application_messages (application_id, created_at)`,
      // Forgot-password flow: a hashed single-use reset token + expiry.
      `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reset_token_hash VARCHAR(64)`,
      `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP`
    ];
    for (const sql of migrations) {
      await pool.query(sql);
    }
    console.log('Database migrations applied.');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }
})();

// Public-facing, anonymized listing title — never exposes the building name
// (which is kept privately in `listing.title`). Deterministic per building so
// every room in the same unit shows the same title, while different buildings
// get different descriptors, keeping titles distinct within a city.
app.locals.publicTitle = function (listing) {
  if (!listing) return '';
  const neighborhood = (listing.neighborhood && String(listing.neighborhood).trim())
    || (listing.city && String(listing.city).trim()) || 'the city';
  const beds = parseInt(listing.bedrooms, 10);
  const bedLabel = (!beds || beds <= 0) ? 'Studio' : beds + 'BR';
  const type = (listing.property_type && String(listing.property_type).trim()) || 'apartment';
  const ADJ = ['luxury', 'modern', 'boutique', 'elegant', 'designer', 'sunlit',
               'stylish', 'chic', 'contemporary', 'serene'];
  const seed = String(listing.title || '') + '|' + String(listing.city || '');
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  const adj = ADJ[h % ADJ.length];
  const article = /^[aeiou]/i.test(adj) ? 'an' : 'a';
  return `${bedLabel} in ${article} ${adj} ${type} in ${neighborhood}`;
};

// Google Maps JS API key for the approximate-area map (empty => iframe fallback).
app.locals.mapsApiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '';

// Stripe publishable key for the client-side embedded Checkout (empty => the
// apply-now page shows a "payments not configured" notice instead of crashing).
app.locals.stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
// The tenant application fee, in cents. Single source of truth for server + view.
app.locals.applicationFeeCents = parseInt(process.env.APPLICATION_FEE_CENTS || '2000', 10);

// Routes
app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));
app.use('/api', require('./routes/api'));

app.use((req, res) => {
  res.status(404).render('public/404', {
    seo: buildSeo(req, {
      title: 'Page Not Found | Hive',
      description: 'The page you requested could not be found. Browse available furnished apartments or return to the Hive homepage.',
      canonicalPath: req.path,
      noindex: true
    })
  });
});

// Start a long-running server only when invoked directly (local dev, Railway).
// On Vercel the app is imported by api/index.js and served as a serverless function.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
