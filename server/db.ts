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

const VALID_KEY = /^(profile|profileChat|draft|form|trip:[\w-]{1,40})$/;
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
