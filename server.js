'use strict';
const { loadConfig } = require('./src/config');
const { Store } = require('./src/store');
const { createApp } = require('./src/app');

function main() {
  const config = loadConfig();
  const store = new Store(config.dataDir);
  store.load();

  if (!config.adminKey) {
    console.warn('WARNING: ADMIN_KEY is not set, so deleting terms is disabled.');
  } else if (config.adminKey.length < 16) {
    console.warn('WARNING: ADMIN_KEY is short. Use at least 16 random characters.');
  }

  const server = createApp({
    store,
    adminKey: config.adminKey,
    frameAncestors: config.frameAncestors,
  });

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Glossary listening on port ${config.port}, data in ${config.dataDir} (${store.list().length} terms)`);
  });

  // Docker stops containers with SIGTERM: finish in-flight writes, then exit.
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();
    server.close(() => store.flush().then(() => process.exit(0)));
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
