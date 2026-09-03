const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSocialLink } = require('../utils/socialLink');

test('accepts official Instagram profile links and normalizes them', () => {
  assert.deepEqual(parseSocialLink('https://www.instagram.com/katzzzie/'),
    { platform: 'instagram', label: 'Instagram', url: 'https://www.instagram.com/katzzzie/' });
  assert.equal(parseSocialLink('instagram.com/mica_lossio01').url, 'https://www.instagram.com/mica_lossio01/');
  assert.equal(parseSocialLink('https://www.instagram.com/james_xomf?igsi=MTlhYTdsejRraGx6NQ==').url,
    'https://www.instagram.com/james_xomf/');
});

test('accepts official LinkedIn profile links, including country subdomains', () => {
  assert.equal(parseSocialLink('https://www.linkedin.com/in/lara-aklouk?utm_source=share_via').url,
    'https://www.linkedin.com/in/lara-aklouk/');
  assert.equal(parseSocialLink('https://ca.linkedin.com/in/supriya-sharma-843252201').label, 'LinkedIn');
  assert.equal(parseSocialLink('linkedin.com/in/utkarshg20/').platform, 'linkedin');
});

test('rejects other sites, bare handles, and non-profile pages', () => {
  assert.equal(parseSocialLink('https://www.facebook.com/share/19SSRL9Hb5/?mibextid=wwXIfr'), null);
  assert.equal(parseSocialLink('@someone'), null);
  assert.equal(parseSocialLink('someone'), null);
  assert.equal(parseSocialLink('https://instagram.com.evil.com/x'), null);
  assert.equal(parseSocialLink('https://notinstagram.com/x'), null);
  assert.equal(parseSocialLink('https://www.instagram.com/p/Cxyz123/'), null);
  assert.equal(parseSocialLink('https://www.linkedin.com/company/hive'), null);
  assert.equal(parseSocialLink('https://www.linkedin.com/'), null);
  assert.equal(parseSocialLink(''), null);
});
