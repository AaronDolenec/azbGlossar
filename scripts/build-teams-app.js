#!/usr/bin/env node
'use strict';
// Builds the Teams app package (a .zip) that wraps the glossary URL so Teams
// shows it inside the chat. Usage:
//   node scripts/build-teams-app.js https://your-public-url [--version 1.0.1] [--out file.zip]
const fs = require('node:fs');
const path = require('node:path');
const { createZip } = require('./zip');

const APP_DIR = path.join(__dirname, '..', 'teams-app');
const DEFAULT_OUT = path.join(__dirname, '..', 'dist', 'azb-glossar-teams.zip');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseAppUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`The app URL is not a valid URL: ${JSON.stringify(input)}`);
  }
  const publicHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname) && !/^\d+(\.\d+){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || !publicHost) {
    throw new Error(`The app URL must be a public https:// address with a domain name, without a login (got ${JSON.stringify(input)})`);
  }
  return url;
}

// Throws if the manifest breaks a Teams limit, so a bad package fails here
// instead of at upload time.
function validateManifest(m) {
  const fail = (what) => { throw new Error(`Invalid manifest: ${what}`); };
  if (!GUID.test(m.id || '')) fail('id must be a GUID');
  if (!/^\d+\.\d+\.\d+$/.test(m.version || '')) fail('version must look like 1.0.0');
  if (!m.name || !m.name.short || m.name.short.length > 30) fail('name.short must be 1-30 characters');
  if (!m.name.full || m.name.full.length > 100) fail('name.full must be 1-100 characters');
  if (!m.description || !m.description.short || m.description.short.length > 80) fail('description.short must be 1-80 characters');
  if (!m.description.full || m.description.full.length > 4000) fail('description.full must be 1-4000 characters');
  if (!/^#[0-9a-f]{6}$/i.test(m.accentColor || '')) fail('accentColor must be a #RRGGBB color');
  for (const key of ['websiteUrl', 'privacyUrl', 'termsOfUseUrl']) {
    if (!/^https:\/\//.test((m.developer || {})[key] || '')) fail(`developer.${key} must be an https URL`);
  }
  for (const tab of m.staticTabs || []) {
    if (!tab.contentUrl || tab.contentUrl.length > 2048) fail('staticTabs[].contentUrl must be set and at most 2048 characters');
  }
}

function buildManifest(appUrl, { version } = {}) {
  const url = parseAppUrl(appUrl);
  const manifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'manifest.template.json'), 'utf8'));
  if (version !== undefined) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`The version must look like 1.0.1 (got ${JSON.stringify(version)})`);
    manifest.version = version;
  }
  for (const tab of manifest.staticTabs) {
    tab.contentUrl = url.href;
    tab.websiteUrl = url.href;
  }
  manifest.validDomains = [url.host];
  validateManifest(manifest);
  return manifest;
}

function buildPackage(appUrl, { version, outFile = DEFAULT_OUT } = {}) {
  const manifest = buildManifest(appUrl, { version });
  const zip = createZip([
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { name: manifest.icons.color, data: fs.readFileSync(path.join(APP_DIR, 'color.png')) },
    { name: manifest.icons.outline, data: fs.readFileSync(path.join(APP_DIR, 'outline.png')) },
  ]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, zip);
  return outFile;
}

function main(argv) {
  const args = argv.slice(2);
  const opts = {};
  let appUrl;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version') opts.version = args[++i];
    else if (args[i] === '--out') opts.outFile = path.resolve(args[++i]);
    else if (!appUrl) appUrl = args[i];
    else throw new Error(`Unexpected argument: ${args[i]}`);
  }
  if (!appUrl) {
    throw new Error('Usage: node scripts/build-teams-app.js https://your-public-url [--version 1.0.1] [--out file.zip]');
  }
  const out = buildPackage(appUrl, opts);
  const manifest = buildManifest(appUrl, opts);
  console.log(`Teams app package written: ${out}`);
  console.log(`  version ${manifest.version}, tab URL ${manifest.staticTabs[0].contentUrl}`);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { buildManifest, buildPackage, validateManifest };
