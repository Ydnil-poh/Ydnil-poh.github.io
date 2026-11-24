import assert from 'node:assert/strict';
import test from 'node:test';

import { isPhoneClient, mobileEntryDecision } from '../functions/_middleware.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const KAKAO_INAPP = 'Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 KAKAOTALK 10.8.1';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const GOOGLEBOT_SMARTPHONE = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

function req(path, ua, { cookie, method = 'GET', mobileHint, cf } = {}) {
  const headers = new Headers({ 'user-agent': ua });
  if (cookie) headers.set('cookie', cookie);
  if (mobileHint) headers.set('sec-ch-ua-mobile', mobileHint);
  const request = new Request(`https://ydnil-poh.pages.dev${path}`, { method, headers });
  if (cf) Object.defineProperty(request, 'cf', { value: cf });
  return request;
}

test('phones are detected; tablets and desktops are not', () => {
  assert.equal(isPhoneClient(new Headers({ 'user-agent': IPHONE })), true);
  assert.equal(isPhoneClient(new Headers({ 'user-agent': ANDROID_PHONE })), true);
  assert.equal(isPhoneClient(new Headers({ 'user-agent': KAKAO_INAPP })), true);
  assert.equal(isPhoneClient(new Headers({ 'user-agent': ANDROID_TABLET })), false);
  assert.equal(isPhoneClient(new Headers({ 'user-agent': IPAD })), false);
  assert.equal(isPhoneClient(new Headers({ 'user-agent': DESKTOP })), false);
  assert.equal(isPhoneClient(new Headers({ 'user-agent': DESKTOP, 'sec-ch-ua-mobile': '?1' })), true);
});

test('a phone on the bare root is redirected to /mobile/, uncached', () => {
  const decision = mobileEntryDecision(req('/', IPHONE));
  assert.equal(decision.redirect.status, 302);
  assert.equal(decision.redirect.headers.get('location'), '/mobile/');
  assert.equal(decision.redirect.headers.get('cache-control'), 'no-store');
});

test('only the root redirects; records, feeds and the list itself pass through', () => {
  for (const path of ['/records/post31/', '/rss.xml', '/mobile/', '/sitemap-index.xml']) {
    assert.equal(mobileEntryDecision(req(path, IPHONE)), null, path);
  }
  assert.equal(mobileEntryDecision(req('/', IPHONE, { method: 'POST' })), null);
});

test('desktops and bots always get the Field', () => {
  assert.equal(mobileEntryDecision(req('/', DESKTOP)), null);
  assert.equal(mobileEntryDecision(req('/', GOOGLEBOT_SMARTPHONE)), null);
  assert.equal(mobileEntryDecision(req('/', ANDROID_PHONE, { cf: { verifiedBotCategory: 'Search Engine Crawler' } })), null);
});

test('?view=field pins the Field via cookie, and the pin is honored', () => {
  const pin = mobileEntryDecision(req('/?view=field', IPHONE));
  assert.equal(pin.redirect, undefined);
  assert.match(pin.setCookie, /^archive_view=field;/);
  assert.equal(mobileEntryDecision(req('/', IPHONE, { cookie: 'other=1; archive_view=field' })), null);
});

test('?view=mobile clears the pin and goes to the list', () => {
  const decision = mobileEntryDecision(req('/?view=mobile', IPHONE, { cookie: 'archive_view=field' }));
  assert.equal(decision.redirect.headers.get('location'), '/mobile/');
  assert.match(decision.redirect.headers.get('set-cookie'), /archive_view=;.*Max-Age=0/);
});

test('onRequest short-circuits the redirect and attaches the pin cookie to the Field', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  let served = 0;
  const context = (request) => ({
    request,
    env: {},
    waitUntil: () => {},
    next: async () => { served += 1; return new Response('field', { headers: { 'content-type': 'text/html' } }); },
  });

  const redirected = await onRequest(context(req('/', IPHONE)));
  assert.equal(redirected.status, 302);
  assert.equal(served, 0);

  const pinned = await onRequest(context(req('/?view=field', IPHONE)));
  assert.equal(await pinned.text(), 'field');
  assert.match(pinned.headers.get('set-cookie'), /archive_view=field/);

  const desktop = await onRequest(context(req('/', DESKTOP)));
  assert.equal(desktop.headers.get('set-cookie'), null);
  assert.equal(served, 2);
});
