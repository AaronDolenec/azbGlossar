'use strict';

// Origins that host the Teams website tab (Teams desktop/web, Microsoft 365,
// Outlook), from Microsoft's "Requirements for building tabs". Override with
// FRAME_ANCESTORS (space separated) if Microsoft adds a new host.
const DEFAULT_FRAME_ANCESTORS = Object.freeze([
  'https://teams.microsoft.com',
  'https://*.teams.microsoft.com',
  'https://*.cloud.microsoft',
  'https://*.microsoft365.com',
  'https://*.office.com',
  'https://outlook.office365.com',
  'https://*.skype.com',
]);

// A CSP host source: optional scheme, optional leading "*.", host, optional port.
const HOST_SOURCE = /^(https?:\/\/)?(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:\d{1,5})?$/;

function loadConfig(env = process.env) {
  const port = env.PORT === undefined || env.PORT === '' ? 8080 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a whole number between 1 and 65535 (got "${env.PORT}")`);
  }

  let frameAncestors = DEFAULT_FRAME_ANCESTORS;
  if (env.FRAME_ANCESTORS && env.FRAME_ANCESTORS.trim()) {
    frameAncestors = env.FRAME_ANCESTORS.trim().split(/\s+/);
    const bad = frameAncestors.find((s) => !HOST_SOURCE.test(s));
    if (bad) throw new Error(`FRAME_ANCESTORS contains an invalid origin: "${bad}"`);
  }

  return {
    port,
    dataDir: env.DATA_DIR || '/data',
    adminKey: env.ADMIN_KEY || '',
    frameAncestors,
  };
}

module.exports = { loadConfig, DEFAULT_FRAME_ANCESTORS };
