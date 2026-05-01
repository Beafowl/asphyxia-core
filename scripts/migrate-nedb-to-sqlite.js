#!/usr/bin/env node
//
// Convert a savedata directory of legacy NeDB `.db` files (line-delimited
// JSON) into the new SQLite format written by SqliteStore. Each input file
// is replaced in place; the original is preserved with a `.nedb.bak`
// suffix so a rollback is one rename away.
//
// Usage:
//   node scripts/migrate-nedb-to-sqlite.js [savedata-dir]
//
// Defaults to ./savedata. Idempotent: files already in SQLite format are
// skipped, files already migrated (a sibling `.nedb.bak` exists) are
// skipped.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { randomBytes } = require('crypto');

const dir = process.argv[2] || path.join(process.cwd(), 'savedata');
if (!fs.existsSync(dir)) {
  console.error(`savedata dir not found: ${dir}`);
  process.exit(1);
}

function isSqliteFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (n < 15) return false;
    return buf.toString('ascii', 0, 15) === 'SQLite format 3';
  } catch {
    return false;
  }
}

// NeDB's reviver for $$date markers. Its native model.js does this plus a
// few other quirks (e.g. unescaping $-prefixed keys), but for actual
// plugin data the only one we hit in practice is dates.
function reviveDates(_key, value) {
  if (value && typeof value === 'object' && typeof value.$$date === 'number') {
    return new Date(value.$$date);
  }
  return value;
}

function parseTs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

function migrateFile(srcPath) {
  const filename = path.basename(srcPath);

  if (isSqliteFile(srcPath)) {
    console.log(`  skip ${filename} (already SQLite)`);
    return { skipped: true };
  }

  const backup = srcPath + '.nedb.bak';
  if (fs.existsSync(backup)) {
    console.log(`  skip ${filename} (backup ${path.basename(backup)} already exists — looks already migrated)`);
    return { skipped: true };
  }

  console.log(`  migrating ${filename}...`);
  // Parse NDJSON into an in-memory dict so deletes (`{ $$deleted: true }`
  // tombstones) and re-inserts (same _id appearing again — NeDB's append
  // log) collapse to a single live record per _id, matching how NeDB
  // re-builds state at load time.
  const live = new Map();
  const text = fs.readFileSync(srcPath, 'utf8');
  let lineNo = 0;
  let dropped = 0;
  for (const raw of text.split('\n')) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;
    let doc;
    try { doc = JSON.parse(line, reviveDates); }
    catch { dropped++; continue; }
    if (!doc || typeof doc !== 'object') continue;
    if (doc.$$indexCreated || doc.$$indexRemoved) continue;
    if (!doc._id) {
      // Index assertions and other meta lines may lack _id; ignore.
      continue;
    }
    if (doc.$$deleted) {
      live.delete(doc._id);
      continue;
    }
    live.set(doc._id, doc);
  }

  // Write to a temporary SQLite file, then swap it in. Avoids a partially
  // converted .db if anything goes sideways.
  const tmp = srcPath + '.sqlite.tmp';
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  const db = new Database(tmp);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        _id        TEXT PRIMARY KEY,
        __s        TEXT,
        __refid    TEXT,
        createdAt  INTEGER,
        updatedAt  INTEGER,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_documents_s        ON documents(__s);
      CREATE INDEX IF NOT EXISTS idx_documents_refid    ON documents(__refid);
      CREATE INDEX IF NOT EXISTS idx_documents_s_refid  ON documents(__s, __refid);
    `);

    const insert = db.prepare(`INSERT INTO documents (_id, __s, __refid, createdAt, updatedAt, data) VALUES (?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction((docs) => {
      for (const doc of docs) {
        const _id = String(doc._id || randomBytes(8).toString('hex').toUpperCase());
        const __s = typeof doc.__s === 'string' ? doc.__s : null;
        const __refid = typeof doc.__refid === 'string' ? doc.__refid : null;
        const createdAt = parseTs(doc.createdAt);
        const updatedAt = parseTs(doc.updatedAt) ?? createdAt;
        const persist = { ...doc };
        delete persist._id;
        delete persist.__s;
        delete persist.__refid;
        delete persist.createdAt;
        delete persist.updatedAt;
        // Re-encode any Date values as ISO strings inside the JSON blob.
        // The hot timestamps are promoted to typed columns above; anything
        // else we just pass through the JSON path so it round-trips.
        insert.run(_id, __s, __refid, createdAt, updatedAt, JSON.stringify(persist, (k, v) => {
          if (v instanceof Date) return v.toISOString();
          return v;
        }));
      }
    });
    tx([...live.values()]);

    db.close();
  } catch (err) {
    db.close();
    fs.unlinkSync(tmp);
    throw err;
  }

  // Promote .nedb.bak first so we always retain the original; then swap.
  fs.renameSync(srcPath, backup);
  fs.renameSync(tmp, srcPath);

  return {
    migrated: true,
    docs: live.size,
    droppedLines: dropped,
    backup,
  };
}

console.log(`Migrating savedata in ${dir}`);
const entries = fs.readdirSync(dir);
let total = 0;
let migrated = 0;
let skipped = 0;
for (const name of entries) {
  if (!name.endsWith('.db')) continue;
  if (name.endsWith('.bak')) continue;
  total++;
  const full = path.join(dir, name);
  try {
    const r = migrateFile(full);
    if (r.migrated) {
      migrated++;
      console.log(`    ok: ${r.docs} doc(s) migrated; legacy file kept at ${path.basename(r.backup)}`);
    } else {
      skipped++;
    }
  } catch (err) {
    console.error(`    FAILED ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`Done. ${migrated} migrated, ${skipped} skipped (of ${total} .db files).`);
