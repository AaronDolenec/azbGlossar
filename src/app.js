'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { HttpError } = require('./store');
const { RateLimiter } = require('./rate-limit');

const MAX_BODY = 16 * 1024;
const DRAIN_LIMIT = 1024 * 1024; // stop reading (and drop the socket) past this
const TERM_URL = /^\/api\/terms\/([A-Za-z0-9_-]{1,64})$/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE']);
const DEFAULT_INDEX = path.join(__dirname, '..', 'public', 'index.html');
const DEFAULT_WRITE_LIMIT = { max: 30, windowMs: 60_000 };

function createApp({
  store,
  adminKey = '',
  frameAncestors,
  indexPath = DEFAULT_INDEX,
  writeLimit = DEFAULT_WRITE_LIMIT,
}) {
  const limiter = new RateLimiter(writeLimit);
  const adminDigest = adminKey ? sha256(adminKey) : null;

  // Teams shows the page in an iframe, so it must not be blocked from framing:
  // no X-Frame-Options, and frame-ancestors lists the Teams hosts. Scripts and
  // styles are inline; user text is only ever inserted as text, never as HTML.
  const securityHeaders = {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      'img-src data:',
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors 'self' ${frameAncestors.join(' ')}`,
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };

  const indexBody = fs.readFileSync(indexPath);
  const indexPage = {
    body: indexBody,
    etag: `W/"${sha256(indexBody).toString('base64url').slice(0, 22)}"`,
    gzip: zlib.gzipSync(indexBody),
  };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...securityHeaders, ...headers });
    res.end(body);
  }

  function sendJson(res, status, value, headers = {}) {
    send(res, status, JSON.stringify(value), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
  }

  function sendError(res, err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, err.headers);
    console.error(err);
    return sendJson(res, 500, { error: 'Internal server error' });
  }

  // Serves a body that changes rarely: weak ETag, 304 support, lazy gzip.
  function sendCacheable(req, res, page, contentType) {
    const weakEtag = page.etag.startsWith('W/') ? page.etag : `W/${page.etag}`;
    const headers = {
      'Content-Type': contentType,
      ETag: weakEtag,
      'Cache-Control': 'no-cache',
      Vary: 'Accept-Encoding',
    };
    const strip = (v) => v.trim().replace(/^W\//, '');
    const candidates = (req.headers['if-none-match'] || '').split(',').map(strip);
    if (candidates.includes(strip(weakEtag))) return send(res, 304, undefined, headers);
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      page.gzip ??= zlib.gzipSync(page.body);
      return send(res, 200, page.gzip, { ...headers, 'Content-Encoding': 'gzip' });
    }
    return send(res, 200, page.body, headers);
  }

  // Behind a reverse proxy the last X-Forwarded-For entry is the address the
  // proxy itself saw; earlier entries can be forged by the client.
  function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',').pop().trim();
    return req.socket.remoteAddress || 'unknown';
  }

  function checkWriteLimit(req) {
    const wait = limiter.hit(clientIp(req));
    if (wait) {
      throw withHeaders(new HttpError(429, 'Too many changes in a short time. Please wait a moment.'), {
        'Retry-After': String(wait),
      });
    }
  }

  function requireAdmin(req) {
    if (!adminDigest) {
      throw new HttpError(403, 'Deleting is disabled: ADMIN_KEY is not set on the server');
    }
    const given = req.headers['x-admin-key'];
    const ok = typeof given === 'string' && crypto.timingSafeEqual(sha256(given), adminDigest);
    if (!ok) throw new HttpError(403, 'Wrong admin key');
  }

  async function route(req, res) {
    const pathname = req.url.split('?')[0].split('#')[0];
    const method = req.method;
    const readOnly = method === 'GET' || method === 'HEAD';

    if (pathname === '/healthz') {
      mustAllow(method, ['GET', 'HEAD']);
      return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    }

    if (pathname === '/' || pathname === '/index.html') {
      mustAllow(method, ['GET', 'HEAD']);
      return sendCacheable(req, res, indexPage, 'text/html; charset=utf-8');
    }

    if (pathname === '/api/terms') {
      mustAllow(method, ['GET', 'HEAD', 'POST']);
      if (readOnly) return sendCacheable(req, res, store.snapshot(), 'application/json; charset=utf-8');
      checkWriteLimit(req);
      const created = await store.add(await readJson(req));
      return sendJson(res, 201, created);
    }

    const match = TERM_URL.exec(pathname);
    if (match) {
      const id = match[1];
      mustAllow(method, ['PUT', 'DELETE']);
      checkWriteLimit(req);
      if (method === 'PUT') {
        return sendJson(res, 200, await store.update(id, await readJson(req)));
      }
      requireAdmin(req);
      await store.remove(id);
      return send(res, 204);
    }

    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => sendError(res, err));
  });

  // Proxies (Traefik/Pangolin) reuse idle connections for a while. Node's
  // default 5s keep-alive would close them first and cause sporadic 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const sweeper = setInterval(() => limiter.sweep(), 5 * 60_000);
  sweeper.unref();
  server.on('close', () => clearInterval(sweeper));

  return server;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function withHeaders(err, headers) {
  err.headers = headers;
  return err;
}

function mustAllow(method, allowed) {
  if (!allowed.includes(method)) {
    throw withHeaders(new HttpError(405, 'Method not allowed'), { Allow: allowed.join(', ') });
  }
}

// Reads a small JSON body. Uses events rather than `for await`, because
// breaking out of an async iteration destroys the socket before the 413
// response could be delivered.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, 'The request is too large');
    if (Number(req.headers['content-length']) > MAX_BODY) {
      req.resume();
      return reject(tooLarge());
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > DRAIN_LIMIT) return req.destroy();
      if (failed) return undefined;
      if (size > MAX_BODY) {
        failed = true;
        chunks.length = 0;
        return reject(tooLarge());
      }
      chunks.push(chunk);
      return undefined;
    });
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'The request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { createApp };
