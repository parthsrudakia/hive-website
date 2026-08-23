'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'seo-test-secret';
process.env.SITE_URL = 'https://www.hiveny.com';

const listing = {
  id: 7,
  title: 'Internal Building Name',
  city: 'New York',
  location: 'New York',
  neighborhood: 'SoHo',
  state: 'NY',
  status: 'available',
  bedrooms: 1,
  bathrooms: 1,
  price_monthly: 4200,
  sqft: 650,
  sort_order: 1,
  images: ['/images/hero-1.jpg'],
  amenities: ['WiFi'],
  building_amenities: [],
  key_amenities: [],
  description: 'A bright, furnished home with flexible terms.',
  highlights: '',
  location_description: '',
  transit: '',
  floor: '4',
  min_stay: 30,
  pet_policy: '',
  smoking_allowed: false,
  events_allowed: false,
  show_booking: true,
  property_type: 'apartment',
  bed_type: 'Queen',
  floor_plan_image: '',
  video_url: '',
  available_from: '2026-09-01',
  available_to: '2027-09-01',
  created_at: new Date('2026-08-01T00:00:00Z'),
  updated_at: new Date('2026-08-20T00:00:00Z')
};

const calls = [];
const fakePool = {
  async query(sql, params = []) {
    calls.push({ sql, params });
    if (/SELECT DISTINCT COALESCE/.test(sql)) return { rows: [{ city: 'New York' }] };
    if (/SELECT id, city, COALESCE/.test(sql)) {
      return { rows: [{ id: listing.id, city: listing.city, location: listing.location, lastmod: listing.updated_at }] };
    }
    if (/SELECT \* FROM listings WHERE id =/.test(sql)) return { rows: [listing] };
    if (/FROM bookings/.test(sql) || /AND \(neighborhood =/.test(sql)) return { rows: [] };
    if (/ANY\(\$1::text\[\]\)/.test(sql)) {
      const requested = params[0][0];
      const city = requested === 'new york' ? 'New York' : requested.replace(/\b\w/g, letter => letter.toUpperCase());
      return { rows: [{ ...listing, city, location: city, state: city === 'New York' ? 'NY' : 'NJ' }] };
    }
    if (/SELECT \* FROM listings WHERE status != 'rented'/.test(sql)) {
      return { rows: params.includes('Atlantis') ? [] : [listing] };
    }
    return { rows: [] };
  }
};

const poolPath = require.resolve('../db/pool');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: fakePool,
  children: [],
  paths: []
};

const reviewsPath = require.resolve('../utils/googleReviews');
require.cache[reviewsPath] = {
  id: reviewsPath,
  filename: reviewsPath,
  loaded: true,
  exports: { getGoogleReviews: async () => ({ reviews: [], rating: 0, totalReviews: 0 }) },
  children: [],
  paths: []
};

const app = require('../server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('publishes crawler controls and AI discovery information', async () => {
  const robots = await fetch(`${baseUrl}/robots.txt`);
  const robotsText = await robots.text();
  assert.equal(robots.status, 200);
  assert.match(robotsText, /User-agent: OAI-SearchBot/);
  assert.match(robotsText, /User-agent: ChatGPT-User/);
  assert.match(robotsText, /User-agent: GPTBot/);
  assert.match(robotsText, /Sitemap: https:\/\/www\.hiveny\.com\/sitemap\.xml/);
  assert.doesNotMatch(robotsText, /Disallow: \/apply/);

  const llms = await fetch(`${baseUrl}/llms.txt`);
  assert.equal(llms.status, 200);
  assert.match(await llms.text(), /Available furnished apartments/);
});

test('builds an absolute sitemap with city and listing URLs', async () => {
  const response = await fetch(`${baseUrl}/sitemap.xml`);
  const xml = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/xml/);
  assert.match(xml, /<loc>https:\/\/www\.hiveny\.com\/properties<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.hiveny\.com\/short-term-rentals\/new-york<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.hiveny\.com\/short-term-rentals\/jersey-city<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.hiveny\.com\/short-term-rentals\/hoboken<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.hiveny\.com\/properties\/7<\/loc>/);
  assert.match(xml, /<lastmod>2026-08-20<\/lastmod>/);
});

test('renders URL-driven filters with canonical metadata', async () => {
  const response = await fetch(`${baseUrl}/properties?location=New%20York&bedrooms=1`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<title>Furnished Apartments in New York \| Hive<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.hiveny\.com\/short-term-rentals\/new-york">/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(html, /name="location"/);
  assert.match(html, /value="New York" selected/);
  assert.match(html, /value="1" selected/);
  assert.match(html, /1BR in a [a-z]+ apartment in SoHo/);
  assert.ok(calls.some(call => call.params.includes('New York') && call.params.includes(1)));
});

test('prevents arbitrary empty location pages from entering the index', async () => {
  const response = await fetch(`${baseUrl}/properties?location=Atlantis`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.hiveny\.com\/properties">/);
  assert.match(html, /No properties match these filters/);
});

test('publishes unique listing metadata and Apartment JSON-LD', async () => {
  const response = await fetch(`${baseUrl}/properties/7?movein=2026-10-01`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<title>1BR in a [a-z]+ apartment in SoHo \| Hive<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.hiveny\.com\/properties\/7">/);
  assert.match(html, /"@type":"Apartment"/);
  assert.match(html, /"unitText":"MONTH"/);
  assert.match(html, /<meta property="og:image" content="https:\/\/www\.hiveny\.com\/images\/hero-1\.jpg">/);
});

test('publishes one useful, canonical landing page per target rental market', async () => {
  const markets = [
    ['/short-term-rentals/new-york', 'Short-Term Furnished Rentals in New York'],
    ['/short-term-rentals/jersey-city', 'Short-Term Furnished Rentals in Jersey City'],
    ['/short-term-rentals/hoboken', 'Short-Term Furnished Rentals in Hoboken']
  ];
  for (const [pathname, heading] of markets) {
    const response = await fetch(`${baseUrl}${pathname}`);
    const html = await response.text();
    assert.equal(response.status, 200, pathname);
    assert.match(html, new RegExp(`<h1>${heading}<\\/h1>`));
    assert.match(html, new RegExp(`<link rel="canonical" href="https:\\/\\/www\\.hiveny\\.com${pathname}">`));
    assert.match(html, /"@type":"CollectionPage"/);
    assert.match(html, /"@type":"FAQPage"/);
    assert.match(html, /30-day minimum/);
    assert.equal((html.match(/<h1>/g) || []).length, 1);
  }

  const legacy = await fetch(`${baseUrl}/properties?location=New%20York`, { redirect: 'manual' });
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get('location'), '/short-term-rentals/new-york');

  const alias = await fetch(`${baseUrl}/furnished-rentals/hoboken`, { redirect: 'manual' });
  assert.equal(alias.status, 301);
  assert.equal(alias.headers.get('location'), '/short-term-rentals/hoboken');
});

test('publishes FAQ and legal pages as indexable, structured content', async () => {
  const faq = await fetch(`${baseUrl}/faq`);
  const faqHtml = await faq.text();
  assert.equal(faq.status, 200);
  assert.match(faqHtml, /"@type":"FAQPage"/);
  assert.match(faqHtml, /<link rel="canonical" href="https:\/\/www\.hiveny\.com\/faq">/);

  const privacy = await fetch(`${baseUrl}/privacy`);
  const privacyHtml = await privacy.text();
  assert.equal(privacy.status, 200);
  assert.match(privacyHtml, /<title>Privacy Policy \| Hive<\/title>/);
  assert.match(privacyHtml, /Payment and identity-verification status/);
});

test('returns a noindex 404 and excludes admin responses from search', async () => {
  const missing = await fetch(`${baseUrl}/this-page-does-not-exist`);
  const missingHtml = await missing.text();
  assert.equal(missing.status, 404);
  assert.match(missingHtml, /This page moved out/);
  assert.match(missingHtml, /<meta name="robots" content="noindex, nofollow, noarchive">/);

  const admin = await fetch(`${baseUrl}/admin/login`);
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(await admin.text(), /<meta name="robots" content="noindex, nofollow, noarchive">/);
});

test('renders shared metadata on every primary public page', async () => {
  const pages = ['/', '/properties', '/short-term-rentals/new-york', '/short-term-rentals/jersey-city', '/short-term-rentals/hoboken', '/partners', '/faq', '/contact', '/privacy', '/terms', '/apply', '/partners/apply', '/apply-now'];
  for (const pathname of pages) {
    const response = await fetch(`${baseUrl}${pathname}`);
    const html = await response.text();
    assert.equal(response.status, 200, pathname);
    assert.equal((html.match(/<title>/g) || []).length, 1, pathname);
    assert.equal((html.match(/<link rel="canonical"/g) || []).length, 1, pathname);
    assert.equal((html.match(/<meta name="description"/g) || []).length, 1, pathname);
    const jsonLd = Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g));
    assert.ok(jsonLd.length >= 1, pathname);
    jsonLd.forEach(match => assert.doesNotThrow(() => JSON.parse(match[1]), pathname));
  }
});
