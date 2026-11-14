// Hosted Mytinerary: serves the single-page app and gives it the three things it can't do from a
// public web page — call Claude, look places up on Google, and sign people in by email link.
// Invite-only: ALLOWED_EMAILS lists who can sign in. No database; sessions are signed cookies.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT || 4321);
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex"); // set it in production, or sign-ins reset on every deploy
const FROM = process.env.RESEND_FROM || "Mytinerary <mytinerary@jeffokita.com>";
const SESSION_DAYS = 60, LINK_MINUTES = 20;
// Per person per day. Generous for real planning, small enough that a bug can't run up a bill.
const LIMITS = { claude: Number(process.env.DAILY_CLAUDE_CALLS || 80), places: Number(process.env.DAILY_PLACES_CALLS || 400), photos: Number(process.env.DAILY_PHOTO_CALLS || 400) };

const APP_HTML = new URL("../mytinerary/index.html", import.meta.url);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
if (!process.env.SESSION_SECRET) console.warn("⚠️  SESSION_SECRET is not set; sign-ins won't survive a restart.");
if (!anthropic) console.warn("⚠️  ANTHROPIC_API_KEY is not set; Claude features are off.");
if (!GOOGLE_KEY) console.warn("⚠️  GOOGLE_MAPS_API_KEY is not set; Google place data is off.");

/* ---------- helpers ---------- */
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage, max = 300_000): Promise<Record<string, any>> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > max) throw new HttpError(413, "That request is too large."); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "That request couldn't be read."); }
}
const isHttps = (req: IncomingMessage) => req.headers["x-forwarded-proto"] === "https";
const clientIp = (req: IncomingMessage) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "?";
const appUrl = (req: IncomingMessage) => process.env.APP_URL?.replace(/\/$/, "") || `${isHttps(req) ? "https" : "http"}://${req.headers.host}`;
const allowed = () => (process.env.ALLOWED_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
function readCookie(req: IncomingMessage, name: string) {
  const m = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

const hits = new Map<string, number[]>();
function rateLimited(key: string, max: number, windowMs: number) {
  const t = Date.now(), recent = (hits.get(key) ?? []).filter(x => t - x < windowMs);
  recent.push(t); hits.set(key, recent);
  return recent.length > max;
}
const usage = new Map<string, number>(); // "YYYY-MM-DD|email|kind" -> count
function spend(email: string, kind: keyof typeof LIMITS, n = 1) {
  const key = new Date().toISOString().slice(0, 10) + "|" + email + "|" + kind;
  const used = (usage.get(key) ?? 0) + n;
  if (used > LIMITS[kind]) throw new HttpError(429, "You've reached today's limit for this. It resets at midnight UTC.");
  usage.set(key, used);
}
setInterval(() => {
  const today = new Date().toISOString().slice(0, 10), t = Date.now();
  for (const k of usage.keys()) if (!k.startsWith(today)) usage.delete(k);
  for (const [k, v] of hits) if (v.every(x => t - x > 3_600_000)) hits.delete(k);
}, 3_600_000).unref();

/* ---------- sign-in: emailed one-time links, signed session cookies ---------- */
const sign = (data: string) => createHmac("sha256", SECRET).update(data).digest("base64url");
function verify(value: string | null): string | null {
  if (!value) return null;
  const i = value.lastIndexOf("."); if (i < 0) return null;
  const data = value.slice(0, i), sig = Buffer.from(value.slice(i + 1)), good = Buffer.from(sign(data));
  if (sig.length !== good.length || !timingSafeEqual(sig, good)) return null;
  return data;
}
const seal = (data: string) => data + "." + sign(data);
function currentUser(req: IncomingMessage): string | null {
  const data = verify(readCookie(req, "mt_session"));
  if (!data) return null;
  const [email, exp] = data.split("|");
  return Number(exp) > Date.now() && allowed().includes(email) ? email : null; // removing someone from ALLOWED_EMAILS signs them out
}
const cookie = (req: IncomingMessage, value: string, maxAge: number) =>
  `mt_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
const usedLinks = new Map<string, number>(); // link nonce -> expiry, so each link works once

async function sendEmail(to: string, subject: string, text: string) {
  if (!process.env.RESEND_API_KEY) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, text }),
  });
  if (!r.ok) console.error(`Email to ${to} failed: ${r.status} ${await r.text()}`);
  return r.ok;
}

/* ---------- Claude: one prompt in, streamed text out (newline-delimited JSON) ---------- */
async function claude(req: IncomingMessage, res: ServerResponse, email: string) {
  if (!anthropic) throw new HttpError(503, "Claude isn't set up on this server yet.");
  const b = await body(req);
  const prompt = String(b.prompt ?? "");
  if (!prompt) throw new HttpError(400, "Nothing to send.");
  spend(email, "claude");
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
  const line = (o: unknown) => res.write(JSON.stringify(o) + "\n");
  const stream = anthropic.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    output_config: { effort: b.tier === "quick" ? "low" : "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // if a request is declined, the API retries it on a fallback model
    messages: [{ role: "user", content: prompt }],
  });
  res.on("close", () => { if (!res.writableFinished) stream.abort(); });
  try {
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") line({ t: ev.delta.text });
    }
    const final = await stream.finalMessage();
    console.log(`🤖 ${email} · ${final.usage.input_tokens} in / ${final.usage.output_tokens} out · ${final.stop_reason}`);
    line({ done: true, stop: final.stop_reason });
  } catch (e) {
    if (res.destroyed) return;
    const code = e instanceof Anthropic.RateLimitError ? "rate_limited"
      : e instanceof Anthropic.AuthenticationError ? "server_config"
      : e instanceof Anthropic.APIUserAbortError ? "cancelled" : "api_error";
    console.error("Claude error:", e instanceof Error ? e.message : e);
    line({ error: { code, message: code === "rate_limited" ? "Claude is busy. Try again in a minute." : "Claude had a problem with that request." } });
  }
  res.end();
}

/* ---------- Google Places (New): match Claude's picks to real places ---------- */
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const pad = (n: number) => String(n ?? 0).padStart(2, "0");
// Google's weekly periods -> the app's {"mon":"10:00-17:00,18:00-22:00", "tue":"closed", ...}
function hoursFrom(roh: any): Record<string, string> | null {
  const periods = roh?.periods;
  if (!Array.isArray(periods) || !periods.length) return null;
  if (periods.length === 1 && periods[0].open && !periods[0].close) return Object.fromEntries(DAYS.map(d => [d, "00:00-24:00"]));
  const by: Record<string, string[]> = Object.fromEntries(DAYS.map(d => [d, []]));
  for (const p of periods) {
    if (!p.open || !p.close) continue;
    const start = `${pad(p.open.hour)}:${pad(p.open.minute)}`;
    let end = `${pad(p.close.hour)}:${pad(p.close.minute)}`;
    if (p.close.day !== p.open.day && end === "00:00") end = "24:00";
    by[DAYS[p.open.day]].push(`${start}-${end}`);
  }
  return Object.fromEntries(DAYS.map(d => [d, by[d].length ? by[d].join(",") : "closed"]));
}
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}
const placeCache = new Map<string, { at: number; v: unknown }>();
const FIELDS = ["id", "displayName", "formattedAddress", "location", "regularOpeningHours", "rating", "userRatingCount", "photos", "googleMapsUri", "businessStatus", "priceLevel"].map(f => "places." + f).join(",");
async function findPlace(item: any, dest: string) {
  const q = [item.name, item.address || item.neighborhood, dest].filter(Boolean).join(", ");
  const hasLL = Number.isFinite(item.lat) && Number.isFinite(item.lng);
  const key = q.toLowerCase();
  const hit = placeCache.get(key);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.v;
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST", signal: AbortSignal.timeout(12_000),
    headers: { "content-type": "application/json", "x-goog-api-key": GOOGLE_KEY, "x-goog-fieldmask": FIELDS },
    body: JSON.stringify({ textQuery: q, pageSize: 1, ...(hasLL ? { locationBias: { circle: { center: { latitude: item.lat, longitude: item.lng }, radius: 30000 } } } : {}) }),
  });
  if (!r.ok) { console.error(`Places search failed (${r.status}): ${(await r.text()).slice(0, 300)}`); throw new HttpError(502, "Google Places didn't answer."); }
  const p = ((await r.json()).places ?? [])[0];
  let v: unknown = null;
  if (p?.location) {
    const loc = { lat: p.location.latitude, lng: p.location.longitude };
    // Claude's guess and Google's answer should be in the same part of town; if not, it matched something else.
    if (!hasLL || km(loc, item) < 15) v = {
      id: p.id, name: p.displayName?.text || item.name, address: p.formattedAddress || "", lat: loc.lat, lng: loc.lng,
      hours: hoursFrom(p.regularOpeningHours), rating: p.rating ?? null, ratingCount: p.userRatingCount ?? null,
      photo: p.photos?.[0]?.name ?? null, mapsUrl: p.googleMapsUri || "", status: p.businessStatus || "", priceLevel: p.priceLevel || "",
    };
  }
  placeCache.set(key, { at: Date.now(), v });
  return v;
}
async function placesMatch(req: IncomingMessage, res: ServerResponse, email: string) {
  if (!GOOGLE_KEY) throw new HttpError(503, "Google Places isn't set up on this server yet.");
  const b = await body(req);
  const items = Array.isArray(b.items) ? b.items.slice(0, 40) : [];
  const dest = String(b.dest ?? "").slice(0, 120);
  spend(email, "places", items.length);
  const results: unknown[] = new Array(items.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await findPlace(items[i], dest); } catch { results[i] = null; }
    }
  }));
  send(res, 200, { results });
}
const photoCache = new Map<string, { at: number; uri: string }>();
async function placePhoto(req: IncomingMessage, res: ServerResponse, email: string, url: URL) {
  if (!GOOGLE_KEY) throw new HttpError(503, "Google Places isn't set up on this server yet.");
  const name = url.searchParams.get("name") || "";
  if (!/^places\/[\w-]+\/photos\/[\w-]+$/.test(name)) throw new HttpError(400, "Bad photo reference.");
  const w = Math.min(1200, Math.max(200, Number(url.searchParams.get("w")) || 800));
  const key = name + "@" + w;
  let hit = photoCache.get(key);
  if (!hit || Date.now() - hit.at > 43_200_000) {
    spend(email, "photos");
    const r = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=${w}&skipHttpRedirect=true`, { headers: { "x-goog-api-key": GOOGLE_KEY }, signal: AbortSignal.timeout(10_000) });
    const uri = r.ok ? (await r.json()).photoUri : "";
    if (!uri) throw new HttpError(404, "No photo.");
    hit = { at: Date.now(), uri }; photoCache.set(key, hit);
  }
  res.writeHead(302, { location: hit.uri, "cache-control": "private, max-age=43200" });
  res.end();
}

/* ---------- routes ---------- */
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname, m = req.method ?? "GET";

  if (path === "/healthz") return send(res, 200, { ok: true });
  if ((path === "/" || path === "/index.html") && m === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return res.end(readFileSync(APP_HTML));
  }

  // The emailed link: /auth/<token>
  if (path.startsWith("/auth/") && m === "GET") {
    const data = verify(decodeURIComponent(path.slice(6)));
    const [email, exp, nonce] = (data ?? "").split("|");
    if (!data || Number(exp) < Date.now() || usedLinks.has(nonce) || !allowed().includes(email)) {
      res.writeHead(302, { location: "/?signin=expired" }); return res.end();
    }
    usedLinks.set(nonce, Number(exp));
    for (const [k, e] of usedLinks) if (e < Date.now()) usedLinks.delete(k);
    const until = Date.now() + SESSION_DAYS * 864e5;
    res.writeHead(302, { location: "/", "set-cookie": cookie(req, seal(`${email}|${until}`), SESSION_DAYS * 86400) });
    console.log(`🔓 ${email} signed in`);
    return res.end();
  }

  if (!path.startsWith("/api/")) return send(res, 404, { error: "Not found" });
  const user = currentUser(req);

  if (path === "/api/me") return send(res, 200, { hosted: true, user, claude: !!anthropic, places: !!GOOGLE_KEY });

  if (path === "/api/login" && m === "POST") {
    const email = String((await body(req, 5_000)).email ?? "").trim().toLowerCase().slice(0, 200);
    if (rateLimited("login:" + clientIp(req), 10, 900_000) || rateLimited("login:" + email, 5, 900_000)) throw new HttpError(429, "Too many tries. Wait 15 minutes and try again.");
    if (allowed().includes(email)) {
      const token = seal(`${email}|${Date.now() + LINK_MINUTES * 60_000}|${randomBytes(9).toString("base64url")}`);
      const link = `${appUrl(req)}/auth/${encodeURIComponent(token)}`;
      const ok = await sendEmail(email, "Your Mytinerary sign-in link", `Tap to sign in to Mytinerary (works once, for ${LINK_MINUTES} minutes):\n\n${link}\n\nIf you didn't ask for this, ignore this email.`);
      if (!ok) console.log(`🔗 Sign-in link for ${email} (email not sent): ${link}`);
    } else console.log(`🚫 Sign-in attempt from an address not on the list`);
    // Same answer either way, so the form can't reveal who's invited.
    return send(res, 200, { ok: true });
  }
  if (path === "/api/logout" && m === "POST") return send(res, 200, { ok: true }, { "set-cookie": cookie(req, "", 0) });

  if (!user) throw new HttpError(401, "Please sign in.");
  if (path === "/api/claude" && m === "POST") return claude(req, res, user);
  if (path === "/api/places/match" && m === "POST") return placesMatch(req, res, user);
  if (path === "/api/places/photo" && m === "GET") return placePhoto(req, res, user, url);
  throw new HttpError(404, "Not found");
}

createServer((req, res) => {
  handle(req, res).catch(e => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.message : "Something went wrong." });
    else res.end();
  });
}).listen(PORT, () => console.log(`✈️  Mytinerary on http://localhost:${PORT}`));
