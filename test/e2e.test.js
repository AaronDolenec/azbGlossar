'use strict';
// Drives the real page in headless Chrome/Edge over the DevTools protocol.
// No dependencies: uses Node's built-in WebSocket. Skipped if no browser is
// found. Set BROWSER_PATH to point at one, E2E_SCREENSHOTS=<dir> to keep PNGs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { createApp } = require('../src/app');

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const browserPath = CANDIDATES.find((p) => fs.existsSync(p));
const skip = browserPath ? false : 'no Chrome/Edge found (set BROWSER_PATH)';

const ADMIN_KEY = 'e2e-admin-key-1234567';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.problems = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (p) (msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.problems.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async waitFor(expression, what, timeout = 5000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await this.eval(expression);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  }

  async resize(width, height = 900) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await this.waitFor(`window.innerWidth === ${width}`, `the viewport to become ${width}px wide`, 10000);
    // Two frames, so layout has settled before anything is measured. The
    // fallback timer covers a page that is not being painted.
    await this.eval('new Promise((resolve) => { const t = setTimeout(resolve, 400); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); resolve(); })); })');
  }

  async shot(name) {
    if (!process.env.E2E_SCREENSHOTS) return;
    fs.mkdirSync(process.env.E2E_SCREENSHOTS, { recursive: true });
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.E2E_SCREENSHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  }
}

const ctx = {};

async function launchBrowser() {
  ctx.child?.kill();
  ctx.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'glossar-browser-'));
  let stderr = '';
  ctx.child = spawn(browserPath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${ctx.profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  ctx.child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1500); });
  const portFile = path.join(ctx.profile, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !fs.existsSync(portFile) && ctx.child.exitCode === null; i++) await sleep(100);
  if (!fs.existsSync(portFile)) {
    throw new Error(`the browser did not start (exit code ${ctx.child.exitCode}). Its output: ${stderr || '(none)'}`);
  }
  const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
  for (let i = 0; i < 100; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((t) => t.type === 'page');
    if (target) return { port, target };
    await sleep(100);
  }
  throw new Error(`the browser started but opened no page. Its output: ${stderr || '(none)'}`);
}

test.before(async () => {
  if (skip) return;
  // A server with 40 seeded terms.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossar-e2e-'));
  const store = new Store(dir);
  store.load();
  for (let i = 0; i < 40; i++) {
    const letter = String.fromCharCode(65 + (i % 26));
    await store.add({ term: `${letter}term ${i}`, definition: `Definition of ${letter}term ${i}.\nSecond line.` });
  }
  const server = createApp({ store, adminKey: ADMIN_KEY, frameAncestors: ['https://teams.microsoft.com'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ctx.store = store;
  ctx.server = server;
  ctx.url = `http://127.0.0.1:${server.address().port}/`;

  // A headless browser with a throwaway profile. Cold starts can be slow on a
  // busy machine, so be patient and try once more before giving up.
  let target;
  let port;
  for (let attempt = 1; !target; attempt++) {
    try {
      ({ port, target } = await launchBrowser());
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ctx.cdp = new Cdp(ws);
  await ctx.cdp.send('Runtime.enable');
  await ctx.cdp.send('Log.enable');
  await ctx.cdp.send('Page.enable');
  await ctx.cdp.resize(1600);
  await ctx.cdp.send('Page.navigate', { url: ctx.url });
  await ctx.cdp.waitFor("document.querySelectorAll('.term-btn').length > 0", 'the list to render', 20000);
});

test.after(async () => {
  if (skip) return;
  // Tolerate a partially failed setup: clean up whatever was started.
  try { ctx.cdp?.ws.close(); } catch { /* already closed */ }
  ctx.child?.kill();
  await sleep(300);
  if (ctx.profile) fs.rmSync(ctx.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (ctx.server) {
    ctx.server.closeAllConnections();
    await new Promise((resolve) => ctx.server.close(resolve));
  }
});

const columnsScript = "new Set([...document.querySelectorAll('.term')].map(t => t.offsetLeft)).size";
const noOverflowScript = 'document.documentElement.scrollWidth <= window.innerWidth';

test('shows the AZB-Glossar name and a working icon', { skip }, async () => {
  const { cdp } = ctx;
  assert.equal(await cdp.eval('document.title'), 'AZB-Glossar');
  assert.equal(await cdp.eval("document.querySelector('h1').textContent"), 'AZB-Glossar');
  // The icon must decode as an image under the page's own CSP.
  const size = await cdp.eval(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
    img.onerror = () => resolve(null);
    img.src = document.querySelector('link[rel=icon]').href;
  })`);
  assert.ok(size && size[0] > 0 && size[1] > 0, 'favicon did not load');
  // The Teams SDK is not fetched on a normal, unframed visit.
  assert.equal(await cdp.eval("typeof window.microsoftTeams"), 'undefined');
});

test('lists every term, grouped under letter dividers', { skip }, async () => {
  const { cdp } = ctx;
  assert.equal(await cdp.eval("document.querySelectorAll('.term-btn').length"), 40);
  assert.equal(await cdp.eval("document.getElementById('count').textContent"), '40 terms');
  const letters = await cdp.eval("[...document.querySelectorAll('.letter')].map(h => h.textContent)");
  assert.deepEqual(letters, [...letters].sort());
  assert.equal(letters[0], 'A');
});

test('uses the full width on a wide desktop tab (multiple columns)', { skip }, async () => {
  const { cdp } = ctx;
  await cdp.resize(1600);
  assert.ok(await cdp.eval(columnsScript) >= 3, 'expected at least 3 columns at 1600px');
  assert.ok(await cdp.eval(noOverflowScript));
  await cdp.shot('wide-1600');
  await cdp.resize(1000);
  const mid = await cdp.eval(columnsScript);
  assert.ok(mid >= 2 && mid <= 3, `expected 2-3 columns at 1000px, got ${mid}`);
  assert.ok(await cdp.eval(noOverflowScript));
  await cdp.shot('medium-1000');
});

test('collapses to one column on a phone-width tab without horizontal scroll', { skip }, async () => {
  const { cdp } = ctx;
  await cdp.resize(400, 800);
  assert.equal(await cdp.eval(columnsScript), 1);
  assert.ok(await cdp.eval(noOverflowScript));
  await cdp.shot('narrow-400');
  await cdp.resize(320, 700);
  assert.ok(await cdp.eval(noOverflowScript));
  await cdp.resize(1600);
});

test('clicking a term shows its explanation, clicking again hides it', { skip }, async () => {
  const { cdp } = ctx;
  const first = "document.querySelector('.term')";
  assert.equal(await cdp.eval(`${first}.querySelector('.def').hidden`), true);
  await cdp.eval(`${first}.querySelector('.term-btn').click()`);
  assert.equal(await cdp.eval(`${first}.querySelector('.term-btn').getAttribute('aria-expanded')`), 'true');
  assert.equal(await cdp.eval(`${first}.querySelector('.def').hidden`), false);
  assert.match(await cdp.eval(`${first}.querySelector('.text').textContent`), /Definition of Aterm 0\.\nSecond line\./);
  await cdp.shot('expanded');
  await cdp.eval(`${first}.querySelector('.term-btn').click()`);
  assert.equal(await cdp.eval(`${first}.querySelector('.def').hidden`), true);
});

test('several terms can be open at once', { skip }, async () => {
  const { cdp } = ctx;
  await cdp.eval("document.querySelectorAll('.term-btn')[0].click(); document.querySelectorAll('.term-btn')[1].click();");
  assert.equal(await cdp.eval("document.querySelectorAll('.term-btn[aria-expanded=\"true\"]').length"), 2);
  await cdp.eval("document.querySelectorAll('.term-btn[aria-expanded=\"true\"]').forEach(b => b.click())");
});

test('filter narrows the list and Escape clears it', { skip }, async () => {
  const { cdp } = ctx;
  const type = (v) => cdp.eval(`(() => { const f = document.getElementById('filter'); f.value = ${JSON.stringify(v)}; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await type('bterm');
  await cdp.waitFor("document.querySelectorAll('.term-btn').length === 2", 'filtered list');
  assert.equal(await cdp.eval("document.getElementById('count').textContent"), '2 of 40');
  await type('zzz-nothing');
  await cdp.waitFor("document.querySelector('.empty')", 'empty message');
  assert.match(await cdp.eval("document.querySelector('.empty').textContent"), /No terms match/);
  await cdp.eval("document.getElementById('filter').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await cdp.waitFor("document.querySelectorAll('.term-btn').length === 40", 'full list again');
});

const openCount = "document.querySelectorAll('.term-btn[aria-expanded=\"true\"]').length";
const zebraItem = "[...document.querySelectorAll('.term')].find(t => t.textContent.startsWith('Zebra'))";

test('adding a term: everything stays folded, the new term is highlighted and on screen; user text is never run as HTML', { skip }, async () => {
  const { cdp } = ctx;
  // Something is open before adding, to prove it gets folded.
  await cdp.eval("document.querySelectorAll('.term-btn')[3].click()");
  assert.equal(await cdp.eval(openCount), 1);
  await cdp.eval("document.getElementById('add').click()");
  await cdp.waitFor("!document.getElementById('editor').hidden", 'add form');
  await cdp.eval(`(() => {
    const f = document.querySelector('#editor form');
    f.term.value = 'Zebra <img src=x onerror="window.__pwned=1">';
    f.definition.value = 'Line one\\nLine <script>window.__pwned=2<\\/script>';
    f.querySelector('[type=submit]').click();
  })()`);
  await cdp.waitFor("[...document.querySelectorAll('.term-btn')].some(b => b.textContent.startsWith('Zebra'))", 'new term');
  assert.equal(await cdp.eval('window.__pwned'), undefined);
  assert.equal(await cdp.eval("document.querySelectorAll('.term img, .term script').length"), 0);
  const shown = await cdp.eval(`(() => {
    const item = [...document.querySelectorAll('.term')].find(t => t.textContent.startsWith('Zebra'));
    return { open: item.querySelector('.term-btn').getAttribute('aria-expanded'), text: item.querySelector('.text').textContent };
  })()`);
  assert.equal(shown.open, 'false', 'the new term is folded');
  assert.equal(await cdp.eval(openCount), 0, 'nothing is left open after adding');
  assert.match(shown.text, /<script>window\.__pwned=2<\/script>/);
  assert.ok(await cdp.eval("document.getElementById('editor').hidden"));
  assert.equal(ctx.store.list().length, 41);
  assert.ok(await cdp.eval(`!!${zebraItem}.classList.contains('flash')`), 'the new term is briefly highlighted');
  assert.ok(await cdp.eval(`(() => { const r = ${zebraItem}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()`),
    'the new term is scrolled into view');
  await cdp.shot('after-add');
  // The highlight is only a moment long.
  await cdp.waitFor('!document.querySelector(".term.flash")', 'the highlight to fade', 6000);
});

test('adding a duplicate keeps the form open and explains why', { skip }, async () => {
  const { cdp } = ctx;
  await cdp.eval("document.getElementById('add').click()");
  await cdp.eval(`(() => {
    const f = document.querySelector('#editor form');
    f.term.value = 'aterm 0';
    f.definition.value = 'again';
    f.querySelector('[type=submit]').click();
  })()`);
  await cdp.waitFor("document.querySelector('#editor .form-msg').textContent.length > 0", 'error message');
  assert.match(await cdp.eval("document.querySelector('#editor .form-msg').textContent"), /already/);
  assert.equal(await cdp.eval("document.querySelector('#editor form').definition.value"), 'again');
  await cdp.eval("document.querySelector('#editor form').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  assert.ok(await cdp.eval("document.getElementById('editor').hidden"));
});

test('empty fields are caught before any request', { skip }, async () => {
  const { cdp } = ctx;
  await cdp.eval("document.getElementById('add').click()");
  await cdp.eval("document.querySelector('#editor [type=submit]').click()");
  assert.match(await cdp.eval("document.querySelector('#editor .form-msg').textContent"), /enter a term/i);
  await cdp.eval("document.querySelector('#editor form').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
});

test('the header has "+ Add term" on the left and the filter on the right', { skip }, async () => {
  const { cdp } = ctx;
  const boxes = `(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const pick = (b) => ({ left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), width: Math.round(b.width) });
    return { title: pick(r('h1')), add: pick(r('#add')), filter: pick(r('#filter')), vw: document.documentElement.clientWidth };
  })()`;
  await cdp.resize(1600);
  let b = await cdp.eval(boxes);
  assert.ok(b.title.right <= b.add.left, `the Add button follows the title ${JSON.stringify(b)}`);
  assert.ok(b.add.right < b.filter.left, `the Add button is left of the filter ${JSON.stringify(b)}`);
  assert.ok(b.vw - b.filter.right < 60, `the filter is pushed to the right edge (gap ${b.vw - b.filter.right}px)`);
  assert.ok(b.add.left < 300, 'the Add button sits at the left');
  await cdp.shot('header-wide');

  await cdp.resize(400, 800);
  b = await cdp.eval(boxes);
  assert.ok(b.add.right <= b.filter.left, `on a phone the Add button is still left of the filter ${JSON.stringify(b)}`);
  assert.ok(Math.abs(b.add.top - b.filter.top) < 20, 'and they share one row');
  assert.ok(b.filter.width >= 100, 'the filter keeps a usable width');
  assert.ok(await cdp.eval(noOverflowScript));
  await cdp.shot('header-narrow');
  await cdp.resize(1600);
});

test('coming back to the page folds everything, but never discards unsaved text', { skip }, async () => {
  const { cdp } = ctx;
  const comeBack = () => cdp.eval("document.dispatchEvent(new Event('visibilitychange'))");

  // Two terms open, then the tab is shown again.
  await cdp.eval("document.querySelectorAll('.term-btn')[0].click(); document.querySelectorAll('.term-btn')[1].click();");
  assert.equal(await cdp.eval(openCount), 2);
  await comeBack();
  assert.equal(await cdp.eval(openCount), 0, 'visibilitychange folds everything');
  assert.equal(await cdp.eval("document.querySelectorAll('.def:not([hidden])').length"), 0);

  // Restored from the browser's back/forward cache.
  await cdp.eval("document.querySelectorAll('.term-btn')[2].click()");
  await cdp.eval("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
  assert.equal(await cdp.eval(openCount), 0, 'a page restored from cache folds everything');

  // A normal pageshow (fresh load) must not do anything surprising.
  await cdp.eval("document.querySelectorAll('.term-btn')[2].click()");
  await cdp.eval("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))");
  assert.equal(await cdp.eval(openCount), 1);
  await cdp.eval("document.querySelectorAll('.term-btn')[2].click()");

  // An empty add form is tidied away; one with typed text is kept, text intact.
  await cdp.eval("document.getElementById('add').click()");
  assert.equal(await cdp.eval("document.getElementById('editor').hidden"), false);
  await comeBack();
  assert.equal(await cdp.eval("document.getElementById('editor').hidden"), true, 'an untouched form is closed');
  await cdp.eval("document.getElementById('add').click()");
  await cdp.eval("document.querySelector('#editor form').term.value = 'Half typed'");
  await comeBack();
  assert.equal(await cdp.eval("document.getElementById('editor').hidden"), false, 'a form with text stays');
  assert.equal(await cdp.eval("document.querySelector('#editor form').term.value"), 'Half typed');
  await cdp.eval("document.querySelector('#editor form').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

  // An edit with unsaved changes stays open; an untouched edit form is closed.
  await cdp.eval("document.querySelector('.term-btn').click(); document.querySelector('.term [data-act=edit]').click();");
  assert.ok(await cdp.eval("!!document.querySelector('.term form')"));
  await comeBack();
  assert.equal(await cdp.eval("!!document.querySelector('.term form')"), false, 'an untouched edit form is closed');
  await cdp.eval("document.querySelector('.term-btn').click(); document.querySelector('.term [data-act=edit]').click();");
  await cdp.eval("document.querySelector('.term form').definition.value = 'unsaved change'");
  await comeBack();
  assert.equal(await cdp.eval("document.querySelector('.term form').definition.value"), 'unsaved change', 'unsaved edit is kept');
  assert.equal(await cdp.eval("document.querySelector('.term form').closest('.def').hidden"), false, 'and stays visible');
  await cdp.eval("document.querySelector('.term form').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await comeBack();
  assert.equal(await cdp.eval(openCount), 0);
});

test('reopening the page starts with everything folded', { skip }, async () => {
  const { cdp } = ctx;
  await cdp.eval("document.querySelectorAll('.term-btn')[4].click()");
  assert.equal(await cdp.eval(openCount), 1);
  await cdp.send('Page.reload');
  await cdp.waitFor("document.querySelectorAll('.term-btn').length > 0", 'the list after reload');
  assert.equal(await cdp.eval(openCount), 0);
  assert.equal(await cdp.eval("document.querySelectorAll('.def:not([hidden])').length"), 0);
});

test('editing a term updates its explanation and leaves everything folded', { skip }, async () => {
  const { cdp } = ctx;
  const zebra = zebraItem;
  await cdp.eval(`${zebra}.querySelector('.term-btn').click()`);
  await cdp.eval(`${zebra}.querySelector('[data-act=edit]').click()`);
  await cdp.waitFor(`${zebra}.querySelector('form')`, 'edit form');
  await cdp.eval(`(() => {
    const f = ${zebra}.querySelector('form');
    f.definition.value = 'Edited explanation';
    f.querySelector('[type=submit]').click();
  })()`);
  await cdp.waitFor(`${zebra}.querySelector('.text') && ${zebra}.querySelector('.text').textContent === 'Edited explanation'`, 'edited text');
  assert.equal(ctx.store.list().find((t) => t.term.startsWith('Zebra')).definition, 'Edited explanation');
  assert.equal(await cdp.eval(`${zebra}.querySelector('.term-btn').getAttribute('aria-expanded')`), 'false', 'folded after saving');
  assert.equal(await cdp.eval(openCount), 0);
  assert.ok(await cdp.eval(`${zebra}.classList.contains('flash')`), 'briefly highlighted');
});

test('deleting needs the admin key', { skip }, async () => {
  const { cdp } = ctx;
  const zebra = zebraItem;
  await cdp.eval(`${zebra}.querySelector('.term-btn').click()`);
  await cdp.eval(`${zebra}.querySelector('[data-act=edit]').click()`);
  await cdp.waitFor(`${zebra}.querySelector('form')`, 'edit form');
  await cdp.eval(`${zebra}.querySelector('.danger-outline').click()`);
  assert.equal(await cdp.eval(`${zebra}.querySelector('.delete-box').hidden`), false);
  await cdp.eval(`(() => {
    const box = ${zebra}.querySelector('.delete-box');
    box.querySelector('input').value = 'wrong-key';
    box.querySelector('.danger').click();
  })()`);
  await cdp.waitFor(`${zebra}.querySelector('.form-msg').textContent.length > 0`, 'wrong key message');
  assert.match(await cdp.eval(`${zebra}.querySelector('.form-msg').textContent`), /Wrong admin key/);
  assert.equal(ctx.store.list().length, 41);
  await cdp.eval(`(() => {
    const box = ${zebra}.querySelector('.delete-box');
    box.querySelector('input').value = ${JSON.stringify(ADMIN_KEY)};
    box.querySelector('.danger').click();
  })()`);
  await cdp.waitFor("![...document.querySelectorAll('.term-btn')].some(b => b.textContent.startsWith('Zebra'))", 'term to disappear');
  assert.equal(ctx.store.list().length, 40);
});

test('inside a frame, as in Teams, the page loads the SDK and starts the Teams handshake', { skip }, async () => {
  const { cdp } = ctx;
  // A stand-in Teams host on another origin that frames the page and records
  // the messages the page posts to it.
  const host = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0"><iframe src="${ctx.framedUrl}" style="width:100vw;height:100vh;border:0"></iframe>
      <script>window.__msgs=[];addEventListener('message',function(e){window.__msgs.push(typeof e.data==='string'?e.data:JSON.stringify(e.data))})</script>`);
  });
  await new Promise((resolve) => host.listen(0, resolve));
  const hostOrigin = `http://localhost:${host.address().port}`;
  const framed = createApp({ store: ctx.store, adminKey: ADMIN_KEY, frameAncestors: [hostOrigin] });
  await new Promise((resolve) => framed.listen(0, '127.0.0.1', resolve));
  ctx.framedUrl = `http://127.0.0.1:${framed.address().port}/`;
  try {
    await cdp.send('Page.navigate', { url: `${hostOrigin}/` });
    await cdp.waitFor("window.__msgs && window.__msgs.some(m => m.indexOf('initialize') !== -1)", 'the Teams SDK handshake', 8000);
    assert.ok(true);
    await cdp.shot('framed-in-host');
  } finally {
    framed.closeAllConnections();
    host.closeAllConnections();
    await Promise.all([new Promise((r) => framed.close(r)), new Promise((r) => host.close(r))]);
  }
});

test('the page ran without script errors or CSP violations', { skip }, () => {
  // The browser logs the 409 (duplicate) and 403 (wrong key) responses that
  // the tests above provoke on purpose. Anything else is a real problem.
  const expected = /Failed to load resource: the server responded with a status of (403|409)/;
  assert.deepEqual(ctx.cdp.problems.filter((p) => !expected.test(p)), []);
});
