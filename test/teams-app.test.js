'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createZip } = require('../scripts/zip');
const { buildManifest, buildPackage, validateManifest } = require('../scripts/build-teams-app');

const URL_IN = 'https://glossar.example.com';

// ---- independent readers (deliberately not sharing code with the writer) ----
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'bad central header');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'bad local header');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(data.length, usize, `${name}: size mismatch`);
    assert.equal(zlib.crc32(data), crc, `${name}: crc mismatch`);
    files[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function readPng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'not a PNG');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const [bitDepth, colorType, , , interlace] = [buf[24], buf[25], buf[26], buf[27], buf[28]];
  assert.equal(bitDepth, 8);
  assert.equal(interlace, 0);
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p);
    if (buf.toString('latin1', p + 4, p + 8) === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const data = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const raw = data[y * (stride + 1) + 1 + x];
      const left = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[(y - 1) * stride + x - bpp] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(up - upLeft);
        const pb = Math.abs(left - upLeft);
        const pc = Math.abs(left + up - 2 * upLeft);
        add = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
      }
      pixels[y * stride + x] = (raw + add) & 255;
    }
  }
  return { width, height, colorType, bpp, pixels };
}

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glossar-teams-')), name);
}

// ---- zip writer ------------------------------------------------------------
test('createZip round-trips files with valid sizes and CRCs', () => {
  const zip = createZip([
    { name: 'a.txt', data: Buffer.from('hello hello hello hello') },
    { name: 'dir/ü.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ]);
  const files = readZip(zip);
  assert.deepEqual(Object.keys(files), ['a.txt', 'dir/ü.bin', 'empty.txt']);
  assert.equal(files['a.txt'].toString(), 'hello hello hello hello');
  assert.deepEqual([...files['dir/ü.bin']], [0, 1, 2, 3, 255]);
  assert.equal(files['empty.txt'].length, 0);
});

// ---- manifest --------------------------------------------------------------
test('manifest points the tab at the app URL and allows its domain', () => {
  const m = buildManifest(URL_IN);
  const tab = m.staticTabs[0];
  assert.equal(tab.contentUrl, 'https://glossar.example.com/');
  assert.equal(tab.websiteUrl, 'https://glossar.example.com/');
  assert.deepEqual(m.validDomains, ['glossar.example.com']);
  assert.ok(tab.scopes.includes('groupChat'), 'must be usable in group chats');
  assert.ok(tab.context.includes('privateChatTab'));
  assert.equal(m.name.short, 'AZB-Glossar');
  assert.doesNotMatch(JSON.stringify(m), /\{\{/);
});

test('manifest keeps a stable app id and honours the requested version', () => {
  const a = buildManifest(URL_IN);
  const b = buildManifest('https://other.example.org', { version: '1.2.3' });
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(a.id, b.id);
  assert.equal(b.version, '1.2.3');
  assert.throws(() => buildManifest(URL_IN, { version: 'v2' }), /version/i);
});

test('manifest keeps a port and a path in the URL', () => {
  const m = buildManifest('https://glossar.example.com:8443/tabs/glossary');
  assert.equal(m.staticTabs[0].contentUrl, 'https://glossar.example.com:8443/tabs/glossary');
  assert.deepEqual(m.validDomains, ['glossar.example.com:8443']);
});

test('rejects URLs Teams cannot load', () => {
  for (const bad of ['', 'not a url', 'http://glossar.example.com', 'https://localhost', 'https://127.0.0.1:8080',
    'https://user:pw@glossar.example.com', 'ftp://glossar.example.com']) {
    assert.throws(() => buildManifest(bad), /URL/i, JSON.stringify(bad));
  }
});

test('validateManifest enforces the Teams length limits', () => {
  const ok = buildManifest(URL_IN);
  assert.doesNotThrow(() => validateManifest(ok));
  assert.throws(() => validateManifest({ ...ok, name: { short: 'x'.repeat(31), full: 'x' } }), /name\.short/);
  assert.throws(() => validateManifest({ ...ok, description: { short: 'x'.repeat(81), full: 'x' } }), /description\.short/);
  assert.throws(() => validateManifest({ ...ok, id: 'nope' }), /id/);
  assert.throws(() => validateManifest({ ...ok, accentColor: 'blue' }), /accentColor/);
});

// ---- package ---------------------------------------------------------------
test('the package has manifest and icons at the zip root, and the icons meet the Teams rules', () => {
  const out = tmpFile('app.zip');
  buildPackage(URL_IN, { outFile: out });
  const files = readZip(fs.readFileSync(out));
  assert.deepEqual(Object.keys(files).sort(), ['color.png', 'manifest.json', 'outline.png']);
  const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
  assert.equal(manifest.icons.color, 'color.png');
  assert.equal(manifest.icons.outline, 'outline.png');

  const color = readPng(files['color.png']);
  assert.deepEqual([color.width, color.height], [192, 192]);

  const outline = readPng(files['outline.png']);
  assert.deepEqual([outline.width, outline.height], [32, 32]);
  assert.equal(outline.colorType, 6, 'outline icon needs an alpha channel');
  let visible = 0;
  let transparent = 0;
  for (let i = 0; i < outline.pixels.length; i += 4) {
    const [r, g, b, a] = outline.pixels.subarray(i, i + 4);
    if (a === 0) { transparent += 1; continue; }
    visible += 1;
    assert.ok(r >= 250 && g >= 250 && b >= 250, `outline pixel is not white: ${[r, g, b, a]}`);
  }
  assert.ok(transparent > 200, 'outline icon should be mostly transparent');
  assert.ok(visible > 40, 'outline icon should not be empty');
});

test('building twice gives byte-identical packages (reproducible)', () => {
  const a = tmpFile('a.zip');
  const b = tmpFile('b.zip');
  buildPackage(URL_IN, { outFile: a });
  buildPackage(URL_IN, { outFile: b });
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)));
});
