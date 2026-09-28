'use strict';
// Static checks on public/index.html (fast; the real-browser checks are in e2e.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

test('the page is called AZB-Glossar (tab title and heading)', () => {
  assert.match(html, /<title>AZB-Glossar<\/title>/);
  assert.match(html, /<h1>AZB-Glossar<\/h1>/);
  assert.doesNotMatch(html, /<h1>Glossary<\/h1>/);
});

test('the page has a real icon, not an empty placeholder', () => {
  const icon = /<link rel="icon"[^>]*href="([^"]+)"/.exec(html);
  assert.ok(icon, 'no <link rel="icon">');
  assert.match(icon[1], /^data:image\/svg\+xml,/);
  const svg = decodeURIComponent(icon[1].replace(/^data:image\/svg\+xml,/, ''));
  assert.match(svg, /^<svg[^>]+xmlns='http:\/\/www\.w3\.org\/2000\/svg'/);
  assert.match(svg, />AZB</);
  assert.doesNotMatch(html, /href="data:,"/);
});

test('the Teams SDK is referenced from our own origin and the file exists', () => {
  const refs = html.match(/\/vendor\/[\w.-]+\.js/g) || [];
  assert.deepEqual([...new Set(refs)].length, 1, 'exactly one vendored script is referenced');
  assert.ok(fs.existsSync(path.join(publicDir, refs[0])), `${refs[0]} is missing`);
  // The SDK is only fetched when the page runs inside a frame (Teams), never
  // as a blocking <script> tag on every visit.
  assert.doesNotMatch(html, /<script[^>]+src=/);
});

test('the page loads nothing from other origins', () => {
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/i);
  assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i);
});
