'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Store } = require('../src/store');
const { createApp } = require('../src/app');

const ADMIN_KEY = 'test-admin-key-123';
const TEAMS = 'https://teams.microsoft.com';

async function start(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossar-api-'));
  const store = new Store(dir);
  store.load();
  const indexPath = path.join(dir, 'index.html');
  fs.writeFileSync(indexPath, '<!doctype html><title>t</title><p>hello</p>');
  const server = createApp({
    store, adminKey: ADMIN_KEY, frameAncestors: [TEAMS], indexPath, ...opts,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body, headers) => fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return { base, call, store, dir };
}

function rawRequest(base, options, chunks = []) {
  return new Promise((resolve, reject) => {
    const req = http.request(base, options, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

test('GET /healthz answers ok', async (t) => {
  const { call } = await start(t);
  const res = await call('GET', '/healthz');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('GET / serves the page with Teams-friendly headers', async (t) => {
  const { call } = await start(t);
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html; charset=utf-8/);
  assert.match(await res.text(), /hello/);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self' https:\/\/teams\.microsoft\.com/);
  assert.match(csp, /connect-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('set-cookie'), null);
});

test('security headers are also on API and error responses', async (t) => {
  const { call } = await start(t);
  for (const res of [await call('GET', '/api/terms'), await call('GET', '/nope'), await call('POST', '/api/terms', '{')]) {
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors/);
    assert.equal(res.headers.get('x-frame-options'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('page supports HEAD and conditional GET (304), including weak etags from proxies', async (t) => {
  const { call } = await start(t);
  const first = await call('GET', '/');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.equal((await call('GET', '/', undefined, { 'if-none-match': etag })).status, 304);
  assert.match(etag, /^W\//);
  // A proxy may strip the W/ prefix, or send several candidates.
  assert.equal((await call('GET', '/', undefined, { 'if-none-match': etag.slice(2) })).status, 304);
  assert.equal((await call('GET', '/', undefined, { 'if-none-match': `"other", ${etag}` })).status, 304);
  assert.equal((await call('GET', '/', undefined, { 'if-none-match': '"other"' })).status, 200);
  const head = await call('HEAD', '/');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('GET /api/terms: empty list, etag, 304, gzip', async (t) => {
  const { base, call } = await start(t);
  const res = await call('GET', '/api/terms');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { terms: [] });
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const etag = res.headers.get('etag');
  assert.equal((await call('GET', '/api/terms', undefined, { 'if-none-match': etag })).status, 304);

  await call('POST', '/api/terms', { term: 'A', definition: 'a' });
  const changed = await call('GET', '/api/terms', undefined, { 'if-none-match': etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);

  const gz = await rawRequest(`${base}/api/terms`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(gz.body)).terms.length, 1);
  const plain = await rawRequest(`${base}/api/terms`, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(plain.body).terms.length, 1);
});

test('POST adds a term (201) and it appears in the list', async (t) => {
  const { call } = await start(t);
  const res = await call('POST', '/api/terms', { term: 'SLA', definition: 'Service level agreement' });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.term, 'SLA');
  const list = await (await call('GET', '/api/terms')).json();
  assert.deepEqual(list.terms, [created]);
});

test('POST rejects bad input with useful messages', async (t) => {
  const { call } = await start(t);
  let res = await call('POST', '/api/terms', '{ not json');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /JSON/);
  res = await call('POST', '/api/terms', '');
  assert.equal(res.status, 400);
  res = await call('POST', '/api/terms', { term: '', definition: 'x' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /term/);
  await call('POST', '/api/terms', { term: 'Dup', definition: 'x' });
  res = await call('POST', '/api/terms', { term: 'dup', definition: 'y' });
  assert.equal(res.status, 409);
});

test('oversized bodies get 413 (declared length and chunked)', async (t) => {
  const { base, call } = await start(t);
  const big = { term: 'x', definition: 'y'.repeat(20 * 1024) };
  assert.equal((await call('POST', '/api/terms', big)).status, 413);
  const chunked = await rawRequest(
    `${base}/api/terms`,
    { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
    [Buffer.alloc(20 * 1024, 'a')],
  );
  assert.equal(chunked.status, 413);
  // The server is still healthy afterwards.
  assert.equal((await call('GET', '/healthz')).status, 200);
});

test('PUT edits a term; 404 for unknown id; 400 for empty update', async (t) => {
  const { call } = await start(t);
  const created = await (await call('POST', '/api/terms', { term: 'API', definition: 'old' })).json();
  let res = await call('PUT', `/api/terms/${created.id}`, { definition: 'new' });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.definition, 'new');
  assert.equal(updated.term, 'API');
  assert.equal((await call('PUT', '/api/terms/unknown1', { definition: 'x' })).status, 404);
  assert.equal((await call('PUT', `/api/terms/${created.id}`, {})).status, 400);
});

test('DELETE needs the admin key', async (t) => {
  const { call } = await start(t);
  const created = await (await call('POST', '/api/terms', { term: 'Gone', definition: 'x' })).json();
  const url = `/api/terms/${created.id}`;
  assert.equal((await call('DELETE', url)).status, 403);
  assert.equal((await call('DELETE', url, undefined, { 'x-admin-key': 'wrong' })).status, 403);
  assert.equal((await call('DELETE', url, undefined, { 'x-admin-key': ADMIN_KEY + 'x' })).status, 403);
  assert.equal((await (await call('GET', '/api/terms')).json()).terms.length, 1);
  assert.equal((await call('DELETE', url, undefined, { 'x-admin-key': ADMIN_KEY })).status, 204);
  assert.equal((await (await call('GET', '/api/terms')).json()).terms.length, 0);
  assert.equal((await call('DELETE', url, undefined, { 'x-admin-key': ADMIN_KEY })).status, 404);
});

test('DELETE is disabled when ADMIN_KEY is not configured', async (t) => {
  const { call } = await start(t, { adminKey: '' });
  const created = await (await call('POST', '/api/terms', { term: 'Stay', definition: 'x' })).json();
  for (const key of [undefined, '', 'anything']) {
    const res = await call('DELETE', `/api/terms/${created.id}`, undefined, key === undefined ? {} : { 'x-admin-key': key });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /ADMIN_KEY/);
  }
  assert.equal((await (await call('GET', '/api/terms')).json()).terms.length, 1);
});

test('writes are rate limited per client ip (last X-Forwarded-For entry)', async (t) => {
  const { call } = await start(t, { writeLimit: { max: 3, windowMs: 60_000 } });
  const post = (n, xff) => call('POST', '/api/terms', { term: `t${n}`, definition: 'x' }, { 'x-forwarded-for': xff });
  for (let i = 0; i < 3; i++) assert.equal((await post(i, '9.9.9.9')).status, 201);
  const limited = await post(3, '9.9.9.9');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  // A spoofed leading entry does not create a fresh allowance.
  assert.equal((await post(4, '1.2.3.4, 9.9.9.9')).status, 429);
  // Another real client is unaffected, and reads are never limited.
  assert.equal((await post(5, '8.8.8.8')).status, 201);
  assert.equal((await call('GET', '/api/terms', undefined, { 'x-forwarded-for': '9.9.9.9' })).status, 200);
});

test('failed admin-key guesses count against the rate limit', async (t) => {
  const { call } = await start(t, { writeLimit: { max: 2, windowMs: 60_000 } });
  const del = () => call('DELETE', '/api/terms/abcdefgh', undefined, { 'x-admin-key': 'guess', 'x-forwarded-for': '7.7.7.7' });
  assert.equal((await del()).status, 403);
  assert.equal((await del()).status, 403);
  assert.equal((await del()).status, 429);
});

test('unknown paths give 404, wrong methods give 405 with Allow', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('GET', '/nope')).status, 404);
  const api404 = await call('GET', '/api/nope');
  assert.equal(api404.status, 404);
  assert.ok((await api404.json()).error);
  assert.equal((await call('GET', '/api/terms/%E0%A4%A')).status, 404); // malformed escape
  const put = await call('PUT', '/api/terms', {});
  assert.equal(put.status, 405);
  assert.match(put.headers.get('allow'), /GET/);
  assert.equal((await call('POST', '/')).status, 405);
  assert.equal((await call('GET', '/api/terms/abcdefgh')).status, 405);
});

test('query strings do not break routing', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('GET', '/?utm=1')).status, 200);
  assert.equal((await call('GET', '/api/terms?x=1')).status, 200);
});

test('internal errors return a generic 500 without leaking details', async (t) => {
  const { call, store } = await start(t);
  store.add = async () => { throw new Error('secret disk path /data/x'); };
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const res = await call('POST', '/api/terms', { term: 'a', definition: 'b' });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /secret/);
  assert.match(JSON.parse(text).error, /server error/i);
});

test('serves the vendored Teams SDK from our own origin with long-lived caching', async (t) => {
  const { base, call } = await start(t);
  const vendored = fs.readdirSync(path.join(__dirname, '..', 'public', 'vendor')).filter((n) => n.endsWith('.js'));
  assert.equal(vendored.length, 1, 'exactly one vendored script expected');
  const res = await call('GET', `/vendor/${vendored[0]}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
  assert.match(res.headers.get('cache-control'), /max-age=\d+.*immutable/);
  assert.match(await res.text(), /microsoftTeams/);
  assert.equal((await call('GET', `/vendor/${vendored[0]}`, undefined, { 'if-none-match': res.headers.get('etag') })).status, 304);
  const gz = await rawRequest(`${base}/vendor/${vendored[0]}`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.ok(gz.body.length < 120 * 1024, 'gzipped SDK should be small');
});

test('vendor route only serves known files (no path traversal)', async (t) => {
  const { base, call } = await start(t);
  assert.equal((await call('GET', '/vendor/nope.js')).status, 404);
  for (const p of ['/vendor/%2e%2e/server.js', '/vendor/..%2fserver.js', '/vendor/../server.js', '/vendor/']) {
    const res = await rawRequest(`${base}${p}`, {});
    assert.equal(res.status, 404, p);
  }
  assert.equal((await call('POST', '/vendor/anything.js', {})).status, 404);
});

test('CSP allows scripts from our own origin (for the SDK) but nothing external', async (t) => {
  const { call } = await start(t);
  const csp = (await call('GET', '/')).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'unsafe-inline'(;|$)/);
  assert.doesNotMatch(csp, /https?:\/\/[^ ;]*(cdn|unpkg|jsdelivr)/i);
  assert.match(csp, /default-src 'none'/);
});

test('keep-alive outlasts typical proxy idle timeouts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossar-ka-'));
  const store = new Store(dir);
  store.load();
  const indexPath = path.join(dir, 'index.html');
  fs.writeFileSync(indexPath, 'x');
  const server = createApp({ store, adminKey: '', frameAncestors: [TEAMS], indexPath });
  t.after(() => server.close());
  assert.ok(server.keepAliveTimeout >= 60_000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
});
