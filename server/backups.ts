// Daily database snapshots (copied from Next Chapter), kept next to the database (on the Railway volume) in backups/.
// Railway's own volume backups need the Pro plan; this covers the common case of rolling back
// after a bug or a mistake. Snapshots are named after the database file, e.g. starter-2026-10-20.db.
//
// To restore: set RESTORE_FROM to a snapshot's file name (listed in the deploy logs at startup),
// let it deploy, then remove the variable. The current database is saved first as before-restore-….db.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const KEEP = 7;
const prefixOf = (dbPath) => basename(dbPath).replace(/\.db$/, '');
const snapshotName = (dbPath, date) => `${prefixOf(dbPath)}-${date.toISOString().slice(0, 10)}.db`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isSnapshot = (dbPath) => {
  const re = new RegExp(`^${escapeRe(prefixOf(dbPath))}-\\d{4}-\\d{2}-\\d{2}\\.db$`);
  return (f) => re.test(f);
};

export const backupDir = (dbPath) => join(dirname(dbPath), 'backups');

export function listSnapshots(dbPath) {
  const dir = backupDir(dbPath);
  return existsSync(dir) ? readdirSync(dir).filter(isSnapshot(dbPath)).sort() : [];
}

// Runs before the database is opened, so the restored file is what the app starts with.
export function restoreIfRequested(dbPath) {
  const name = process.env.RESTORE_FROM?.trim();
  if (!name) return;
  const dir = backupDir(dbPath);
  const source = join(dir, basename(name)); // basename: only files inside backups/
  const marker = join(dir, '.last-restore');
  if (!existsSync(source)) {
    console.warn(`⚠️  RESTORE_FROM: no snapshot named ${name}. Available: ${listSnapshots(dbPath).join(', ') || 'none'}`);
    return;
  }
  // Restoring again on every restart would undo everything since; only restore each request once.
  if (existsSync(marker) && readFileSync(marker, 'utf8') === basename(name)) {
    console.warn(`⚠️  RESTORE_FROM=${name} was already restored. Remove the variable from Railway.`);
    return;
  }
  if (existsSync(dbPath)) {
    // VACUUM INTO, not a file copy: recent changes may still be in the -wal file next to the database,
    // and copying just the .db would leave them out of the safety copy.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const current = new DatabaseSync(dbPath);
    try { current.exec(`VACUUM INTO '${join(dir, `before-restore-${stamp}.db`).replaceAll("'", "''")}'`); } finally { current.close(); }
  }
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  copyFileSync(source, dbPath);
  writeFileSync(marker, basename(name));
  console.log(`♻️  Restored the database from ${name}. Remove RESTORE_FROM from Railway now.`);
}

// Takes today's snapshot if it doesn't exist yet, and deletes all but the newest KEEP.
export function snapshotIfDue(db, dbPath) {
  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, snapshotName(dbPath, new Date()));
  if (existsSync(target)) return;
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`); // a consistent copy, safe while the app runs
    const old = listSnapshots(dbPath).slice(0, -KEEP);
    for (const f of old) rmSync(join(dir, f));
    console.log(`🗄️  Saved snapshot ${basename(target)} (keeping the last ${KEEP})`);
  } catch (err) {
    console.error(`⚠️  Snapshot failed: ${err.message}`);
  }
}

export function startDailySnapshots(db, dbPath) {
  snapshotIfDue(db, dbPath);
  setInterval(() => snapshotIfDue(db, dbPath), 60 * 60 * 1000).unref(); // check hourly; one per day
  const all = listSnapshots(dbPath);
  console.log(`🗄️  Snapshots available: ${all.join(', ') || 'none yet'}`);
}
