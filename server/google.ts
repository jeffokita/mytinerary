// "Connect Gmail & Calendar" for the hosted app: Google OAuth with read-only scopes, tokens kept
// server-side (encrypted), and three small endpoints shaped like the claude.ai Gmail/Calendar
// connectors so the app's trip finder works the same either way.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db } from "./db.ts";

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
export const oauthConfigured = () => !!(CLIENT_ID && CLIENT_SECRET);
export const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/gmail.readonly"];

db.exec(`
CREATE TABLE IF NOT EXISTS google_tokens (
  email         TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,  -- encrypted
  access_token  TEXT,           -- encrypted
  expires_at    INTEGER NOT NULL DEFAULT 0,
  connected_at  INTEGER NOT NULL
);
`);

// Tokens are encrypted at rest with a key derived from SESSION_SECRET (AES-256-GCM).
const key = () => createHash("sha256").update("google-tokens:" + (process.env.SESSION_SECRET || "")).digest();
function encrypt(text: string) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString("base64url")).join(".");
}
function decrypt(value: string) {
  const [iv, tag, data] = value.split(".").map(s => Buffer.from(s, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

export class GoogleError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

export function authUrl(redirectUri: string, state: string, email: string) {
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state, login_hint: email,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + q;
}
async function tokenRequest(params: Record<string, string>) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new GoogleError(j.error === "invalid_grant" ? "needs_reauth" : "google_error", j.error_description || j.error || `Google said ${r.status}`);
  return j as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
}
export async function finishConnect(email: string, code: string, redirectUri: string) {
  const t = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  const granted = String(t.scope || "").split(" ");
  const missing = SCOPES.filter(s => !granted.includes(s));
  if (!t.refresh_token) throw new GoogleError("google_error", "Google didn't return a refresh token.");
  db.prepare(`INSERT INTO google_tokens (email, refresh_token, access_token, expires_at, connected_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (email) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token, expires_at = excluded.expires_at, connected_at = excluded.connected_at`)
    .run(email, encrypt(t.refresh_token), encrypt(t.access_token), Date.now() + (t.expires_in - 60) * 1000, Date.now());
  return { missing };
}
export const isConnected = (email: string) => !!db.prepare("SELECT 1 AS x FROM google_tokens WHERE email = ?").get(email);
export async function disconnect(email: string) {
  const row = db.prepare("SELECT refresh_token FROM google_tokens WHERE email = ?").get(email) as { refresh_token: string } | undefined;
  db.prepare("DELETE FROM google_tokens WHERE email = ?").run(email);
  if (row) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(decrypt(row.refresh_token)), { method: "POST", signal: AbortSignal.timeout(10_000) }).catch(() => {});
}
async function accessToken(email: string) {
  const row = db.prepare("SELECT * FROM google_tokens WHERE email = ?").get(email) as { refresh_token: string; access_token: string | null; expires_at: number } | undefined;
  if (!row) throw new GoogleError("not_connected", "Gmail and Calendar aren't connected.");
  if (row.access_token && Number(row.expires_at) > Date.now()) return decrypt(row.access_token);
  try {
    const t = await tokenRequest({ refresh_token: decrypt(row.refresh_token), grant_type: "refresh_token" });
    db.prepare("UPDATE google_tokens SET access_token = ?, expires_at = ? WHERE email = ?").run(encrypt(t.access_token), Date.now() + (t.expires_in - 60) * 1000, email);
    return t.access_token;
  } catch (e) {
    if (e instanceof GoogleError && e.code === "needs_reauth") db.prepare("DELETE FROM google_tokens WHERE email = ?").run(email);
    throw e;
  }
}
async function gget(email: string, url: string) {
  const r = await fetch(url, { headers: { authorization: "Bearer " + await accessToken(email) }, signal: AbortSignal.timeout(15_000) });
  if (r.status === 401) throw new GoogleError("needs_reauth", "Google sign-in expired.");
  if (r.status === 403) throw new GoogleError("not_in_manifest", "Google didn't grant access to this.");
  if (!r.ok) throw new GoogleError("server_unavailable", `Google said ${r.status}`);
  return r.json();
}

// Shaped like the connector's list_events payload: { events: [{ summary, location, start, end, eventType }] }.
export async function listEvents(email: string, timeMin: string, timeMax: string) {
  const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250", fields: "items(summary,location,start,end,eventType)" });
  const j = await gget(email, "https://www.googleapis.com/calendar/v3/calendars/primary/events?" + q);
  return { events: (j.items || []).map((e: any) => ({ ...e, eventType: e.eventType === "fromGmail" ? "FROM_GMAIL" : String(e.eventType || "default").toUpperCase() })) };
}
const header = (m: any, name: string) => ((m.payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";
// Shaped like search_threads: { threads: [{ id, messages: [{ date, subject, snippet, sender }] }] }.
export async function searchThreads(email: string, query: string, max: number) {
  const list = await gget(email, "https://gmail.googleapis.com/gmail/v1/users/me/threads?" + new URLSearchParams({ q: query, maxResults: String(Math.min(max, 30)) }));
  const ids: string[] = (list.threads || []).map((t: any) => t.id);
  const threads = await Promise.all(ids.map(async id => {
    const t = await gget(email, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
    const m = (t.messages || [])[0] || {};
    return { id, messages: [{ date: new Date(Number(m.internalDate) || Date.now()).toISOString(), subject: header(m, "Subject"), snippet: m.snippet || "", sender: header(m, "From").replace(/\s*<.*>$/, "").replace(/"/g, "") }] };
  }));
  return { threads };
}
function plainText(part: any): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts || []) { const t = plainText(p); if (t) return t; }
  if (part.mimeType === "text/html" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  return "";
}
// Shaped like get_thread: { messages: [{ subject, plaintextBody, snippet }] }.
export async function getThread(email: string, id: string) {
  if (!/^[\w-]{6,40}$/.test(id)) throw new GoogleError("google_error", "Bad thread id.");
  const t = await gget(email, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=full`);
  return { messages: (t.messages || []).slice(0, 5).map((m: any) => ({ subject: header(m, "Subject"), snippet: m.snippet || "", plaintextBody: plainText(m.payload).slice(0, 8000) })) };
}
