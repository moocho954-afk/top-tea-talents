// TOP TEA TALENTS — public backend API. Bun + TypeScript, ZERO npm dependencies.
// TEST MODE is always on: no external submission calls exist anywhere in this
// file; nothing is ever sent live; no payments are processed; email is queued
// only ("email pending: integration not connected") and never claimed as sent.
// Never collect SSN or bank credentials. Free-only: no paid service anywhere.
import { createHash, randomUUID } from "node:crypto";
import { createDb, type Db, type Row } from "./libsql.js";

const VERSION = "1.0.0";
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const SEED_DIR = import.meta.dir + "/../seed";

const db: Db = createDb();

// ---------- small helpers ----------
const nowIso = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().slice(0, 10);
const genId = (p: string) => p + "_" + randomUUID().replace(/-/g, "").slice(0, 16);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function canonical(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS" } });
}
const err = (status: number, message: string) => json({ ok: false, error: message }, status);
const ok = (data: any = {}) => json({ ok: true, ...data });

async function body(req: Request): Promise<any> {
  try { const t = await req.text(); return t ? JSON.parse(t) : {}; }
  catch { return null; }
}
const isObj = (v: any) => v && typeof v === "object" && !Array.isArray(v);
const normName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
const slugify = (s: string) => normName(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";

// ---------- money / pay parsing ----------
function parseMoney(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = String(text).replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}
function parseHours(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*(?:-?\s*hour|hr)/i);
  return m ? Number(m[1]) : null;
}
// normalizedDaily = hourly? hourly*8 (hours default 8 when unstated) : daily? daily : flat? flat : null
function normalizedDaily(compType: string | null | undefined, compText: string | null | undefined, hoursText: string | null | undefined): number | null {
  const amt = parseMoney(compText);
  if (amt === null) return null;
  const t = (compType || "").toLowerCase();
  if (t === "hourly") return amt * (parseHours(hoursText) ?? 8);
  if (t === "daily" || t === "flat" || t === "session" || t === "residual") return amt;
  return null;
}

// ---------- settings ----------
async function getSetting(key: string, fallback: string): Promise<string> {
  const rows = await db.all("SELECT value FROM settings WHERE key = ?", [key]);
  return rows.length ? String(rows[0].value) : fallback;
}
async function setSetting(key: string, value: string): Promise<void> {
  await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}
async function submissionsPaused(): Promise<boolean> {
  return (await getSetting("submissions_paused", "true")) === "true";
}
async function repeatThreshold(): Promise<number> {
  const v = Number(await getSetting("repeat_agency_threshold", "3"));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 3;
}
async function repeatTopPercent(): Promise<number> {
  const v = Number(await getSetting("repeat_agency_top_percent", "10"));
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 10;
}
async function commissionSettings(): Promise<{ floorDaily: number; floorRate: number; ceilingDaily: number; ceilingRate: number }> {
  return {
    floorDaily: Number(await getSetting("commission_floor_daily", "100")),
    floorRate: Number(await getSetting("commission_floor_rate", "10")),
    ceilingDaily: Number(await getSetting("commission_ceiling_daily", "1000")),
    ceilingRate: Number(await getSetting("commission_ceiling_rate", "15")),
  };
}
// rate = clamp(floor + (ceiling-floor)*(daily-floorDaily)/(ceilingDaily-floorDaily), floor, ceiling)
function commissionRate(daily: number | null, s: { floorDaily: number; floorRate: number; ceilingDaily: number; ceilingRate: number }): number {
  if (daily === null) return s.floorRate;
  if (daily <= s.floorDaily) return s.floorRate;
  if (daily >= s.ceilingDaily) return s.ceilingRate;
  const r = s.floorRate + ((s.ceilingRate - s.floorRate) * (daily - s.floorDaily)) / (s.ceilingDaily - s.floorDaily);
  return Math.round(r * 100) / 100;
}
// Integer cents throughout: gross - fee = net exactly.
function commissionFor(grossCents: number, rate: number): { feeCents: number; netCents: number } {
  const feeCents = Math.round((grossCents * rate) / 100);
  return { feeCents, netCents: grossCents - feeCents };
}

// ---------- ledger (append-only, hash-chained) ----------
async function ledgerAppend(eventType: string, entityType: string, entityId: string, actor: string, data: any): Promise<number> {
  const rows = await db.all("SELECT MAX(seq) AS m, hash FROM ledger_events GROUP BY seq ORDER BY seq DESC LIMIT 1").catch(() => []);
  let prevHash = "GENESIS";
  let seq = 1;
  if (rows.length) {
    prevHash = String(rows[0].hash);
    seq = Number(rows[0].m) + 1;
  } else {
    const all = await db.all("SELECT seq, hash FROM ledger_events ORDER BY seq DESC LIMIT 1");
    if (all.length) { prevHash = String(all[0].hash); seq = Number(all[0].seq) + 1; }
  }
  const ts = nowIso();
  const hash = sha256(prevHash + "|" + canonical({ seq, ts, event_type: eventType, entity_type: entityType, entity_id: entityId, actor, data }));
  await db.run(
    "INSERT INTO ledger_events (seq, ts, event_type, entity_type, entity_id, actor, data_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [seq, ts, eventType, entityType, entityId, actor, JSON.stringify(data ?? {}), prevHash, hash],
  );
  return seq;
}

async function audit(action: string, entityType: string, entityId: string, actor: string, data: any): Promise<void> {
  const ts = nowIso();
  await db.run(
    "INSERT INTO audit_log (id, ts, actor, action, entity_type, entity_id, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [genId("aud"), ts, actor, action, entityType, entityId, JSON.stringify(data ?? {})],
  ).catch(() => {});
  await ledgerAppend(action, entityType, entityId, actor, data ?? {});
}

// ---------- contacts ----------
async function upsertContact(kind: string, name: string, extra: any = {}): Promise<string> {
  const normalized = normName(name);
  if (!normalized) return "";
  const id = "ctc_" + sha256(kind + "|" + normalized).slice(0, 16);
  const ts = nowIso();
  const existing = await db.all("SELECT id, data_json FROM contacts WHERE id = ?", [id]);
  const merged = existing.length ? { ...JSON.parse(String(existing[0].data_json || "{}")), ...extra, name } : { ...extra, name };
  if (existing.length) {
    await db.run("UPDATE contacts SET name = ?, email = ?, phone = ?, city = ?, state = ?, source = ?, data_json = ?, updated_at = ? WHERE id = ?",
      [name, extra.email ?? null, extra.phone ?? null, extra.city ?? null, extra.state ?? null, extra.source ?? null, JSON.stringify(merged), ts, id]);
  } else {
    await db.run("INSERT INTO contacts (id, kind, name, normalized, email, phone, city, state, source, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, kind, name, normalized, extra.email ?? null, extra.phone ?? null, extra.city ?? null, extra.state ?? null, extra.source ?? null, JSON.stringify(merged), ts, ts]);
  }
  return id;
}

// ---------- auth ----------
const loginAttempts = new Map<string, number[]>();
function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (loginAttempts.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= 10) return true;
  arr.push(now);
  loginAttempts.set(ip, arr);
  return false;
}
async function talentFromToken(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const rows = await db.all("SELECT talent_id FROM sessions WHERE token = ?", [m[1]]);
  return rows.length ? String(rows[0].talent_id) : null;
}
function isAdmin(req: Request): boolean {
  if (!ADMIN_TOKEN) return false;
  const h = req.headers.get("authorization") || "";
  return h === `Bearer ${ADMIN_TOKEN}`;
}
function requireAdmin(req: Request): Response | null {
  if (!ADMIN_TOKEN) return err(503, "admin not configured");
  if (!isAdmin(req)) return err(401, "admin authorization required");
  return null;
}
async function loadTalent(id: string): Promise<{ row: Row; profile: any } | null> {
  const rows = await db.all("SELECT * FROM talents WHERE id = ?", [id]);
  if (!rows.length) return null;
  let profile: any = {};
  try { profile = JSON.parse(String(rows[0].profile_json || "{}")); } catch { profile = {}; }
  return { row: rows[0], profile };
}
async function saveProfile(id: string, profile: any): Promise<void> {
  await db.run("UPDATE talents SET profile_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(profile), nowIso(), id]);
}

// Completion checklist: 10 items, 10% each.
const COMPLETION_ITEMS: { key: string; label: string; check: (p: any) => boolean }[] = [
  { key: "contact", label: "Contact info (email + phone)", check: (p) => !!p.email && !!p.phone },
  { key: "name", label: "Legal name", check: (p) => !!p.firstName && !!p.lastName },
  { key: "location", label: "Location (city, state, zip)", check: (p) => !!p.city && !!p.state && !!p.zip },
  { key: "height", label: "Height", check: (p) => !!p.height },
  { key: "age_range", label: "Age range", check: (p) => !!p.ageRange },
  { key: "languages", label: "Languages", check: (p) => Array.isArray(p.languages) && p.languages.length > 0 },
  { key: "skills", label: "Skills", check: (p) => Array.isArray(p.skills) && p.skills.length > 0 },
  { key: "experience", label: "Experience", check: (p) => !!p.experience },
  { key: "categories", label: "Categories", check: (p) => Array.isArray(p.categories) && p.categories.length > 0 },
  { key: "availability", label: "Availability", check: (p) => Array.isArray(p.availability) && p.availability.length > 0 },
];
function completionOf(p: any): { percent: number; checklist: { key: string; label: string; done: boolean }[] } {
  const checklist = COMPLETION_ITEMS.map((i) => ({ key: i.key, label: i.label, done: i.check(p) }));
  const done = checklist.filter((c) => c.done).length;
  return { percent: Math.round((done / checklist.length) * 100), checklist };
}
async function deriveStatus(talentId: string, profile: any): Promise<string> {
  const c = await db.all("SELECT signed, status FROM consents WHERE talent_id = ?", [talentId]);
  const consent = c.length ? c[0] : null;
  if (consent && String(consent.status) === "REVOKED") return "REVOKED";
  const pct = completionOf(profile).percent;
  if (pct < 100) return "PROFILE INCOMPLETE";
  const r = await db.all("SELECT decision FROM reviews WHERE talent_id = ? ORDER BY created_at DESC LIMIT 1", [talentId]);
  if (r.length && String(r[0].decision) === "PASS") return "READY FOR MATCHING";
  if (consent && Number(consent.signed) === 1) return "AWAITING AGENCY REVIEW";
  return "PROFILE UNDER REVIEW";
}
async function refreshStatus(talentId: string): Promise<string> {
  const t = await loadTalent(talentId);
  if (!t) return "";
  const status = await deriveStatus(talentId, t.profile);
  const p = { ...t.profile, status, completion: completionOf(t.profile).percent };
  await saveProfile(talentId, p);
  return status;
}

// ---------- opportunities ----------
function oppExpired(o: any): boolean {
  if (!o.deadline) return false;
  return String(o.deadline).slice(0, 10) < todayStr();
}
async function allOpps(): Promise<any[]> {
  const rows = await db.all("SELECT data_json FROM opportunities");
  return rows.map((r) => JSON.parse(String(r.data_json)));
}
async function allIntel(): Promise<any[]> {
  const rows = await db.all("SELECT data_json FROM production_intel");
  return rows.map((r) => JSON.parse(String(r.data_json)));
}
async function allSources(): Promise<any[]> {
  const rows = await db.all("SELECT data_json FROM sources ORDER BY id");
  return rows.map((r) => JSON.parse(String(r.data_json)));
}
function oppWithExpiry(o: any): any {
  return { ...o, expired: oppExpired(o) };
}

// ---------- seed ----------
async function loadSeed(): Promise<{ inserted: number; skipped: number; intelInserted: number; intelSkipped: number; sourcesInserted: number; sourcesSkipped: number }> {
  const readJson = async (name: string): Promise<any[]> => {
    try { return JSON.parse(await Bun.file(SEED_DIR + "/" + name).text()); } catch { return []; }
  };
  const opps = await readJson("opportunities.json");
  const intel = await readJson("production-intel.json");
  const sources = await readJson("sources.json");
  let inserted = 0, skipped = 0;
  for (const o of opps) {
    if (!o || !o.id) continue;
    const ex = await db.all("SELECT id FROM opportunities WHERE id = ?", [o.id]);
    if (ex.length) { skipped++; continue; }
    await db.run("INSERT INTO opportunities (id, data_json) VALUES (?, ?)", [o.id, JSON.stringify(o)]);
    inserted++;
  }
  let intelInserted = 0, intelSkipped = 0;
  for (const it of intel) {
    if (!it || !it.id) continue;
    const ex = await db.all("SELECT id FROM production_intel WHERE id = ?", [it.id]);
    if (ex.length) { intelSkipped++; continue; }
    await db.run("INSERT INTO production_intel (id, data_json) VALUES (?, ?)", [it.id, JSON.stringify(it)]);
    intelInserted++;
  }
  let sourcesInserted = 0, sourcesSkipped = 0;
  for (const s of sources) {
    if (!s || !s.id) continue;
    const ex = await db.all("SELECT id FROM sources WHERE id = ?", [s.id]);
    if (ex.length) { sourcesSkipped++; continue; }
    await db.run("INSERT INTO sources (id, data_json) VALUES (?, ?)", [s.id, JSON.stringify(s)]);
    sourcesInserted++;
  }
  // Upsert agency/employer/casting-professional/production-company contacts from seed (one pass, no ledger spam).
  const seen = new Set<string>();
  for (const o of opps) {
    for (const [kind, name] of [["agency", o.casting_org], ["agency", o.employer], ["casting-professional", o.casting_professional], ["production-company", o.production]] as const) {
      if (name && !seen.has(kind + "|" + normName(String(name)))) {
        seen.add(kind + "|" + normName(String(name)));
        await upsertContact(kind, String(name), { source: o.source ?? null, city: o.location?.city ?? null, state: o.location?.state ?? null });
      }
    }
  }
  for (const it of intel) {
    if (it.company && !seen.has("production-company|" + normName(String(it.company)))) {
      seen.add("production-company|" + normName(String(it.company)));
      await upsertContact("production-company", String(it.company), { source: it.source ?? null });
    }
  }
  return { inserted, skipped, intelInserted, intelSkipped, sourcesInserted, sourcesSkipped };
}

const SCHEMA = await Bun.file(import.meta.dir + "/schema.sql").text();
await db.exec(SCHEMA);
{
  const rows = await db.all("SELECT COUNT(*) AS n FROM opportunities");
  if (Number(rows[0]?.n ?? 0) === 0) {
    const r = await loadSeed();
    await ledgerAppend("seed.import", "seed", "seed-2026-11-21", "system", {
      opportunities: 423, productionIntel: 96, sources: 23,
      inserted: r.inserted, skipped: r.skipped,
      intelInserted: r.intelInserted, sourcesInserted: r.sourcesInserted,
      note: "First-boot lazy seed of bundled seed JSON. One summary event, not one event per record.",
    });
  }
}

// ---------- talent view ----------
const SLOT_LABELS: Record<number, string> = {
  1: "MAIN HEADSHOT", 2: "FULL-BODY PHOTO", 3: "PROFESSIONAL PORTRAIT", 4: "CASUAL LOOK",
  5: "ALTERNATE LOOK", 6: "PROFILE OR SIDE VIEW", 7: "ADDITIONAL PHOTO", 8: "ADDITIONAL PHOTO",
};
async function photoCount(talentId: string): Promise<number> {
  const rows = await db.all("SELECT COUNT(*) AS n FROM photos WHERE talent_id = ?", [talentId]);
  return Number(rows[0]?.n ?? 0);
}
async function talentView(id: string): Promise<any | null> {
  const t = await loadTalent(id);
  if (!t) return null;
  const p = t.profile;
  const comp = completionOf(p);
  const status = p.status || (await deriveStatus(id, p));
  const ft = await db.all("SELECT version, authorized_at FROM fast_track WHERE talent_id = ?", [id]);
  const gd = await db.all("SELECT data_json FROM guardians WHERE talent_id = ?", [id]);
  const cs = await db.all("SELECT signed, signed_at, signature, status, version FROM consents WHERE talent_id = ?", [id]);
  return {
    id,
    ...p,
    completion: comp.percent,
    completionChecklist: comp.checklist,
    status,
    photoCount: await photoCount(id),
    fastTrack: ft.length ? { version: ft[0].version, authorizedAt: ft[0].authorized_at } : null,
    guardian: gd.length ? JSON.parse(String(gd[0].data_json)) : null,
    consent: cs.length
      ? { signed: Number(cs[0].signed) === 1, signedAt: cs[0].signed_at, signature: cs[0].signature, status: cs[0].status, version: cs[0].version }
      : { signed: false, signedAt: null, signature: null, status: "UNSIGNED", version: "TTT-LIKENESS-v1.0" },
  };
}
async function requireTalentOrAdmin(req: Request, talentId: string): Promise<{ ok: boolean; res?: Response; talentId?: string; admin?: boolean }> {
  if (isAdmin(req)) return { ok: true, talentId, admin: true };
  const me = await talentFromToken(req);
  if (me && me === talentId) return { ok: true, talentId, admin: false };
  if (!me) return { ok: false, res: err(401, "authentication required") };
  return { ok: false, res: err(403, "not authorized for this talent") };
}

const LIKENESS_TEXT = `TOP TEA TALENTS — LIKENESS RELEASE (contract version TTT-LIKENESS-v1.0)

1. GRANT OF LIKENESS RIGHTS. By signing, you grant TOP TEA TALENTS the right to use your name, likeness, photographs, video, voice, and professional information to solicit, submit, and promote you for paid work, including sending your materials to casting directors, producers, employers, and agencies.

2. NON-EXCLUSIVE. This grant is non-exclusive. You remain free to seek and accept work through any other person or agency.

3. NO GUARANTEE OF BOOKINGS OR EARNINGS. TOP TEA TALENTS does not guarantee any bookings, auditions, callbacks, or earnings. Submission does not promise work.

4. COMMISSION. TOP TEA TALENTS takes 10-15% of each successful booking on a sliding scale (see commission settings: 10% at $100/day, rising to 15% at $1,000/day). Commission is deducted from the gross booking pay; you receive the net.

5. REVOCATION. You may revoke this release at any time by submitting a revocation in the platform. Revocation stops future submissions and removes you from the rotation; it does not undo submissions or promotions already made, and does not cancel bookings already confirmed.

6. MINORS. If the talent is under 18, a parent or legal guardian must also consent (guardian consent on file) before any submission. A minor's auto-submit is disabled until guardian consent is recorded.

7. NO SSN OR BANK DETAILS. TOP TEA TALENTS never collects your Social Security number or bank credentials through this platform.

8. TEST MODE. The platform is in TEST MODE: no submission is ever sent live and no payment is ever processed.`;

const AVAILABILITY = ["Available immediately", "Weekdays", "Weekends", "Evenings", "Flexible", "Specific dates", "Temporarily unavailable"];
const CATEGORIES = ["Film and television", "Background extras", "Featured extras", "Commercials", "Advertising", "Music videos", "Modeling", "Print campaigns", "Promotional events", "Brand activations", "Reality television", "Live events", "Corporate productions", "Specialty talent", "Other paid opportunities"];

// ---------- route handler ----------
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = req.method;
  if (method === "OPTIONS") return json({ ok: true });
  const seg = path.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } }); // e.g. ["api","v1","talent", id, ...] — decode so IDs with ":" (opportunities) resolve from encoded links
  if (seg[0] !== "api" || seg[1] !== "v1") return err(404, "not found");
  const rest = seg.slice(2);
  const q = url.searchParams;

  // ----- health / stats -----
  if (method === "GET" && rest.length === 1 && rest[0] === "health") {
    const counts = await countsAll();
    return ok({ version: VERSION, test_mode: true, submissions_paused: await submissionsPaused(), storage: db.storage, storage_durable: db.durable, counts });
  }
  if (method === "GET" && rest.length === 1 && rest[0] === "stats") {
    const c = await countsAll();
    return ok({
      talentCount: c.talents, opportunityCount: c.opportunities, verifiedOppCount: c.verifiedOpportunities,
      expiredOppCount: c.expiredOpportunities, productionIntelCount: c.productionIntel, sourceCount: c.sources,
      applicationCount: c.applications, pendingApprovalCount: c.pendingApproval, bookingCount: c.bookings,
      notificationCount: c.notifications, unreadCount: c.unreadNotifications, photoCount: c.photos,
      submissionsPaused: await submissionsPaused(),
    });
  }

  // ----- auth -----
  if (method === "POST" && rest.join("/") === "auth/register") {
    const b = await body(req);
    if (!b) return err(400, "invalid JSON");
    for (const f of ["email", "phone", "firstName", "lastName", "password"]) if (!b[f]) return err(400, `missing field: ${f}`);
    if (b.termsAccepted !== true) return err(400, "termsAccepted must be true");
    const email = String(b.email).toLowerCase().trim();
    const ex = await db.all("SELECT id FROM talents WHERE email = ?", [email]);
    if (ex.length) return err(409, "email already registered");
    const id = genId("tal");
    const hash = await Bun.password.hash(String(b.password));
    const profile: any = {
      email, phone: String(b.phone), firstName: String(b.firstName), lastName: String(b.lastName),
      professionalName: b.professionalName ? String(b.professionalName) : null,
      contactMethod: b.contactMethod ?? null, notifyEmail: b.notifyEmail ?? true, notifySms: b.notifySms ?? false,
      city: null, state: null, zip: null, location: null, travelRadius: null,
      availability: [], height: null, ageRange: null, adultOrMinor: null, languages: [], skills: [],
      experience: null, categories: [], unionAffiliation: null, minCompensation: null,
      clothing: {}, resume: null, demoReel: null, portfolioLinks: [],
      demographics: { race: null, ethnicity: null, gender: null, pronouns: null },
      visibility: "private", status: "PROFILE INCOMPLETE", completion: 0,
    };
    const ts = nowIso();
    await db.run("INSERT INTO talents (id, email, password_hash, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, email, hash, JSON.stringify(profile), ts, ts]);
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await db.run("INSERT INTO sessions (token, talent_id, created_at) VALUES (?, ?, ?)", [token, id, ts]);
    await upsertContact("talent", `${profile.firstName} ${profile.lastName}`, { email, phone: profile.phone });
    await audit("talent.register", "talent", id, id, { email, firstName: profile.firstName, lastName: profile.lastName });
    return json({ ok: true, talentId: id, token }, 201);
  }
  if (method === "POST" && rest.join("/") === "auth/login") {
    const ip = req.headers.get("x-forwarded-for") || "local";
    if (loginRateLimited(ip)) return err(429, "too many login attempts, try again in a minute");
    const b = await body(req);
    if (!b) return err(400, "invalid JSON");
    const email = String(b.email || "").toLowerCase().trim();
    const rows = await db.all("SELECT id, password_hash FROM talents WHERE email = ?", [email]);
    if (!rows.length) return err(401, "invalid email or password");
    const valid = await Bun.password.verify(String(b.password || ""), String(rows[0].password_hash));
    if (!valid) return err(401, "invalid email or password");
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await db.run("INSERT INTO sessions (token, talent_id, created_at) VALUES (?, ?, ?)", [token, String(rows[0].id), nowIso()]);
    return ok({ token, talentId: String(rows[0].id) });
  }

  // ----- sources -----
  if (rest[0] === "sources") {
    if (method === "GET" && rest.length === 1) return ok({ sources: await allSources() });
    if (method === "POST" && rest.length === 1) {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || !b.name || !b.url) return err(400, "name and url are required");
      const id = b.id ? String(b.id) : genId("src");
      const rec = { id, name: b.name, url: b.url, category: b.category ?? null, tier: b.tier ?? 3, status: b.status ?? "NOT CONNECTED", connectionMethod: b.connectionMethod ?? null, provides: b.provides ?? null, tosStatus: b.tosStatus ?? null, updateFrequency: b.updateFrequency ?? null, verificationBasis: b.verificationBasis ?? null };
      await db.run("INSERT INTO sources (id, data_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json", [id, JSON.stringify(rec)]);
      await audit("source.create", "source", id, "admin", { name: rec.name });
      return json({ ok: true, source: rec }, 201);
    }
    return err(404, "not found");
  }

  // ----- settings -----
  if (rest.join("/") === "settings") {
    if (method === "GET") return ok({ testMode: true, submissionsPaused: await submissionsPaused(), repeatAgencyThreshold: await repeatThreshold(), repeatAgencyTopPercent: await repeatTopPercent() });
    if (method === "POST") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      if (typeof b.submissionsPaused === "boolean") await setSetting("submissions_paused", String(b.submissionsPaused));
      if (b.repeatAgencyThreshold !== undefined) {
        const t = Number(b.repeatAgencyThreshold);
        if (!Number.isFinite(t) || t < 1) return err(400, "repeatAgencyThreshold must be a positive number");
        await setSetting("repeat_agency_threshold", String(Math.floor(t)));
      }
      if (b.repeatAgencyTopPercent !== undefined) {
        const tp = Number(b.repeatAgencyTopPercent);
        if (!Number.isFinite(tp) || tp < 0 || tp > 100) return err(400, "repeatAgencyTopPercent must be 0–100 (0 disables the top-% rule)");
        await setSetting("repeat_agency_top_percent", String(Math.floor(tp)));
      }
      await audit("settings.update", "settings", "settings", "admin", { submissionsPaused: await submissionsPaused(), repeatAgencyThreshold: await repeatThreshold(), repeatAgencyTopPercent: await repeatTopPercent(), note: "TEST MODE stays on: even unpaused, TEST MODE blocks every submission." });
      return ok({ testMode: true, submissionsPaused: await submissionsPaused(), repeatAgencyThreshold: await repeatThreshold(), repeatAgencyTopPercent: await repeatTopPercent() });
    }
  }

  // ----- commission -----
  if (rest.join("/") === "commission-settings") {
    if (method === "GET") return ok(await commissionSettings());
    if (method === "PATCH") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      const cur = await commissionSettings();
      const next = {
        floorDaily: b.floorDaily ?? cur.floorDaily, floorRate: b.floorRate ?? cur.floorRate,
        ceilingDaily: b.ceilingDaily ?? cur.ceilingDaily, ceilingRate: b.ceilingRate ?? cur.ceilingRate,
      };
      for (const [k, v] of Object.entries(next)) if (typeof v !== "number" || !Number.isFinite(v)) return err(400, `${k} must be a number`);
      if (next.floorRate < 0 || next.floorRate > 100 || next.ceilingRate < 0 || next.ceilingRate > 100) return err(400, "rates must be between 0 and 100");
      if (next.ceilingDaily <= next.floorDaily) return err(400, "ceilingDaily must be greater than floorDaily");
      await setSetting("commission_floor_daily", String(next.floorDaily));
      await setSetting("commission_floor_rate", String(next.floorRate));
      await setSetting("commission_ceiling_daily", String(next.ceilingDaily));
      await setSetting("commission_ceiling_rate", String(next.ceilingRate));
      await audit("commission.settings.update", "settings", "commission-settings", "admin", next);
      return ok(next);
    }
  }
  if (method === "GET" && rest.join("/") === "commission/calculate") {
    const gross = Number(q.get("gross"));
    if (!Number.isFinite(gross) || gross < 0) return err(400, "gross must be a non-negative number");
    const type = q.get("type") || "daily";
    const hours = q.get("hours") ? Number(q.get("hours")) : null;
    const s = await commissionSettings();
    const daily = type === "hourly" ? gross * (hours ?? 8) : gross;
    const rate = commissionRate(type === "hourly" || type === "daily" || type === "flat" ? daily : null, s);
    const grossCents = Math.round(gross * 100);
    const { feeCents, netCents } = commissionFor(grossCents, rate);
    return ok({ gross, rate, fee: feeCents / 100, net: netCents / 100, grossCents, feeCents, netCents, normalizedDaily: daily });
  }

  // ----- admin seed -----
  if (method === "POST" && rest.join("/") === "admin/seed") {
    const adm = requireAdmin(req); if (adm) return adm;
    const r = await loadSeed();
    const total = await countsAll();
    if (r.inserted > 0 || r.intelInserted > 0 || r.sourcesInserted > 0) {
      await ledgerAppend("seed.import", "seed", "seed-2026-11-21", "admin", { opportunities: total.opportunities, productionIntel: total.productionIntel, sources: total.sources, inserted: r.inserted, note: "Admin re-seed; existing IDs skipped." });
    }
    return ok({ inserted: r.inserted, skipped: r.skipped, intelInserted: r.intelInserted, intelSkipped: r.intelSkipped, sourcesInserted: r.sourcesInserted, sourcesSkipped: r.sourcesSkipped });
  }

  // ----- cubicles -----
  if (rest[0] === "cubicles") {
    if (method === "GET" && rest.length === 1) {
      const rows = await db.all("SELECT data_json, status FROM cubicles");
      return ok({ cubicles: rows.map((r) => ({ ...JSON.parse(String(r.data_json)), status: r.status })) });
    }
    if (method === "POST" && rest.length === 1) {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      const id = genId("cub");
      const rec = { id, ...b, status: b.status ?? "OPEN" };
      await db.run("INSERT INTO cubicles (id, data_json, status, created_at) VALUES (?, ?, ?, ?)", [id, JSON.stringify(rec), rec.status, nowIso()]);
      await audit("cubicle.create", "cubicle", id, "admin", { name: rec.name ?? null });
      return json({ ok: true, cubicle: rec }, 201);
    }
    if (method === "PATCH" && rest.length === 3 && rest[2] === "status") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || !b.status) return err(400, "status is required");
      const rows = await db.all("SELECT data_json FROM cubicles WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "cubicle not found");
      const rec = { ...JSON.parse(String(rows[0].data_json)), status: String(b.status) };
      await db.run("UPDATE cubicles SET data_json = ?, status = ? WHERE id = ?", [JSON.stringify(rec), rec.status, rest[1]]);
      await audit("cubicle.status", "cubicle", rest[1], "admin", { status: rec.status });
      return ok({ cubicle: rec });
    }
    return err(404, "not found");
  }

  // ----- ledger -----
  if (rest[0] === "ledger") {
    if (method === "GET" && rest.length === 1) {
      const limit = Math.min(Math.max(Number(q.get("limit") || 100), 1), 500);
      const offset = Math.max(Number(q.get("offset") || 0), 0);
      const conds: string[] = []; const args: any[] = [];
      if (q.get("event_type")) { conds.push("event_type = ?"); args.push(q.get("event_type")); }
      if (q.get("entity_id")) { conds.push("entity_id = ?"); args.push(q.get("entity_id")); }
      if (q.get("from")) { conds.push("ts >= ?"); args.push(q.get("from")); }
      if (q.get("to")) { conds.push("ts <= ?"); args.push(q.get("to")); }
      const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
      const total = await db.all(`SELECT COUNT(*) AS n FROM ledger_events ${where}`, args);
      const rows = await db.all(`SELECT * FROM ledger_events ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
      return ok({ events: rows.map(ledgerRow), total: Number(total[0]?.n ?? 0) });
    }
    if (method === "POST" && rest.length === 2 && rest[1] === "note") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || !String(b.note || "").trim()) return err(400, "note is required");
      const noteData: any = { note: String(b.note).trim() };
      if (String(b.event_type || "").trim()) noteData.event_type = String(b.event_type).trim();
      const seq = await ledgerAppend("ledger.note", String(b.entity_type || "note"), String(b.entity_id || "manual"), "admin", noteData);
      return json({ ok: true, seq }, 201);
    }
    if (method === "GET" && rest.length === 2 && rest[1] === "verify") {
      const rows = await db.all("SELECT * FROM ledger_events ORDER BY seq ASC");
      let prev = "GENESIS"; let valid = true; let firstBad: number | null = null;
      for (const r of rows) {
        let data: any = {};
        try { data = JSON.parse(String(r.data_json || "{}")); } catch { data = {}; }
        const expect = sha256(String(r.prev_hash) + "|" + canonical({ seq: Number(r.seq), ts: String(r.ts), event_type: String(r.event_type), entity_type: String(r.entity_type), entity_id: String(r.entity_id), actor: String(r.actor), data }));
        if (String(r.prev_hash) !== prev || expect !== String(r.hash)) { valid = false; firstBad = Number(r.seq); break; }
        prev = String(r.hash);
      }
      return ok({ events: rows.length, head_seq: rows.length ? Number(rows[rows.length - 1].seq) : 0, head_hash: rows.length ? String(rows[rows.length - 1].hash) : "GENESIS", valid, first_bad_seq: firstBad });
    }
    if (method === "GET" && rest.length === 2 && rest[1] === "export") {
      const rows = await db.all("SELECT * FROM ledger_events ORDER BY seq ASC");
      const lines = rows.map((r) => JSON.stringify(ledgerRow(r))).join("\n");
      return new Response(lines + (lines ? "\n" : ""), { headers: { "Content-Type": "application/x-ndjson", "Content-Disposition": 'attachment; filename="top-tea-talents-ledger.jsonl"', "Access-Control-Allow-Origin": "*" } });
    }
    return err(404, "not found");
  }

  // ----- contacts -----
  if (method === "GET" && rest.join("/") === "contacts") {
    const rows = await db.all("SELECT * FROM contacts ORDER BY kind, name");
    const apps = await db.all("SELECT talent_id, opportunity_id FROM applications");
    const books = await db.all("SELECT talent_id, opportunity_id FROM bookings");
    const opps = await allOpps();
    const oppAgency = new Map<string, string>();
    for (const o of opps) oppAgency.set(String(o.id), normName(String(o.casting_org || o.employer || "")));
    const out = [];
    for (const r of rows) {
      let data: any = {};
      try { data = JSON.parse(String(r.data_json || "{}")); } catch { data = {}; }
      let applications = 0, bookings = 0;
      if (r.kind === "talent") {
        const tid = data.talentId as string | undefined;
        applications = apps.filter((a) => String(a.talent_id) === tid).length;
        bookings = books.filter((a) => String(a.talent_id) === tid).length;
      } else {
        const n = String(r.normalized);
        const ids = new Set(opps.filter((o) => normName(String(o.casting_org || o.employer || o.casting_professional || o.production || "")) === n).map((o) => String(o.id)));
        applications = apps.filter((a) => ids.has(String(a.opportunity_id))).length;
        bookings = books.filter((a) => ids.has(String(a.opportunity_id))).length;
      }
      out.push({ id: r.id, kind: r.kind, name: r.name, email: r.email, phone: r.phone, city: r.city, state: r.state, source: r.source, applications, bookings, ...data });
    }
    return ok({ contacts: out, total: out.length });
  }

  // ----- agencies -----
  if (rest[0] === "agencies") {
    if (method === "GET" && rest.length === 1) return ok({ agencies: await agencyStats() });
    if (method === "GET" && rest.length === 3 && rest[2] === "history") {
      const agencies = await agencyStats();
      const ag = agencies.find((a: any) => a.id === rest[1]);
      if (!ag) return err(404, "agency not found");
      return ok(await agencyHistory(ag));
    }
    return err(404, "not found");
  }

  // ----- talent -----
  if (rest[0] === "talent") {
    if (method === "GET" && rest.length === 1) {
      const adm = requireAdmin(req); if (adm) return adm;
      const rows = await db.all("SELECT id FROM talents ORDER BY created_at");
      const list = [];
      for (const r of rows) list.push(await talentView(String(r.id)));
      return ok({ talents: list, total: list.length });
    }
    const talentId = rest[1];
    if (!talentId) return err(404, "not found");
    // sub-routes
    if (rest.length === 3 && rest[2] === "audit" && method === "GET") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const rows = await db.all("SELECT * FROM ledger_events WHERE entity_id = ? ORDER BY seq ASC", [talentId]);
      return ok({ talentId, events: rows.map(ledgerRow), total: rows.length });
    }
    if (rest.length === 3 && rest[2] === "photos") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      if (method === "GET") return ok({ photos: await photoList(talentId) });
      if (method === "POST") {
        if (!chk.admin && (await talentFromToken(req)) !== talentId) return err(403, "not authorized for this talent");
        const b = await body(req);
        if (!b) return err(400, "invalid JSON");
        const slot = Number(b.slot);
        if (!Number.isInteger(slot) || slot < 1 || slot > 8) return err(400, "slot must be an integer 1-8");
        const dataUrl = String(b.dataUrl || "");
        const m = dataUrl.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return err(400, "dataUrl must be data:image/jpeg|png|webp;base64,...");
        const buf = Buffer.from(m[3], "base64");
        if (buf.length > 500 * 1024) return err(400, `photo decoded size ${buf.length} bytes exceeds the 500KB limit — downscale the image first and retry`);
        const existing = await db.all("SELECT COUNT(*) AS n FROM photos WHERE talent_id = ?", [talentId]);
        if (Number(existing[0]?.n ?? 0) >= 8) return err(400, "maximum 8 photos per talent");
        const id = genId("ph");
        const isPrimary = slot === 1 || Number(existing[0]?.n ?? 0) === 0 ? 1 : 0;
        if (isPrimary) await db.run("UPDATE photos SET is_primary = 0 WHERE talent_id = ?", [talentId]);
        await db.run("INSERT INTO photos (id, talent_id, slot, label, caption, is_primary, sort_order, mime, data_base64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, talentId, slot, SLOT_LABELS[slot], b.caption ? String(b.caption) : null, isPrimary, slot, m[1], m[3], nowIso()]);
        await audit("talent.photo.add", "talent", talentId, talentId, { photoId: id, slot, label: SLOT_LABELS[slot] });
        return json({ ok: true, photo: (await photoList(talentId)).find((p: any) => p.id === id) }, 201);
      }
      return err(404, "not found");
    }
    if (rest.length === 3 && rest[2] === "fast-track") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      if (method === "GET") {
        const rows = await db.all("SELECT data_json, version, authorized_at FROM fast_track WHERE talent_id = ?", [talentId]);
        if (!rows.length) return ok({ fastTrack: null, version: null });
        return ok({ fastTrack: JSON.parse(String(rows[0].data_json)), version: rows[0].version, authorizedAt: rows[0].authorized_at });
      }
      if (method === "POST") {
        const b = await body(req);
        if (!b) return err(400, "invalid JSON");
        const existing = await db.all("SELECT version FROM fast_track WHERE talent_id = ?", [talentId]);
        let version = "v1.0";
        if (existing.length) {
          const cur = parseFloat(String(existing[0].version).replace(/^v/, "")) || 1.0;
          version = "v" + (Math.round((cur + 0.1) * 10) / 10).toFixed(1);
        }
        const ft = {
          controls: b.controls ?? {},
          rules: b.rules ?? { categories: [], geography: null, minHourly: null, minDaily: null, minFlat: null, showUndisclosed: false, travel: null, availability: [], approvedMaterials: [] },
          autoSubmit: b.autoSubmit === true,
        };
        const ts = nowIso();
        await db.run("INSERT INTO fast_track (talent_id, data_json, version, authorized_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(talent_id) DO UPDATE SET data_json = excluded.data_json, version = excluded.version, authorized_at = excluded.authorized_at, updated_at = excluded.updated_at",
          [talentId, JSON.stringify(ft), version, ts, ts]);
        await audit("talent.fast-track.save", "talent", talentId, talentId, { version, autoSubmit: ft.autoSubmit });
        return ok({ fastTrack: ft, version, authorizedAt: ts });
      }
      return err(404, "not found");
    }
    if (rest.length === 3 && rest[2] === "guardian" && method === "POST") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      for (const f of ["guardianName", "guardianEmail", "guardianPhone", "relationship"]) if (!b[f]) return err(400, `missing field: ${f}`);
      const rec = { guardianName: b.guardianName, guardianEmail: b.guardianEmail, guardianPhone: b.guardianPhone, relationship: b.relationship, consentGiven: b.consentGiven === true };
      await db.run("INSERT INTO guardians (talent_id, data_json, created_at) VALUES (?, ?, ?) ON CONFLICT(talent_id) DO UPDATE SET data_json = excluded.data_json",
        [talentId, JSON.stringify(rec), nowIso()]);
      await audit("talent.guardian.save", "talent", talentId, talentId, { guardianName: rec.guardianName, consentGiven: rec.consentGiven });
      return ok({ guardian: rec });
    }
    if (rest.length === 3 && rest[2] === "likeness-release") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      if (method === "GET") {
        const rows = await db.all("SELECT signed, signed_at, signature, status, version FROM consents WHERE talent_id = ?", [talentId]);
        const c = rows.length ? rows[0] : null;
        return ok({
          contractVersion: "TTT-LIKENESS-v1.0",
          contractText: LIKENESS_TEXT,
          consent: c
            ? { signed: Number(c.signed) === 1, signedAt: c.signed_at, signature: c.signature, status: c.status, version: c.version }
            : { signed: false, signedAt: null, signature: null, status: "UNSIGNED", version: "TTT-LIKENESS-v1.0" },
        });
      }
      return err(404, "not found");
    }
    if (rest.length === 4 && rest[2] === "likeness-release" && rest[3] === "sign" && method === "POST") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const t = await loadTalent(talentId);
      if (!t) return err(404, "talent not found");
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      if (b.agreed !== true) return err(400, "agreed must be true");
      const sig = String(b.signature || "").trim();
      if (!sig) return err(400, "signature is required");
      const legal = `${t.profile.firstName ?? ""} ${t.profile.lastName ?? ""}`.trim().toLowerCase();
      const prof = String(t.profile.professionalName || "").trim().toLowerCase();
      if (sig.toLowerCase() !== legal && sig.toLowerCase() !== prof) return err(400, "signature must match your legal name or professional name");
      const comp = completionOf(t.profile);
      if (comp.percent < 100) return err(400, `profile must be 100% complete before signing (currently ${comp.percent}%)`);
      const ts = nowIso();
      await db.run("INSERT INTO consents (talent_id, signed, signed_at, signature, status, version, updated_at) VALUES (?, 1, ?, ?, 'SIGNED', 'TTT-LIKENESS-v1.0', ?) ON CONFLICT(talent_id) DO UPDATE SET signed = 1, signed_at = excluded.signed_at, signature = excluded.signature, status = 'SIGNED', version = 'TTT-LIKENESS-v1.0', updated_at = excluded.updated_at",
        [talentId, ts, sig, ts]);
      const status = await refreshStatus(talentId);
      await audit("consent.sign", "talent", talentId, talentId, { version: "TTT-LIKENESS-v1.0", signedAt: ts, signature: sig, status });
      return ok({ signed: true, signedAt: ts, signature: sig, status, version: "TTT-LIKENESS-v1.0" });
    }
    if (rest.length === 4 && rest[2] === "likeness-release" && rest[3] === "revoke" && method === "POST") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const ts = nowIso();
      await db.run("INSERT INTO consents (talent_id, signed, signed_at, signature, status, version, updated_at) VALUES (?, 0, NULL, NULL, 'REVOKED', 'TTT-LIKENESS-v1.0', ?) ON CONFLICT(talent_id) DO UPDATE SET signed = 0, status = 'REVOKED', updated_at = excluded.updated_at",
        [talentId, ts]);
      await refreshStatus(talentId);
      await audit("consent.revoke", "talent", talentId, talentId, { status: "REVOKED", note: "Removed from rotation; future applications blocked." });
      return ok({ signed: false, status: "REVOKED" });
    }
    if (rest.length === 3 && rest[2] === "review" && method === "POST") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      if (b.decision !== "PASS" && b.decision !== "FAIL") return err(400, 'decision must be "PASS" or "FAIL"');
      if (b.decision === "FAIL" && !b.reason) return err(400, "FAIL requires a reason");
      const id = genId("rvw");
      await db.run("INSERT INTO reviews (id, talent_id, decision, reason, created_at) VALUES (?, ?, ?, ?, ?)", [id, talentId, b.decision, b.reason ?? null, nowIso()]);
      const status = await refreshStatus(talentId);
      if (b.decision === "FAIL") {
        await notify(talentId, "Agency review: more information needed", `Your profile was not approved. Reason: ${b.reason}`);
      }
      await audit("review.decision", "talent", talentId, "admin", { decision: b.decision, reason: b.reason ?? null, status });
      return ok({ decision: b.decision, status });
    }
    if (rest.length === 3 && rest[2] === "match" && method === "POST") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const t = await loadTalent(talentId);
      if (!t) return err(404, "talent not found");
      const matches = matchTalent(t.profile, await allOpps());
      await audit("talent.match", "talent", talentId, talentId, { evaluated: matches.length, strong: matches.filter((m: any) => m.classification === "STRONG MATCH").length });
      return ok({ matches, demographicsNote: "Demographics are never used as a matching score. Matching uses location/travel radius, age/eligibility, skills, experience, availability, and compensation preferences only." });
    }
    if (rest.length === 3 && rest[2] === "rotation-queue" && method === "POST") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const gate = await rotationGate(talentId);
      if (gate) return gate;
      const t = await loadTalent(talentId);
      if (!t) return err(404, "talent not found");
      const b = (await body(req)) || {};
      const caps = { perDay: Number(b.caps?.perDay ?? b.perDay ?? 3), perWeek: Number(b.caps?.perWeek ?? b.perWeek ?? 10) };
      const queue = rotationQueue(t.profile, await allOpps(), caps, await existingBookings(talentId));
      await audit("talent.rotation-queue", "talent", talentId, talentId, { selected: queue.filter((x: any) => x.decision === "SELECTED").length, caps });
      return ok({ queue, caps });
    }
    if (rest.length === 3 && rest[2] === "queue-selected" && method === "POST") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const gate = await rotationGate(talentId);
      if (gate) return gate;
      const b = await body(req);
      if (!b || !Array.isArray(b.opportunityIds)) return err(400, "opportunityIds array is required");
      const created: any[] = []; const skipped: any[] = [];
      for (const oppId of b.opportunityIds) {
        const dup = await db.all("SELECT id FROM applications WHERE talent_id = ? AND opportunity_id = ?", [talentId, oppId]);
        if (dup.length) { skipped.push({ opportunityId: oppId, reason: "duplicate application" }); continue; }
        const oppRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [oppId]);
        if (!oppRows.length) { skipped.push({ opportunityId: oppId, reason: "opportunity not found" }); continue; }
        const id = genId("app");
        const ts = nowIso();
        await db.run("INSERT INTO applications (id, talent_id, opportunity_id, status, created_at, updated_at) VALUES (?, ?, ?, 'AWAITING APPROVAL', ?, ?)", [id, talentId, oppId, ts, ts]);
        await audit("application.create", "application", id, talentId, { talentId, opportunityId: oppId, status: "AWAITING APPROVAL", note: "TEST MODE: nothing was sent." });
        created.push({ id, talentId, opportunityId: oppId, status: "AWAITING APPROVAL" });
      }
      return ok({ applications: created, skipped, note: "TEST MODE: nothing was sent." });
    }
    if (rest.length === 3 && rest[2] === "notifications" && method === "GET") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const rows = await db.all("SELECT * FROM notifications WHERE talent_id = ? ORDER BY created_at DESC", [talentId]);
      return ok({ notifications: rows.map((r) => ({ id: r.id, talentId: r.talent_id, title: r.title, body: r.body, read: Number(r.read) === 1, createdAt: r.created_at })) });
    }
    // GET /talent/:id, PATCH, DELETE
    if (rest.length === 2 && method === "GET") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const v = await talentView(talentId);
      if (!v) return err(404, "talent not found");
      return ok({ talent: v });
    }
    if (rest.length === 2 && method === "PATCH") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const t = await loadTalent(talentId);
      if (!t) return err(404, "talent not found");
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      if (b.email !== undefined) return err(400, "email cannot be changed here");
      const allowed = ["phone", "firstName", "lastName", "professionalName", "contactMethod", "notifyEmail", "notifySms", "city", "state", "zip", "location", "travelRadius", "availability", "height", "ageRange", "adultOrMinor", "languages", "skills", "experience", "categories", "unionAffiliation", "minCompensation", "clothing", "clothingSizes", "measurements", "resume", "demoReel", "portfolioLinks", "demographics", "visibility", "hairColor", "eyeColor", "paused"];
      const p = { ...t.profile };
      for (const k of allowed) if (b[k] !== undefined) p[k] = b[k];
      if (p.availability !== undefined && !Array.isArray(p.availability)) return err(400, "availability must be an array");
      if (p.categories !== undefined && !Array.isArray(p.categories)) return err(400, "categories must be an array");
      await saveProfile(talentId, p);
      const status = await refreshStatus(talentId);
      await audit("talent.update", "talent", talentId, chk.admin ? "admin" : talentId, { fields: Object.keys(b), status });
      const v = await talentView(talentId);
      return ok({ talent: v });
    }
    if (rest.length === 2 && method === "DELETE") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      await db.run("DELETE FROM photos WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM fast_track WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM guardians WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM consents WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM notifications WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM sessions WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM talents WHERE id = ?", [talentId]);
      await audit("talent.delete", "talent", talentId, chk.admin ? "admin" : talentId, { note: "Profile, photos, fast-track, guardian, and notifications deleted." });
      return ok({ deleted: true, talentId });
    }
    return err(404, "not found");
  }

  // ----- photos by id -----
  if (rest[0] === "photos" && rest.length === 2) {
    const photoId = rest[1];
    const rows = await db.all("SELECT * FROM photos WHERE id = ?", [photoId]);
    if (!rows.length) return err(404, "photo not found");
    const ph = rows[0];
    const chk = await requireTalentOrAdmin(req, String(ph.talent_id)); if (!chk.ok) return chk.res!;
    if (method === "GET") {
      const buf = Buffer.from(String(ph.data_base64), "base64");
      return new Response(buf, { headers: { "Content-Type": String(ph.mime), "Access-Control-Allow-Origin": "*" } });
    }
    if (method === "PATCH") {
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      if (b.isPrimary === true) await db.run("UPDATE photos SET is_primary = 0 WHERE talent_id = ?", [ph.talent_id]);
      await db.run("UPDATE photos SET caption = ?, is_primary = ?, sort_order = ? WHERE id = ?",
        [b.caption !== undefined ? String(b.caption) : ph.caption, b.isPrimary !== undefined ? (b.isPrimary ? 1 : 0) : ph.is_primary, b.sortOrder !== undefined ? Number(b.sortOrder) : ph.sort_order, photoId]);
      await audit("talent.photo.update", "talent", String(ph.talent_id), String(ph.talent_id), { photoId });
      return ok({ photo: (await photoList(String(ph.talent_id))).find((p: any) => p.id === photoId) });
    }
    if (method === "DELETE") {
      await db.run("DELETE FROM photos WHERE id = ?", [photoId]);
      await audit("talent.photo.delete", "talent", String(ph.talent_id), String(ph.talent_id), { photoId });
      return ok({ deleted: true, photoId });
    }
    return err(404, "not found");
  }

  // ----- reviews list -----
  if (method === "GET" && rest.join("/") === "reviews") {
    const adm = requireAdmin(req); if (adm) return adm;
    const rows = await db.all("SELECT id FROM talents");
    const awaiting = [];
    for (const r of rows) {
      const v = await talentView(String(r.id));
      if (v && v.status === "AWAITING AGENCY REVIEW") awaiting.push(v);
    }
    return ok({ reviews: awaiting, total: awaiting.length });
  }

  // ----- opportunities -----
  if (rest[0] === "opportunities") {
    if (method === "GET" && rest.length === 1) {
      let list = (await allOpps()).map(oppWithExpiry);
      const expiredCount = list.filter((o) => o.expired).length;
      const liveCount = list.length - expiredCount;
      if (q.get("geography")) list = list.filter((o) => o.geography === q.get("geography"));
      if (q.get("category")) list = list.filter((o) => o.category === q.get("category"));
      if (q.get("verification_status")) list = list.filter((o) => o.verification_status === q.get("verification_status"));
      if (q.get("pay_type")) list = list.filter((o) => o.compensation_type === q.get("pay_type"));
      if (q.get("source")) list = list.filter((o) => o.source === q.get("source"));
      if (q.get("county")) list = list.filter((o) => o.location && o.location.county === q.get("county"));
      if (q.get("q")) {
        const needle = q.get("q")!.toLowerCase();
        list = list.filter((o) => JSON.stringify(o).toLowerCase().includes(needle));
      }
      // Live-vs-expired: explicit status wins; otherwise include_expired keeps
      // the old behaviour (default live only).
      const status = q.get("status");
      if (status === "live") list = list.filter((o) => !o.expired);
      else if (status === "expired") list = list.filter((o) => o.expired);
      else if (status === "all") { /* keep everything */ }
      else {
        const includeExpired = q.get("include_expired") === "true";
        if (!includeExpired) list = list.filter((o) => !o.expired);
      }
      // Date order: "date listed" is discovered_at (when we found the listing —
      // the source boards gave no per-listing posted date). Ties break by
      // deadline, then id, so the order is stable.
      const byDateDesc = (a: any, b: any) => String(b.discovered_at || "").localeCompare(String(a.discovered_at || ""))
        || String(b.deadline || "").localeCompare(String(a.deadline || ""))
        || String(a.id).localeCompare(String(b.id));
      const byDateAsc = (a: any, b: any) => String(a.discovered_at || "").localeCompare(String(b.discovered_at || ""))
        || String(a.deadline || "").localeCompare(String(b.deadline || ""))
        || String(a.id).localeCompare(String(b.id));
      const sort = q.get("sort");
      if (sort === "oldest") list.sort(byDateAsc);
      else if (sort === "newest") list.sort(byDateDesc);
      else list.sort((a, b) => Number(a.expired) - Number(b.expired) || byDateDesc(a, b));
      const total = list.length;
      const limit = Math.max(Number(q.get("limit") || 100), 1);
      const offset = Math.max(Number(q.get("offset") || 0), 0);
      return ok({ opportunities: list.slice(offset, offset + limit), total, expiredCount, liveCount });
    }
    if (method === "GET" && rest.length === 2) {
      const rows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "opportunity not found");
      return ok({ opportunity: oppWithExpiry(JSON.parse(String(rows[0].data_json))) });
    }
    if (method === "POST" && rest.length === 1) {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || !b.title) return err(400, "title is required");
      const id = b.id ? String(b.id) : genId("opp");
      const rec = { ...b, id, verification_status: b.verification_status ?? "UNVERIFIED", discovered_at: b.discovered_at ?? nowIso() };
      await db.run("INSERT INTO opportunities (id, data_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json", [id, JSON.stringify(rec)]);
      await audit("opportunity.create", "opportunity", id, "admin", { title: rec.title, source: rec.source ?? null });
      return json({ ok: true, opportunity: oppWithExpiry(rec) }, 201);
    }
    if (method === "PATCH" && rest.length === 3 && rest[2] === "verification") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || !b.verification) return err(400, "verification is required");
      const rows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "opportunity not found");
      // Lifecycle status is DERIVED from verification — single source of truth.
      const rec = { ...JSON.parse(String(rows[0].data_json)), verification_status: String(b.verification), verified_at: nowIso(), verification_notes: b.verification_notes ?? b.notes ?? null };
      await db.run("UPDATE opportunities SET data_json = ? WHERE id = ?", [JSON.stringify(rec), rest[1]]);
      await audit("opportunity.verification", "opportunity", rest[1], "admin", { verification_status: rec.verification_status });
      return ok({ opportunity: oppWithExpiry(rec) });
    }
    if (method === "DELETE" && rest.length === 2) {
      const adm = requireAdmin(req); if (adm) return adm;
      await db.run("DELETE FROM opportunities WHERE id = ?", [rest[1]]);
      await audit("opportunity.delete", "opportunity", rest[1], "admin", {});
      return ok({ deleted: true, opportunityId: rest[1] });
    }
    return err(404, "not found");
  }

  // ----- production intel -----
  if (rest[0] === "production-intel") {
    if (method === "GET" && rest.length === 1) {
      const list = await allIntel();
      return ok({ productionIntel: list, total: list.length });
    }
    if (method === "GET" && rest.length === 2) {
      const rows = await db.all("SELECT data_json FROM production_intel WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "production intel not found");
      return ok({ productionIntel: JSON.parse(String(rows[0].data_json)) });
    }
    return err(404, "not found");
  }

  // ----- applications -----
  if (rest[0] === "applications") {
    if (method === "POST" && rest.length === 1) {
      const b = await body(req);
      if (!b || !b.talentId || !b.opportunityId) return err(400, "talentId and opportunityId are required");
      const chk = await requireTalentOrAdmin(req, String(b.talentId)); if (!chk.ok) return chk.res!;
      const dup = await db.all("SELECT id FROM applications WHERE talent_id = ? AND opportunity_id = ?", [b.talentId, b.opportunityId]);
      if (dup.length) return err(409, "application already exists for this talent and opportunity");
      const oppRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [b.opportunityId]);
      if (!oppRows.length) return err(404, "opportunity not found");
      const id = genId("app");
      const ts = nowIso();
      await db.run("INSERT INTO applications (id, talent_id, opportunity_id, status, created_at, updated_at) VALUES (?, ?, ?, 'AWAITING APPROVAL', ?, ?)", [id, b.talentId, b.opportunityId, ts, ts]);
      await audit("application.create", "application", id, String(b.talentId), { talentId: b.talentId, opportunityId: b.opportunityId, status: "AWAITING APPROVAL", note: "TEST MODE: nothing was sent." });
      return json({ ok: true, application: { id, talentId: b.talentId, opportunityId: b.opportunityId, status: "AWAITING APPROVAL" }, note: "TEST MODE: nothing was sent." }, 201);
    }
    if (method === "GET" && rest.length === 1) {
      const rows = await db.all("SELECT * FROM applications ORDER BY created_at DESC");
      let list = rows.map((r) => ({ id: r.id, talentId: r.talent_id, opportunityId: r.opportunity_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at }));
      if (q.get("talentId")) list = list.filter((a) => a.talentId === q.get("talentId"));
      if (q.get("status")) list = list.filter((a) => a.status === q.get("status"));
      return ok({ applications: list, total: list.length });
    }
    if (method === "PATCH" && rest.length === 3 && rest[2] === "status") {
      const b = await body(req);
      if (!b || !b.status) return err(400, "status is required");
      const rows = await db.all("SELECT * FROM applications WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "application not found");
      const chk = await requireTalentOrAdmin(req, String(rows[0].talent_id)); if (!chk.ok) return chk.res!;
      const status = String(b.status);
      if (status === "SUBMITTED — CONFIRMED" || status === "SUBMITTED - CONFIRMED" || status === "SUBMITTED_CONFIRMED") {
        return err(400, "SUBMITTED — CONFIRMED is BLOCKED in TEST MODE: no submission is ever sent live. The application stays AWAITING APPROVAL until TEST MODE is lifted by the owner.");
      }
      await db.run("UPDATE applications SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), rest[1]]);
      await audit("application.status", "application", rest[1], String(rows[0].talent_id), { status });
      return ok({ application: { id: rest[1], talentId: rows[0].talent_id, opportunityId: rows[0].opportunity_id, status } });
    }
    if (method === "DELETE" && rest.length === 2) {
      const adm = requireAdmin(req); if (adm) return adm;
      await db.run("DELETE FROM applications WHERE id = ?", [rest[1]]);
      await audit("application.delete", "application", rest[1], "admin", {});
      return ok({ deleted: true, applicationId: rest[1] });
    }
    return err(404, "not found");
  }

  // ----- bookings -----
  if (rest[0] === "bookings") {
    if (method === "POST" && rest.length === 1) {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || !b.applicationId) return err(400, "applicationId is required");
      if (!b.evidence) return err(400, "evidence is required to record a booking");
      const appRows = await db.all("SELECT * FROM applications WHERE id = ?", [b.applicationId]);
      if (!appRows.length) return err(404, "application not found");
      const app = appRows[0];
      const oppRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [app.opportunity_id]);
      const opp = oppRows.length ? JSON.parse(String(oppRows[0].data_json)) : null;
      const grossDollars = b.gross !== undefined ? Number(b.gross) : parseMoney(opp?.compensation);
      const grossCents = grossDollars !== null && Number.isFinite(grossDollars) ? Math.round(grossDollars * 100) : 0;
      const s = await commissionSettings();
      const daily = normalizedDaily(opp?.compensation_type, opp?.compensation, opp?.hours);
      const rate = commissionRate(daily, s);
      const { feeCents, netCents } = commissionFor(grossCents, rate);
      const id = genId("bkg");
      const ts = nowIso();
      const status = b.status ?? "BOOKED";
      await db.run("INSERT INTO bookings (id, application_id, talent_id, opportunity_id, status, evidence, gross_cents, rate, commission_cents, net_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, b.applicationId, app.talent_id, app.opportunity_id, status, String(b.evidence), grossCents, rate, feeCents, netCents, ts, ts]);
      const t = await loadTalent(String(app.talent_id));
      const name = t ? `${t.profile.firstName ?? ""} ${t.profile.lastName ?? ""}`.trim() : String(app.talent_id);
      const title = opp?.title ?? String(app.opportunity_id);
      const summary = `Booking confirmed: ${title} for ${name}. Gross $${(grossCents / 100).toFixed(2)} — commission ${rate}% $${(feeCents / 100).toFixed(2)} — net $${(netCents / 100).toFixed(2)}. Evidence on file. TEST MODE: no payment processed.`;
      await notify(String(app.talent_id), `Booking confirmed: ${title}`, summary);
      const emailId = genId("eml");
      await db.run("INSERT INTO email_queue (id, talent_id, subject, body, status, created_at) VALUES (?, ?, ?, ?, 'QUEUED', ?)",
        [emailId, app.talent_id, `Booking confirmed: ${title}`, summary, ts]);
      await audit("booking.create", "booking", id, "admin", { applicationId: b.applicationId, talentId: app.talent_id, opportunityId: app.opportunity_id, status, grossCents, rate, commissionCents: feeCents, netCents, agency: opp ? (opp.casting_org || opp.employer || null) : null, email: "email pending: integration not connected" });
      return json({ ok: true, booking: bookingView({ id, application_id: b.applicationId, talent_id: app.talent_id, opportunity_id: app.opportunity_id, status, evidence: b.evidence, gross_cents: grossCents, rate, commission_cents: feeCents, net_cents: netCents, created_at: ts, updated_at: ts }), note: "Email queued only — email pending: integration not connected. No payment processed (TEST MODE)." }, 201);
    }
    if (method === "GET" && rest.length === 1) {
      const rows = await db.all("SELECT * FROM bookings ORDER BY created_at DESC");
      let list = rows.map(bookingView);
      if (q.get("talentId")) list = list.filter((x) => x.talentId === q.get("talentId"));
      if (q.get("status")) list = list.filter((x) => x.status === q.get("status"));
      return ok({ bookings: list, total: list.length });
    }
    if (method === "PATCH" && rest.length === 3 && rest[2] === "status") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || !b.status) return err(400, "status is required");
      const rows = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "booking not found");
      const status = String(b.status);
      const evidence = b.evidence ? String(b.evidence) : rows[0].evidence;
      if ((status === "BOOKED" || status === "BOOKING CONFIRMED") && !evidence) return err(400, "evidence is required to enter BOOKED / BOOKING CONFIRMED");
      await db.run("UPDATE bookings SET status = ?, evidence = ?, updated_at = ? WHERE id = ?", [status, evidence, nowIso(), rest[1]]);
      if (status === "BOOKED" || status === "BOOKING CONFIRMED") {
        const oppRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [rows[0].opportunity_id]);
        const opp = oppRows.length ? JSON.parse(String(oppRows[0].data_json)) : null;
        await notify(String(rows[0].talent_id), `Booking ${status === "BOOKED" ? "confirmed" : "confirmed"}: ${opp?.title ?? rows[0].opportunity_id}`,
          `Your booking is now ${status}. Gross $${(Number(rows[0].gross_cents || 0) / 100).toFixed(2)} — commission $${(Number(rows[0].commission_cents || 0) / 100).toFixed(2)} — net $${(Number(rows[0].net_cents || 0) / 100).toFixed(2)}. TEST MODE: no payment processed.`);
      }
      await audit("booking.status", "booking", rest[1], "admin", { status });
      const updated = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      return ok({ booking: bookingView(updated[0]) });
    }
    if (method === "PATCH" && rest.length === 3 && rest[2] === "payment") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || (b.status !== "PAYMENT_PENDING" && b.status !== "PAID")) return err(400, 'payment status must be "PAYMENT_PENDING" or "PAID"');
      const rows = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "booking not found");
      await db.run("UPDATE bookings SET updated_at = ? WHERE id = ?", [nowIso(), rest[1]]);
      await audit("booking.payment", "booking", rest[1], "admin", { paymentStatus: b.status, note: "Payment tracking only — no payment processed (TEST MODE)." });
      const updated = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      return ok({ booking: { ...bookingView(updated[0]), paymentStatus: b.status }, note: "Payment tracking only — no payment processed." });
    }
    return err(404, "not found");
  }

  // ----- notifications -----
  if (rest[0] === "notifications" && rest.length === 3 && rest[2] === "read" && method === "PATCH") {
    const rows = await db.all("SELECT * FROM notifications WHERE id = ?", [rest[1]]);
    if (!rows.length) return err(404, "notification not found");
    const chk = await requireTalentOrAdmin(req, String(rows[0].talent_id)); if (!chk.ok) return chk.res!;
    await db.run("UPDATE notifications SET read = 1 WHERE id = ?", [rest[1]]);
    await audit("notification.read", "notification", rest[1], String(rows[0].talent_id), {});
    return ok({ notification: { id: rest[1], read: true } });
  }
  if (rest[0] === "notifications" && rest.length === 2 && method === "DELETE") {
    const rows = await db.all("SELECT * FROM notifications WHERE id = ?", [rest[1]]);
    if (!rows.length) return err(404, "notification not found");
    const chk = await requireTalentOrAdmin(req, String(rows[0].talent_id)); if (!chk.ok) return chk.res!;
    await db.run("DELETE FROM notifications WHERE id = ?", [rest[1]]);
    await audit("notification.delete", "notification", rest[1], String(rows[0].talent_id), {});
    return ok({ deleted: true, notificationId: rest[1] });
  }

  return err(404, "not found");
}

function ledgerRow(r: Row): any {
  let data: any = {};
  try { data = JSON.parse(String(r.data_json || "{}")); } catch { data = {}; }
  return { seq: Number(r.seq), ts: r.ts, event_type: r.event_type, entity_type: r.entity_type, entity_id: r.entity_id, actor: r.actor, data, prev_hash: r.prev_hash, hash: r.hash };
}

async function photoList(talentId: string): Promise<any[]> {
  const rows = await db.all("SELECT id, talent_id, slot, label, caption, is_primary, sort_order, created_at FROM photos WHERE talent_id = ? ORDER BY sort_order ASC, slot ASC", [talentId]);
  return rows.map((r) => ({ id: r.id, talentId: r.talent_id, slot: Number(r.slot), label: r.label, caption: r.caption, isPrimary: Number(r.is_primary) === 1, sortOrder: Number(r.sort_order), url: `/api/v1/photos/${r.id}`, createdAt: r.created_at }));
}

async function notify(talentId: string, title: string, body: string): Promise<string> {
  const id = genId("ntf");
  await db.run("INSERT INTO notifications (id, talent_id, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)", [id, talentId, title, body, nowIso()]);
  await audit("notification.create", "notification", id, "system", { talentId, title });
  return id;
}

async function countsAll(): Promise<any> {
  const n = async (sql: string) => Number((await db.all(sql))[0]?.n ?? 0);
  const opps = await allOpps();
  return {
    talents: await n("SELECT COUNT(*) AS n FROM talents"),
    opportunities: opps.length,
    verifiedOpportunities: opps.filter((o) => o.verification_status === "VERIFIED").length,
    expiredOpportunities: opps.filter(oppExpired).length,
    productionIntel: await n("SELECT COUNT(*) AS n FROM production_intel"),
    sources: await n("SELECT COUNT(*) AS n FROM sources"),
    applications: await n("SELECT COUNT(*) AS n FROM applications"),
    pendingApproval: await n("SELECT COUNT(*) AS n FROM applications WHERE status = 'AWAITING APPROVAL'"),
    bookings: await n("SELECT COUNT(*) AS n FROM bookings"),
    notifications: await n("SELECT COUNT(*) AS n FROM notifications"),
    unreadNotifications: await n("SELECT COUNT(*) AS n FROM notifications WHERE read = 0"),
    photos: await n("SELECT COUNT(*) AS n FROM photos"),
  };
}

// ---------- matching ----------
function parseAgeRange(s: string | null | undefined): [number, number] | null {
  if (!s) return null;
  const m = String(s).match(/(\d+)\s*-\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function matchTalent(profile: any, opps: any[]): any[] {
  const out: any[] = [];
  const mySkills: Set<string> = new Set((profile.skills || []).map((s: string) => String(s).toLowerCase()));
  const myCats = new Set((profile.categories || []).map((s: string) => String(s).toLowerCase()));
  const myAvail = new Set((profile.availability || []).map((s: string) => String(s).toLowerCase()));
  const myAge = parseAgeRange(profile.ageRange);
  const myMin = profile.minCompensation != null ? Number(profile.minCompensation) : null;
  for (const o of opps) {
    if (oppExpired(o)) continue;
    const reasons: string[] = [];
    let score = 0;
    // Location / travel radius
    const geo = o.geography;
    const state = o.location?.state;
    const myState = profile.state;
    if (geo === "nationwide") { score += 1; reasons.push("Nationwide opportunity"); }
    else if (myState && state === myState) { score += 2; reasons.push(`Same state (${state})`); }
    else if (geo === "florida" && myState === "FL") { score += 1; reasons.push("Florida opportunity, talent is in Florida"); }
    else if (geo === "south-florida" && ["Miami-Dade", "Broward", "Palm Beach"].includes(o.location?.county ?? "")) { score += 1; reasons.push("South Florida opportunity"); }
    else { reasons.push("Location outside talent's area"); }
    // Age / eligibility
    const oppAge = parseAgeRange(o.age);
    if (myAge && oppAge) {
      if (myAge[0] <= oppAge[1] && oppAge[0] <= myAge[1]) { score += 2; reasons.push("Age range overlaps the role's age range"); }
      else { score -= 2; reasons.push("Age range does not overlap the role's age range"); }
    } else if (o.age) { reasons.push(`Role age: ${o.age}`); }
    // Skills
    const oppSkills = String(o.skills || "").toLowerCase();
    const matched = [...mySkills].filter((s) => s && oppSkills.includes(s));
    if (matched.length) { score += 1; reasons.push(`Skill match: ${matched.join(", ")}`); }
    // Experience
    if (profile.experience) { score += 1; reasons.push("Experience on file"); }
    // Availability
    if (myAvail.size) { score += 1; reasons.push("Availability on file"); }
    // Compensation preference
    const daily = normalizedDaily(o.compensation_type, o.compensation, o.hours);
    if (myMin !== null && daily !== null) {
      if (daily >= myMin) { score += 1; reasons.push(`Pay meets minimum compensation ($${daily}/day)`); }
      else { score -= 1; reasons.push(`Pay below minimum compensation ($${daily}/day < $${myMin})`); }
    } else if (daily === null) { reasons.push("Pay undisclosed — needs talent approval"); }
    let classification = "NOT QUALIFIED";
    if (score >= 6) classification = "STRONG MATCH";
    else if (score >= 4) classification = "QUALIFIED MATCH";
    else if (score >= 2) classification = "POTENTIAL MATCH";
    else if (daily === null) classification = "NEEDS TALENT APPROVAL";
    out.push({ opportunityId: o.id, classification, reasons, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------- rotation ----------
async function existingBookings(talentId: string): Promise<any[]> {
  const rows = await db.all("SELECT opportunity_id FROM bookings WHERE talent_id = ?", [talentId]);
  const out = [];
  for (const r of rows) {
    const o = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [r.opportunity_id]);
    if (o.length) out.push(JSON.parse(String(o[0].data_json)));
  }
  return out;
}
async function rotationGate(talentId: string): Promise<Response | null> {
  if (await submissionsPaused()) return err(400, "Submissions are paused. Rotation queue is unavailable while submissions are paused.");
  const t = await loadTalent(talentId);
  if (!t) return err(404, "talent not found");
  if (t.profile.paused === true) return err(400, "Profile is paused — unpause it in Settings to run the rotation queue.");
  const status = await deriveStatus(talentId, t.profile);
  const c = await db.all("SELECT signed FROM consents WHERE talent_id = ?", [talentId]);
  if (!c.length || Number(c[0].signed) !== 1) return err(400, "Likeness release must be signed before the rotation queue can run.");
  if (status === "REVOKED") return err(400, "Consent revoked — removed from rotation; future applications are blocked.");
  if (status !== "READY FOR MATCHING") return err(400, `Talent must be READY FOR MATCHING (currently ${status}) before the rotation queue can run.`);
  const ft = await db.all("SELECT data_json FROM fast_track WHERE talent_id = ?", [talentId]);
  if (!ft.length) return err(400, "Fast-track settings must be saved before the rotation queue can run.");
  const ftData = JSON.parse(String(ft[0].data_json));
  if (t.profile.adultOrMinor === "minor" || String(t.profile.ageRange || "").startsWith("0-")) {
    const g = await db.all("SELECT data_json FROM guardians WHERE talent_id = ?", [talentId]);
    const gd = g.length ? JSON.parse(String(g[0].data_json)) : null;
    if (!gd || gd.consentGiven !== true) return err(400, "Minor: guardian consent must be recorded before auto-submit or rotation.");
    if (ftData.autoSubmit === true) return err(400, "Minor: autoSubmit is forced off until guardian consent is recorded.");
  }
  return null;
}
function extractDateTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const s = String(text);
  const tokens = new Set<string>();
  for (const m of s.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) tokens.add(m[0]);
  for (const m of s.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s*&\s*(\d{1,2}))?(?:,?\s*(20\d\d))?/gi)) {
    tokens.add(m[1].toLowerCase() + "-" + m[2] + "-" + (m[4] || "2026"));
    if (m[3]) tokens.add(m[1].toLowerCase() + "-" + m[3] + "-" + (m[4] || "2026"));
  }
  return [...tokens];
}
function rotationQueue(profile: any, opps: any[], caps: { perDay: number; perWeek: number }, booked: any[]): any[] {
  const live = opps.filter((o) => !oppExpired(o));
  const ranked = live
    .map((o) => ({ o, daily: normalizedDaily(o.compensation_type, o.compensation, o.hours) }))
    .sort((a, b) => (b.daily ?? -1) - (a.daily ?? -1));
  const selected: any[] = [];
  const queue: any[] = [];
  const bookedTokens = new Set<string>();
  for (const b of booked) for (const t of extractDateTokens(b.production_dates || b.deadline)) bookedTokens.add(t);
  const bookedLocs = new Set(booked.map((b) => normName(String(b.location?.raw || ""))));
  for (const { o, daily } of ranked) {
    const tokens = extractDateTokens(o.production_dates || o.deadline);
    const loc = normName(String(o.location?.raw || ""));
    const hasTimes = tokens.length > 0;
    const overlapsBooked = hasTimes && tokens.some((t) => bookedTokens.has(t)) && !bookedLocs.has(loc);
    const overlapsSelected = hasTimes && selected.some((s) => {
      const st = extractDateTokens(s.production_dates || s.deadline);
      const sloc = normName(String(s.location?.raw || ""));
      return st.some((t) => tokens.includes(t)) && sloc !== loc;
    });
    const sameAddressCluster = hasTimes && selected.some((s) => {
      const st = extractDateTokens(s.production_dates || s.deadline);
      const sloc = normName(String(s.location?.raw || ""));
      return st.some((t) => tokens.includes(t)) && sloc === loc && loc !== "";
    });
    let decision = "SELECTED";
    let reason = hasTimes ? "Pay-first rank; no time/location conflict" : "times not stated — verify before submitting";
    if (overlapsBooked || overlapsSelected) { decision = "SKIPPED"; reason = "Overlapping time at a different location vs already-selected/booked work"; }
    else if (selected.length >= caps.perDay) { decision = "SKIPPED"; reason = `Daily cap reached (${caps.perDay}/day)`; }
    else if (selected.length >= caps.perWeek) { decision = "SKIPPED"; reason = `Weekly cap reached (${caps.perWeek}/week)`; }
    else if (daily === null) { reason = "times not stated — verify before submitting; pay undisclosed, ranked last"; }
    if (sameAddressCluster) reason += "; same-address non-overlapping cluster included";
    if (decision === "SELECTED") selected.push(o);
    queue.push({ opportunityId: o.id, decision, reason, normalizedDailyPay: daily });
  }
  return queue;
}

// ---------- agencies ----------
async function agencyStats(): Promise<any[]> {
  const opps = await allOpps();
  const apps = await db.all("SELECT opportunity_id FROM applications");
  const books = await db.all("SELECT * FROM bookings");
  const threshold = await repeatThreshold();
  const byName = new Map<string, any>();
  for (const o of opps) {
    const name = String(o.casting_org || o.employer || "").trim();
    if (!name) continue;
    const key = normName(name);
    if (!byName.has(key)) byName.set(key, { id: slugify(name), name, jobsPosted: 0, applicationsSent: 0, bookingsConfirmed: 0, totalGrossCents: 0, totalCommissionCents: 0, firstBookingAt: null as string | null, lastBookingAt: null as string | null, _oppIds: new Set<string>() });
    const a = byName.get(key);
    a.jobsPosted++;
    a._oppIds.add(String(o.id));
  }
  for (const app of apps) {
    const o = opps.find((x) => String(x.id) === String(app.opportunity_id));
    if (!o) continue;
    const key = normName(String(o.casting_org || o.employer || ""));
    const a = byName.get(key);
    if (a) a.applicationsSent++;
  }
  const now = Date.now();
  for (const b of books) {
    const o = opps.find((x) => String(x.id) === String(b.opportunity_id));
    if (!o) continue;
    const key = normName(String(o.casting_org || o.employer || ""));
    const a = byName.get(key);
    if (!a) continue;
    if (String(b.status) === "BOOKED" || String(b.status) === "BOOKING CONFIRMED") {
      a.bookingsConfirmed++;
      a.totalGrossCents += Number(b.gross_cents || 0);
      a.totalCommissionCents += Number(b.commission_cents || 0);
      const ts = String(b.created_at);
      if (!a.firstBookingAt || ts < a.firstBookingAt) a.firstBookingAt = ts;
      if (!a.lastBookingAt || ts > a.lastBookingAt) a.lastBookingAt = ts;
    }
  }
  const list = [...byName.values()].map((a) => {
    const { _oppIds, ...rest } = a;
    const oppIds = [..._oppIds];
    // Spike: bookings in last 30 days >= 2x prior monthly average, or first-ever booking after 3+ postings.
    let spike = false; let spikeReason: string | null = null;
    if (a.bookingsConfirmed >= 1 && a.jobsPosted >= 3 && a.bookingsConfirmed === 1) {
      spike = true; spikeReason = "First-ever booking after 3+ postings — relationship worth nurturing";
    }
    const last30 = books.filter((b) => {
      const o = opps.find((x) => String(x.id) === String(b.opportunity_id));
      if (!o || normName(String(o.casting_org || o.employer || "")) !== normName(a.name)) return false;
      if (!(String(b.status) === "BOOKED" || String(b.status) === "BOOKING CONFIRMED")) return false;
      return now - new Date(String(b.created_at)).getTime() <= 30 * 86400_000;
    }).length;
    const prior = a.bookingsConfirmed - last30;
    if (last30 > 0 && a.firstBookingAt) {
      const months = Math.max(1, (now - new Date(a.firstBookingAt).getTime()) / (30 * 86400_000));
      const avg = prior / months;
      if (last30 >= 2 * Math.max(avg, 0.5) && last30 >= 2) { spike = true; spikeReason = `Booking spike: ${last30} booking(s) in the last 30 days vs ${avg.toFixed(1)}/month prior average`; }
    }
    return { ...rest, repeatBadge: false, repeatReason: null as string | null, repeatThreshold: threshold, spike, spikeReason, opportunityIds: oppIds };
  });
  list.sort((x, y) => y.bookingsConfirmed - x.bookingsConfirmed || y.jobsPosted - x.jobsPosted);
  // Repeat rule (mirrors the artifact's monitor settings): at least N confirmed
  // bookings OR in the top P% by booking volume (default P=10, 0 disables it).
  const topPct = await repeatTopPercent();
  const booked = list.filter((a) => a.bookingsConfirmed > 0);
  const topCut = topPct > 0 && booked.length ? Math.max(1, Math.ceil((topPct / 100) * booked.length)) : 0;
  list.forEach((a, i) => {
    const byCount = a.bookingsConfirmed >= threshold;
    const byTop = topCut > 0 && a.bookingsConfirmed > 0 && i < topCut;
    a.repeatBadge = byCount || byTop;
    a.repeatReason = byCount && byTop ? `${threshold}+ bookings and top ${topPct}% by volume`
      : byCount ? `${threshold}+ bookings`
      : byTop ? `top ${topPct}% by volume` : null;
  });
  return list;
}
async function agencyHistory(ag: any): Promise<any> {
  const opps = await allOpps();
  const jobs = opps.filter((o) => normName(String(o.casting_org || o.employer || "")) === normName(ag.name)).map(oppWithExpiry);
  const ids = new Set(jobs.map((o) => String(o.id)));
  const apps = (await db.all("SELECT * FROM applications")).filter((a) => ids.has(String(a.opportunity_id)))
    .map((r) => ({ id: r.id, talentId: r.talent_id, opportunityId: r.opportunity_id, status: r.status, createdAt: r.created_at }));
  const books = (await db.all("SELECT * FROM bookings")).filter((b) => ids.has(String(b.opportunity_id))).map(bookingView);
  const payments = books.map((b: any) => ({ bookingId: b.id, status: "TRACKING ONLY", grossCents: b.grossCents, commissionCents: b.commissionCents, netCents: b.netCents, note: "Payment tracking only — no payment processed (TEST MODE)." }));
  const events = (await db.all("SELECT * FROM ledger_events ORDER BY seq ASC"))
    .map(ledgerRow)
    .filter((e: any) => ids.has(String(e.data?.opportunityId)) || String(e.data?.agency || "") === ag.name || normName(String(e.data?.agency || "")) === normName(ag.name));
  return { agency: ag, jobs, applications: apps, bookings: books, payments, events, total: jobs.length + apps.length + books.length + events.length };
}

function bookingView(r: Row): any {
  return {
    id: r.id, applicationId: r.application_id, talentId: r.talent_id, opportunityId: r.opportunity_id,
    status: r.status, evidence: r.evidence, grossCents: Number(r.gross_cents ?? 0), rate: Number(r.rate ?? 0),
    commissionCents: Number(r.commission_cents ?? 0), netCents: Number(r.net_cents ?? 0),
    gross: Number(r.gross_cents ?? 0) / 100, fee: Number(r.commission_cents ?? 0) / 100, net: Number(r.net_cents ?? 0) / 100,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---------- serve ----------
Bun.serve({
  port: PORT,
  async fetch(req) {
    try {
      return await handle(req);
    } catch (e: any) {
      console.error(e);
      return err(500, e?.message || "internal error");
    }
  },
});
console.log(`TOP TEA TALENTS API listening on :${PORT} (storage: ${db.storage}, durable: ${db.durable}, TEST MODE on)`);
