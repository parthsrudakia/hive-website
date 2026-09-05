const test = require('node:test');
const assert = require('node:assert/strict');
const { verifySvixSignature, signSvix, stripQuotedReply, htmlToText } = require('../utils/resendWebhook');
const { parseReplyAddress, replyAddress } = require('../utils/mailer');

const SECRET = 'whsec_' + Buffer.from('a-test-signing-secret-32-bytes!!').toString('base64');
const BODY = JSON.stringify({ type: 'email.received', data: { email_id: 'abc' } });

test('accepts a correctly signed webhook', () => {
  const headers = signSvix(BODY, SECRET);
  assert.equal(verifySvixSignature(BODY, headers, SECRET), true);
  assert.equal(verifySvixSignature(Buffer.from(BODY), headers, SECRET), true);
});

test('accepts when any of several rotated signatures matches', () => {
  const headers = signSvix(BODY, SECRET);
  headers['svix-signature'] = 'v1,AAAA ' + headers['svix-signature'];
  assert.equal(verifySvixSignature(BODY, headers, SECRET), true);
});

test('rejects tampered bodies, wrong secrets, and missing headers', () => {
  const headers = signSvix(BODY, SECRET);
  assert.equal(verifySvixSignature(BODY + ' ', headers, SECRET), false);
  assert.equal(verifySvixSignature(BODY, headers, 'whsec_' + Buffer.from('other').toString('base64')), false);
  assert.equal(verifySvixSignature(BODY, {}, SECRET), false);
  assert.equal(verifySvixSignature(BODY, headers, ''), false);
});

test('rejects stale timestamps', () => {
  const old = Math.floor(Date.now() / 1000) - 10 * 60;
  const headers = signSvix(BODY, SECRET, { ts: old });
  assert.equal(verifySvixSignature(BODY, headers, SECRET), false);
});

test('strips quoted history from Gmail/Outlook-style replies', () => {
  assert.equal(stripQuotedReply('Yes, that works for me!\n\nOn Tue, Sep 2, 2026 at 3:10 PM Hive <x@hiveny.com> wrote:\n> Hi there\n> when can you move in?'),
    'Yes, that works for me!');
  assert.equal(stripQuotedReply('Sounds good.\r\n\r\n________________________________\r\nFrom: Hive <x@hiveny.com>\r\nSent: Tuesday\r\nSubject: Re: Your Hive application'),
    'Sounds good.');
  assert.equal(stripQuotedReply('Thanks\n\nOn Tue, Sep 2, 2026 at 3:10 PM Hive\n<x@hiveny.com> wrote:\n> hi'), 'Thanks');
  assert.equal(stripQuotedReply('Just the reply, no quote.'), 'Just the reply, no quote.');
  assert.equal(stripQuotedReply(''), '');
});

test('falls back to plain text from html', () => {
  assert.equal(htmlToText('<div>Hello<br>there &amp; you</div><p>Bye</p>'), 'Hello\nthere & you\nBye');
});

test('round-trips the per-application reply address', () => {
  const app = { id: 42, reply_token: '0123456789abcdef' };
  const addr = replyAddress(app);
  assert.match(addr, /^app-42-0123456789abcdef@/);
  assert.deepEqual(parseReplyAddress(addr), { id: 42, token: '0123456789abcdef' });
  assert.deepEqual(parseReplyAddress(`Hive Replies <${addr.toUpperCase()}>`), { id: 42, token: '0123456789abcdef' });
  assert.equal(parseReplyAddress('hello@reply.hiveny.com'), null);
  assert.equal(parseReplyAddress(''), null);
});
