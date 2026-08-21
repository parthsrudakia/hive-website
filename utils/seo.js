const SITE_NAME = 'Hive';
const SITE_URL = (process.env.SITE_URL || 'https://www.hiveny.com').replace(/\/+$/, '');
const DEFAULT_DESCRIPTION = 'Move-in ready, fully furnished apartments with flexible lease terms, transparent monthly pricing, and no broker fees.';
const DEFAULT_IMAGE = '/images/hero-1.jpg';

const PAGE_DEFAULTS = {
  '/': {
    title: 'Hive | Furnished Apartments with Flexible Leases',
    description: DEFAULT_DESCRIPTION
  },
  '/properties': {
    title: 'Furnished Apartments for Rent | Hive',
    description: 'Browse furnished, move-in ready apartments across major U.S. cities. Compare monthly pricing, amenities, availability, and flexible lease options.'
  },
  '/partners': {
    title: 'Property Management Partnerships for Landlords | Hive',
    description: 'Partner with Hive to reduce vacancies, simplify tenant management, and create dependable rental income for furnished apartments.'
  },
  '/faq': {
    title: 'Frequently Asked Questions | Hive',
    description: 'Learn about Hive furnished apartments, flexible lease terms, included utilities, applications, move-in, and extending your stay.'
  },
  '/contact': {
    title: 'Contact Hive | Furnished Apartment Support',
    description: 'Contact Hive about furnished apartment availability, an application, a current stay, or a landlord partnership.'
  },
  '/privacy': {
    title: 'Privacy Policy | Hive',
    description: 'Learn what information Hive collects, why it is used, and how application, payment, identity, and inquiry data are handled.'
  },
  '/terms': {
    title: 'Terms of Service | Hive',
    description: 'Read the terms that apply when browsing Hive listings, submitting an application, or using the Hive website.'
  },
  '/apply': {
    title: 'Rental Application | Hive',
    description: 'Tell Hive what you are looking for and submit an inquiry about a furnished apartment.',
    noindex: true
  },
  '/apply-now': {
    title: 'Complete Your Rental Application | Hive',
    description: 'Complete the secure Hive tenant application, application-fee payment, and identity-verification process.',
    noindex: true
  },
  '/partners/apply': {
    title: 'Landlord Partnership Inquiry | Hive',
    description: 'Share your property details with the Hive partnerships team.',
    noindex: true
  }
};

function absoluteUrl(value = '/') {
  if (/^https?:\/\//i.test(value)) return value;
  return `${SITE_URL}${value.startsWith('/') ? value : `/${value}`}`;
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function pageDefaults(pathname) {
  if (pathname.startsWith('/apply-now/')) return PAGE_DEFAULTS['/apply-now'];
  return PAGE_DEFAULTS[pathname] || {};
}

function buildSeo(req, overrides = {}) {
  const pathname = req.path || '/';
  const defaults = pageDefaults(pathname);
  const canonical = absoluteUrl(overrides.canonicalPath || pathname);
  const title = overrides.title || defaults.title || `${SITE_NAME} | City Living, Made Simple`;
  const description = stripHtml(overrides.description || defaults.description || DEFAULT_DESCRIPTION).slice(0, 320);
  const noindex = overrides.noindex !== undefined ? overrides.noindex : !!defaults.noindex;
  const pageType = overrides.pageType || 'WebPage';

  const webPage = {
    '@type': pageType,
    '@id': `${canonical}#webpage`,
    url: canonical,
    name: title,
    description,
    isPartOf: { '@id': `${SITE_URL}/#website` },
    inLanguage: 'en-US'
  };

  return {
    title,
    description,
    canonical,
    image: absoluteUrl(overrides.image || DEFAULT_IMAGE),
    imageAlt: overrides.imageAlt || 'A furnished Hive apartment',
    type: overrides.type || 'website',
    robots: noindex
      ? 'noindex, nofollow, noarchive'
      : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
    googleSiteVerification: process.env.GOOGLE_SITE_VERIFICATION || '',
    bingSiteVerification: process.env.BING_SITE_VERIFICATION || '',
    structuredData: {
      '@context': 'https://schema.org',
      '@graph': [webPage].concat(overrides.structuredData || [])
    }
  };
}

function organizationSchema() {
  return {
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: SITE_NAME,
    alternateName: 'HiveNY',
    url: `${SITE_URL}/`,
    logo: {
      '@type': 'ImageObject',
      url: absoluteUrl('/favicon.svg')
    },
    description: DEFAULT_DESCRIPTION,
    email: 'hello@hiveny.com',
    areaServed: ['New York', 'Los Angeles', 'Chicago', 'Miami', 'San Francisco', 'Washington DC', 'Boston'].map(name => ({
      '@type': 'City',
      name
    })),
    sameAs: [
      'https://maps.app.goo.gl/KD5n7sVz1eoVoh9W9'
    ]
  };
}

function websiteSchema() {
  return {
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    url: `${SITE_URL}/`,
    name: SITE_NAME,
    alternateName: 'HiveNY',
    description: DEFAULT_DESCRIPTION,
    publisher: { '@id': `${SITE_URL}/#organization` },
    inLanguage: 'en-US',
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${SITE_URL}/properties?location={search_term_string}`
      },
      'query-input': 'required name=search_term_string'
    }
  };
}

function breadcrumbSchema(items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path)
    }))
  };
}

function listingsSchema(listings, publicTitle) {
  return {
    '@type': 'ItemList',
    name: 'Furnished apartment listings',
    numberOfItems: listings.length,
    itemListElement: listings.map((listing, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: absoluteUrl(`/properties/${listing.id}`),
      name: publicTitle(listing)
    }))
  };
}

function listingSchema(listing, publicName) {
  const images = (listing.images || []).map(absoluteUrl);
  const city = listing.city || listing.location || 'the city';
  const neighborhood = listing.neighborhood ? `${listing.neighborhood}, ${city}` : city;
  const schema = {
    '@type': 'Apartment',
    '@id': `${absoluteUrl(`/properties/${listing.id}`)}#residence`,
    name: publicName,
    url: absoluteUrl(`/properties/${listing.id}`),
    // Listing descriptions can contain private building/address details. Keep
    // the public schema useful without exposing anything the UI anonymizes.
    description: `A move-in ready, furnished apartment in ${neighborhood} with flexible lease terms.`,
    image: images,
    numberOfBedrooms: Number(listing.bedrooms || 0),
    numberOfBathroomsTotal: Number(listing.bathrooms || 0),
    address: {
      '@type': 'PostalAddress',
      addressLocality: city,
      addressRegion: listing.state,
      addressCountry: 'US'
    },
    offers: {
      '@type': 'Offer',
      url: absoluteUrl(`/properties/${listing.id}`),
      priceCurrency: 'USD',
      price: Number(listing.price_monthly || 0),
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: Number(listing.price_monthly || 0),
        priceCurrency: 'USD',
        unitText: 'MONTH'
      },
      availability: listing.status === 'available'
        ? 'https://schema.org/InStock'
        : 'https://schema.org/PreOrder'
    }
  };
  if (listing.sqft) {
    schema.floorSize = { '@type': 'QuantitativeValue', value: Number(listing.sqft), unitCode: 'FTK' };
  }
  if (listing.available_to) {
    schema.offers.priceValidUntil = new Date(listing.available_to).toISOString().slice(0, 10);
  }
  return schema;
}

function faqSchema(items) {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer }
    }))
  };
}

module.exports = {
  SITE_NAME,
  SITE_URL,
  DEFAULT_DESCRIPTION,
  absoluteUrl,
  stripHtml,
  safeJson,
  buildSeo,
  organizationSchema,
  websiteSchema,
  breadcrumbSchema,
  listingsSchema,
  listingSchema,
  faqSchema
};
