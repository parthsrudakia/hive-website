const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSpam } = require('../utils/spamCheck');

// A plausible landlord inquiry; each test changes one field.
const inquiry = (overrides) => Object.assign({
  full_name: 'Maria Lopez',
  email: 'maria.lopez@gmail.com',
  phone: '(201) 555-0134',
  property_location: '123 Main St, Jersey City, NJ 07306',
  num_units: '2',
  property_type: 'apartment',
  message: 'Two renovated units in a brownstone, available from June.',
  referral_source: 'Google search'
}, overrides);

test('lets real landlord inquiries through', () => {
  assert.equal(checkSpam(inquiry()), null);
  assert.equal(checkSpam(inquiry({ property_location: '45 Washington St., Apt. 3B, Hoboken, NJ 07030' })), null);
  assert.equal(checkSpam(inquiry({ message: '3 bed in Journal Square, 2 units available' })), null);
  assert.equal(checkSpam(inquiry({ message: 'Call me at (201) 555-0134 or 201.555.0134 after 5pm to set up a showing.' })), null);
  assert.equal(checkSpam(inquiry({ message: 'Corner unit, 1.5 baths. Rent is $3,200/mo. Top floor with views.' })), null);
  assert.equal(checkSpam(inquiry({ message: 'Two units in Jersey City, NJ.Top floor is vacant now.' })), null);
  assert.equal(checkSpam(inquiry({ message: 'Email me at maria.lopez@gmail.com with next steps.' })), null);
  assert.equal(checkSpam(inquiry({ referral_source: 'A friend who lived in Seoul' })), null);
  assert.equal(checkSpam(inquiry({ message: 'Each unit has a parking slot. Your best bet is to call.' })), null);
  assert.equal(checkSpam(inquiry({ message: 'There is a construction loan on the building and two parking slots.' })), null);
  assert.equal(checkSpam(inquiry({ message: 'The mortgage loans are with Chase; viewing slots are open on weekends.' })), null);
});

test('ignores the email field and missing or odd input', () => {
  assert.equal(checkSpam(inquiry({ email: 'owner@casino-deals.com' })), null);
  assert.equal(checkSpam({}), null);
  assert.equal(checkSpam(undefined), null);
  assert.equal(checkSpam({ message: null, full_name: undefined }), null);
});

test('flags a casino link', () => {
  assert.equal(checkSpam(inquiry({ message: 'Big wins at https://www.bestcasino777.com/promo?ref=12 tonight!' })),
    'web address in message: https://www.bestcasino777.com/promo?ref=12');
});

test('flags web addresses in any free-text field', () => {
  assert.match(checkSpam(inquiry({ message: 'More at http://example.net' })), /^web address in message: /);
  assert.match(checkSpam(inquiry({ message: 'See www.example-deals.biz for details' })), /^web address in message: www\./);
  assert.equal(checkSpam(inquiry({ property_location: 'cheap-rooms.xyz' })), 'web address in property_location: cheap-rooms.xyz');
  assert.equal(checkSpam(inquiry({ referral_source: 'promo.site.top' })), 'web address in referral_source: promo.site.top');
  assert.match(checkSpam(inquiry({ full_name: 'Visit https://x.io' })), /^web address in full_name: /);
});

test('flags bare domains', () => {
  for (const domain of ['word.com', 'word.net', 'word.org', 'word.io', 'word.xyz', 'word.top', 'word.ru', 'WORD.COM']) {
    assert.equal(checkSpam(inquiry({ message: `Great offers, visit ${domain} today.` })),
      `web address in message: ${domain}`, domain);
  }
  assert.equal(checkSpam(inquiry({ message: 'Check my-site.com/landlords' })), 'web address in message: my-site.com');
});

test('flags each spam word as a whole word, in any case', () => {
  const words = ['casino', 'betting', 'crypto', 'bitcoin', 'forex', 'seo',
                 'backlink', 'guest post', 'viagra', 'porn', 'escort'];
  for (const word of words) {
    assert.equal(checkSpam(inquiry({ message: `We offer ${word} services to property owners.` })),
      `spam word in message: ${word}`, word);
    assert.equal(checkSpam(inquiry({ message: `WE OFFER ${word.toUpperCase()} SERVICES TO OWNERS.` })),
      `spam word in message: ${word}`, word.toUpperCase());
  }
});

test('flags plurals and common variants of spam words', () => {
  assert.equal(checkSpam(inquiry({ message: 'Top casinos ranked for you' })), 'spam word in message: casino');
  assert.equal(checkSpam(inquiry({ message: 'Quality backlinks for your site' })), 'spam word in message: backlink');
  assert.equal(checkSpam(inquiry({ message: 'Accepting guest-posting offers' })), 'spam word in message: guest post');
  assert.equal(checkSpam(inquiry({ message: 'Invest in cryptocurrency now' })), 'spam word in message: crypto');
  assert.equal(checkSpam(inquiry({ referral_source: 'SEO agency' })), 'spam word in referral_source: seo');
});

test('does not flag words that only contain a spam word', () => {
  for (const text of ['Near the museo and Seoul Garden restaurant', 'Loaned furniture stays in the unit',
                      'Escorted tours of the building', 'Slotted shelving in each closet', 'Lots of light']) {
    assert.equal(checkSpam(inquiry({ message: text })), null, text);
  }
});

test('checks the contact form subject', () => {
  assert.equal(checkSpam({ full_name: 'Sam Lee', subject: 'Forex signals', message: 'Hello there, quick question.' }),
    'spam word in subject: forex');
});
