import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { restoreIfRequested, startDailySnapshots } from "./backups.ts";

// Same setup as Next Chapter. Data must live on a persistent volume or it's wiped on every deploy.
// With a Railway volume attached, the database goes on it automatically; DB_PATH overrides that if set.
// (Wishful lost every account on each deploy because DB_PATH pointed off the volume. Leave DB_PATH
// unset on Railway; use it locally to test against a throwaway copy.)
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
export const dbPath = resolve(process.env.DB_PATH || (volume ? join(volume, "mytinerary.db") : join(import.meta.dirname, "..", "data", "mytinerary.db")));
mkdirSync(dirname(dbPath), { recursive: true });
restoreIfRequested(dbPath); // before opening, so a restored snapshot is what the app starts with
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
if (process.env.RAILWAY_ENVIRONMENT && !volume && !process.env.DB_PATH) console.warn("⚠️  No Railway volume attached: saved trips will be wiped on the next deploy.");

// Each person's profile, plan in progress, form defaults and trips, one JSON document per key.
// "updated" is the client's save time in ms; the newest write wins. A null value marks a deleted trip.
db.exec(`
CREATE TABLE IF NOT EXISTS docs (
  email   TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY (email, key)
);
`);
startDailySnapshots(db, dbPath);

const VALID_KEY = /^(profile|profileChat|draft|form|found|trip:[\w-]{1,40})$/;
export function loadDocs(email: string) {
  return (db.prepare("SELECT key, value, updated FROM docs WHERE email = ?").all(email) as { key: string; value: string | null; updated: number }[])
    .map(r => ({ key: r.key, value: r.value == null ? null : JSON.parse(r.value), updated: Number(r.updated) }));
}
export function saveDocs(email: string, docs: { key: unknown; value: unknown; updated: unknown }[]) {
  const upsert = db.prepare(`INSERT INTO docs (email, key, value, updated) VALUES (?, ?, ?, ?)
    ON CONFLICT (email, key) DO UPDATE SET value = excluded.value, updated = excluded.updated WHERE excluded.updated > docs.updated`);
  let saved = 0;
  db.exec("BEGIN");
  try {
    for (const d of docs) {
      const key = String(d.key), updated = Math.min(Number(d.updated) || 0, Date.now() + 60_000);
      if (!VALID_KEY.test(key) || !updated) continue;
      saved += Number(upsert.run(email, key, d.value == null ? null : JSON.stringify(d.value), updated).changes);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return saved;
}

// Free-text "Other" answers (occasion and the like), counted so the most common become real options.
db.exec(`
CREATE TABLE IF NOT EXISTS answers (
  field     TEXT NOT NULL,
  value     TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 1,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (field, value)
);
-- Read-only links to one trip. The trip is read live from docs, so later edits show up.
CREATE TABLE IF NOT EXISTS shares (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  trip_id    TEXT NOT NULL,
  owner_name TEXT NOT NULL DEFAULT '',
  created    INTEGER NOT NULL
);
-- People who asked for an invite (from a shared trip or the landing page), and the ones approved.
CREATE TABLE IF NOT EXISTS invite_requests (
  email    TEXT PRIMARY KEY,
  name     TEXT NOT NULL DEFAULT '',
  via      TEXT NOT NULL DEFAULT '',
  created  INTEGER NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0
);
`);
export function recordAnswer(field: string, value: string) {
  const v = value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
  if (!v) return;
  db.prepare(`INSERT INTO answers (field, value, last_seen) VALUES (?, ?, ?)
    ON CONFLICT (field, value) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen`).run(field, v, Date.now());
}
export const topAnswers = () => db.prepare("SELECT field, value, count, last_seen FROM answers ORDER BY field, count DESC, last_seen DESC LIMIT 200").all();
export function shareFor(email: string, tripId: string, ownerName: string) {
  const row = db.prepare("SELECT token FROM shares WHERE email = ? AND trip_id = ?").get(email, tripId) as { token: string } | undefined;
  if (row) { db.prepare("UPDATE shares SET owner_name = ? WHERE token = ?").run(ownerName, row.token); return row.token; }
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  db.prepare("INSERT INTO shares (token, email, trip_id, owner_name, created) VALUES (?, ?, ?, ?, ?)").run(token, email, tripId, ownerName, Date.now());
  return token;
}
export function sharedTrip(token: string) {
  const s = db.prepare("SELECT email, trip_id, owner_name FROM shares WHERE token = ?").get(token) as { email: string; trip_id: string; owner_name: string } | undefined;
  if (!s) return null;
  const doc = db.prepare("SELECT value FROM docs WHERE email = ? AND key = ?").get(s.email, "trip:" + s.trip_id) as { value: string | null } | undefined;
  return doc && doc.value ? { trip: JSON.parse(doc.value), owner: s.owner_name } : null;
}
export function requestInvite(email: string, name: string, via: string) {
  db.prepare(`INSERT INTO invite_requests (email, name, via, created) VALUES (?, ?, ?, ?)
    ON CONFLICT (email) DO UPDATE SET name = excluded.name, via = excluded.via`).run(email, name, via, Date.now());
}
export const approveInvite = (email: string) => db.prepare("UPDATE invite_requests SET approved = 1 WHERE email = ?").run(email).changes > 0;
export const approvedEmails = () => (db.prepare("SELECT email FROM invite_requests WHERE approved = 1").all() as { email: string }[]).map(r => r.email);
