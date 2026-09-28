'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMITS = Object.freeze({ term: 100, definition: 5000, maxTerms: 5000 });
const BACKUPS_KEPT = 14;
const BACKUP_NAME = /^glossary-\d{4}-\d{2}-\d{2}\.json$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const charCount = (s) => Array.from(s).length;

// Lower-cased, accent-free form used to detect duplicate terms.
const dedupeKey = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function cleanTerm(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'The term must be text');
  if (CONTROL_CHARS.test(value)) throw new HttpError(400, 'The term contains control characters');
  const v = value.replace(/\s+/g, ' ').trim();
  if (!v) throw new HttpError(400, 'The term must not be empty');
  if (charCount(v) > LIMITS.term) throw new HttpError(400, `The term must be at most ${LIMITS.term} characters`);
  return v;
}

function cleanDefinition(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'The explanation must be text');
  if (CONTROL_CHARS.test(value)) throw new HttpError(400, 'The explanation contains control characters');
  const v = value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (!v) throw new HttpError(400, 'The explanation must not be empty');
  if (charCount(v) > LIMITS.definition) {
    throw new HttpError(400, `The explanation must be at most ${LIMITS.definition} characters`);
  }
  return v;
}

function requireObject(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'The request body must be a JSON object');
  }
}

class Store {
  constructor(dataDir, { now = () => new Date() } = {}) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'glossary.json');
    this.backupDir = path.join(dataDir, 'backups');
    this.now = now;
    this.terms = [];
    this._snap = null;
    this._queue = Promise.resolve();
  }

  // Synchronous on purpose: runs once at startup, before the server listens.
  load() {
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, terms: [] }, null, 2));
      this.terms = [];
    } else {
      this.terms = this._readFile();
    }
    this._sortAndIndex();
  }

  _readFile() {
    const fail = (reason) => {
      throw new Error(
        `Cannot start: ${this.file} is not usable (${reason}). ` +
        'Fix or move the file, or restore one from the backups folder. It has not been modified.',
      );
    };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      return fail(err.message);
    }
    if (!data || typeof data !== 'object') return fail('not a JSON object');
    if (data.version !== 1) return fail(`unsupported version ${data.version}`);
    if (!Array.isArray(data.terms)) return fail('"terms" is not a list');
    for (const t of data.terms) {
      const ok = t && ['id', 'term', 'definition', 'createdAt', 'updatedAt'].every((k) => typeof t[k] === 'string');
      if (!ok) return fail('a term entry is malformed');
    }
    return data.terms;
  }

  list() {
    return this.terms;
  }

  // { body, etag, gzip }: the serialised list, its ETag, and a slot the HTTP
  // layer fills lazily with the gzipped body. Replaced whenever the data changes.
  snapshot() {
    return this._snap;
  }

  add(input) {
    return this._enqueue(async () => {
      requireObject(input);
      const term = cleanTerm(input.term);
      const definition = cleanDefinition(input.definition);
      if (this.terms.length >= LIMITS.maxTerms) {
        throw new HttpError(409, `The glossary is full (${LIMITS.maxTerms} terms)`);
      }
      this._assertUnique(term);
      const stamp = this.now().toISOString();
      const created = { id: this._newId(), term, definition, createdAt: stamp, updatedAt: stamp };
      await this._commit([...this.terms, created]);
      return created;
    });
  }

  update(id, input) {
    return this._enqueue(async () => {
      requireObject(input);
      const existing = this.terms.find((t) => t.id === id);
      if (!existing) throw new HttpError(404, 'Term not found');
      if (input.term === undefined && input.definition === undefined) {
        throw new HttpError(400, 'Nothing to update: send a term and/or an explanation');
      }
      const term = input.term === undefined ? existing.term : cleanTerm(input.term);
      const definition = input.definition === undefined ? existing.definition : cleanDefinition(input.definition);
      this._assertUnique(term, id);
      const updated = { ...existing, term, definition, updatedAt: this.now().toISOString() };
      await this._commit(this.terms.map((t) => (t.id === id ? updated : t)));
      return updated;
    });
  }

  remove(id) {
    return this._enqueue(async () => {
      if (!this.terms.some((t) => t.id === id)) throw new HttpError(404, 'Term not found');
      await this._commit(this.terms.filter((t) => t.id !== id));
    });
  }

  // All mutations run one at a time, so each sees the result of the previous
  // one. A failed mutation rejects its own caller but never blocks the queue.
  _enqueue(fn) {
    const run = this._queue.then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _assertUnique(term, exceptId) {
    const key = dedupeKey(term);
    if (this.terms.some((t) => t.id !== exceptId && dedupeKey(t.term) === key)) {
      throw new HttpError(409, `"${term}" is already in the glossary`);
    }
  }

  _newId() {
    let id;
    do id = crypto.randomBytes(6).toString('base64url');
    while (this.terms.some((t) => t.id === id));
    return id;
  }

  // Persist first, then swap the in-memory state, so a failed write leaves
  // memory and disk in agreement.
  async _commit(next) {
    next.sort((a, b) => collator.compare(a.term, b.term));
    await this._persist(next);
    this.terms = next;
    this._sortAndIndex();
  }

  _sortAndIndex() {
    this.terms.sort((a, b) => collator.compare(a.term, b.term));
    const body = JSON.stringify({ terms: this.terms });
    const hash = crypto.createHash('sha1').update(body).digest('base64url');
    this._snap = { body, etag: `"${hash}"`, gzip: null };
  }

  async _persist(terms) {
    await this._backupIfNeeded();
    const tmp = `${this.file}.tmp`;
    try {
      const fh = await fsp.open(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify({ version: 1, terms }, null, 2));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, this.file);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  // First write of each UTC day keeps a copy of the file as it was before.
  // A backup problem is logged but never blocks a user's edit.
  async _backupIfNeeded() {
    try {
      const day = this.now().toISOString().slice(0, 10);
      const dest = path.join(this.backupDir, `glossary-${day}.json`);
      try {
        await fsp.copyFile(this.file, dest, fs.constants.COPYFILE_EXCL);
      } catch (err) {
        if (err.code === 'EEXIST') return;
        throw err;
      }
      const names = (await fsp.readdir(this.backupDir)).filter((n) => BACKUP_NAME.test(n)).sort();
      for (const name of names.slice(0, Math.max(0, names.length - BACKUPS_KEPT))) {
        await fsp.unlink(path.join(this.backupDir, name));
      }
    } catch (err) {
      console.error(`Backup failed: ${err.message}`);
    }
  }
}

module.exports = { Store, HttpError, LIMITS };
