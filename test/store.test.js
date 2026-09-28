'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, HttpError, LIMITS } = require('../src/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glossar-'));
}

function newStore(dir = tmpDir(), opts) {
  const store = new Store(dir, opts);
  store.load();
  return store;
}

async function rejectsWith(promise, status, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${err}`);
    assert.equal(err.status, status, err.message);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

test('starts empty and creates the data file', () => {
  const dir = tmpDir();
  const store = newStore(dir);
  assert.deepEqual(store.list(), []);
  assert.ok(fs.existsSync(path.join(dir, 'glossary.json')));
});

test('add trims input, assigns id and timestamps', async () => {
  const store = newStore();
  const t = await store.add({ term: '  SLA  ', definition: '  Service level agreement \r\n second line ' });
  assert.equal(t.term, 'SLA');
  assert.equal(t.definition, 'Service level agreement\n second line');
  assert.match(t.id, /^[A-Za-z0-9_-]{8}$/);
  assert.ok(t.createdAt && t.updatedAt);
  assert.deepEqual(store.list(), [t]);
});

test('term whitespace is collapsed to single spaces', async () => {
  const store = newStore();
  const t = await store.add({ term: 'Root   cause\tanalysis', definition: 'x' });
  assert.equal(t.term, 'Root cause analysis');
});

test('list is sorted alphabetically, ignoring case', async () => {
  const store = newStore();
  await store.add({ term: 'zebra', definition: 'z' });
  await store.add({ term: 'Apple', definition: 'a' });
  await store.add({ term: 'mango', definition: 'm' });
  assert.deepEqual(store.list().map((t) => t.term), ['Apple', 'mango', 'zebra']);
});

test('rejects non-object bodies and non-string fields', async () => {
  const store = newStore();
  await rejectsWith(store.add(null), 400);
  await rejectsWith(store.add([]), 400);
  await rejectsWith(store.add('x'), 400);
  await rejectsWith(store.add({ term: 5, definition: 'x' }), 400, /term/);
  await rejectsWith(store.add({ term: 'x', definition: {} }), 400, /explanation/);
});

test('rejects empty and whitespace-only fields', async () => {
  const store = newStore();
  await rejectsWith(store.add({ term: '   ', definition: 'x' }), 400, /term/);
  await rejectsWith(store.add({ term: 'x', definition: '  \n ' }), 400, /explanation/);
  await rejectsWith(store.add({ definition: 'x' }), 400, /term/);
});

test('enforces length limits by characters, not bytes', async () => {
  const store = newStore();
  await store.add({ term: 'é'.repeat(LIMITS.term), definition: 'x' });
  await rejectsWith(store.add({ term: 'a'.repeat(LIMITS.term + 1), definition: 'x' }), 400, /at most/);
  await store.add({ term: 'ok', definition: '😀'.repeat(LIMITS.definition) });
  await rejectsWith(store.add({ term: 'ok2', definition: 'a'.repeat(LIMITS.definition + 1) }), 400, /at most/);
});

test('rejects control characters', async () => {
  const store = newStore();
  await rejectsWith(store.add({ term: 'bad\u0000term', definition: 'x' }), 400, /control/);
  await rejectsWith(store.add({ term: 'ok', definition: 'bad\u0007text' }), 400, /control/);
});

test('rejects duplicates ignoring case and accents', async () => {
  const store = newStore();
  await store.add({ term: 'Café', definition: 'x' });
  await rejectsWith(store.add({ term: 'cafe', definition: 'y' }), 409, /already/);
  await rejectsWith(store.add({ term: '  CAFÉ ', definition: 'y' }), 409, /already/);
});

test('enforces the maximum number of terms', async () => {
  const dir = tmpDir();
  const terms = Array.from({ length: LIMITS.maxTerms }, (_, i) => ({
    id: `id${i}`.padEnd(8, '_'), term: `t${i}`, definition: 'x', createdAt: 'x', updatedAt: 'x',
  }));
  fs.writeFileSync(path.join(dir, 'glossary.json'), JSON.stringify({ version: 1, terms }));
  const store = newStore(dir);
  await rejectsWith(store.add({ term: 'one more', definition: 'x' }), 409, /full/);
});

test('update changes fields, keeps others, bumps updatedAt', async () => {
  let clock = new Date('2026-01-01T00:00:00Z');
  const store = newStore(tmpDir(), { now: () => clock });
  const t = await store.add({ term: 'API', definition: 'old' });
  clock = new Date('2026-01-02T00:00:00Z');
  const u = await store.update(t.id, { definition: 'new' });
  assert.equal(u.term, 'API');
  assert.equal(u.definition, 'new');
  assert.equal(u.createdAt, t.createdAt);
  assert.equal(u.updatedAt, '2026-01-02T00:00:00.000Z');
  const renamed = await store.update(t.id, { term: 'REST API' });
  assert.equal(renamed.term, 'REST API');
  assert.equal(renamed.definition, 'new');
});

test('update validates, needs a field, 404s on unknown id, checks duplicates', async () => {
  const store = newStore();
  const a = await store.add({ term: 'A', definition: 'a' });
  await store.add({ term: 'B', definition: 'b' });
  await rejectsWith(store.update(a.id, {}), 400, /nothing to update/i);
  await rejectsWith(store.update(a.id, { term: '' }), 400, /term/);
  await rejectsWith(store.update('nope1234', { term: 'C' }), 404);
  await rejectsWith(store.update(a.id, { term: 'b' }), 409, /already/);
  // renaming to itself (case change only) is fine
  const same = await store.update(a.id, { term: 'a' });
  assert.equal(same.term, 'a');
});

test('remove deletes and 404s on unknown id', async () => {
  const store = newStore();
  const t = await store.add({ term: 'X', definition: 'x' });
  await store.remove(t.id);
  assert.deepEqual(store.list(), []);
  await rejectsWith(store.remove(t.id), 404);
});

test('data survives a restart', async () => {
  const dir = tmpDir();
  const first = newStore(dir);
  const t = await first.add({ term: 'Persist', definition: 'me' });
  const second = newStore(dir);
  assert.deepEqual(second.list(), [t]);
});

test('concurrent adds are all kept (writes are serialised)', async () => {
  const dir = tmpDir();
  const store = newStore(dir);
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.add({ term: `term ${i}`, definition: 'x' })));
  assert.equal(store.list().length, 25);
  assert.equal(newStore(dir).list().length, 25);
});

test('failed writes do not change memory and do not poison the queue', async () => {
  const dir = tmpDir();
  const store = newStore(dir);
  await store.add({ term: 'keep', definition: 'x' });
  // Make the temp file path a directory so the write fails.
  fs.mkdirSync(path.join(dir, 'glossary.json.tmp'));
  await assert.rejects(store.add({ term: 'lost', definition: 'x' }));
  assert.deepEqual(store.list().map((t) => t.term), ['keep']);
  fs.rmdirSync(path.join(dir, 'glossary.json.tmp'));
  await store.add({ term: 'after', definition: 'x' });
  assert.deepEqual(store.list().map((t) => t.term), ['after', 'keep']);
});

test('retries a transient rename failure (EPERM/EBUSY from antivirus or network volumes)', async (t) => {
  const fsp = require('node:fs/promises');
  const realRename = fsp.rename;
  let calls = 0;
  t.mock.method(fsp, 'rename', async (...args) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    return realRename(...args);
  });
  const dir = tmpDir();
  const store = newStore(dir);
  await store.add({ term: 'Flaky', definition: 'disk' });
  assert.equal(calls, 3);
  assert.equal(newStore(dir).list()[0].term, 'Flaky');
});

test('gives up on a persistent rename failure and keeps memory unchanged', async (t) => {
  const fsp = require('node:fs/promises');
  t.mock.method(fsp, 'rename', async () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  });
  const store = newStore();
  await assert.rejects(store.add({ term: 'Nope', definition: 'x' }), /busy/);
  assert.deepEqual(store.list(), []);
});

test('refuses to start on a corrupt file and leaves it untouched', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'glossary.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => new Store(dir).load(), /glossary\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('refuses to start on a wrongly shaped file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'glossary.json'), JSON.stringify({ version: 1, terms: [{ id: 1 }] }));
  assert.throws(() => new Store(dir).load(), /glossary\.json/);
  fs.writeFileSync(path.join(dir, 'glossary.json'), JSON.stringify({ version: 2, terms: [] }));
  assert.throws(() => new Store(dir).load(), /version/);
});

test('writes one backup per UTC day (pre-write state) and keeps the newest 14', async () => {
  const dir = tmpDir();
  let clock = new Date('2026-03-01T10:00:00Z');
  const store = newStore(dir, { now: () => clock });
  await store.add({ term: 'first', definition: 'x' });
  const backups = () => fs.readdirSync(path.join(dir, 'backups')).sort();
  assert.deepEqual(backups(), ['glossary-2026-03-01.json']);
  await store.add({ term: 'second', definition: 'x' }); // same day: no new backup
  assert.deepEqual(backups(), ['glossary-2026-03-01.json']);
  // The day's backup holds the state before that day's first write (empty).
  const day1 = JSON.parse(fs.readFileSync(path.join(dir, 'backups', 'glossary-2026-03-01.json'), 'utf8'));
  assert.deepEqual(day1.terms, []);

  for (let d = 2; d <= 20; d++) {
    clock = new Date(Date.UTC(2026, 2, d, 10));
    await store.add({ term: `day ${d}`, definition: 'x' });
  }
  const kept = backups();
  assert.equal(kept.length, 14);
  assert.equal(kept[0], 'glossary-2026-03-07.json');
  assert.equal(kept[13], 'glossary-2026-03-20.json');
});

test('snapshot exposes a stable body and an etag that changes with the data', async () => {
  const dir = tmpDir();
  const store = newStore(dir);
  const empty = store.snapshot();
  assert.equal(JSON.parse(empty.body).terms.length, 0);
  assert.match(empty.etag, /^"[A-Za-z0-9_-]+"$/);
  assert.equal(store.snapshot(), empty); // cached object while nothing changed
  await store.add({ term: 'A', definition: 'a' });
  const one = store.snapshot();
  assert.notEqual(one.etag, empty.etag);
  // Same data after a restart gives the same etag (safe for browser caches).
  assert.equal(newStore(dir).snapshot().etag, one.etag);
});
