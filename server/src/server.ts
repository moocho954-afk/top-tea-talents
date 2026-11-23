// TOP TEA TALENTS — public backend API. Bun + TypeScript, ZERO npm dependencies.
// LIVE MODE (v1.3.0): sending is gated by liveMode() — env TTT_LIVE_MODE=true
// OR the DB setting `live_mode`. In TEST MODE (the default) no external
// submission call is ever made; email is queued only and never claimed as
// sent. In live mode, application emails send through the Gmail API
// (src/mailer.ts) from the agency mailbox (setting `agency_email`); every
// send is written to the ledger with its Gmail message id. Never collect
// SSN or bank credentials. Free-only: no paid service anywhere.
import { createHash, randomInt, randomUUID } from "node:crypto";
import { createDb, type Db, type Row } from "./libsql.js";
import { appendMirror, bootRestoreIfNeeded, defaultMirrorPath, readMirrorText, rebuildMirrorFromDb, verifyMirrorFile } from "./mirror.js";
import { extractEmail, mailStatus, sendGmail } from "./mailer.js";
import { MISSING_INFO_QUESTIONS, TAYLORMADE_MIAMI_VICE_DATES, shortCode, type MissingInfoQuestion } from "./missing-info-questions.js";

const VERSION = "1.3.2";
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const SEED_DIR = import.meta.dir + "/../seed";

const db: Db = createDb();

// Wipe-proof ledger mirror (see src/mirror.ts): every ledger event is also
// appended to a JSONL mirror file next to the DB, carrying the full state
// snapshot, so a wiped DB can be rebuilt from the mirror on boot. The file
// is the durable artifact a collector pushes to the repo (see
// prototype/ledger-mirror-recorder.yml — not activated yet).
const MIRROR_PATH = defaultMirrorPath();

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

// ---------- public site origin (talent-facing SPA links) ----------
// v1.3.2 live proof (2026-11-23): PUBLIC_URL on Render points at the API
// host (top-tea-talents-api.onrender.com), which serves JSON and 404s at
// its root — it can never serve the SPA. The missing-info alert email
// linked `${PUBLIC_URL}/#/complete-profile` and the link was dead. Every
// talent-facing link (#/talent/:id, #/complete-profile) must point at the
// Pages site, so PUBLIC_URL is honoured ONLY when it is set and does not
// point at an onrender.com host; anything else (unset, or the API host)
// falls back to the Pages origin. A future custom domain still works —
// any non-onrender PUBLIC_URL is used as-is.
const PAGES_ORIGIN = "https://moocho954-afk.github.io/top-tea-talents";
function publicBase(): string {
  const env = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  if (env && !env.includes("onrender.com")) return env;
  return PAGES_ORIGIN;
}

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
// ---------- v1.3.0: live mode ----------
// Live mode is ON when the deploy env says so OR the admin flips the DB
// setting. Either switch turns it on; turning it off requires both off.
// Default is TEST MODE (off) — sending is impossible until the owner
// deliberately enables it. The sender address is a DB setting so the
// agency mailbox can swap (moocho954@gmail.com today, topteatalents@
// gmail.com once that mailbox exists) without a redeploy.
async function liveMode(): Promise<boolean> {
  if ((process.env.TTT_LIVE_MODE || "").toLowerCase() === "true") return true;
  return (await getSetting("live_mode", "false")) === "true";
}
async function agencyEmail(): Promise<string> {
  const v = (await getSetting("agency_email", "moocho954@gmail.com")).trim();
  return v || "moocho954@gmail.com";
}
// The note that travels with application creates: honest in both modes.
async function modeNote(): Promise<string> {
  return (await liveMode()) ? "Live mode: queued for agency send." : "TEST MODE: nothing was sent.";
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
// state (optional): the full record snapshot AFTER this change, carried
// into the mirror so boot-restore can rebuild the DB from the mirror
// alone. Never a secret: no password hash, no session token, no photo bytes.
async function ledgerAppend(eventType: string, entityType: string, entityId: string, actor: string, data: any, state: any = null): Promise<number> {
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
  // Mirror the event (with its state) to the durable JSONL log. Awaited:
  // the mirror is fsync'd before this call returns. A mirror failure is
  // logged loudly by appendMirror but never fails the API call — the DB
  // row above is the live record; POST /ledger/mirror/rebuild re-syncs.
  await appendMirror(MIRROR_PATH, { seq, ts, event_type: eventType, entity_type: entityType, entity_id: entityId, actor, data: data ?? {}, prev_hash: prevHash, hash }, state);
  return seq;
}

async function audit(action: string, entityType: string, entityId: string, actor: string, data: any, state: any = null): Promise<void> {
  const ts = nowIso();
  await db.run(
    "INSERT INTO audit_log (id, ts, actor, action, entity_type, entity_id, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [genId("aud"), ts, actor, action, entityType, entityId, JSON.stringify(data ?? {})],
  ).catch(() => {});
  await ledgerAppend(action, entityType, entityId, actor, data ?? {}, state);
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

// Completion: TWO numbers, kept apart on purpose (owner orders 2026-11-22).
// - corePercent: the 6 CORE items only (contact, name, location, height,
//   age range, experience). THIS is the release/status gate: nothing
//   optional ever blocks signing, so a talent who skips categories,
//   photos, or social links can still sign and be READY FOR MATCHING.
// - percent: honest profile richness (core 60 + photos 10 + categories 10
//   + availability 5 + gender 5 + social-verified 10). A bare record with
//   only the 6 core items reads 60%, never 100% — the Dashboard shows
//   this number. Photos/social need live counts, so completionOf takes an
//   optional extras param; callers without it get core-only richness.
// (Before v1.2.0 the Dashboard showed the 6-core number alone, so a bare
// record with 0 photos and no categories read "100%".)
const COMPLETION_ITEMS: { key: string; label: string; check: (p: any) => boolean }[] = [
  { key: "contact", label: "Contact info (email + phone)", check: (p) => !!p.email && !!p.phone },
  { key: "name", label: "Legal name", check: (p) => !!p.firstName && !!p.lastName },
  { key: "location", label: "Location (city, state, zip)", check: (p) => !!p.city && !!p.state && !!p.zip },
  { key: "height", label: "Height", check: (p) => !!p.height },
  { key: "age_range", label: "Age range", check: (p) => !!p.ageRange },
  { key: "experience", label: "Experience", check: (p) => !!p.experience },
];
const RICHNESS_ITEMS: { key: string; label: string; points: number; check: (p: any, x?: { photos?: number; socialVerified?: boolean }) => boolean }[] = [
  { key: "photos", label: "Portfolio photos", points: 10, check: (p, x) => (x?.photos ?? 0) > 0 },
  { key: "categories", label: "Categories", points: 10, check: (p) => Array.isArray(p.categories) && p.categories.length > 0 },
  { key: "availability", label: "Availability", points: 5, check: (p) => Array.isArray(p.availability) && p.availability.length > 0 },
  { key: "gender", label: "Gender", points: 5, check: (p) => !!(p.demographics?.gender || p.gender) },
  { key: "social", label: "Verified social link", points: 10, check: (p, x) => x?.socialVerified === true },
];
function completionOf(p: any, extras?: { photos?: number; socialVerified?: boolean }): { percent: number; corePercent: number; checklist: { key: string; label: string; done: boolean; points: number }[] } {
  const core = COMPLETION_ITEMS.map((i) => ({ key: i.key, label: i.label, done: i.check(p), points: 10 }));
  const coreDone = core.filter((c) => c.done).length;
  const corePercent = Math.round((coreDone / core.length) * 100);
  const rich = RICHNESS_ITEMS.map((i) => ({ key: i.key, label: i.label, done: i.check(p, extras), points: i.points }));
  const richPoints = rich.filter((c) => c.done).reduce((s, c) => s + c.points, 0);
  return { percent: coreDone * 10 + richPoints, corePercent, checklist: [...core, ...rich] };
}
async function deriveStatus(talentId: string, profile: any): Promise<string> {
  const c = await db.all("SELECT signed, status FROM consents WHERE talent_id = ?", [talentId]);
  const consent = c.length ? c[0] : null;
  if (consent && String(consent.status) === "REVOKED") return "REVOKED";
  const pct = completionOf(profile).corePercent;
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
  const sel = deriveSelectivity(o);
  const dg = deriveOppGenders(o);
  return { ...o, expired: oppExpired(o), selectivity: sel.class, selectivityReason: sel.reason, genderRequirement: dg.genders === "open" ? null : dg.genders };
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
// v12–v14: bring pre-existing social tables up to the new columns.
// Idempotent: duplicate-column errors are caught and ignored, so this is
// safe on fresh DBs (CREATE TABLE already has the columns) and on live DBs
// built by v11. Then v13 rule 3 (migration): any record left LINKED or
// AUTHORIZED without a confirmed code is corrected to pending — never
// left authorized. Legacy PENDING rows become PENDING_VERIFICATION.
await migrateSocialV12();
// v1.3.0: email_queue gains addressing + delivery tracking columns so the
// drain can send real mail and prove it. Idempotent (same catch pattern).
await migrateMailV13();
// v1.3.1: bookings gain an event date (the 72-hour release rule needs a
// concrete booking date) + released_at. Idempotent (same catch pattern).
await migrateReleaseV131();
// v1.3.2: applications gain a submission snapshot, a portal submission
// link, and the agency outcome. Idempotent (same catch pattern).
await migrateAlertsV132();
async function migrateAlertsV132(): Promise<void> {
  const adds: [string, string][] = [
    ["applications", "snapshot_json TEXT"],
    ["applications", "submission_link TEXT"],
    ["applications", "outcome TEXT"],
    ["applications", "outcome_at TEXT"],
    ["applications", "outcome_detail_json TEXT"],
  ];
  for (const [table, col] of adds) {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${col}`).catch(() => {});
  }
}
async function migrateReleaseV131(): Promise<void> {
  const adds: [string, string][] = [
    ["bookings", "event_date TEXT"],
    ["bookings", "released_at TEXT"],
  ];
  for (const [table, col] of adds) {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${col}`).catch(() => {});
  }
}
async function migrateMailV13(): Promise<void> {
  const adds: [string, string][] = [
    ["email_queue", "to_addr TEXT"],
    ["email_queue", "cc TEXT"],
    ["email_queue", "reply_to TEXT"],
    ["email_queue", "application_id TEXT"],
    ["email_queue", "kind TEXT NOT NULL DEFAULT 'general'"],
    ["email_queue", "attempts INTEGER NOT NULL DEFAULT 0"],
    ["email_queue", "last_error TEXT"],
    ["email_queue", "sent_at TEXT"],
    ["email_queue", "message_id TEXT"],
  ];
  for (const [table, col] of adds) {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${col}`).catch(() => {});
  }
}
async function migrateSocialV12(): Promise<void> {
  const adds: [string, string][] = [
    ["social_links", "profile_url TEXT"],
    ["social_links", "verification_status TEXT NOT NULL DEFAULT 'code_issued'"],
    ["social_links", "ownership_code TEXT"],
    ["social_links", "signature_name TEXT"],
    ["social_links", "signed_at TEXT"],
    ["social_links", "check_detail TEXT"],
    ["social_links", "checked_at TEXT"],
    ["social_links", "pull_status TEXT NOT NULL DEFAULT ''"],
    ["social_links", "pull_detail TEXT"],
    ["social_links", "pulled_at TEXT"],
    ["social_links", "pull_rejected_count INTEGER NOT NULL DEFAULT 0"],
    ["social_photos", "mime TEXT"],
    ["social_photos", "data_base64 TEXT"],
    ["social_photos", "source_post_url TEXT"],
    ["social_photos", "source TEXT NOT NULL DEFAULT 'upload'"],
    ["social_photos", "selection TEXT"],
    ["social_photos", "identity_verdict TEXT"],
    ["social_photos", "identity_note TEXT"],
    ["social_photos", "likes_label TEXT"],
  ];
  for (const [table, col] of adds) {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${col}`).catch(() => {});
  }
  const ts = nowIso();
  await db.run("UPDATE social_links SET status = 'PENDING_VERIFICATION', verification_status = '', bio_checked = 0, updated_at = ? WHERE status IN ('LINKED', 'AUTHORIZED') AND COALESCE(verification_status, '') <> 'code_confirmed'", [ts]).catch(() => {});
  await db.run("UPDATE social_links SET status = 'PENDING_VERIFICATION', verification_status = '', updated_at = ? WHERE status = 'PENDING'", [ts]).catch(() => {});
}
// Wipe-proof boot-restore: if the local DB is empty (wiped) and a ledger
// mirror exists, replay the mirror into the fresh DB BEFORE the seed check
// runs, so staff-added state comes back first and the seed only fills what
// the mirror doesn't carry. A tampered mirror is REFUSED (boots from seed
// only) — see src/mirror.ts.
await bootRestoreIfNeeded(db, MIRROR_PATH, ledgerAppend);
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
  const comp = completionOf(p, {
    photos: await photoCount(id),
    socialVerified: (await db.all("SELECT id FROM social_links WHERE talent_id = ? AND status = 'AUTHORIZED'", [id])).length > 0,
  });
  const status = p.status || (await deriveStatus(id, p));
  const ft = await db.all("SELECT version, authorized_at FROM fast_track WHERE talent_id = ?", [id]);
  const gd = await db.all("SELECT data_json FROM guardians WHERE talent_id = ?", [id]);
  const cs = await db.all("SELECT signed, signed_at, signature, status, version FROM consents WHERE talent_id = ?", [id]);
  return {
    id,
    ...p,
    completion: comp.percent,
    coreCompletion: comp.corePercent,
    completionChecklist: comp.checklist,
    status,
    emailVerified: p.emailVerified === true,
    automation: await loadAutomation(id),
    portfolioLink: { path: `#/talent/${id}`, visibility: p.visibility || "private" },
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

// ---------- v16: community board helpers (Phase 0) ----------
// A talent's board handle: professional name (or full name) with
// spaces/punctuation stripped, lowercased — @moocho style. Mentions
// match on this handle and on the display name. Ported from artifact
// top-tea-talents v16 (boardDisplayName/boardHandle).
function boardDisplayName(p: any): string {
  const prof = String(p?.professionalName || "").trim();
  if (prof) return prof;
  const full = `${p?.firstName ?? ""} ${p?.lastName ?? ""}`.trim();
  return full || "Talent";
}
function boardHandle(p: any): string {
  const raw = boardDisplayName(p).toLowerCase().replace(/[^a-z0-9]/g, "");
  return raw || "talent";
}
// Owner token carried in a request BODY (the artifact's removeBoardPost
// takes ownerToken as a param). Validated against owner_sessions the
// same way ownerFromToken validates the Authorization header — a talent
// session token never passes this check.
async function ownerTokenValid(token: string): Promise<boolean> {
  if (!token) return false;
  const rows = await db.all("SELECT expires_at FROM owner_sessions WHERE token = ?", [token]);
  if (!rows.length) return false;
  if (new Date(String(rows[0].expires_at)).getTime() < Date.now()) {
    await db.run("DELETE FROM owner_sessions WHERE token = ?", [token]);
    return false;
  }
  return true;
}
async function boardPostView(r: any, viewerTalentId: string): Promise<any> {
  const author = await loadTalent(String(r.talent_id));
  const media = await db.all("SELECT * FROM board_post_media WHERE post_id = ? ORDER BY sort_order ASC LIMIT 1", [r.id]);
  const mentions = await db.all("SELECT * FROM board_mentions WHERE post_id = ?", [r.id]);
  const mentionViews: any[] = [];
  for (const m of mentions) {
    const t = await loadTalent(String(m.mentioned_talent_id));
    mentionViews.push({ talentId: String(m.mentioned_talent_id), name: t ? boardDisplayName(t.profile) : "Talent", handle: t ? boardHandle(t.profile) : "" });
  }
  return {
    id: String(r.id), talentId: String(r.talent_id),
    authorName: author ? boardDisplayName(author.profile) : "Talent",
    authorHandle: author ? boardHandle(author.profile) : "",
    body: String(r.body || ""),
    photoUrl: media.length ? `/api/v1/board/photos/${media[0].id}` : "",
    mentions: mentionViews,
    mentionsViewer: !!viewerTalentId && mentionViews.some((m) => m.talentId === viewerTalentId),
    createdAt: String(r.created_at),
  };
}

// ---------- v11: verification codes (hash-only, 15-min expiry, 5-attempt lock) ----------
// Codes are stored as sha256 hashes ONLY — the plaintext code is never
// written to the DB, the ledger, or the mirror. TEST MODE honesty: email
// is not connected, so the code is returned once in the API response
// under a clearly-named testMode* field, never in any stored record.
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
async function issueCode(email: string, talentId: string | null, purpose: string): Promise<{ code: string; expiresAt: string }> {
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await db.run("UPDATE verification_codes SET used = 1 WHERE email = ? AND purpose = ? AND used = 0", [email, purpose]);
  await db.run("INSERT INTO verification_codes (id, talent_id, email, code_hash, purpose, attempts, used, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)",
    [genId("vc"), talentId, email, sha256(code), purpose, expiresAt, nowIso()]);
  return { code, expiresAt };
}
async function checkCode(email: string, purpose: string, code: string): Promise<{ ok: boolean; error?: string; row?: Row }> {
  const rows = await db.all("SELECT * FROM verification_codes WHERE email = ? AND purpose = ? AND used = 0 ORDER BY created_at DESC LIMIT 1", [email, purpose]);
  if (!rows.length) return { ok: false, error: "no active code — request a new one" };
  const row = rows[0];
  if (new Date(String(row.expires_at)).getTime() < Date.now()) return { ok: false, error: "code expired — request a new one" };
  if (Number(row.attempts) >= CODE_MAX_ATTEMPTS) return { ok: false, error: "code locked after too many attempts — request a new one" };
  if (sha256(code) !== String(row.code_hash)) {
    await db.run("UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?", [row.id]);
    const left = CODE_MAX_ATTEMPTS - (Number(row.attempts) + 1);
    return { ok: false, error: left > 0 ? `wrong code — ${left} attempt${left === 1 ? "" : "s"} left` : "code locked after too many attempts — request a new one" };
  }
  await db.run("UPDATE verification_codes SET used = 1 WHERE id = ?", [row.id]);
  return { ok: true, row };
}

// ---------- v11: owner gate (v10) ----------
// Owner passcode hash lives in settings under owner_passcode_hash — NEVER
// in the ledger or the mirror (a wipe means the passcode must be re-set,
// same as passwords). A successful unlock issues a 12-hour owner session
// token. Agency money is served ONLY to a valid owner session or the
// admin token (the owner's credential); everyone else gets 401/403.
const OWNER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ownerUnlockAttempts = new Map<string, number[]>();
function ownerUnlockRateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (ownerUnlockAttempts.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  if (arr.length >= 5) return true;
  arr.push(now);
  ownerUnlockAttempts.set(ip, arr);
  return false;
}
async function ownerPasscodeSet(): Promise<boolean> {
  const rows = await db.all("SELECT value FROM settings WHERE key = 'owner_passcode_hash'");
  return rows.length > 0 && !!String(rows[0].value);
}
async function ownerFromToken(req: Request): Promise<boolean> {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  const rows = await db.all("SELECT expires_at FROM owner_sessions WHERE token = ?", [m[1]]);
  if (!rows.length) return false;
  if (new Date(String(rows[0].expires_at)).getTime() < Date.now()) {
    await db.run("DELETE FROM owner_sessions WHERE token = ?", [m[1]]);
    return false;
  }
  return true;
}
async function requireOwner(req: Request): Promise<Response | null> {
  if (isAdmin(req)) return null;
  if (await ownerFromToken(req)) return null;
  return err(401, "owner access required — unlock the owner view with the owner passcode");
}

// ---------- v11: per-(talent, job) reference codes ----------
// Deterministic: the same (talent, job) pair always yields the same code,
// so the code can travel in agency-send emails without a lookup table.
function refCode(talentId: string, opportunityId: string): string {
  return "TTT-" + sha256(talentId + "|" + opportunityId).slice(0, 8).toUpperCase();
}

// ---------- v11: automation settings (v8 BIG toggle) ----------
async function loadAutomation(talentId: string): Promise<any> {
  const rows = await db.all("SELECT data_json FROM automation_settings WHERE talent_id = ?", [talentId]);
  const base = { enabled: false, agencySendEmail: true, ccTalent: true, replyToTalent: true, categories: [], geography: null, minDaily: null };
  if (!rows.length) return base;
  try { return { ...base, ...JSON.parse(String(rows[0].data_json)) }; } catch { return base; }
}

// ---------- v11: talent earnings (own net ONLY) + proof-of-work credits ----------
// Talent-facing: per-job NET + running total only. Commission/fee and any
// agency total are NEVER in this payload — agency money is owner-only
// (see agencyEarnings + the owner gate).
async function talentEarnings(talentId: string): Promise<any> {
  const rows = await db.all("SELECT * FROM bookings WHERE talent_id = ? ORDER BY created_at DESC", [talentId]);
  const jobs: any[] = [];
  let totalNetCents = 0, completedNetCents = 0, completedCount = 0;
  for (const r of rows) {
    const o = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [r.opportunity_id]);
    const opp = o.length ? JSON.parse(String(o[0].data_json)) : null;
    const net = Number(r.net_cents ?? 0);
    totalNetCents += net;
    if (String(r.status) === "COMPLETED") { completedNetCents += net; completedCount++; }
    jobs.push({ bookingId: r.id, opportunityId: r.opportunity_id, title: opp?.title ?? String(r.opportunity_id), agency: opp?.casting_org || opp?.employer || null, status: r.status, netCents: net, net: net / 100, date: r.created_at });
  }
  return { jobs, totalNetCents, totalNet: totalNetCents / 100, completedNetCents, completedNet: completedNetCents / 100, jobCount: rows.length, completedCount };
}
// Proof of work: every job the talent accepted AND completed successfully,
// shown as a credits list in their profile. No money here at all.
async function talentCredits(talentId: string): Promise<any> {
  const rows = await db.all("SELECT * FROM bookings WHERE talent_id = ? AND status = 'COMPLETED' ORDER BY created_at DESC", [talentId]);
  const credits: any[] = [];
  for (const r of rows) {
    const o = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [r.opportunity_id]);
    const opp = o.length ? JSON.parse(String(o[0].data_json)) : null;
    credits.push({ bookingId: r.id, opportunityId: r.opportunity_id, title: opp?.title ?? String(r.opportunity_id), production: opp?.production ?? null, agency: opp?.casting_org || opp?.employer || null, completedAt: r.updated_at });
  }
  const accepted = await db.all("SELECT COUNT(*) AS n FROM bookings WHERE talent_id = ? AND status = 'BOOKED'", [talentId]);
  return { credits, completedCount: credits.length, acceptedInProgress: Number(accepted[0]?.n ?? 0) };
}
// Owner-only: agency earnings (commission totals + per-agency breakdown).
async function agencyEarnings(): Promise<any> {
  const rows = await db.all("SELECT * FROM bookings ORDER BY created_at DESC");
  let totalGross = 0, totalFee = 0, totalNet = 0;
  const byAgency = new Map<string, any>();
  const bookings: any[] = [];
  for (const r of rows) {
    const o = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [r.opportunity_id]);
    const opp = o.length ? JSON.parse(String(o[0].data_json)) : null;
    const agency = opp?.casting_org || opp?.employer || "Unknown";
    totalGross += Number(r.gross_cents ?? 0); totalFee += Number(r.commission_cents ?? 0); totalNet += Number(r.net_cents ?? 0);
    const a = byAgency.get(agency) ?? { agency, bookings: 0, grossCents: 0, commissionCents: 0, netCents: 0 };
    a.bookings++; a.grossCents += Number(r.gross_cents ?? 0); a.commissionCents += Number(r.commission_cents ?? 0); a.netCents += Number(r.net_cents ?? 0);
    byAgency.set(agency, a);
    bookings.push({ bookingId: r.id, talentId: r.talent_id, opportunityId: r.opportunity_id, title: opp?.title ?? String(r.opportunity_id), agency, status: r.status, grossCents: Number(r.gross_cents ?? 0), commissionCents: Number(r.commission_cents ?? 0), netCents: Number(r.net_cents ?? 0), rate: Number(r.rate ?? 0), date: r.created_at });
  }
  return { totalGrossCents: totalGross, totalCommissionCents: totalFee, totalNetCents: totalNet, bookingCount: rows.length, byAgency: [...byAgency.values()], bookings };
}

// ---------- v12–v14: social link / photo helpers (module scope —
// publicTalentView and the talent routes both use them) ----------
function genOwnershipCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[randomInt(chars.length)];
  return "TTT-" + s;
}
function signatureMatchesProfile(sig: string, profile: any): boolean {
  const legal = `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim().toLowerCase();
  const prof = String(profile.professionalName || "").trim().toLowerCase();
  const s = String(sig || "").trim().toLowerCase();
  return s !== "" && (s === legal || s === prof);
}
function socialLinkView(r: any): any {
  const confirmed = r.verification_status === "code_confirmed";
  const authorized = r.status === "AUTHORIZED" && confirmed;
  return {
    id: r.id, platform: r.platform, handle: r.handle, profileUrl: r.profile_url || null,
    status: authorized ? "AUTHORIZED" : "PENDING_VERIFICATION",
    verificationStatus: r.verification_status || "",
    ownershipCode: r.ownership_code || null,
    bioChecked: confirmed,
    signatureName: r.signature_name || null, signedAt: r.signed_at || null,
    checkDetail: r.check_detail || null, checkedAt: r.checked_at || null,
    pullStatus: r.pull_status || "", pullDetail: r.pull_detail || null, pulledAt: r.pulled_at || null,
    pullRejectedCount: Number(r.pull_rejected_count ?? 0),
    createdAt: r.created_at,
  };
}
function socialPhotoView(r: any): any {
  const stored = !!r.data_base64;
  return {
    id: r.id, platform: r.platform,
    photoUrl: stored ? `/api/v1/social-photos/${r.id}` : (r.photo_url || null),
    publicPhotoUrl: stored ? `/api/v1/public/social-photos/${r.id}` : (r.photo_url || null),
    sourcePostUrl: r.source_post_url || null,
    source: r.source || "upload",
    selection: r.selection || null,
    identityVerdict: r.identity_verdict || null,
    identityNote: r.identity_note || null,
    likesLabel: r.likes_label || null,
    caption: r.caption || null, createdAt: r.created_at,
  };
}
async function demoteInconsistentSocialLinks(talentId: string): Promise<void> {
  // v13 rule 2+3 (read path): never report AUTHORIZED when the code was
  // not confirmed — demote such records to pending, persist the
  // correction, and record the honest reason.
  const bad = await db.all("SELECT * FROM social_links WHERE talent_id = ? AND status = 'AUTHORIZED' AND COALESCE(verification_status, '') <> 'code_confirmed'", [talentId]);
  for (const r of bad) {
    const ts = nowIso();
    await db.run("UPDATE social_links SET status = 'PENDING_VERIFICATION', bio_checked = 0, updated_at = ? WHERE id = ?", [ts, r.id]);
    const fixed = { ...r, status: "PENDING_VERIFICATION", bio_checked: 0, updated_at: ts };
    await audit("talent.social-link.demoted", "talent", talentId, "system", { linkId: r.id, platform: r.platform, reason: "AUTHORIZED without a confirmed bio code — demoted to pending (v13 hardening)" }, { socialLink: fixed });
  }
}

// ---------- v11: public per-talent portfolio ----------
// Casting-safe fields ONLY. Never: email, phone, demographics, zip/exact
// address, password/session data, fees/earnings, guardian, fast-track,
// consent. Visibility rules (MODULE-TALENT-REGISTRATION.md §4): private
// by default — a private portfolio resolves to nothing (404); "agency"
// needs the admin token; "public" is open. Photos are shared only when
// the talent also set sharePhotos.
async function publicTalentView(id: string): Promise<any | null> {
  const t = await loadTalent(id);
  if (!t) return null;
  const p = t.profile;
  const visibility = p.visibility || "private";
  const sharePhotos = p.sharePhotos === true;
  const credits = (await talentCredits(id)).credits;
  const photos = sharePhotos ? await photoList(id) : [];
  // v13: the public page shows a social link ONLY when its bio code was
  // confirmed (AUTHORIZED + code_confirmed), and preview photos ONLY from
  // authorized platforms — a pending or unverified account never appears.
  const socials = await db.all("SELECT platform, handle FROM social_links WHERE talent_id = ? AND status = 'AUTHORIZED' AND verification_status = 'code_confirmed'", [id]);
  const authorizedPlatforms = new Set(socials.map((s: any) => s.platform));
  const allSocialPhotos = sharePhotos ? await db.all("SELECT * FROM social_photos WHERE talent_id = ?", [id]) : [];
  const socialPhotos = allSocialPhotos.filter((s: any) => authorizedPlatforms.has(s.platform));
  return {
    id,
    professionalName: p.professionalName || null,
    firstName: p.firstName, lastName: p.lastName,
    city: p.city, state: p.state,
    categories: p.categories || [], skills: p.skills || [], languages: p.languages || [],
    experience: p.experience || null, availability: p.availability || [],
    height: p.height || null, travelRadius: p.travelRadius || null,
    visibility, sharePhotos,
    photoCount: await photoCount(id),
    photos: photos.map((ph: any) => ({ id: ph.id, slot: ph.slot, label: ph.label, caption: ph.caption, url: `/api/v1/public/photos/${ph.id}` })),
    credits,
    socialLinks: socials.map((s: any) => ({ platform: s.platform, handle: s.handle, bioChecked: true })),
    socialPhotos: socialPhotos.map((s: any) => socialPhotoView(s)),
  };
}

const LIKENESS_TEXT = `TOP TEA TALENTS — LIKENESS RELEASE (contract version TTT-LIKENESS-v1.0)

1. GRANT OF LIKENESS RIGHTS. By signing, you grant TOP TEA TALENTS the right to use your name, likeness, photographs, video, voice, and professional information to solicit, submit, and promote you for paid work, including sending your materials to casting directors, producers, employers, and agencies.

2. NON-EXCLUSIVE. This grant is non-exclusive. You remain free to seek and accept work through any other person or agency.

3. NO GUARANTEE OF BOOKINGS OR EARNINGS. TOP TEA TALENTS does not guarantee any bookings, auditions, callbacks, or earnings. Submission does not promise work.

4. COMMISSION. TOP TEA TALENTS takes 10-15% of each successful booking on a sliding scale (see commission settings: 10% at $100/day, rising to 15% at $1,000/day). Commission is deducted from the gross booking pay; you receive the net.

5. REVOCATION. You may revoke this release at any time by submitting a revocation in the platform. Revocation stops future submissions and removes you from the rotation; it does not undo submissions or promotions already made, and does not cancel bookings already confirmed.

6. MINORS. If the talent is under 18, a parent or legal guardian must also consent (guardian consent on file) before any submission. A minor's auto-submit is disabled until guardian consent is recorded.

7. NO SSN OR BANK DETAILS. TOP TEA TALENTS never collects your Social Security number or bank credentials through this platform.

8. SUBMISSIONS. In live mode the agency submits applications by email from its agency mailbox, with you copied when your automation settings ask for it, and each send is logged with its delivery receipt. In test mode no submission is ever sent live. No payment is ever processed through this platform — payments are tracked only.`;

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
    const live = await liveMode();
    return ok({ version: VERSION, test_mode: !live, live_mode: live, mail_configured: mailStatus().configured, submissions_paused: await submissionsPaused(), storage: db.storage, storage_durable: db.durable, counts });
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
      contactMethod: b.contactMethod ? String(b.contactMethod) : null, notifyEmail: b.notifyEmail ?? true, notifySms: b.notifySms ?? false,
      city: b.city ? String(b.city) : null, state: b.state ? String(b.state) : null, zip: null, location: null, travelRadius: null,
      availability: [], height: null, ageRange: null, adultOrMinor: null, languages: [], skills: [],
      experience: null, categories: [], unionAffiliation: null, minCompensation: null,
      clothing: {}, resume: null, demoReel: null, portfolioLinks: [],
      demographics: { race: null, ethnicity: null, gender: null, pronouns: null },
      visibility: "private", sharePhotos: false, emailVerified: false, status: "PROFILE INCOMPLETE", completion: 0,
    };
    const ts = nowIso();
    await db.run("INSERT INTO talents (id, email, password_hash, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, email, hash, JSON.stringify(profile), ts, ts]);
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await db.run("INSERT INTO sessions (token, talent_id, created_at) VALUES (?, ?, ?)", [token, id, ts]);
    await upsertContact("talent", `${profile.firstName} ${profile.lastName}`, { email, phone: profile.phone });
    await audit("talent.register", "talent", id, id, { email, firstName: profile.firstName, lastName: profile.lastName, verificationRequired: true }, { talent: { id, email, profile, created_at: ts, updated_at: ts } });
    // v7: email verification. 6-digit code, hash-only, 15-min expiry.
    // TEST MODE: email is not connected, so the code is returned once
    // here under a clearly-named testMode* field — never stored anywhere.
    // LIVE MODE: the code is emailed from the agency mailbox instead and
    // is NEVER returned in the response.
    const { code: vcode, expiresAt } = await issueCode(email, id, "email_verify");
    if (await liveMode()) {
      await queueVerificationEmail(email, vcode, "email_verify", id);
      const ms = mailStatus();
      await audit("talent.email.verification-issued", "talent", id, id, { email, purpose: "email_verify", note: ms.configured ? "Live mode: verification code emailed from the agency mailbox." : "Live mode: verification email QUEUED — the agency mailbox is not connected yet, so the code has not been delivered. Contact the agency." });
      return json({ ok: true, talentId: id, token, verificationRequired: true, verificationExpiresAt: expiresAt, emailQueued: true, mailConfigured: ms.configured }, 201);
    }
    await audit("talent.email.verification-issued", "talent", id, id, { email, purpose: "email_verify", note: "TEST MODE: email not connected — code shown once in the register response, never emailed." });
    return json({ ok: true, talentId: id, token, verificationRequired: true, verificationExpiresAt: expiresAt, testModeVerificationCode: vcode, testModeNote: "TEST MODE: email is not connected, so the verification code is shown here instead of emailed. Never do this in live mode." }, 201);
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

  // ----- v7: email verification (6-digit code, resend, status) -----
  if (method === "POST" && rest.join("/") === "auth/verify-email") {
    const b = await body(req);
    if (!b || !b.email || !b.code) return err(400, "email and code are required");
    const email = String(b.email).toLowerCase().trim();
    const chk = await checkCode(email, "email_verify", String(b.code).trim());
    if (!chk.ok) return err(400, chk.error!);
    const rows = await db.all("SELECT id FROM talents WHERE email = ?", [email]);
    if (!rows.length) return err(404, "talent not found");
    const t = await loadTalent(String(rows[0].id));
    if (!t) return err(404, "talent not found");
    const p = { ...t.profile, emailVerified: true };
    await saveProfile(String(rows[0].id), p);
    await audit("talent.email.verified", "talent", String(rows[0].id), String(rows[0].id), { email, verified: true }, { profile: p });
    return ok({ verified: true, talentId: String(rows[0].id) });
  }
  if (method === "POST" && rest.join("/") === "auth/resend-verification") {
    const b = await body(req);
    if (!b || !b.email) return err(400, "email is required");
    const email = String(b.email).toLowerCase().trim();
    const rows = await db.all("SELECT id FROM talents WHERE email = ?", [email]);
    if (!rows.length) return err(404, "talent not found");
    const { code: vcode, expiresAt } = await issueCode(email, String(rows[0].id), "email_verify");
    if (await liveMode()) {
      await queueVerificationEmail(email, vcode, "email_verify", String(rows[0].id));
      const ms = mailStatus();
      await audit("talent.email.verification-issued", "talent", String(rows[0].id), String(rows[0].id), { email, purpose: "email_verify", note: ms.configured ? "Resent. Live mode: verification code emailed." : "Resent. Live mode: verification email QUEUED — agency mailbox not connected yet." });
      return ok({ resent: true, verificationExpiresAt: expiresAt, emailQueued: true, mailConfigured: ms.configured });
    }
    await audit("talent.email.verification-issued", "talent", String(rows[0].id), String(rows[0].id), { email, purpose: "email_verify", note: "Resent. TEST MODE: email not connected — code shown once in the response, never emailed." });
    return ok({ resent: true, verificationExpiresAt: expiresAt, testModeVerificationCode: vcode, testModeNote: "TEST MODE: email is not connected, so the verification code is shown here instead of emailed. Never do this in live mode." });
  }
  if (method === "GET" && rest.join("/") === "auth/verification-status") {
    const email = String(q.get("email") || "").toLowerCase().trim();
    if (!email) return err(400, "email query param is required");
    const rows = await db.all("SELECT id FROM talents WHERE email = ?", [email]);
    if (!rows.length) return err(404, "talent not found");
    const t = await loadTalent(String(rows[0].id));
    const codes = await db.all("SELECT expires_at FROM verification_codes WHERE email = ? AND purpose = 'email_verify' AND used = 0 ORDER BY created_at DESC LIMIT 1", [email]);
    const active = codes.length ? String(codes[0].expires_at) : null;
    const hasActiveCode = !!active && new Date(active).getTime() > Date.now();
    return ok({ email, verified: t?.profile.emailVerified === true, hasActiveCode, codeExpiresAt: hasActiveCode ? active : null });
  }
  if (method === "POST" && rest.join("/") === "auth/mark-email-verification-dispatched") {
    const adm = requireAdmin(req); if (adm) return adm;
    const b = await body(req);
    if (!b || !b.email) return err(400, "email is required");
    const email = String(b.email).toLowerCase().trim();
    const rows = await db.all("SELECT id FROM talents WHERE email = ?", [email]);
    if (!rows.length) return err(404, "talent not found");
    await audit("talent.email.verification-dispatched", "talent", String(rows[0].id), "admin", { email, note: "Staff marked the verification email as dispatched." });
    return ok({ dispatched: true, email });
  }

  // ----- v7: password reset (6-digit code, hash-only, 15-min expiry) -----
  if (method === "POST" && rest.join("/") === "auth/request-password-reset") {
    const b = await body(req);
    if (!b || !b.email) return err(400, "email is required");
    const email = String(b.email).toLowerCase().trim();
    const rows = await db.all("SELECT id FROM talents WHERE email = ?", [email]);
    // Always 200 — never reveal whether the email is registered.
    if (!rows.length) return ok({ requested: true, testModeNote: (await liveMode()) ? "Live mode: if the address is registered, a reset code was emailed." : "TEST MODE: email is not connected. If the address is registered, the reset code is shown in the response instead of emailed." });
    const { code: rcode, expiresAt } = await issueCode(email, String(rows[0].id), "password_reset");
    if (await liveMode()) {
      await queueVerificationEmail(email, rcode, "password_reset", String(rows[0].id));
      const ms = mailStatus();
      await audit("talent.password.reset-requested", "talent", String(rows[0].id), String(rows[0].id), { email, note: ms.configured ? "Live mode: reset code emailed." : "Live mode: reset email QUEUED — agency mailbox not connected yet." });
      return ok({ requested: true, resetExpiresAt: expiresAt, emailQueued: true, mailConfigured: ms.configured });
    }
    await audit("talent.password.reset-requested", "talent", String(rows[0].id), String(rows[0].id), { email, note: "TEST MODE: email not connected — code shown once in the response, never emailed." });
    return ok({ requested: true, resetExpiresAt: expiresAt, testModeResetCode: rcode, testModeNote: "TEST MODE: email is not connected, so the reset code is shown here instead of emailed. Never do this in live mode." });
  }
  if (method === "POST" && rest.join("/") === "auth/reset-password") {
    const b = await body(req);
    if (!b || !b.email || !b.code || !b.newPassword) return err(400, "email, code and newPassword are required");
    if (String(b.newPassword).length < 8) return err(400, "newPassword must be at least 8 characters");
    const email = String(b.email).toLowerCase().trim();
    const chk = await checkCode(email, "password_reset", String(b.code).trim());
    if (!chk.ok) return err(400, chk.error!);
    const rows = await db.all("SELECT id FROM talents WHERE email = ?", [email]);
    if (!rows.length) return err(404, "talent not found");
    const hash = await Bun.password.hash(String(b.newPassword));
    await db.run("UPDATE talents SET password_hash = ?, updated_at = ? WHERE id = ?", [hash, nowIso(), String(rows[0].id)]);
    await db.run("DELETE FROM sessions WHERE talent_id = ?", [String(rows[0].id)]);
    await audit("talent.password.reset", "talent", String(rows[0].id), String(rows[0].id), { email, note: "Password reset via emailed code; all sessions invalidated." });
    return ok({ reset: true, talentId: String(rows[0].id) });
  }

  // ----- v10: owner gate -----
  if (rest[0] === "owner") {
    if (method === "GET" && rest.length === 2 && rest[1] === "gate") {
      return ok({ configured: await ownerPasscodeSet(), unlocked: await ownerFromToken(req) || isAdmin(req) });
    }
    if (method === "POST" && rest.length === 2 && rest[1] === "set-passcode") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || !b.passcode || String(b.passcode).length < 6) return err(400, "passcode must be at least 6 characters");
      const hash = await Bun.password.hash(String(b.passcode));
      await setSetting("owner_passcode_hash", hash);
      // Never put the hash in the ledger or the mirror — only the fact
      // that a passcode was set. A wipe means the passcode must be re-set.
      await audit("owner.passcode.set", "owner", "owner", "admin", { configured: true, note: "Owner passcode set. Hash is stored in settings only — never in the ledger or mirror." });
      return ok({ configured: true });
    }
    if (method === "POST" && rest.length === 2 && rest[1] === "unlock") {
      const ip = req.headers.get("x-forwarded-for") || "local";
      if (ownerUnlockRateLimited(ip)) return err(429, "too many unlock attempts, try again in 15 minutes");
      const b = await body(req);
      if (!b || !b.passcode) return err(400, "passcode is required");
      if (!(await ownerPasscodeSet())) return err(400, "no owner passcode is set yet");
      const rows = await db.all("SELECT value FROM settings WHERE key = 'owner_passcode_hash'");
      const valid = await Bun.password.verify(String(b.passcode), String(rows[0].value));
      if (!valid) return err(401, "wrong owner passcode");
      const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      const expiresAt = new Date(Date.now() + OWNER_SESSION_TTL_MS).toISOString();
      await db.run("INSERT INTO owner_sessions (token, created_at, expires_at) VALUES (?, ?, ?)", [token, nowIso(), expiresAt]);
      await audit("owner.unlock", "owner", "owner", "owner", { unlocked: true, expiresAt });
      return ok({ unlocked: true, ownerToken: token, expiresAt });
    }
    if (method === "POST" && rest.length === 2 && rest[1] === "lock") {
      const h = req.headers.get("authorization") || "";
      const m = h.match(/^Bearer\s+(.+)$/);
      if (m) await db.run("DELETE FROM owner_sessions WHERE token = ?", [m[1]]);
      await audit("owner.lock", "owner", "owner", "owner", { locked: true });
      return ok({ locked: true });
    }
    return err(404, "not found");
  }

  // ----- v9: agency earnings (OWNER ONLY) -----
  if (method === "GET" && rest.join("/") === "agency-earnings") {
    const gate = await requireOwner(req);
    if (gate) return gate;
    return ok(await agencyEarnings());
  }

  // ----- v11: public per-talent portfolio (no auth; visibility-gated) -----
  if (rest[0] === "public" && rest[1] === "talent" && rest.length === 3) {
    const v = await publicTalentView(rest[2]);
    if (!v) return err(404, "talent not found");
    if (v.visibility === "private") return err(404, "this portfolio is private");
    if (v.visibility === "agency" && !isAdmin(req)) return err(403, "this portfolio is visible to agency staff only");
    return ok({ portfolio: v });
  }
  if (rest[0] === "public" && rest[1] === "photos" && rest.length === 3 && method === "GET") {
    // Serves a portfolio photo ONLY when that talent's portfolio is
    // public and sharePhotos is on — otherwise the photo stays private.
    const rows = await db.all("SELECT * FROM photos WHERE id = ?", [rest[2]]);
    if (!rows.length) return err(404, "photo not found");
    const t = await loadTalent(String(rows[0].talent_id));
    if (!t || (t.profile.visibility || "private") !== "public" || t.profile.sharePhotos !== true) return err(404, "photo not found");
    const buf = Buffer.from(String(rows[0].data_base64), "base64");
    return new Response(buf, { headers: { "Content-Type": String(rows[0].mime), "Access-Control-Allow-Origin": "*" } });
  }

  // ----- v14: social photo-pull callback (admin) -----
  // Standalone adaptation of the artifact's marksocialphotopull: the pull
  // itself is dispatched from the agency app, so its report arrives here
  // from the agency (admin token) instead of a one-time dispatch token.
  // Outcomes 'private' / 'login_wall' / 'unreadable' / 'no_reference'
  // place NOTHING and record the honest reason. On 'pulled', only photos
  // the identity check calls a match are placed (max 4); the rest are
  // counted as rejected, never shown.
  if (method === "POST" && rest.join("/") === "social-photo-pull-callback") {
    const adm = requireAdmin(req); if (adm) return adm;
    const b = await body(req);
    if (!b) return err(400, "invalid JSON");
    const talentIdCb = String(b.talentId || b.talent_id || "");
    const platform = String(b.platform || "").toLowerCase();
    if (!talentIdCb) return err(400, "talentId is required");
    if (platform !== "instagram" && platform !== "facebook") return err(400, 'platform must be "instagram" or "facebook"');
    const outcome = String(b.outcome || "");
    if (outcome !== "pulled" && outcome !== "private" && outcome !== "login_wall" && outcome !== "unreadable" && outcome !== "no_reference") return err(400, 'outcome must be "pulled", "private", "login_wall", "unreadable", or "no_reference"');
    const links = await db.all("SELECT * FROM social_links WHERE talent_id = ? AND platform = ?", [talentIdCb, platform]);
    if (!links.length) return err(404, "social link not found");
    const link = links[0];
    if (link.status !== "AUTHORIZED" || link.verification_status !== "code_confirmed") return err(400, "the account must be AUTHORIZED before pulled photos can be placed");
    const detail = b.detail ? String(b.detail).slice(0, 800) : null;
    const ts = nowIso();
    if (outcome !== "pulled") {
      await db.run("UPDATE social_links SET pull_status = ?, pull_detail = ?, pulled_at = ?, updated_at = ? WHERE id = ?", [outcome, detail, ts, ts, link.id]);
      await audit("talent.social-photo-pull.report", "talent", talentIdCb, "admin", { linkId: link.id, platform, outcome, note: "Auto-pull placed nothing; the honest reason is recorded." }, { socialLink: { ...link, pull_status: outcome, pull_detail: detail, pulled_at: ts } });
      return ok({ placed: 0, rejected: 0, pullStatus: outcome });
    }
    const photos = Array.isArray(b.photos) ? b.photos.slice(0, 4) : [];
    let placed = 0, rejected = 0;
    for (const ph of photos) {
      const verdict = String(ph.identity_verdict || ph.identityVerdict || "");
      const src = String(ph.source_post_url || ph.sourcePostUrl || "").trim();
      const rawB64 = String(ph.data_base64 || ph.dataBase64 || "");
      const mime = String(ph.mime_type || ph.mimeType || "").toLowerCase();
      if (verdict !== "match" || !/^https?:\/\/.+/.test(src) || src.length < 10 || !/^[A-Za-z0-9+/=]+$/.test(rawB64) || (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp")) { rejected++; continue; }
      const pbuf = Buffer.from(rawB64, "base64");
      if (pbuf.length > 500 * 1024) { rejected++; continue; }
      const selection = ph.selection === "most_popular" ? "most_popular" : "first_three";
      const pid = genId("sph");
      await db.run("INSERT INTO social_photos (id, talent_id, platform, photo_url, mime, data_base64, source_post_url, source, selection, identity_verdict, identity_note, likes_label, caption, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 'browser_pull', ?, ?, ?, ?, ?, ?)",
        [pid, talentIdCb, platform, mime, rawB64, src, selection, verdict, ph.identity_note || ph.identityNote ? String(ph.identity_note || ph.identityNote).slice(0, 400) : null, ph.likes_label || ph.likesLabel ? String(ph.likes_label || ph.likesLabel).slice(0, 60) : null, ph.caption ? String(ph.caption).slice(0, 400) : null, ts]);
      placed++;
    }
    rejected += Math.max(0, (Array.isArray(b.photos) ? b.photos.length : 0) - photos.length);
    rejected += Number(b.rejectedCount ?? b.rejected_count ?? 0) || 0;
    await db.run("UPDATE social_links SET pull_status = 'pulled', pull_detail = ?, pulled_at = ?, pull_rejected_count = ?, updated_at = ? WHERE id = ?", [detail, ts, rejected, ts, link.id]);
    await audit("talent.social-photo-pull.report", "talent", talentIdCb, "admin", { linkId: link.id, platform, outcome: "pulled", placed, rejected, note: "Only identity-matched photos were placed; the rest were rejected, never shown." }, { socialLink: { ...link, pull_status: "pulled", pull_detail: detail, pulled_at: ts, pull_rejected_count: rejected } });
    return ok({ placed, rejected, pullStatus: "pulled" });
  }

  // ----- v12–v14: social preview photos by id (bytes) -----
  if (rest[0] === "social-photos" && rest.length === 2 && method === "GET") {
    const rows = await db.all("SELECT * FROM social_photos WHERE id = ?", [rest[1]]);
    if (!rows.length || !rows[0].data_base64) return err(404, "photo not found");
    const ph = rows[0];
    const chk = await requireTalentOrAdmin(req, String(ph.talent_id)); if (!chk.ok) return chk.res!;
    const sbuf = Buffer.from(String(ph.data_base64), "base64");
    return new Response(sbuf, { headers: { "Content-Type": String(ph.mime || "image/jpeg"), "Access-Control-Allow-Origin": "*" } });
  }
  if (rest[0] === "public" && rest[1] === "social-photos" && rest.length === 3 && method === "GET") {
    // Serves a social preview photo ONLY when that talent's portfolio is
    // public, sharePhotos is on, AND the photo's platform is AUTHORIZED.
    const rows = await db.all("SELECT * FROM social_photos WHERE id = ?", [rest[2]]);
    if (!rows.length || !rows[0].data_base64) return err(404, "photo not found");
    const ph = rows[0];
    const t = await loadTalent(String(ph.talent_id));
    if (!t || (t.profile.visibility || "private") !== "public" || t.profile.sharePhotos !== true) return err(404, "photo not found");
    const links = await db.all("SELECT * FROM social_links WHERE talent_id = ? AND platform = ? AND status = 'AUTHORIZED' AND verification_status = 'code_confirmed'", [String(ph.talent_id), ph.platform]);
    if (!links.length) return err(404, "photo not found");
    const sbuf = Buffer.from(String(ph.data_base64), "base64");
    return new Response(sbuf, { headers: { "Content-Type": String(ph.mime || "image/jpeg"), "Access-Control-Allow-Origin": "*" } });
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
      await audit("source.create", "source", id, "admin", { name: rec.name }, { source: rec });
      return json({ ok: true, source: rec }, 201);
    }
    return err(404, "not found");
  }

  // ----- community board (v16, Phase 0) -----
  // One public board: everybody sees everybody's posts — there are no
  // private DMs in this product, and the direct-talk bubble is only a
  // filtered view of these same public posts. Action names mirror the
  // artifact (searchBoardMentions, createBoardPost, listBoardPosts,
  // createBoardMediaPost, deleteBoardPost, removeBoardPost,
  // reportBoardPost). Photo storage adapts the artifact's blob storage
  // to this package's pattern: bytes in board_post_media.data_base64,
  // same as portfolio photos. Ledger events carry ids + counts only —
  // never post bodies or photo bytes (see MIRROR.md).
  if (rest[0] === "board") {
    // GET /board/photos/:id — public: the board itself is public.
    if (method === "GET" && rest[1] === "photos" && rest.length === 3) {
      const rows = await db.all("SELECT * FROM board_post_media WHERE id = ?", [rest[2]]);
      if (!rows.length || !rows[0].data_base64) return err(404, "photo not found");
      const buf = Buffer.from(String(rows[0].data_base64), "base64");
      return new Response(buf, { headers: { "Content-Type": String(rows[0].mime || "image/jpeg"), "Access-Control-Allow-Origin": "*" } });
    }
    // GET /board/posts?viewerTalentId= — newest first, deleted excluded.
    if (method === "GET" && rest.join("/") === "board/posts") {
      const viewer = String(q.get("viewerTalentId") || "");
      const rows = await db.all("SELECT * FROM board_posts ORDER BY created_at DESC LIMIT 200");
      const posts: any[] = [];
      for (const r of rows) {
        if (Number(r.deleted) === 1) continue;
        posts.push(await boardPostView(r, viewer));
      }
      return ok({ posts });
    }
    // GET /board/mentions/search?q= — live @ autocomplete: handle or
    // name starts with the fragment, narrowing with each letter.
    if (method === "GET" && rest.join("/") === "board/mentions/search") {
      const frag = String(q.get("q") || q.get("query") || "").trim().toLowerCase().replace(/^@/, "");
      const talents = await db.all("SELECT * FROM talents");
      const matched = talents.filter((row: any) => {
        let p: any = {};
        try { p = JSON.parse(String(row.profile_json || "{}")); } catch { p = {}; }
        if (!frag) return true;
        const handle = boardHandle(p);
        const name = boardDisplayName(p).toLowerCase();
        return handle.startsWith(frag) || name.startsWith(frag) || name.split(/\s+/).some((w: string) => w.startsWith(frag));
      });
      matched.sort((a: any, b: any) => {
        const pa = JSON.parse(String(a.profile_json || "{}")); const pb = JSON.parse(String(b.profile_json || "{}"));
        return boardHandle(pa).localeCompare(boardHandle(pb));
      });
      return ok({
        profiles: matched.slice(0, 8).map((row: any) => {
          let p: any = {};
          try { p = JSON.parse(String(row.profile_json || "{}")); } catch { p = {}; }
          return { talentId: String(row.id), name: boardDisplayName(p), handle: boardHandle(p) };
        }),
      });
    }
    // POST /board/posts — text + optional ONE photo, resolved @mentions.
    if (method === "POST" && rest.join("/") === "board/posts") {
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      const talentId = String(b.talentId || "");
      if (!talentId) return err(400, "talentId is required");
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const author = await loadTalent(talentId);
      if (!author) return err(404, "talent profile not found — sign up or pick your profile before posting");
      const postBody = String(b.body || "").trim();
      if (postBody.length > 1000) return err(400, "board posts are limited to 1000 characters");
      const photo = isObj(b.photo) ? b.photo : null;
      if (!postBody && !photo) return err(400, "Write something or add a photo before posting.");
      // Photo gate — same pattern as portfolio photos, 500KB decoded cap.
      let photoB64: string | null = null; let photoMime = "";
      if (photo) {
        const allowed = ["image/jpeg", "image/png", "image/webp"];
        photoMime = String(photo.mimeType || photo.mime || "").toLowerCase();
        if (!allowed.includes(photoMime)) return err(400, "Board photos must be JPG, PNG, or WEBP.");
        const rawB64 = String(photo.dataBase64 || photo.data_base64 || "");
        if (!/^[A-Za-z0-9+/=]+$/.test(rawB64)) return err(400, "That photo appears empty or corrupted. Choose a different photo.");
        const buf = Buffer.from(rawB64, "base64");
        if (buf.length === 0) return err(400, "That photo appears empty or corrupted. Choose a different photo.");
        if (buf.length > 500 * 1024) return err(400, "That photo is too large for the board — 500 KB maximum. Pick a smaller photo.");
        photoB64 = rawB64;
      }
      const mentionedIds: string[] = Array.isArray(b.mentionedTalentIds) ? b.mentionedTalentIds.map((x: any) => String(x)) : [];
      if (mentionedIds.length > 10) return err(400, "at most 10 mentions per post");
      const postId = genId("brd");
      const ts = nowIso();
      if (photo && photoB64) {
        await db.run("INSERT INTO board_post_media (id, post_id, kind, mime, data_base64, sort_order, created_at) VALUES (?, ?, 'photo', ?, ?, 0, ?)",
          [genId("brm"), postId, photoMime, photoB64, ts]);
      }
      await db.run("INSERT INTO board_posts (id, talent_id, body, created_at, deleted, deleted_by) VALUES (?, ?, ?, ?, 0, '')", [postId, talentId, postBody, ts]);
      // Resolve mentions: only real talents, never the author, no dupes.
      const wanted = [...new Set(mentionedIds)].filter((id) => id !== talentId);
      const mentioned: any[] = [];
      for (const mid of wanted) {
        const t = await loadTalent(mid);
        if (!t) continue;
        mentioned.push(t);
        await db.run("INSERT INTO board_mentions (id, post_id, mentioned_talent_id, created_at) VALUES (?, ?, ?, ?)", [genId("bmn"), postId, mid, ts]);
      }
      const authorName = boardDisplayName(author.profile);
      await audit("BOARD_POST_CREATED", "board_post", postId, `talent:${talentId}`,
        { hasPhoto: !!photo, mentionCount: mentioned.length },
        { boardPost: { id: postId, talent_id: talentId, created_at: ts, deleted: false, hasPhoto: !!photo, mentionCount: mentioned.length } });
      for (const m of mentioned) {
        const mProfile = m.profile;
        await notify(String(m.row.id), `${authorName} mentioned you on the Community Board`,
          `@${boardHandle(author.profile)} mentioned you on the public board — open the Community Board to reply. The board is public: everyone can see the conversation.`);
        await audit("BOARD_MENTION_DELIVERED", "board_post", postId, "system",
          { postId, fromTalentId: talentId, mentionedTalentId: String(m.row.id) },
          { boardMention: { post_id: postId, from_talent_id: talentId, mentioned_talent_id: String(m.row.id) } });
      }
      return json({ ok: true, id: postId, message: "Posted to the Community Board — everyone on the board can see it." }, 201);
    }
    // POST /board/media-posts — honest refusal for audio/carousel.
    // Nothing is stored, nothing is ledger-recorded: no post exists.
    if (method === "POST" && rest.join("/") === "board/media-posts") {
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      const kind = String(b.kind || "");
      if (kind === "audio") return json({ ok: false, message: "Audio posts coming soon — the board takes text and photos today. Your post was not created." });
      if (kind === "carousel") return json({ ok: false, message: "Carousel posts coming soon — the board takes text and one photo per post today. Your post was not created." });
      return err(400, "kind must be 'audio' or 'carousel'");
    }
    // POST /board/posts/:id/delete — own post only (soft delete).
    if (method === "POST" && rest.length === 4 && rest[1] === "posts" && rest[3] === "delete") {
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      const talentId = String(b.talentId || "");
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const rows = await db.all("SELECT * FROM board_posts WHERE id = ?", [rest[2]]);
      const post = rows[0];
      if (!post || Number(post.deleted) === 1) return err(404, "That post is already gone.");
      if (String(post.talent_id) !== talentId) return err(403, "You can only delete your own posts.");
      await db.run("UPDATE board_posts SET deleted = 1, deleted_at = ?, deleted_by = 'talent' WHERE id = ?", [nowIso(), rest[2]]);
      await audit("BOARD_POST_DELETED", "board_post", String(rest[2]), `talent:${talentId}`,
        { postId: String(rest[2]) },
        { boardPost: { id: String(rest[2]), deleted: true, deleted_by: "talent" } });
      return ok({ message: "Your post was deleted from the board." });
    }
    // POST /board/posts/:id/remove — OWNER ONLY (owner session token
    // via Authorization header, admin token, or ownerToken in the body).
    if (method === "POST" && rest.length === 4 && rest[1] === "posts" && rest[3] === "remove") {
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      const viaHeader = isAdmin(req) || (await ownerFromToken(req));
      const viaBody = await ownerTokenValid(String(b.ownerToken || ""));
      if (!viaHeader && !viaBody) return err(401, "Owner sign-in required — only the agency owner can remove another talent's post.");
      const rows = await db.all("SELECT * FROM board_posts WHERE id = ?", [rest[2]]);
      const post = rows[0];
      if (!post || Number(post.deleted) === 1) return err(404, "That post is already gone.");
      await db.run("UPDATE board_posts SET deleted = 1, deleted_at = ?, deleted_by = 'owner' WHERE id = ?", [nowIso(), rest[2]]);
      await audit("BOARD_POST_REMOVED_BY_OWNER", "board_post", String(rest[2]), "owner",
        { postId: String(rest[2]), authorTalentId: String(post.talent_id) },
        { boardPost: { id: String(rest[2]), deleted: true, deleted_by: "owner" } });
      await notify(String(post.talent_id), "One of your board posts was removed",
        "The agency owner removed one of your Community Board posts. The board is moderated by the owner — there is no automatic filter.");
      return ok({ message: "Post removed from the board (recorded in the ledger)." });
    }
    // POST /board/posts/:id/report — recorded for owner review; no
    // automated action is ever taken from a report in v1.
    if (method === "POST" && rest.length === 4 && rest[1] === "posts" && rest[3] === "report") {
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      const rows = await db.all("SELECT * FROM board_posts WHERE id = ?", [rest[2]]);
      const post = rows[0];
      if (!post || Number(post.deleted) === 1) return err(404, "That post is already gone.");
      const reporterId = String(b.reporterTalentId || "");
      if (reporterId) {
        const chk = await requireTalentOrAdmin(req, reporterId); if (!chk.ok) return chk.res!;
      }
      const reportId = genId("brp");
      const reason = String(b.reason || "").trim().slice(0, 300);
      await db.run("INSERT INTO board_reports (id, post_id, reporter_talent_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
        [reportId, String(rest[2]), reporterId, reason, nowIso()]);
      await audit("BOARD_POST_REPORTED", "board_post", String(rest[2]), reporterId ? `talent:${reporterId}` : "system",
        { postId: String(rest[2]), reportId },
        { boardReport: { id: reportId, post_id: String(rest[2]) } });
      return ok({ message: "Reported — the agency owner will review it. Nothing happens automatically." });
    }
    return err(404, "not found");
  }

  // ----- settings -----
  if (rest.join("/") === "settings") {
    if (method === "GET") return ok({ testMode: !(await liveMode()), liveMode: await liveMode(), agencyEmail: await agencyEmail(), mailConfigured: mailStatus().configured, submissionsPaused: await submissionsPaused(), repeatAgencyThreshold: await repeatThreshold(), repeatAgencyTopPercent: await repeatTopPercent() });
    if (method === "POST") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      if (typeof b.submissionsPaused === "boolean") await setSetting("submissions_paused", String(b.submissionsPaused));
      if (typeof b.liveMode === "boolean") await setSetting("live_mode", String(b.liveMode));
      if (typeof b.agencyEmail === "string" && b.agencyEmail.trim()) {
        const em = b.agencyEmail.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return err(400, "agencyEmail must be a valid email address");
        await setSetting("agency_email", em);
      }
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
      const settingsSnap = { liveMode: await liveMode(), agencyEmail: await agencyEmail(), mailConfigured: mailStatus().configured, submissionsPaused: await submissionsPaused(), repeatAgencyThreshold: await repeatThreshold(), repeatAgencyTopPercent: await repeatTopPercent() };
      await audit("settings.update", "settings", "settings", "admin", { ...settingsSnap, note: "Live mode is on only when liveMode is true (env or setting). In test mode every submission is blocked; in live mode sends go through the Gmail transport and are logged with their message id." }, { settings: { live_mode: String(settingsSnap.liveMode), agency_email: settingsSnap.agencyEmail, submissions_paused: String(settingsSnap.submissionsPaused), repeat_agency_threshold: String(settingsSnap.repeatAgencyThreshold), repeat_agency_top_percent: String(settingsSnap.repeatAgencyTopPercent) } });
      return ok({ testMode: !settingsSnap.liveMode, liveMode: settingsSnap.liveMode, agencyEmail: settingsSnap.agencyEmail, mailConfigured: settingsSnap.mailConfigured, submissionsPaused: settingsSnap.submissionsPaused, repeatAgencyThreshold: settingsSnap.repeatAgencyThreshold, repeatAgencyTopPercent: settingsSnap.repeatAgencyTopPercent });
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
      await audit("commission.settings.update", "settings", "commission-settings", "admin", next, { settings: { commission_floor_daily: String(next.floorDaily), commission_floor_rate: String(next.floorRate), commission_ceiling_daily: String(next.ceilingDaily), commission_ceiling_rate: String(next.ceilingRate) } });
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
      await audit("cubicle.create", "cubicle", id, "admin", { name: rec.name ?? null }, { cubicle: rec });
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
      await audit("cubicle.status", "cubicle", rest[1], "admin", { status: rec.status }, { cubicle: rec });
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
      return ok({ events: rows.length, head_seq: rows.length ? Number(rows[rows.length - 1].seq) : 0, head_hash: rows.length ? String(rows[rows.length - 1].hash) : "GENESIS", valid, first_bad_seq: firstBad, mirror: verifyMirrorFile(MIRROR_PATH) });
    }
    if (method === "GET" && rest.length === 2 && rest[1] === "export") {
      const rows = await db.all("SELECT * FROM ledger_events ORDER BY seq ASC");
      const lines = rows.map((r) => JSON.stringify(ledgerRow(r))).join("\n");
      return new Response(lines + (lines ? "\n" : ""), { headers: { "Content-Type": "application/x-ndjson", "Content-Disposition": 'attachment; filename="top-tea-talents-ledger.jsonl"', "Access-Control-Allow-Origin": "*" } });
    }
    // ----- ledger mirror (wipe-proof copy) -----
    // GET /ledger/mirror returns the raw JSONL mirror — the durable
    // artifact a collector pushes to the repo (see MIRROR.md). Admin-only:
    // mirror lines carry full state (profiles, emails, signatures).
    if (method === "GET" && rest.length === 2 && rest[1] === "mirror") {
      const adm = requireAdmin(req); if (adm) return adm;
      const text = readMirrorText(MIRROR_PATH);
      if (text === null) return err(404, "no ledger mirror on this server yet");
      return new Response(text, { headers: { "Content-Type": "application/x-ndjson", "Content-Disposition": 'attachment; filename="top-tea-talents-ledger-mirror.jsonl"', "Access-Control-Allow-Origin": "*" } });
    }
    if (method === "GET" && rest.length === 3 && rest[1] === "mirror" && rest[2] === "verify") {
      const adm = requireAdmin(req); if (adm) return adm;
      return ok({ mirror: verifyMirrorFile(MIRROR_PATH) });
    }
    if (method === "POST" && rest.length === 3 && rest[1] === "mirror" && rest[2] === "rebuild") {
      const adm = requireAdmin(req); if (adm) return adm;
      return ok(await rebuildMirrorFromDb(db, MIRROR_PATH));
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

  // ----- contacts: admin upsert (2026-11-23 email harvest) -----
  // Seeded ONLY from addresses actually seen on a live listing page.
  // Platform support / general-contact addresses are refused outright —
  // they are never submission destinations.
  if (method === "POST" && rest.join("/") === "contacts") {
    const adm = requireAdmin(req); if (adm) return adm;
    const b = await body(req);
    if (!b || !b.name) return err(400, "name is required");
    const kind = String(b.kind || "agency");
    if (!["agency", "employer", "casting-professional", "production-company"].includes(kind)) {
      return err(400, "kind must be agency, employer, casting-professional, or production-company");
    }
    const email = b.email ? String(b.email).trim() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, "email is not a valid address");
    const blocked = ["support@allcasting.com", "support@projectcasting.com", "support@productionbeast.com", "hello@heybooker.app", "casting@backstage.com", "uigroup@ep.com"];
    if (email && blocked.includes(email.toLowerCase())) return err(400, "platform support addresses are not submission destinations");
    // Merge with any existing row so an upsert that omits a field never
    // wipes a stored email/phone.
    const exRows = await db.all("SELECT * FROM contacts WHERE normalized = ? AND kind = ?", [normName(String(b.name)), kind]);
    const ex = exRows[0];
    const mergedEmail = email || (ex ? String(ex.email || "") || null : null);
    const mergedPhone = (b.phone ? String(b.phone) : null) || (ex ? String(ex.phone || "") || null : null);
    const mergedCity = (b.city ? String(b.city) : null) || (ex ? String(ex.city || "") || null : null);
    const mergedState = (b.state ? String(b.state) : null) || (ex ? String(ex.state || "") || null : null);
    const mergedSource = b.source ? String(b.source) : (ex && ex.source ? String(ex.source) : "admin");
    const extra: any = { source: mergedSource };
    if (mergedEmail) extra.email = mergedEmail;
    if (mergedPhone) extra.phone = mergedPhone;
    if (mergedCity) extra.city = mergedCity;
    if (mergedState) extra.state = mergedState;
    const id = await upsertContact(kind, String(b.name), extra);
    await audit("contact.upsert", "contact", id, "admin", { kind, name: String(b.name), email: mergedEmail }, { contact: { id, kind, name: String(b.name), email: mergedEmail, phone: mergedPhone } });
    const rows = await db.all("SELECT * FROM contacts WHERE id = ?", [id]);
    return json({ ok: true, contact: rows[0] || { id, kind, name: String(b.name), email: mergedEmail } }, 201);
  }

  // ----- contacts: delete a contact (admin only) -----
  // Added 2026-11-23: the alerts+receipts live proof left a scratch
  // contacts row ("Test Proof") the API could not remove — no delete
  // route existed. Same shape as DELETE /bookings/:id: admin-only,
  // audited, {ok:true, deletedId}. Contacts have no lifecycle state, so
  // there is no status guard — admin-only + the audit trail is the guard.
  // Never delete a contact the live system still uses as a submission
  // destination; check its applications/bookings counts first.
  if (method === "DELETE" && rest.length === 2 && rest[0] === "contacts") {
    const adm = requireAdmin(req); if (adm) return adm;
    const rows = await db.all("SELECT * FROM contacts WHERE id = ?", [rest[1]]);
    if (!rows.length) return err(404, "contact not found");
    await db.run("DELETE FROM contacts WHERE id = ?", [rest[1]]);
    await audit("contact.delete", "contact", rest[1], "admin",
      { kind: String(rows[0].kind || ""), name: String(rows[0].name || ""), email: String(rows[0].email || "") }, { deleted: true });
    return ok({ ok: true, deletedId: rest[1] });
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
        await audit("talent.photo.add", "talent", talentId, talentId, { photoId: id, slot, label: SLOT_LABELS[slot] }, { photo: { id, slot, label: SLOT_LABELS[slot], is_primary: isPrimary === 1, mime: m[1] } });
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
        await audit("talent.fast-track.save", "talent", talentId, talentId, { version, autoSubmit: ft.autoSubmit }, { fastTrack: { talent_id: talentId, data: ft, version, authorized_at: ts, updated_at: ts } });
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
      const gts = nowIso();
      await db.run("INSERT INTO guardians (talent_id, data_json, created_at) VALUES (?, ?, ?) ON CONFLICT(talent_id) DO UPDATE SET data_json = excluded.data_json",
        [talentId, JSON.stringify(rec), gts]);
      await audit("talent.guardian.save", "talent", talentId, talentId, { guardianName: rec.guardianName, consentGiven: rec.consentGiven }, { guardian: { talent_id: talentId, data: rec, created_at: gts } });
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
      // v7: the likeness release can only be signed once the email is verified.
      if (t.profile.emailVerified !== true) return err(400, (await liveMode()) ? "verify your email first — enter the 6-digit code emailed to you at sign-up" : "verify your email first — enter the 6-digit code from your sign-up confirmation (TEST MODE: the code is shown on the sign-up confirmation screen)");
      const sig = String(b.signature || "").trim();
      if (!sig) return err(400, "signature is required");
      const legal = `${t.profile.firstName ?? ""} ${t.profile.lastName ?? ""}`.trim().toLowerCase();
      const prof = String(t.profile.professionalName || "").trim().toLowerCase();
      if (sig.toLowerCase() !== legal && sig.toLowerCase() !== prof) return err(400, "signature must match your legal name or professional name");
      const comp = completionOf(t.profile);
      if (comp.corePercent < 100) {
        const missing = comp.checklist.filter((c) => !c.done && COMPLETION_ITEMS.some((i) => i.key === c.key)).map((c) => c.label).join(", ");
        return err(400, `profile core must be 100% complete before signing (currently ${comp.corePercent}% — missing: ${missing})`);
      }
      const ts = nowIso();
      await db.run("INSERT INTO consents (talent_id, signed, signed_at, signature, status, version, updated_at) VALUES (?, 1, ?, ?, 'SIGNED', 'TTT-LIKENESS-v1.0', ?) ON CONFLICT(talent_id) DO UPDATE SET signed = 1, signed_at = excluded.signed_at, signature = excluded.signature, status = 'SIGNED', version = 'TTT-LIKENESS-v1.0', updated_at = excluded.updated_at",
        [talentId, ts, sig, ts]);
      const status = await refreshStatus(talentId);
      const consentRow = await db.all("SELECT * FROM consents WHERE talent_id = ?", [talentId]);
      const afterSign = await loadTalent(talentId);
      const crow = consentRow.length ? consentRow[0] : null;
      await audit("consent.sign", "talent", talentId, talentId, { version: "TTT-LIKENESS-v1.0", signedAt: ts, signature: sig, status }, crow ? { consent: { talent_id: talentId, signed: Number(crow.signed) === 1, signed_at: crow.signed_at, signature: crow.signature, status: crow.status, version: crow.version, updated_at: crow.updated_at }, profile: afterSign?.profile ?? null } : null);
      return ok({ signed: true, signedAt: ts, signature: sig, status, version: "TTT-LIKENESS-v1.0" });
    }
    if (rest.length === 4 && rest[2] === "likeness-release" && rest[3] === "revoke" && method === "POST") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const ts = nowIso();
      await db.run("INSERT INTO consents (talent_id, signed, signed_at, signature, status, version, updated_at) VALUES (?, 0, NULL, NULL, 'REVOKED', 'TTT-LIKENESS-v1.0', ?) ON CONFLICT(talent_id) DO UPDATE SET signed = 0, status = 'REVOKED', updated_at = excluded.updated_at",
        [talentId, ts]);
      await refreshStatus(talentId);
      const revokeRow = await db.all("SELECT * FROM consents WHERE talent_id = ?", [talentId]);
      const afterRevoke = await loadTalent(talentId);
      const rrow = revokeRow.length ? revokeRow[0] : null;
      await audit("consent.revoke", "talent", talentId, talentId, { status: "REVOKED", note: "Removed from rotation; future applications blocked." }, rrow ? { consent: { talent_id: talentId, signed: Number(rrow.signed) === 1, signed_at: rrow.signed_at, signature: rrow.signature, status: rrow.status, version: rrow.version, updated_at: rrow.updated_at }, profile: afterRevoke?.profile ?? null } : null);
      return ok({ signed: false, status: "REVOKED" });
    }
    if (rest.length === 3 && rest[2] === "review" && method === "POST") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      if (b.decision !== "PASS" && b.decision !== "FAIL") return err(400, 'decision must be "PASS" or "FAIL"');
      if (b.decision === "FAIL" && !b.reason) return err(400, "FAIL requires a reason");
      const id = genId("rvw");
      const rts = nowIso();
      await db.run("INSERT INTO reviews (id, talent_id, decision, reason, created_at) VALUES (?, ?, ?, ?, ?)", [id, talentId, b.decision, b.reason ?? null, rts]);
      const status = await refreshStatus(talentId);
      if (b.decision === "FAIL") {
        await notify(talentId, "Agency review: more information needed", `Your profile was not approved. Reason: ${b.reason}`);
      }
      const afterReview = await loadTalent(talentId);
      await audit("review.decision", "talent", talentId, "admin", { decision: b.decision, reason: b.reason ?? null, status }, { review: { id, talent_id: talentId, decision: b.decision, reason: b.reason ?? null, created_at: rts }, profile: afterReview?.profile ?? null });
      return ok({ decision: b.decision, status });
    }
    if (rest.length === 3 && rest[2] === "match" && method === "POST") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const t = await loadTalent(talentId);
      if (!t) return err(404, "talent not found");
      const mStats: { genderExcluded?: Array<{ opportunityId: string; requiredGender: "female" | "male"; source: string }> } = {};
      const matches = matchTalent(t.profile, await allOpps(), mStats);
      const genderExcluded = mStats.genderExcluded || [];
      await audit("talent.match", "talent", talentId, talentId, { evaluated: matches.length, strong: matches.filter((m: any) => m.classification === "STRONG MATCH").length, genderExcluded: genderExcluded.length });
      return ok({ matches, genderExcluded, talentGender: talentGender(t.profile), genderSet: !!(t.profile?.demographics?.gender || t.profile?.gender), demographicsNote: "Gender is a hard eligibility filter, never a score: a listing that requires a different gender never appears in your matches. Other demographics are never used as a matching score. Matching scores use location/travel radius, age/eligibility, skills, experience, availability, and compensation preferences only." });
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
      const tp = await loadTalent(talentId);
      const tg = talentGender(tp?.profile);
      for (const oppId of b.opportunityIds) {
        const dup = await db.all("SELECT id FROM applications WHERE talent_id = ? AND opportunity_id = ?", [talentId, oppId]);
        if (dup.length) { skipped.push({ opportunityId: oppId, reason: "duplicate application" }); continue; }
        const oppRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [oppId]);
        if (!oppRows.length) { skipped.push({ opportunityId: oppId, reason: "opportunity not found" }); continue; }
        const opp = JSON.parse(String(oppRows[0].data_json));
        const dg = deriveOppGenders(opp);
        if (genderBlocksTalent(dg.genders, tg)) { skipped.push({ opportunityId: oppId, reason: `gender requirement (${dg.genders}-only) does not match talent gender` }); continue; }
        const id = genId("app");
        const ts = nowIso();
        await db.run("INSERT INTO applications (id, talent_id, opportunity_id, status, created_at, updated_at) VALUES (?, ?, ?, 'AWAITING APPROVAL', ?, ?)", [id, talentId, oppId, ts, ts]);
        await audit("application.create", "application", id, talentId, { talentId, opportunityId: oppId, status: "AWAITING APPROVAL", note: await modeNote() }, { application: { id, talent_id: talentId, opportunity_id: oppId, status: "AWAITING APPROVAL", created_at: ts, updated_at: ts } });
        created.push({ id, talentId, opportunityId: oppId, status: "AWAITING APPROVAL" });
      }
      return ok({ applications: created, skipped, note: await modeNote() });
    }
    if (rest.length === 3 && rest[2] === "notifications" && method === "GET") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const rows = await db.all("SELECT * FROM notifications WHERE talent_id = ? ORDER BY created_at DESC", [talentId]);
      return ok({ notifications: rows.map((r) => ({ id: r.id, talentId: r.talent_id, title: r.title, body: r.body, read: Number(r.read) === 1, createdAt: r.created_at })) });
    }
    // ----- v8: Jobs For You feed -----
    if (rest.length === 3 && rest[2] === "jobs-for-you" && method === "GET") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const t = await loadTalent(talentId);
      if (!t) return err(404, "talent not found");
      const jStats: { genderExcluded?: Array<{ opportunityId: string; requiredGender: "female" | "male"; source: string }> } = {};
      const matches = matchTalent(t.profile, await allOpps(), jStats);
      const automation = await loadAutomation(talentId);
      const opps = await allOpps();
      const byId = new Map(opps.map((o: any) => [String(o.id), o]));
      const live = await liveMode();
      const jobs = matches
        .filter((m: any) => m.classification !== "NOT QUALIFIED")
        .slice(0, 25)
        .map((m: any) => {
          const o = byId.get(String(m.opportunityId)) || {};
          // v1.3.1: the match classification alone does not make a job
          // auto-eligible — the automation/Fast-Track hard rules
          // (geography, pay, required languages) must all pass too.
          // Blocked jobs stay in the feed for manual review.
          const blockers = automationBlockers(t.profile, o, automation);
          const autoEligible = automation.enabled === true && m.classification !== "NEEDS TALENT APPROVAL" && blockers.length === 0;
          return {
            opportunityId: m.opportunityId, title: o.title || m.opportunityId, production: o.production || null,
            agency: o.casting_org || o.employer || null, location: o.location || null,
            compensation: o.compensation || null, compensationType: o.compensation_type || null,
            deadline: o.deadline || null, verificationStatus: o.verification_status || null,
            classification: m.classification, reasons: m.reasons, score: m.score,
            selectivity: m.selectivity || "unknown", selectivityReason: m.selectivityReason || null,
            genderRequirement: m.genderRequirement || null,
            referenceCode: refCode(talentId, String(m.opportunityId)),
            automationEligible: autoEligible,
            automationBlockers: blockers,
            automationNote: automation.enabled !== true
              ? "Automation is OFF — nothing is submitted automatically."
              : autoEligible
                ? (live ? "Automation is ON and this job fits your rules — the agency will send your application by email." : "Automation is ON and this job fits your rules — it would be queued for agency-send (TEST MODE: nothing is ever sent live).")
                : "Automation is ON but this job needs your approval first.",
          };
        });
      return ok({ jobs, total: jobs.length, genderExcluded: (jStats.genderExcluded || []).length, talentGender: talentGender(t.profile), genderSet: !!(t.profile?.demographics?.gender || t.profile?.gender), automationEnabled: automation.enabled === true, generatedAt: nowIso(), note: live ? "Live mode: the feed ranks matches; automation-eligible jobs are sent by the agency email." : "TEST MODE: the feed ranks matches; nothing is ever submitted live." });
    }
    // ----- v8: BIG automation toggle -----
    if (rest.length === 3 && rest[2] === "automation") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      if (method === "GET") return ok({ automation: await loadAutomation(talentId), testMode: !(await liveMode()), note: (await liveMode()) ? "Live mode: with automation ON, eligible jobs are sent by the agency email." : "TEST MODE: even with automation ON, nothing is ever sent live. Would-be sends queue for review." });
      if (method === "POST") {
        const b = await body(req);
        if (!b) return err(400, "invalid JSON");
        const cur = await loadAutomation(talentId);
        const next = {
          enabled: b.enabled === true,
          agencySendEmail: b.agencySendEmail !== undefined ? b.agencySendEmail === true : cur.agencySendEmail,
          ccTalent: b.ccTalent !== undefined ? b.ccTalent === true : cur.ccTalent,
          replyToTalent: b.replyToTalent !== undefined ? b.replyToTalent === true : cur.replyToTalent,
          categories: Array.isArray(b.categories) ? b.categories : cur.categories,
          geography: b.geography !== undefined ? b.geography : cur.geography,
          minDaily: b.minDaily !== undefined ? b.minDaily : cur.minDaily,
        };
        const ts = nowIso();
        await db.run("INSERT INTO automation_settings (talent_id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(talent_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at",
          [talentId, JSON.stringify(next), ts]);
        await audit("talent.automation.save", "talent", talentId, talentId, { enabled: next.enabled, note: (await liveMode()) ? "Live mode: automation armed — eligible jobs will be sent." : "TEST MODE: automation armed, nothing sent live." }, { automation: { talent_id: talentId, data: next, updated_at: ts } });
        return ok({ automation: next, testMode: !(await liveMode()), note: (await liveMode()) ? "Live mode: automation armed — eligible jobs will be sent by the agency email." : "TEST MODE: even with automation ON, nothing is ever sent live." });
      }
      return err(404, "not found");
    }
    // ----- v9: proof-of-work credits + talent earnings (own net ONLY) -----
    if (rest.length === 3 && rest[2] === "credits" && method === "GET") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      return ok(await talentCredits(talentId));
    }
    if (rest.length === 3 && rest[2] === "earnings" && method === "GET") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      // Own net per job + running total only — never commission, never
      // any agency total. See talentEarnings().
      return ok(await talentEarnings(talentId));
    }
    // ----- v11: per-talent public portfolio link -----
    if (rest.length === 3 && rest[2] === "portfolio-link" && method === "GET") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const t = await loadTalent(talentId);
      if (!t) return err(404, "talent not found");
      const base = publicBase();
      return ok({
        talentId, path: `#/talent/${talentId}`,
        publicUrl: base ? `${base}/#/talent/${talentId}` : null,
        visibility: t.profile.visibility || "private", sharePhotos: t.profile.sharePhotos === true,
        note: "Share this link — it opens THIS person's profile and portfolio, never the front page. Private by default; shared only with the talent's permission.",
      });
    }
    // ---------- v12–v14: social links + extended portfolio ----------
    // v12: per-talent Instagram/Facebook linking with an ownership code
    // the talent places in their own bio + a typed signature (same name
    // standard as the Likeness Release). v13: AUTHORIZED exists ONLY when
    // the live bio check confirmed the code (verification_status =
    // 'code_confirmed') — confirming/signing never authorizes by itself.
    // v14: browser auto-pull of Instagram photos with face-match; the
    // pull is dispatched from the agency app, so the standalone site
    // records a pull request as 'unavailable' and says so honestly.
    // Helpers are function declarations (hoisted): socialLinkView,
    // socialPhotoView, demoteInconsistentSocialLinks, genOwnershipCode,
    // signatureMatchesProfile are defined below the routes.
    if (rest.length === 3 && rest[2] === "social-links") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      if (method === "GET") {
        await demoteInconsistentSocialLinks(talentId);
        const rows = await db.all("SELECT * FROM social_links WHERE talent_id = ? ORDER BY created_at", [talentId]);
        const photos = await db.all("SELECT * FROM social_photos WHERE talent_id = ? ORDER BY created_at", [talentId]);
        return ok({
          socialLinks: rows.map(socialLinkView),
          socialPhotos: photos.map(socialPhotoView),
          photoPullNote: "Instagram auto-pull runs from the agency app — this public site cannot dispatch a browser visit, so a pull request here is recorded as unavailable and nothing is faked. Your own uploads below work now.",
          note: "Link YOUR OWN Instagram/Facebook. Put the ownership code in your bio, sign to confirm it is there, and the agency runs the live bio check — only a confirmed code authorizes the account.",
        });
      }
      if (method === "POST") {
        // begin (v12): issue (or re-issue) the ownership code.
        const b = await body(req);
        if (!b) return err(400, "invalid JSON");
        const platform = String(b.platform || "").toLowerCase();
        if (platform !== "instagram" && platform !== "facebook") return err(400, 'platform must be "instagram" or "facebook"');
        const handle = String(b.handle || "").trim();
        if (!handle) return err(400, "handle is required");
        if (b.ownAccountConfirmed !== true) return err(400, "confirm this is your own account");
        const profileUrl = b.profileUrl ? String(b.profileUrl).trim() : null;
        if (profileUrl && !/^https?:\/\/.+/.test(profileUrl)) return err(400, "profileUrl must be an http(s) URL");
        const existing = await db.all("SELECT * FROM social_links WHERE talent_id = ? AND platform = ?", [talentId, platform]);
        const code = genOwnershipCode();
        const ts = nowIso();
        if (existing.length) {
          const cur = existing[0];
          if (cur.status === "AUTHORIZED" && cur.verification_status === "code_confirmed") {
            return err(400, `your ${platform} account is already authorized — unlink it first to link a different account`);
          }
          await db.run("UPDATE social_links SET handle = ?, profile_url = ?, status = 'PENDING_VERIFICATION', verification_status = 'code_issued', ownership_code = ?, signature_name = NULL, signed_at = NULL, check_detail = NULL, checked_at = NULL, updated_at = ? WHERE id = ?",
            [handle, profileUrl, code, ts, cur.id]);
          const row = { ...cur, handle, profile_url: profileUrl, status: "PENDING_VERIFICATION", verification_status: "code_issued", ownership_code: code, signature_name: null, signed_at: null, check_detail: null, checked_at: null, updated_at: ts };
          await audit("talent.social-link.begin", "talent", talentId, talentId, { platform, handle, status: "PENDING_VERIFICATION", note: "Ownership code re-issued; put it in your bio." }, { socialLink: row });
          return json({ ok: true, socialLink: socialLinkView(row), next: `Put the code ${code} in your ${platform} bio, then sign on the Social page.` }, 201);
        }
        const id = genId("soc");
        await db.run("INSERT INTO social_links (id, talent_id, platform, handle, profile_url, status, verification_status, ownership_code, bio_checked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'PENDING_VERIFICATION', 'code_issued', ?, 0, ?, ?)",
          [id, talentId, platform, handle, profileUrl, code, ts, ts]);
        const row = { id, talent_id: talentId, platform, handle, profile_url: profileUrl, status: "PENDING_VERIFICATION", verification_status: "code_issued", ownership_code: code, bio_checked: 0, created_at: ts, updated_at: ts };
        await audit("talent.social-link.begin", "talent", talentId, talentId, { platform, handle, status: "PENDING_VERIFICATION", note: "Ownership code issued; put it in your bio." }, { socialLink: row });
        return json({ ok: true, socialLink: socialLinkView(row), next: `Put the code ${code} in your ${platform} bio, then sign on the Social page.` }, 201);
      }
      return err(404, "not found");
    }
    if (rest.length === 4 && rest[2] === "social-links" && method === "POST") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const linkId = rest[3];
      const rows = await db.all("SELECT * FROM social_links WHERE id = ? AND talent_id = ?", [linkId, talentId]);
      if (!rows.length) return err(404, "social link not found");
      const b = await body(req);
      if (!b) return err(400, "invalid JSON");
      const action = String(b.action || "");
      const ts = nowIso();
      const link = rows[0];
      const isAuthorized = link.status === "AUTHORIZED" && link.verification_status === "code_confirmed";
      if (action === "confirm") {
        // v12 step 2 + v13: signing NEVER authorizes by itself. It
        // records the signature and starts the live bio check
        // (check_pending); only the bio-check outcome can authorize.
        if (isAuthorized) return err(400, "this account is already authorized");
        if (b.agreed !== true) return err(400, "agreed must be true");
        if (b.codeInBioConfirmed !== true) return err(400, "confirm the ownership code is in your bio");
        const t = await loadTalent(talentId);
        if (!t) return err(404, "talent not found");
        const sig = String(b.signatureName || "").trim();
        if (!sig) return err(400, "signature is required");
        if (!signatureMatchesProfile(sig, t.profile)) return err(400, "signature must match your legal name or professional name");
        await db.run("UPDATE social_links SET signature_name = ?, signed_at = ?, verification_status = 'check_pending', updated_at = ? WHERE id = ?", [sig, ts, ts, linkId]);
        const row = { ...link, signature_name: sig, signed_at: ts, verification_status: "check_pending", updated_at: ts };
        await audit("talent.social-link.confirm", "talent", talentId, talentId, { linkId, platform: link.platform, status: "PENDING_VERIFICATION", verificationStatus: "check_pending", note: "Signed; live bio check pending. Signing does not authorize the account." }, { socialLink: row });
        return ok({ socialLink: socialLinkView(row), next: "Signed. The agency runs the live bio check against your public bio — your account authorizes only when the code is found there." });
      }
      if (action === "resend-bio-check") {
        if (isAuthorized) return err(400, "this account is already authorized");
        if (!link.signature_name) return err(400, "sign the authorization first — the bio check needs your signature on file");
        await db.run("UPDATE social_links SET verification_status = 'check_pending', check_detail = NULL, updated_at = ? WHERE id = ?", [ts, linkId]);
        const row = { ...link, verification_status: "check_pending", check_detail: null, updated_at: ts };
        await audit("talent.social-link.bio-check-resend", "talent", talentId, talentId, { linkId, platform: link.platform, verificationStatus: "check_pending", note: "Bio check re-requested; the agency re-runs the live check." }, { socialLink: row });
        return ok({ socialLink: socialLinkView(row), next: "Bio check re-requested — the agency re-runs the live check against your public bio." });
      }
      if (action === "bio-check") {
        // Standalone adaptation of the artifact's marksocialbiochecked
        // callback: the live check is dispatched from the agency app, so
        // the outcome is reported by the agency (admin token) instead of
        // a one-time dispatch token — same precedent as
        // auth/mark-email-verification-dispatched. A wrong admin token is
        // refused (401); a talent token can never call this.
        const adm = requireAdmin(req); if (adm) return adm;
        const outcome = String(b.outcome || "");
        if (outcome !== "found" && outcome !== "not_found" && outcome !== "unreadable") return err(400, 'outcome must be "found", "not_found", or "unreadable"');
        const detail = b.detail ? String(b.detail).slice(0, 500) : null;
        if (outcome === "found") {
          await db.run("UPDATE social_links SET verification_status = 'code_confirmed', status = 'AUTHORIZED', bio_checked = 1, check_detail = ?, checked_at = ?, updated_at = ? WHERE id = ?", [detail, ts, ts, linkId]);
          const row = { ...link, verification_status: "code_confirmed", status: "AUTHORIZED", bio_checked: 1, check_detail: detail, checked_at: ts, updated_at: ts };
          await audit("talent.social-link.bio-checked", "talent", talentId, "admin", { linkId, platform: link.platform, outcome, status: "AUTHORIZED", note: "Live bio check found the ownership code in the talent's public bio." }, { socialLink: row });
          return ok({ socialLink: socialLinkView(row) });
        }
        const vs = outcome === "not_found" ? "code_not_found" : "check_unreadable";
        await db.run("UPDATE social_links SET verification_status = ?, check_detail = ?, checked_at = ?, updated_at = ? WHERE id = ?", [vs, detail, ts, ts, linkId]);
        const row = { ...link, verification_status: vs, check_detail: detail, checked_at: ts, updated_at: ts };
        await audit("talent.social-link.bio-checked", "talent", talentId, "admin", { linkId, platform: link.platform, outcome, status: "PENDING_VERIFICATION", note: outcome === "not_found" ? "Live bio check did not find the code in the bio." : "Live bio check could not read the profile." }, { socialLink: row });
        return ok({ socialLink: socialLinkView(row), next: outcome === "not_found" ? "The code was not found in your bio — check it is there, then re-run the bio check." : "Your profile could not be read (private or login-walled) — make it public, then re-run the bio check." });
      }
      if (action === "request-photo-pull") {
        // v14: the browser auto-pull is dispatched from the agency app.
        // This standalone site has no background-task dispatch, so the
        // request is recorded as unavailable — honestly, never faked.
        if (!isAuthorized) return err(400, "authorize this account first — the bio check must confirm your code");
        if (link.platform !== "instagram") return err(400, "auto-pull is Instagram-only in this build");
        const pullNote = "The standalone public site cannot dispatch a browser visit, so no auto-pull ran. The pull runs from the agency app; your own uploads still work.";
        await db.run("UPDATE social_links SET pull_status = 'unavailable', pull_detail = ?, updated_at = ? WHERE id = ?", [pullNote, ts, linkId]);
        const row = { ...link, pull_status: "unavailable", pull_detail: pullNote, updated_at: ts };
        await audit("talent.social-photo-pull.unavailable", "talent", talentId, talentId, { linkId, platform: link.platform, pullStatus: "unavailable", note: "No browser dispatch in the standalone build; pull not run, nothing faked." }, { socialLink: row });
        return ok({ requested: false, pullStatus: "unavailable", socialLink: socialLinkView(row), reason: "Instagram auto-pull runs from the agency app — this public site cannot dispatch a browser visit, so no pull ran. Add your photos with the upload form below; they show the same way." });
      }
      return err(400, 'action must be "confirm", "resend-bio-check", "bio-check", or "request-photo-pull"');
    }
    if (rest.length === 4 && rest[2] === "social-links" && method === "DELETE") {
      // v12 unlink: by platform — the link closes AND every preview photo
      // from that platform is removed at once.
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const platform = String(rest[3] || "").toLowerCase();
      if (platform !== "instagram" && platform !== "facebook") return err(400, 'unlink by platform: "instagram" or "facebook"');
      const rows = await db.all("SELECT * FROM social_links WHERE talent_id = ? AND platform = ?", [talentId, platform]);
      if (!rows.length) return err(404, "social link not found");
      const photos = await db.all("SELECT id FROM social_photos WHERE talent_id = ? AND platform = ?", [talentId, platform]);
      await db.run("DELETE FROM social_photos WHERE talent_id = ? AND platform = ?", [talentId, platform]);
      await db.run("DELETE FROM social_links WHERE talent_id = ? AND platform = ?", [talentId, platform]);
      await audit("talent.social-link.unlink", "talent", talentId, talentId, { linkId: rows[0].id, platform, photosRemoved: photos.length, note: "Unlinked; all of that platform's preview photos removed at once." }, { deleted: true, socialLinkId: rows[0].id, photosRemoved: photos.length });
      return ok({ deleted: true, socialLinkId: rows[0].id, photosRemoved: photos.length });
    }
    if (rest.length === 3 && rest[2] === "social-photos") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      if (method === "GET") {
        const photos = await db.all("SELECT * FROM social_photos WHERE talent_id = ? ORDER BY created_at", [talentId]);
        return ok({ socialPhotos: photos.map(socialPhotoView) });
      }
      if (method === "POST") {
        // v12 addsocialphoto: the talent uploads the photo bytes AND
        // pastes the link to the original post on their own AUTHORIZED
        // account, so every preview photo is traceable to the talent's
        // own post. Bytes are stored like the 8-photo portfolio (500KB
        // cap); the mirror state below carries metadata only, never bytes.
        const b = await body(req);
        if (!b) return err(400, "invalid JSON");
        const platform = String(b.platform || "").toLowerCase();
        if (platform !== "instagram" && platform !== "facebook") return err(400, 'platform must be "instagram" or "facebook"');
        const links = await db.all("SELECT * FROM social_links WHERE talent_id = ? AND platform = ? AND status = 'AUTHORIZED' AND verification_status = 'code_confirmed'", [talentId, platform]);
        if (!links.length) return err(400, `authorize your ${platform} account first — the bio check must confirm your ownership code before preview photos can come from it`);
        const sourcePostUrl = String(b.sourcePostUrl || "").trim();
        if (!/^https?:\/\/.+/.test(sourcePostUrl) || sourcePostUrl.length < 10) return err(400, "sourcePostUrl must be the http(s) link to the original post on your own authorized account");
        let mime = "", b64 = "";
        const raw = String(b.dataBase64 || "").trim();
        const dataUrl = String(b.dataUrl || "").trim();
        if (dataUrl) {
          const dm = dataUrl.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
          if (!dm) return err(400, "dataUrl must be data:image/jpeg|png|webp;base64,...");
          mime = dm[1]; b64 = dm[3];
        } else if (raw) {
          mime = String(b.mimeType || "").toLowerCase();
          if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") return err(400, "mimeType must be image/jpeg, image/png, or image/webp");
          if (!/^[A-Za-z0-9+/=]+$/.test(raw)) return err(400, "dataBase64 must be base64 image data");
          b64 = raw;
        } else {
          return err(400, "dataBase64 (or dataUrl) with the photo bytes is required");
        }
        const buf = Buffer.from(b64, "base64");
        if (buf.length > 500 * 1024) return err(400, `photo decoded size ${buf.length} bytes exceeds the 500KB limit — downscale the image first and retry`);
        const caption = b.caption ? String(b.caption).slice(0, 200) : null;
        const id = genId("sph");
        const ts = nowIso();
        await db.run("INSERT INTO social_photos (id, talent_id, platform, photo_url, mime, data_base64, source_post_url, source, caption, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 'upload', ?, ?)",
          [id, talentId, platform, mime, b64, sourcePostUrl, caption, ts]);
        const row = { id, talent_id: talentId, platform, photo_url: null, mime, data_base64: b64, source_post_url: sourcePostUrl, source: "upload", selection: null, identity_verdict: null, identity_note: null, likes_label: null, caption, created_at: ts };
        await audit("talent.social-photo.add", "talent", talentId, talentId, { photoId: id, platform, sourcePostUrl }, { socialPhoto: { id, talent_id: talentId, platform, source_post_url: sourcePostUrl, source: "upload", caption, created_at: ts } });
        return json({ ok: true, socialPhoto: socialPhotoView(row) }, 201);
      }
      return err(404, "not found");
    }
    if (rest.length === 4 && rest[2] === "social-photos" && method === "DELETE") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const photoId = rest[3];
      const rows = await db.all("SELECT * FROM social_photos WHERE id = ? AND talent_id = ?", [photoId, talentId]);
      if (!rows.length) return err(404, "social photo not found");
      await db.run("DELETE FROM social_photos WHERE id = ?", [photoId]);
      await audit("talent.social-photo.remove", "talent", talentId, talentId, { photoId }, { deleted: true, socialPhotoId: photoId });
      return ok({ deleted: true, socialPhotoId: photoId });
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
      const allowed = ["phone", "firstName", "lastName", "professionalName", "contactMethod", "notifyEmail", "notifySms", "city", "state", "zip", "location", "travelRadius", "availability", "height", "ageRange", "adultOrMinor", "languages", "skills", "experience", "categories", "unionAffiliation", "minCompensation", "clothing", "clothingSizes", "measurements", "resume", "demoReel", "portfolioLinks", "demographics", "visibility", "sharePhotos", "hairColor", "eyeColor", "paused"];
      const p = { ...t.profile };
      for (const k of allowed) if (b[k] !== undefined) p[k] = b[k];
      if (p.availability !== undefined && !Array.isArray(p.availability)) return err(400, "availability must be an array");
      if (p.categories !== undefined && !Array.isArray(p.categories)) return err(400, "categories must be an array");
      await saveProfile(talentId, p);
      const status = await refreshStatus(talentId);
      const afterPatch = await loadTalent(talentId);
      await audit("talent.update", "talent", talentId, chk.admin ? "admin" : talentId, { fields: Object.keys(b), status }, { profile: afterPatch?.profile ?? null });
      const v = await talentView(talentId);
      return ok({ talent: v });
    }
    // ----- v1.3.2: missing-info form (talent alerts + receipts) -----
    // GET /talent/:id/missing-info — the in-house form's question set:
    // every profile-gap question with its exact option list, whether it is
    // already answered, and the current value. Gendered sizes and
    // conditionals (tattoo locations, car details) appear only when they
    // apply. Photos are a separate gap entry (answered in the portfolio).
    if (rest.length === 3 && rest[2] === "missing-info" && method === "GET") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const t = await loadTalent(talentId);
      if (!t) return err(404, "talent not found");
      const oppId = q.get("opportunityId");
      const formSlug = q.get("formSlug");
      let opp: any = null;
      if (oppId) {
        const oRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [oppId]);
        if (oRows.length) opp = JSON.parse(String(oRows[0].data_json));
      }
      const photoRows = await db.all("SELECT COUNT(*) AS n FROM photos WHERE talent_id = ?", [talentId]);
      const info = computeMissingInfo(t.profile, Number(photoRows[0]?.n ?? 0), opp, formSlug);
      return ok({ talentId, opportunityId: oppId, formSlug, questions: info.questions, gaps: info.gaps, photosCount: Number(photoRows[0]?.n ?? 0) });
    }
    // POST /talent/:id/missing-info-alert — admin sends the alert: email to
    // the talent (exact gap list + in-profile form link + reply option) AND
    // a profile notification. dryRun previews the email without sending.
    // When there are no gaps, nothing is sent and the response says so.
    if (rest.length === 3 && rest[2] === "missing-info-alert" && method === "POST") {
      const adm = requireAdmin(req); if (adm) return adm;
      const t = await loadTalent(talentId);
      if (!t) return err(404, "talent not found");
      const b = (await body(req)) || {};
      const oppId = b.opportunityId ? String(b.opportunityId) : null;
      const formSlug = b.formSlug ? String(b.formSlug) : null;
      let opp: any = null;
      if (oppId) {
        const oRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [oppId]);
        if (oRows.length) opp = JSON.parse(String(oRows[0].data_json));
      }
      const photoRows = await db.all("SELECT COUNT(*) AS n FROM photos WHERE talent_id = ?", [talentId]);
      const info = computeMissingInfo(t.profile, Number(photoRows[0]?.n ?? 0), opp, formSlug);
      if (!info.gaps.length) return ok({ alerted: false, gaps: [], reason: "no missing info — the profile already carries every answer" });
      const base = publicBase();
      const formUrl = base ? `${base}/#/complete-profile` : null;
      const talentName = (`${t.profile.firstName ?? ""} ${t.profile.lastName ?? ""}`.trim() || t.profile.professionalName || "Talent");
      const email = await buildMissingInfoEmail(talentName, info.gaps, formUrl, opp ? String(opp.title || opp.id) : null);
      if (b.dryRun === true) {
        return ok({ dryRun: true, talentId, opportunityId: oppId, gaps: info.gaps, formUrl, email: { from: email.from, to: String(t.profile.email || ""), replyTo: email.replyTo, subject: email.subject, body: email.body } });
      }
      const talentEmail = String(t.profile.email || "");
      if (!talentEmail) return err(400, "talent has no email on file — the alert cannot be sent");
      const emailId = await enqueueEmail({ to: talentEmail, replyTo: email.replyTo, talentId, applicationId: null, kind: "missing-info", subject: email.subject, body: email.body });
      const attempt = await drainOneEmail(emailId);
      const ntfId = await notify(talentId, `Details needed${opp ? ` for ${String(opp.title || opp.id)}` : ""} — ${info.gaps.length} item${info.gaps.length === 1 ? "" : "s"}`,
        `TOP TEA TALENTS needs ${info.gaps.length} more detail${info.gaps.length === 1 ? "" : "s"} before we can submit you: ${info.gaps.map((g: any) => g.label).join(", ")}. Answer them in your profile (Complete My Details) or reply to the email we just sent.`);
      await audit("talent.missing-info.alert", "talent", talentId, "admin", { opportunityId: oppId, gaps: info.gaps.map((g: any) => g.id), emailId, emailSent: attempt.sent, messageId: attempt.messageId ?? null, notificationId: ntfId }, { gaps: info.gaps });
      return ok({ alerted: true, talentId, opportunityId: oppId, gaps: info.gaps, formUrl, emailQueued: true, emailSent: attempt.sent, messageId: attempt.messageId ?? null, emailReason: attempt.sent ? undefined : attempt.reason, notificationId: ntfId });
    }
    // POST /talent/:id/answers — the in-profile form submit. Validates every
    // answer against the question's exact option list (or date/number
    // rules) FIRST; if any answer is invalid, nothing is saved and every
    // error is reported. Valid answers land on the record forever (the
    // same fields the submitter reads). The talent herself or admin.
    if (rest.length === 3 && rest[2] === "answers" && method === "POST") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      const t = await loadTalent(talentId);
      if (!t) return err(404, "talent not found");
      const b = await body(req);
      if (!b || typeof b.answers !== "object" || b.answers === null) return err(400, "answers object is required");
      const oppId = b.opportunityId ? String(b.opportunityId) : null;
      const formSlug = b.formSlug ? String(b.formSlug) : null;
      let opp: any = null;
      if (oppId) {
        const oRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [oppId]);
        if (oRows.length) opp = JSON.parse(String(oRows[0].data_json));
      }
      const photoRows = await db.all("SELECT COUNT(*) AS n FROM photos WHERE talent_id = ?", [talentId]);
      const info = computeMissingInfo(t.profile, Number(photoRows[0]?.n ?? 0), opp, formSlug);
      const byId = new Map(info.questions.map((x: any) => [x.id, x]));
      const errors: string[] = [];
      const toSave: { q: any; value: any }[] = [];
      for (const [qid, value] of Object.entries(b.answers)) {
        const def = MISSING_INFO_QUESTIONS.find((x) => x.id === qid);
        if (!def) { errors.push(`unknown question: ${qid}`); continue; }
        const shown = byId.get(qid);
        if (!shown) { errors.push(`${def.label}: this question does not apply right now`); continue; }
        const errText = validateAnswer(def, value, shown.options ?? def.options);
        if (errText) { errors.push(errText); continue; }
        toSave.push({ q: def, value });
      }
      if (errors.length) return err(400, errors.join(" | "));
      if (!toSave.length) return err(400, "no answers to save");
      const p = { ...t.profile };
      const saved: string[] = [];
      for (const { q, value } of toSave) {
        setProfileValue(p, q.path, storeAnswerValue(q, value));
        saved.push(q.id);
        if (q.id === "english" && shortCode(String(value)) === "YES") {
          const langs = Array.isArray(p.languages) ? [...p.languages] : [];
          if (!langs.some((l: any) => String(l).toLowerCase() === "english")) langs.push("English");
          p.languages = langs;
        }
      }
      await saveProfile(talentId, p);
      const status = await refreshStatus(talentId);
      const after = await loadTalent(talentId);
      const remaining = computeMissingInfo(after?.profile || p, Number(photoRows[0]?.n ?? 0), opp, formSlug);
      await audit("talent.answers", "talent", talentId, chk.admin ? "admin" : talentId, { saved, remainingGaps: remaining.gaps.map((g: any) => g.id), status }, { profile: after?.profile ?? null });
      return ok({ saved, remainingGaps: remaining.gaps, status });
    }
    if (rest.length === 2 && method === "DELETE") {
      const chk = await requireTalentOrAdmin(req, talentId); if (!chk.ok) return chk.res!;
      await db.run("DELETE FROM photos WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM social_links WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM social_photos WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM fast_track WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM guardians WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM consents WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM notifications WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM sessions WHERE talent_id = ?", [talentId]);
      await db.run("DELETE FROM talents WHERE id = ?", [talentId]);
      await audit("talent.delete", "talent", talentId, chk.admin ? "admin" : talentId, { note: "Profile, photos, social links + preview photos, fast-track, guardian, and notifications deleted." }, { deleted: true });
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
      await audit("talent.photo.update", "talent", String(ph.talent_id), String(ph.talent_id), { photoId }, { photo: { id: photoId } });
      return ok({ photo: (await photoList(String(ph.talent_id))).find((p: any) => p.id === photoId) });
    }
    if (method === "DELETE") {
      await db.run("DELETE FROM photos WHERE id = ?", [photoId]);
      await audit("talent.photo.delete", "talent", String(ph.talent_id), String(ph.talent_id), { photoId }, { deleted: true, photoId });
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
      await audit("opportunity.create", "opportunity", id, "admin", { title: rec.title, source: rec.source ?? null }, { opportunity: rec });
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
      await audit("opportunity.verification", "opportunity", rest[1], "admin", { verification_status: rec.verification_status }, { opportunity: rec });
      return ok({ opportunity: oppWithExpiry(rec) });
    }
    if (method === "DELETE" && rest.length === 2) {
      const adm = requireAdmin(req); if (adm) return adm;
      await db.run("DELETE FROM opportunities WHERE id = ?", [rest[1]]);
      await audit("opportunity.delete", "opportunity", rest[1], "admin", {}, { deleted: true });
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

  // ----- v1.3.0: email queue + send -----
  if (rest[0] === "email") {
    if (method === "GET" && rest.join("/") === "email/status") {
      const adm = requireAdmin(req); if (adm) return adm;
      const st = mailStatus();
      const counts = await db.all("SELECT status, COUNT(*) AS n FROM email_queue GROUP BY status");
      const byStatus: any = {}; for (const r of counts) byStatus[String(r.status)] = Number(r.n);
      return ok({ liveMode: await liveMode(), agencyEmail: await agencyEmail(), mailConfigured: st.configured, mailMissing: st.missing, queue: byStatus });
    }
    if (method === "POST" && rest.join("/") === "email/drain") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = (await body(req)) || {};
      const limit = Math.min(Math.max(Number(b.limit ?? 10) || 10, 1), 50);
      return ok(await drainEmailQueue(limit));
    }
    return err(404, "not found");
  }

  // ----- v1.3.0: send an approved application -----
  if (method === "POST" && rest[0] === "applications" && rest.length === 3 && rest[2] === "send") {
    const adm = requireAdmin(req); if (adm) return adm;
    const appId = rest[1];
    const appRows = await db.all("SELECT * FROM applications WHERE id = ?", [appId]);
    if (!appRows.length) return err(404, "application not found");
    const app = appRows[0];
    const b = (await body(req)) || {};
    const t = await loadTalent(String(app.talent_id));
    if (!t) return err(404, "talent not found");
    const oppRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [app.opportunity_id]);
    if (!oppRows.length) return err(404, "opportunity not found");
    const opp = JSON.parse(String(oppRows[0].data_json));
    const automation = await loadAutomation(String(app.talent_id));
    const base = publicBase();
    const publicUrl = base ? `${base}/#/talent/${app.talent_id}` : null;
    const email = await buildApplicationEmail(String(app.talent_id), t.profile, opp, publicUrl, automation);
    const dest = await resolveDestination(opp, b.to ? String(b.to) : undefined);
    const live = await liveMode();
    // dryRun previews the exact email without queueing, sending, or
    // changing any status — safe in either mode.
    if (b.dryRun === true) {
      return ok({ dryRun: true, applicationId: appId, status: String(app.status), liveMode: live, mailConfigured: mailStatus().configured, destination: dest.to, destinationSource: dest.source, submitVia: dest.to ? null : (opp.source_url || null), email: { from: email.from, to: dest.to, cc: email.cc, replyTo: email.replyTo, subject: email.subject, body: email.body, referenceCode: email.referenceCode, portfolioLink: email.portfolioLink, payAsk: email.payAsk } });
    }
    if (!live) return err(400, "TEST MODE: sending is disabled — use dryRun to preview the exact email that would go.");
    if (String(app.status) !== "APPROVED") return err(400, `application must be APPROVED before sending (currently ${app.status})`);
    if (!dest.to) {
      const ts = nowIso();
      await db.run("UPDATE applications SET status = 'PACKAGE READY', updated_at = ? WHERE id = ?", [ts, appId]);
      await audit("application.package.ready", "application", appId, "admin", { opportunityId: String(app.opportunity_id), referenceCode: email.referenceCode, portfolioLink: email.portfolioLink, payAsk: email.payAsk, submitVia: opp.source_url || null, note: "No submission email on file for this listing — the package is prepared; submit via the official link." }, { application: { id: appId, status: "PACKAGE READY" } });
      // v1.3.2: the package-ready receipt — the talent gets the snapshot
      // (what would have gone out + the portal link) even though no email
      // went to the agency. A snapshot failure never fails the send.
      try {
        const snap = await storeSnapshot(appId, "package-ready", {
          email, destination: null, destinationSource: null, submitVia: opp.source_url || null,
          sentAt: null, messageId: null, status: "PACKAGE READY",
          note: "The agency has no submission email on file — the full package is ready for the portal; the snapshot carries everything that would have gone out.",
        });
        if (snap) {
          const sres = await sendSnapshotEmailToTalent(appId, snap);
          await audit("application.snapshot.email", "application", appId, "admin", { snapshotEmailSent: sres.sent, messageId: sres.messageId ?? null, reason: sres.reason ?? null }, { snapshot: snap });
        }
      } catch (e) { console.error("snapshot failed for", appId, (e as any)?.message || e); }
      return ok({ sent: false, packageReady: true, applicationId: appId, status: "PACKAGE READY", destination: null, submitVia: opp.source_url || null, email: { from: email.from, cc: email.cc, replyTo: email.replyTo, subject: email.subject, body: email.body, referenceCode: email.referenceCode, portfolioLink: email.portfolioLink, payAsk: email.payAsk } });
    }
    const emailId = await enqueueEmail({ to: dest.to, cc: email.cc, replyTo: email.replyTo, talentId: String(app.talent_id), applicationId: appId, kind: "application", subject: email.subject, body: email.body });
    const attempt = await drainOneEmail(emailId);
    if (attempt.sent) {
      // v1.3.2: the sent receipt — snapshot stored on the application and
      // the receipt email queued to the talent. A snapshot failure never
      // fails the send.
      try {
        const qRows = await db.all("SELECT sent_at, message_id FROM email_queue WHERE id = ?", [emailId]);
        const snap = await storeSnapshot(appId, "email-sent", {
          email, destination: dest.to, destinationSource: dest.source, submitVia: null,
          sentAt: qRows[0]?.sent_at ?? null, messageId: attempt.messageId ?? null, status: "SUBMITTED — SENT",
        });
        if (snap) {
          const sres = await sendSnapshotEmailToTalent(appId, snap);
          await audit("application.snapshot.email", "application", appId, "admin", { snapshotEmailSent: sres.sent, messageId: sres.messageId ?? null, reason: sres.reason ?? null }, { snapshot: snap });
        }
      } catch (e) { console.error("snapshot failed for", appId, (e as any)?.message || e); }
      return ok({ sent: true, applicationId: appId, status: "SUBMITTED — SENT", messageId: attempt.messageId, destination: dest.to, destinationSource: dest.source, referenceCode: email.referenceCode });
    }
    return ok({ sent: false, queued: true, applicationId: appId, status: String(app.status), emailId, destination: dest.to, reason: attempt.reason, note: "Email queued — it was not sent. The drain will retry it; nothing is claimed sent." });
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
      const tp = await loadTalent(String(b.talentId));
      const opp = JSON.parse(String(oppRows[0].data_json));
      const dg = deriveOppGenders(opp);
      if (genderBlocksTalent(dg.genders, talentGender(tp?.profile))) return err(400, `This opportunity requires ${dg.genders} talent and does not match this talent's gender (derived from listing text, ${dg.source}).`);
      const id = genId("app");
      const ts = nowIso();
      await db.run("INSERT INTO applications (id, talent_id, opportunity_id, status, created_at, updated_at) VALUES (?, ?, ?, 'AWAITING APPROVAL', ?, ?)", [id, b.talentId, b.opportunityId, ts, ts]);
      await audit("application.create", "application", id, String(b.talentId), { talentId: b.talentId, opportunityId: b.opportunityId, status: "AWAITING APPROVAL", note: await modeNote() }, { application: { id, talent_id: b.talentId, opportunity_id: b.opportunityId, status: "AWAITING APPROVAL", created_at: ts, updated_at: ts } });
      return json({ ok: true, application: { id, talentId: b.talentId, opportunityId: b.opportunityId, status: "AWAITING APPROVAL" }, note: await modeNote() }, 201);
    }
    if (method === "GET" && rest.length === 1) {
      // v1.3.0: the full applications list is admin-only. A talent sees
      // only their own applications (never anyone else's).
      if (isAdmin(req)) {
        const rows = await db.all("SELECT * FROM applications ORDER BY created_at DESC");
        let list = rows.map(applicationSummary);
        if (q.get("talentId")) list = list.filter((a) => a.talentId === q.get("talentId"));
        if (q.get("status")) list = list.filter((a) => a.status === q.get("status"));
        return ok({ applications: list, total: list.length });
      }
      const me = await talentFromToken(req);
      if (!me) return err(401, "authentication required");
      const rows = await db.all("SELECT * FROM applications WHERE talent_id = ? ORDER BY created_at DESC", [me]);
      let list = rows.map(applicationSummary);
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
        if (!(await liveMode())) {
          return err(400, "SUBMITTED — CONFIRMED is BLOCKED in TEST MODE: no submission is ever sent live. The application stays AWAITING APPROVAL until TEST MODE is lifted by the owner.");
        }
        const sentRows = await db.all("SELECT id FROM email_queue WHERE application_id = ? AND kind = 'application' AND status = 'SENT' LIMIT 1", [rest[1]]);
        if (!sentRows.length) {
          return err(400, "Cannot mark CONFIRMED before the application email is sent — send it first (POST /applications/:id/send). Nothing is confirmed on a promise.");
        }
      }
      await db.run("UPDATE applications SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), rest[1]]);
      await audit("application.status", "application", rest[1], String(rows[0].talent_id), { status }, { status });
      return ok({ application: { id: rest[1], talentId: rows[0].talent_id, opportunityId: rows[0].opportunity_id, status } });
    }
    if (method === "DELETE" && rest.length === 2) {
      const adm = requireAdmin(req); if (adm) return adm;
      await db.run("DELETE FROM applications WHERE id = ?", [rest[1]]);
      await audit("application.delete", "application", rest[1], "admin", {}, { deleted: true });
      return ok({ deleted: true, applicationId: rest[1] });
    }
    // ----- v1.3.2: submission link, snapshot, outcome (receipts) -----
    // GET /applications/:id — the full record: snapshot, submission link,
    // outcome. The list below carries the summary only.
    if (method === "GET" && rest.length === 2) {
      const rows = await db.all("SELECT * FROM applications WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "application not found");
      const chk = await requireTalentOrAdmin(req, String(rows[0].talent_id)); if (!chk.ok) return chk.res!;
      return ok({ application: applicationView(rows[0]) });
    }
    // POST /applications/:id/submission-link — record the portal link for a
    // form/portal submission (e.g. the TaylorMade Tally form). The talent
    // gets the link in her snapshot email; the agency can go back and
    // check it. The snapshot is refreshed with the link when one exists.
    if (method === "POST" && rest.length === 3 && rest[2] === "submission-link") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || !b.link) return err(400, "link is required");
      const link = String(b.link).trim();
      if (!/^https?:\/\/.+/.test(link) || link.length < 10) return err(400, "link must be an http(s) URL");
      const rows = await db.all("SELECT * FROM applications WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "application not found");
      await db.run("UPDATE applications SET submission_link = ?, updated_at = ? WHERE id = ?", [link, nowIso(), rest[1]]);
      const note = b.note ? String(b.note).slice(0, 500) : null;
      const existing = rows[0].snapshot_json ? JSON.parse(String(rows[0].snapshot_json)) : null;
      if (existing) {
        existing.link = link;
        existing.submitVia = link;
        if (note) existing.note = note;
        await db.run("UPDATE applications SET snapshot_json = ? WHERE id = ?", [JSON.stringify(existing), rest[1]]);
      }
      await audit("application.submission-link", "application", rest[1], "admin", { link, note }, { submissionLink: link });
      const updated = await db.all("SELECT * FROM applications WHERE id = ?", [rest[1]]);
      return ok({ application: applicationView(updated[0]) });
    }
    // POST /applications/:id/snapshot — (re)build the snapshot from the
    // current record and email the receipt to the talent. The send flow
    // calls the same routine automatically when a submission is confirmed.
    if (method === "POST" && rest.length === 3 && rest[2] === "snapshot") {
      const adm = requireAdmin(req); if (adm) return adm;
      const rows = await db.all("SELECT * FROM applications WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "application not found");
      const b = (await body(req)) || {};
      const snap = await storeSnapshot(rest[1], "manual", { status: String(rows[0].status), submitVia: rows[0].submission_link || null, note: b.note ? String(b.note).slice(0, 500) : null });
      if (!snap) return err(404, "application not found");
      const sent = await sendSnapshotEmailToTalent(rest[1], snap);
      await audit("application.snapshot.send", "application", rest[1], "admin", { emailSent: sent.sent, messageId: sent.messageId ?? null, reason: sent.reason ?? null }, { snapshot: snap });
      return ok({ snapshot: snap, snapshotEmailQueued: sent.queued, snapshotEmailSent: sent.sent, messageId: sent.messageId ?? null, emailReason: sent.reason ?? null });
    }
    // POST /applications/:id/outcome — record the agency's outcome on an
    // application (accepted / callback / rejected) and notify the talent
    // INSTANTLY (email + profile notification). Every detail comes from
    // the agency's reply as supplied — nothing is invented: a missing call
    // time or location is reported as "still to come". Accepted creates
    // (or updates) the booking from the supplied facts only.
    if (method === "POST" && rest.length === 3 && rest[2] === "outcome") {
      const adm = requireAdmin(req); if (adm) return adm;
      const rows = await db.all("SELECT * FROM applications WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "application not found");
      const app = rows[0];
      const b = await body(req);
      if (!b || !b.outcome) return err(400, "outcome is required");
      const outcome = String(b.outcome).toLowerCase();
      if (outcome !== "accepted" && outcome !== "callback" && outcome !== "rejected") return err(400, 'outcome must be "accepted", "callback", or "rejected"');
      const details = (b.details && typeof b.details === "object") ? b.details : {};
      for (const k of ["callTime", "location", "whatToBring", "contact", "ask", "notes"]) {
        if (details[k] !== undefined && (typeof details[k] !== "string" || details[k].length > 500)) return err(400, `${k} must be text (max 500 characters)`);
      }
      let eventDate: string | null = null;
      if (details.eventDate !== undefined && details.eventDate !== null && details.eventDate !== "") {
        eventDate = String(details.eventDate).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return err(400, "eventDate must be YYYY-MM-DD");
      }
      let replyBody: string | null = null;
      if (b.replyId) {
        const rRows = await db.all("SELECT * FROM application_replies WHERE id = ? AND application_id = ?", [String(b.replyId), rest[1]]);
        if (!rRows.length) return err(400, "replyId does not belong to this application");
        replyBody = String(rRows[0].body || "");
      }
      const oppRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [app.opportunity_id]);
      const opp = oppRows.length ? JSON.parse(String(oppRows[0].data_json)) : null;
      const t = await loadTalent(String(app.talent_id));
      const talentName = t ? (`${t.profile.firstName ?? ""} ${t.profile.lastName ?? ""}`.trim() || t.profile.professionalName || "Talent") : String(app.talent_id);
      const fromName = b.fromName ? String(b.fromName).slice(0, 100) : (opp?.casting_org || opp?.employer || null);
      const ts = nowIso();
      const detailJson = JSON.stringify({ ...details, eventDate, replyId: b.replyId ? String(b.replyId) : null });
      await db.run("UPDATE applications SET outcome = ?, outcome_at = ?, outcome_detail_json = ?, updated_at = ? WHERE id = ?", [outcome, ts, detailJson, ts, rest[1]]);
      let booking: any = null;
      if (outcome === "accepted") {
        const existing = await db.all("SELECT * FROM bookings WHERE application_id = ? AND status IN ('BOOKED', 'BOOKING CONFIRMED') ORDER BY created_at DESC LIMIT 1", [rest[1]]);
        const evidence = (details.notes ? String(details.notes) : null) || (replyBody ? replyBody.slice(0, 200) : null) || "Accepted per agency reply";
        if (existing.length) {
          booking = existing[0];
          if (eventDate) await db.run("UPDATE bookings SET event_date = ?, updated_at = ? WHERE id = ?", [eventDate, ts, booking.id]);
          await audit("booking.outcome.update", "booking", String(booking.id), "admin", { applicationId: rest[1], outcome, eventDate }, { bookingId: String(booking.id) });
          const upd = await db.all("SELECT * FROM bookings WHERE id = ?", [booking.id]);
          booking = bookingView(upd[0]);
        } else {
          const grossDollars = parseMoney(opp?.compensation);
          const grossCents = grossDollars !== null && Number.isFinite(grossDollars) ? Math.round(grossDollars * 100) : 0;
          const s = await commissionSettings();
          const daily = normalizedDaily(opp?.compensation_type, opp?.compensation, opp?.hours);
          const rate = commissionRate(daily, s);
          const { feeCents, netCents } = commissionFor(grossCents, rate);
          const id = genId("bkg");
          await db.run("INSERT INTO bookings (id, application_id, talent_id, opportunity_id, status, event_date, released_at, evidence, gross_cents, rate, commission_cents, net_cents, created_at, updated_at) VALUES (?, ?, ?, ?, 'BOOKED', ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
            [id, rest[1], app.talent_id, app.opportunity_id, eventDate, evidence, grossCents, rate, feeCents, netCents, ts, ts]);
          const title = opp?.title ?? String(app.opportunity_id);
          const summary = `Booking confirmed: ${title} for ${talentName}. Gross $${(grossCents / 100).toFixed(2)} — commission ${rate}% $${(feeCents / 100).toFixed(2)} — net $${(netCents / 100).toFixed(2)}. Evidence on file. No payment processed — tracking only.`;
          await notify(String(app.talent_id), `Booking confirmed: ${title}`, summary);
          const talentEmail = t ? String(t.profile.email || "") : "";
          const emailId = genId("eml");
          await db.run("INSERT INTO email_queue (id, talent_id, subject, body, status, created_at, to_addr, application_id, kind) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, 'booking')",
            [emailId, app.talent_id, `Booking confirmed: ${title}`, summary, ts, talentEmail || null, rest[1]]);
          await audit("booking.create", "booking", id, "admin", { applicationId: rest[1], talentId: app.talent_id, opportunityId: app.opportunity_id, status: "BOOKED", grossCents, rate, commissionCents: feeCents, netCents, agency: opp ? (opp.casting_org || opp.employer || null) : null, note: "Booking created from a recorded agency acceptance — facts from the reply only." }, {
            booking: { id, application_id: rest[1], talent_id: app.talent_id, opportunity_id: app.opportunity_id, status: "BOOKED", event_date: eventDate, released_at: null, evidence, gross_cents: grossCents, rate, commission_cents: feeCents, net_cents: netCents, created_at: ts, updated_at: ts },
          });
          const created = await db.all("SELECT * FROM bookings WHERE id = ?", [id]);
          booking = bookingView(created[0]);
        }
      }
      const email = await buildOutcomeEmail(talentName, outcome, opp, { ...details, eventDate }, fromName);
      const talentEmail = t ? String(t.profile.email || "") : "";
      let emailSent = false, messageId: string | undefined, emailReason: string | undefined, emailQueued = false;
      if (talentEmail) {
        const emailId = await enqueueEmail({ to: talentEmail, replyTo: email.replyTo, talentId: String(app.talent_id), applicationId: rest[1], kind: "outcome", subject: email.subject, body: email.body });
        emailQueued = true;
        const attempt = await drainOneEmail(emailId);
        emailSent = attempt.sent;
        messageId = attempt.messageId;
        emailReason = attempt.sent ? undefined : attempt.reason;
      } else {
        emailReason = "no talent email on file";
      }
      const ntfTitle = outcome === "accepted" ? `You're booked: ${opp?.title ?? String(app.opportunity_id)}` : outcome === "callback" ? `Callback from ${fromName || "the agency"}: ${opp?.title ?? String(app.opportunity_id)}` : `Update: ${opp?.title ?? String(app.opportunity_id)} — not selected`;
      const ntfBody = outcome === "accepted"
        ? `You were booked for ${opp?.title ?? String(app.opportunity_id)}.${details.callTime ? ` Call time: ${details.callTime}.` : ""}${eventDate ? ` Date: ${eventDate}.` : ""}${details.location ? ` Location: ${details.location}.` : ""}${!details.callTime || !eventDate || !details.location ? " Anything not listed here is still to come from the agency — we will send it the moment it arrives." : ""}`
        : outcome === "callback"
          ? `${fromName || "The agency"} came back on ${opp?.title ?? String(app.opportunity_id)}.${details.ask ? ` They ask: ${details.ask}` : ""}${details.notes ? ` Notes: ${details.notes}` : ""}`
          : `You were not selected for ${opp?.title ?? String(app.opportunity_id)}. Your other applications are unaffected.`;
      const ntfId = await notify(String(app.talent_id), ntfTitle, ntfBody);
      await audit("application.outcome", "application", rest[1], "admin", { outcome, replyId: b.replyId ? String(b.replyId) : null, fromName, eventDate, emailQueued, emailSent, messageId: messageId ?? null, notificationId: ntfId, bookingId: booking?.id ?? null }, { outcome, outcomeAt: ts, booking: booking ?? null });
      const updated = await db.all("SELECT * FROM applications WHERE id = ?", [rest[1]]);
      return ok({ application: applicationView(updated[0]), booking: booking ?? null, emailQueued, emailSent, messageId: messageId ?? null, emailReason, notificationId: ntfId });
    }
    return err(404, "not found");
  }

  // ----- v8/v11: inbound replies from agencies/casting -----
  if (rest[0] === "application-replies") {
    if (method === "POST" && rest.length === 1) {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || !b.applicationId || !b.body) return err(400, "applicationId and body are required");
      const appRows = await db.all("SELECT * FROM applications WHERE id = ?", [b.applicationId]);
      if (!appRows.length) return err(404, "application not found");
      const id = genId("rpl");
      const ts = nowIso();
      const receivedAt = b.receivedAt ? String(b.receivedAt) : ts;
      await db.run("INSERT INTO application_replies (id, application_id, talent_id, from_name, channel, body, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, b.applicationId, appRows[0].talent_id, b.fromName ? String(b.fromName) : null, b.channel ? String(b.channel) : null, String(b.body), receivedAt, ts]);
      const row = { id, application_id: b.applicationId, talent_id: appRows[0].talent_id, from_name: b.fromName ? String(b.fromName) : null, channel: b.channel ? String(b.channel) : null, body: String(b.body), received_at: receivedAt, created_at: ts };
      await audit("application.reply.record", "application", b.applicationId, "admin", { replyId: id, fromName: row.from_name, channel: row.channel }, { applicationReply: row });
      return json({ ok: true, reply: { id, applicationId: b.applicationId, talentId: appRows[0].talent_id, fromName: row.from_name, channel: row.channel, body: row.body, receivedAt } }, 201);
    }
    if (method === "GET" && rest.length === 1) {
      // Talent sees only their own replies; admin sees all.
      const appId = q.get("applicationId");
      const talentId = q.get("talentId");
      let rows = await db.all("SELECT * FROM application_replies ORDER BY received_at DESC, created_at DESC");
      if (appId) rows = rows.filter((r: any) => String(r.application_id) === appId);
      if (talentId) rows = rows.filter((r: any) => String(r.talent_id) === talentId);
      if (!isAdmin(req)) {
        const me = await talentFromToken(req);
        if (!me) return err(401, "authentication required");
        rows = rows.filter((r: any) => String(r.talent_id) === me);
      }
      return ok({ replies: rows.map((r: any) => ({ id: r.id, applicationId: r.application_id, talentId: r.talent_id, fromName: r.from_name, channel: r.channel, body: r.body, receivedAt: r.received_at, createdAt: r.created_at })), total: rows.length });
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
      // v1.3.1: an optional event date (YYYY-MM-DD) — the 72-hour release
      // rule needs a concrete booking date. Validated, never invented.
      const eventDate = b.eventDate ? String(b.eventDate).trim() : null;
      if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return err(400, "eventDate must be YYYY-MM-DD");
      await db.run("INSERT INTO bookings (id, application_id, talent_id, opportunity_id, status, event_date, released_at, evidence, gross_cents, rate, commission_cents, net_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, b.applicationId, app.talent_id, app.opportunity_id, status, eventDate, null, String(b.evidence), grossCents, rate, feeCents, netCents, ts, ts]);
      const t = await loadTalent(String(app.talent_id));
      const name = t ? `${t.profile.firstName ?? ""} ${t.profile.lastName ?? ""}`.trim() : String(app.talent_id);
      const title = opp?.title ?? String(app.opportunity_id);
      const summary = `Booking confirmed: ${title} for ${name}. Gross $${(grossCents / 100).toFixed(2)} — commission ${rate}% $${(feeCents / 100).toFixed(2)} — net $${(netCents / 100).toFixed(2)}. Evidence on file. No payment processed — tracking only.`;
      const ntfId = await notify(String(app.talent_id), `Booking confirmed: ${title}`, summary);
      const emailId = genId("eml");
      const talentEmail = t ? String(t.profile.email || "") : "";
      await db.run("INSERT INTO email_queue (id, talent_id, subject, body, status, created_at, to_addr, application_id, kind) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, 'booking')",
        [emailId, app.talent_id, `Booking confirmed: ${title}`, summary, ts, talentEmail || null, b.applicationId]);
      await audit("booking.create", "booking", id, "admin", { applicationId: b.applicationId, talentId: app.talent_id, opportunityId: app.opportunity_id, status, grossCents, rate, commissionCents: feeCents, netCents, agency: opp ? (opp.casting_org || opp.employer || null) : null, email: "email pending: integration not connected" }, {
        booking: { id, application_id: b.applicationId, talent_id: app.talent_id, opportunity_id: app.opportunity_id, status, event_date: eventDate, released_at: null, evidence: String(b.evidence), gross_cents: grossCents, rate, commission_cents: feeCents, net_cents: netCents, created_at: ts, updated_at: ts },
        notification: ntfId ? { id: ntfId, talent_id: app.talent_id, title: `Booking confirmed: ${title}`, body: summary, read: false, created_at: ts } : null,
        email: { id: emailId, talent_id: app.talent_id, subject: `Booking confirmed: ${title}`, body: summary, status: "QUEUED", created_at: ts },
      });
      return json({ ok: true, booking: bookingView({ id, application_id: b.applicationId, talent_id: app.talent_id, opportunity_id: app.opportunity_id, status, event_date: eventDate, released_at: null, evidence: b.evidence, gross_cents: grossCents, rate, commission_cents: feeCents, net_cents: netCents, created_at: ts, updated_at: ts }), note: "Email queued only — the booking confirmation goes out once the agency mailbox is connected. No payment processed — tracking only." }, 201);
    }
    if (method === "GET" && rest.length === 1) {
      const rows = await db.all("SELECT * FROM bookings ORDER BY created_at DESC");
      let list = rows.map(bookingView);
      if (q.get("talentId")) list = list.filter((x) => x.talentId === q.get("talentId"));
      if (q.get("status")) list = list.filter((x) => x.status === q.get("status"));
      // v1.3.1: attach the resolved event date + hours-until so the talent
      // view can show the booking date and the 72-hour release rule.
      for (const x of list) {
        const oppRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [x.opportunityId]);
        const opp = oppRows.length ? JSON.parse(String(oppRows[0].data_json)) : null;
        const ev = resolveBookingEventDate(x, opp);
        x.eventDate = ev.display;
        x.eventDateSource = ev.source;
        x.hoursUntilEvent = ev.date ? Math.round(((ev.date.getTime() - Date.now()) / 3_600_000) * 10) / 10 : null;
      }
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
          `Your booking is now ${status}. Gross $${(Number(rows[0].gross_cents || 0) / 100).toFixed(2)} — commission $${(Number(rows[0].commission_cents || 0) / 100).toFixed(2)} — net $${(Number(rows[0].net_cents || 0) / 100).toFixed(2)}. No payment processed — tracking only.`);
      }
      await audit("booking.status", "booking", rest[1], "admin", { status }, { status, evidence });
      const updated = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      return ok({ booking: bookingView(updated[0]) });
    }
    if (method === "POST" && rest.length === 3 && rest[2] === "complete") {
      const adm = requireAdmin(req); if (adm) return adm;
      const rows = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "booking not found");
      if (!rows[0].evidence) return err(400, "evidence is required to mark a booking complete");
      const ts = nowIso();
      await db.run("UPDATE bookings SET status = 'COMPLETED', updated_at = ? WHERE id = ?", [ts, rest[1]]);
      await notify(String(rows[0].talent_id), "Job completed — proof of work added", `Your booking is now marked COMPLETED and appears in your proof-of-work credits. Net pay for this job: $${(Number(rows[0].net_cents || 0) / 100).toFixed(2)}. No payment processed — tracking only.`);
      const updated = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      const b = updated[0];
      await audit("booking.complete", "booking", rest[1], "admin", { status: "COMPLETED" }, { booking: { id: b.id, application_id: b.application_id, talent_id: b.talent_id, opportunity_id: b.opportunity_id, status: "COMPLETED", evidence: b.evidence, gross_cents: b.gross_cents, rate: b.rate, commission_cents: b.commission_cents, net_cents: b.net_cents, created_at: b.created_at, updated_at: b.updated_at } });
      return ok({ booking: bookingView(updated[0]) });
    }
    // ----- v1.3.1: release a BOOKED booking (>= 72h before the event) -----
    if (method === "POST" && rest.length === 3 && rest[2] === "release") {
      const rows = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "booking not found");
      const booking = rows[0];
      const chk = await requireTalentOrAdmin(req, String(booking.talent_id)); if (!chk.ok) return chk.res!;
      const b = (await body(req)) || {};
      const status = String(booking.status || "");
      if (status === "RELEASED") return err(400, "this booking was already released");
      if (status === "COMPLETED") return err(400, "this booking is already completed and cannot be released");
      if (status !== "BOOKED" && status !== "BOOKING CONFIRMED") return err(400, `only a BOOKED booking can be released (currently ${status})`);
      const t = await loadTalent(String(booking.talent_id));
      const oppRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [booking.opportunity_id]);
      const opp = oppRows.length ? JSON.parse(String(oppRows[0].data_json)) : null;
      const ev = resolveBookingEventDate(booking, opp);
      const talentName = t ? (`${t.profile.firstName ?? ""} ${t.profile.lastName ?? ""}`.trim() || t.profile.professionalName || "Talent") : String(booking.talent_id);
      const agencyName = String(opp?.casting_org || opp?.employer || "Casting");
      const title = opp?.title ?? String(booking.opportunity_id);
      const hoursUntil = ev.date ? (ev.date.getTime() - Date.now()) / 3_600_000 : null;
      const dest = opp ? await resolveDestination(opp) : { to: null, source: null };
      const destination = dest.to && !isPlatformSupportEmail(dest.to) ? dest.to : null;
      const destinationSource = destination ? dest.source : null;
      // dryRun previews the exact email + the 72h math without changing
      // anything — safe in either mode, same discipline as the send endpoint.
      if (b.dryRun === true) {
        const email = await buildReleaseEmail(talentName, agencyName, opp, ev.display);
        return ok({ dryRun: true, bookingId: rest[1], status, eventDate: ev.display, eventDateSource: ev.source, hoursUntilEvent: hoursUntil === null ? null : Math.round(hoursUntil * 10) / 10, releasable: ev.date !== null && hoursUntil !== null && hoursUntil >= 72, destination, destinationSource, email: { from: email.from, to: destination, replyTo: email.replyTo, subject: email.subject, body: email.body } });
      }
      if (!ev.date || hoursUntil === null) {
        return err(400, "No event date on file for this booking — the 72-hour rule cannot be checked, so the release is blocked. Contact the agency directly.");
      }
      if (hoursUntil < 72) {
        return err(400, `Too late to release online — this booking starts in ${Math.max(0, Math.round(hoursUntil))} hours, inside the 72-hour window. Contact the agency directly.`);
      }
      const ts = nowIso();
      await db.run("UPDATE bookings SET status = 'RELEASED', released_at = ?, updated_at = ? WHERE id = ?", [ts, ts, rest[1]]);
      await notify(String(booking.talent_id), `Booking released: ${title}`, `You released this booking ${Math.round(hoursUntil)} hours before the event date (${ev.display}). It no longer appears on your page.${destination ? " The agency has been notified by email." : " No agency email was on file, so contact the agency directly."}`);
      let emailQueued = false, emailSent = false, messageId: string | undefined, emailReason: string | undefined;
      if (destination) {
        const email = await buildReleaseEmail(talentName, agencyName, opp, ev.display);
        const emailId = await enqueueEmail({ to: destination, replyTo: email.replyTo, talentId: String(booking.talent_id), applicationId: String(booking.application_id), kind: "release", subject: email.subject, body: email.body });
        emailQueued = true;
        const attempt = await drainOneEmail(emailId);
        emailSent = attempt.sent;
        messageId = attempt.messageId;
        emailReason = attempt.sent ? undefined : attempt.reason;
      }
      const actor = chk.admin ? "admin" : String(booking.talent_id);
      await audit("booking.release", "booking", rest[1], actor, { talentId: String(booking.talent_id), opportunityId: String(booking.opportunity_id), eventDate: ev.display, eventDateSource: ev.source, hoursUntilEvent: Math.round(hoursUntil * 10) / 10, releasedAt: ts, destination, destinationSource, emailQueued, emailSent, messageId: messageId ?? null }, { booking: { id: rest[1], status: "RELEASED", released_at: ts, updated_at: ts } });
      const updated = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      return ok({ ok: true, booking: bookingView(updated[0]), releasedAt: ts, eventDate: ev.display, eventDateSource: ev.source, hoursUntilEvent: Math.round(hoursUntil * 10) / 10, emailQueued, emailSent, messageId: messageId ?? null, destination, destinationSource, emailNote: destination ? (emailSent ? "Release email sent to the agency." : `Release email queued — not yet sent (${emailReason || "drain pending"}).`) : "No agency email on file for this listing — the release was recorded but no email was sent. Contact the agency directly." });
    }
    if (method === "PATCH" && rest.length === 3 && rest[2] === "payment") {
      const adm = requireAdmin(req); if (adm) return adm;
      const b = await body(req);
      if (!b || (b.status !== "PAYMENT_PENDING" && b.status !== "PAID")) return err(400, 'payment status must be "PAYMENT_PENDING" or "PAID"');
      const rows = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "booking not found");
      await db.run("UPDATE bookings SET updated_at = ? WHERE id = ?", [nowIso(), rest[1]]);
      await audit("booking.payment", "booking", rest[1], "admin", { paymentStatus: b.status, note: "Payment tracking only — no payment processed." });
      const updated = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      return ok({ booking: { ...bookingView(updated[0]), paymentStatus: b.status }, note: "Payment tracking only — no payment processed." });
    }
    // ----- v1.3.1: delete a booking (admin only) — only a RELEASED or
    // CANCELLED booking can be deleted. A BOOKED booking must be released
    // first; a COMPLETED one is proof-of-work and stays. Added to clear the
    // release-button live-proof scratch booking, which the API could not
    // remove (no delete route existed).
    if (method === "DELETE" && rest.length === 2) {
      const adm = requireAdmin(req); if (adm) return adm;
      const rows = await db.all("SELECT * FROM bookings WHERE id = ?", [rest[1]]);
      if (!rows.length) return err(404, "booking not found");
      const status = String(rows[0].status || "");
      if (status !== "RELEASED" && status !== "CANCELLED") {
        return err(400, `only a released or cancelled booking can be deleted — release a booked one first (currently ${status})`);
      }
      await db.run("DELETE FROM bookings WHERE id = ?", [rest[1]]);
      await audit("booking.delete", "booking", rest[1], "admin",
        { status, talentId: String(rows[0].talent_id), opportunityId: String(rows[0].opportunity_id) }, { deleted: true });
      return ok({ ok: true, deletedId: rest[1] });
    }
    return err(404, "not found");
  }

  // ----- notifications -----
  if (rest[0] === "notifications" && rest.length === 3 && rest[2] === "read" && method === "PATCH") {
    const rows = await db.all("SELECT * FROM notifications WHERE id = ?", [rest[1]]);
    if (!rows.length) return err(404, "notification not found");
    const chk = await requireTalentOrAdmin(req, String(rows[0].talent_id)); if (!chk.ok) return chk.res!;
    await db.run("UPDATE notifications SET read = 1 WHERE id = ?", [rest[1]]);
    await audit("notification.read", "notification", rest[1], String(rows[0].talent_id), {}, { read: 1 });
    return ok({ notification: { id: rest[1], read: true } });
  }
  if (rest[0] === "notifications" && rest.length === 2 && method === "DELETE") {
    const rows = await db.all("SELECT * FROM notifications WHERE id = ?", [rest[1]]);
    if (!rows.length) return err(404, "notification not found");
    const chk = await requireTalentOrAdmin(req, String(rows[0].talent_id)); if (!chk.ok) return chk.res!;
    await db.run("DELETE FROM notifications WHERE id = ?", [rest[1]]);
    await audit("notification.delete", "notification", rest[1], String(rows[0].talent_id), {}, { deleted: true });
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
  const ts = nowIso();
  await db.run("INSERT INTO notifications (id, talent_id, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)", [id, talentId, title, body, ts]);
  await audit("notification.create", "notification", id, "system", { talentId, title }, { notification: { id, talent_id: talentId, title, body, read: false, created_at: ts } });
  return id;
}

// ---------- v1.3.2: missing-info questions (talent alerts + receipts) ----------
// The in-house TTT form. Question definitions live in
// missing-info-questions.ts (exact casting-form option texts, captured from
// the live TaylorMade form). These helpers compute gaps from the talent
// record, validate answers against the exact option lists, and store them
// on the record forever — the same storage the submitter reads, so an
// answer given once never becomes a gap again.
function profileValue(profile: any, path: string): any {
  const m = path.match(/^clothing\["(.+)"\]$/);
  if (m) return (profile.clothing || {})[m[1]];
  const parts = path.split(".");
  if (parts.length === 2) return (profile[parts[0]] || {})[parts[1]];
  return profile[path];
}
function setProfileValue(profile: any, path: string, value: any): void {
  const m = path.match(/^clothing\["(.+)"\]$/);
  if (m) { if (!profile.clothing) profile.clothing = {}; profile.clothing[m[1]] = value; return; }
  const parts = path.split(".");
  if (parts.length === 2) { if (!profile[parts[0]]) profile[parts[0]] = {}; profile[parts[0]][parts[1]] = value; return; }
  profile[path] = value;
}
function storedShort(profile: any, path: string): string | null {
  const v = profileValue(profile, path);
  return typeof v === "string" ? v : null;
}
function questionApplies(q: MissingInfoQuestion, profile: any): boolean {
  if (q.applies) {
    const g = storedShort(profile, "demographics.gender") || (typeof profile.gender === "string" ? profile.gender : null);
    if (!g || g !== q.applies) return false;
  }
  if (q.requires) {
    const [reqPath, reqVal] = q.requires.split("=");
    const key = reqPath === "tattoos" ? "demographics.tattoos" : reqPath === "vintageVehicle" ? "demographics.vintageVehicle" : reqPath;
    if (storedShort(profile, key) !== reqVal) return false;
  }
  return true;
}
function isAnswered(q: MissingInfoQuestion, profile: any): boolean {
  const v = profileValue(profile, q.path);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "boolean") return v === true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.trim() !== "";
  return v !== null && v !== undefined;
}
function filmingDateOptions(opp: any, formSlug: string | null): { options: string[] | null; source: string } {
  const title = String(opp?.title || "");
  if (formSlug === "miamivice" || /miami vice/i.test(title)) {
    return { options: [...TAYLORMADE_MIAMI_VICE_DATES], source: "taylormade-miamivice" };
  }
  if (opp) {
    const tokens = extractDateTokens(opp.production_dates || opp.deadline);
    if (tokens.length >= 2) {
      const display = tokens.map((t) => {
        const m = t.match(/^([a-z]+)-(\d{1,2})-(\d{4})$/);
        if (!m) return t;
        return m[1].charAt(0).toUpperCase() + m[1].slice(1) + " " + m[2] + ", " + m[3];
      });
      return { options: display, source: "opportunity" };
    }
  }
  return { options: null, source: "free-text" };
}
function computeMissingInfo(profile: any, photosCount: number, opp: any = null, formSlug: string | null = null): { questions: any[]; gaps: any[] } {
  const questions: any[] = [];
  for (const q of MISSING_INFO_QUESTIONS) {
    if (!questionApplies(q, profile)) continue;
    let options: string[] | null = q.options;
    let optionsSource = "casting-form";
    if (q.id === "filmingDates") {
      const r = filmingDateOptions(opp, formSlug);
      options = r.options;
      optionsSource = r.source;
    }
    const answered = isAnswered(q, profile);
    questions.push({ id: q.id, label: q.label, kind: q.kind, options, optionsSource, store: q.store, order: q.order, answered, currentValue: profileValue(profile, q.path) ?? null });
  }
  questions.sort((a, b) => a.order - b.order);
  const gaps = questions.filter((x) => !x.answered).map((x) => ({ id: x.id, label: x.label, kind: x.kind }));
  if (photosCount < 2) {
    gaps.push({ id: "photos", label: "Close-up + full-body photos", kind: "photos" });
  }
  return { questions, gaps };
}
function validateAnswer(q: MissingInfoQuestion, value: any, options: string[] | null): string | null {
  if (q.kind === "bool") {
    if (value !== true) return `${q.label}: check the box to confirm`;
    return null;
  }
  if (q.kind === "choice") {
    if (typeof value !== "string" || !(options || []).includes(value)) return `${q.label}: pick one of the listed options`;
    return null;
  }
  if (q.kind === "multi") {
    if (!Array.isArray(value) || value.length === 0) return `${q.label}: pick at least one`;
    for (const v of value) if (typeof v !== "string" || !(options || []).includes(v)) return `${q.label}: "${String(v)}" is not one of the listed options`;
    return null;
  }
  if (q.kind === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + "T00:00:00Z"))) return `${q.label}: use YYYY-MM-DD`;
    if (value > todayStr()) return `${q.label}: date of birth cannot be in the future`;
    return null;
  }
  if (q.kind === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${q.label}: enter a number`;
    if (q.id === "weightLbs" && (n < 50 || n > 700)) return `${q.label}: weight must be 50–700 lbs`;
    if (q.id === "carYear" && (n < 1960 || n > 1989)) return `${q.label}: car year must be 1960–1989`;
    return null;
  }
  if (q.kind === "text") {
    if (typeof value !== "string" || !value.trim() || value.length > 200) return `${q.label}: enter text (max 200 characters)`;
    return null;
  }
  return `${q.label}: unknown question kind`;
}
function storeAnswerValue(q: MissingInfoQuestion, value: any): any {
  if (q.store === "short") return shortCode(String(value));
  if (q.store === "bool") return true;
  if (q.kind === "number") return Number(value);
  return value;
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

// ---------- gender gate (owner order 2026-11-22) ----------
// Gender is never a SCORE — it is a hard eligibility gate. A listing that
// requires female must NEVER match a male talent, and vice versa. Listings
// carry no gender column (opportunities store data_json only), so the
// requirement is derived from the listing text at match time: per-role
// "(Female; …)" / "(Male; …)" / "(Both genders; …)" annotations in roles
// first, then the listing prose (title / eligibility / appearance). A
// listing with no gender requirement matches every gender. Derivation is
// logged, never silent: matchTalent counts gender-excluded listings in
// stats.genderExcluded and names each one, and the rotation queue marks
// them SKIPPED with the reason on the row.
// v1.2.1: the listing-level open-signal test runs against prose + roles
// with per-role annotations stripped, and a definite gender plus "both"
// roles resolves to that definite gender — a "both" role never overrides
// a definite one (allcasting:307031 was open, now female).
const FEMALE_WORDS = /\b(female|females|woman|women|girl|girls|actress|actresses)\b/i;
const MALE_WORDS = /\b(male|males|man|men|boy|boys)\b/i;
// Explicit open-to-all signals — these override any single-gender mention
// (e.g. a grooming note "Men should stop cutting hair" inside an
// "All roles and types welcome" listing is not a male-only requirement).
const OPEN_GENDER_SIGNALS = /\b(both genders|all genders|male and female|female and male|men and women|women and men|male or female|female or male|male\/female|female\/male|female\s*&\s*male|male\s*&\s*female|all roles and types welcome|open to all|everyone welcome)\b/i;
const ROLE_GENDER_ANN = /\((Female|Male|Both genders|All genders)[^)]*\)/gi;
type OppGenders = "female" | "male" | "open";
function deriveOppGenders(o: any): { genders: OppGenders; source: string } {
  const roles = String(o.roles || "");
  const prose = [o.title, o.eligibility, o.appearance].map((x) => String(x || "")).join(" ");
  // v1.2.1: per-role "(Both genders; …)" / "(All genders; …)" annotations
  // are per-ROLE, not listing-level — they must not trip the listing-level
  // open-signal test, or a mixed listing (Female role + Both role, e.g.
  // allcasting:307031 "Recruitment for Miami Girl Group") is declared
  // open before the annotation branch ever runs. Strip the annotations
  // from roles before testing open signals; the prose test is unchanged.
  const rolesNoAnn = roles.replace(ROLE_GENDER_ANN, " ");
  if (OPEN_GENDER_SIGNALS.test(rolesNoAnn + " " + prose)) return { genders: "open", source: "open-signal" };
  const anns: string[] = [];
  ROLE_GENDER_ANN.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = ROLE_GENDER_ANN.exec(roles)) !== null) anns.push(am[1].toLowerCase());
  if (anns.length) {
    // v1.2.1: a "both"/"all" role never opens the whole listing on its own
    // and never overrides a definite one. A definite gender plus "both"
    // roles resolves to that definite gender (matching is per-opportunity,
    // not per-role — the listing does say female/male); only both/all
    // roles, or both definite genders present, stays open.
    const definite = new Set<string>();
    for (const a of anns) {
      if (a.includes("both") || a.includes("all")) continue;
      else if (a.includes("female")) definite.add("female");
      else if (a.includes("male")) definite.add("male");
    }
    if (definite.has("female") && definite.has("male")) return { genders: "open", source: "roles-both" };
    if (definite.has("female")) {
      if (MALE_WORDS.test(prose)) return { genders: "open", source: "roles+prose" };
      return { genders: "female", source: "roles" };
    }
    if (definite.has("male")) {
      if (FEMALE_WORDS.test(prose)) return { genders: "open", source: "roles+prose" };
      return { genders: "male", source: "roles" };
    }
    return { genders: "open", source: "roles-both" };
  }
  const f = FEMALE_WORDS.test(prose);
  const ml = MALE_WORDS.test(prose);
  if (f && !ml) return { genders: "female", source: "prose" };
  if (ml && !f) return { genders: "male", source: "prose" };
  return { genders: "open", source: "prose-none-or-both" };
}
// The talent's gender lives at profile.demographics.gender (the wizard
// saves it nested; the frontend also mirrors it flat as profile.gender).
// Only a definite Male/Female gates anything: non-binary, other, and
// prefer-not-to-say are never hard-excluded by this filter.
function talentGender(profile: any): "male" | "female" | null {
  const g = profile?.demographics?.gender ?? profile?.gender ?? null;
  if (!g) return null;
  const n = String(g).trim().toLowerCase();
  if (n === "male") return "male";
  if (n === "female") return "female";
  return null;
}
function genderBlocksTalent(oppGenders: OppGenders, tg: "male" | "female" | null): boolean {
  if (!tg) return false;
  if (oppGenders === "female" && tg === "male") return true;
  if (oppGenders === "male" && tg === "female") return true;
  return false;
}

// ---------- selectivity (owner order 2026-11-22) ----------
// Every casting is classed by how selective it is, derived from the
// listing text — never guessed as guaranteed:
// - "guaranteed": the text says it outright — open call / open casting /
//   walk-in / everyone welcome / immediate hire / no audition. These are
//   the everybody-gets-picked jobs; they rank first in Jobs For You and
//   are preferred by the auto-submit rotation.
// - "selective": audition / callback / limited spots / only a few picked /
//   competitive / by invitation. Clearly labeled so a talent knows the
//   odds before applying; ranked below guaranteed.
// - "unknown": neither signal is present. Shown as "selectivity unknown",
//   never promoted to guaranteed. Audition language wins ties: an "open
//   casting call" that still holds auditions is selective, not guaranteed.
// ("Open to all ethnicities/ages" is an inclusivity statement, not a hire
// guarantee — the lookahead excludes it. "No experience necessary" only
// speaks to requirements, not hiring odds, so it is not a signal either.)
type SelectivityClass = "guaranteed" | "selective" | "unknown";
const GUARANTEED_SIGNALS = /\b(open call|open casting|walk[\s-]?in|everyone welcome|all welcome|all are welcome|everyone hired|immediate hire|hiring immediately|no audition|all sizes welcome|all types welcome|open to all(?!\s+(ethnicities|ages))|everyone who (shows? up|applies|attends)|guaranteed (hire|work|pay|booking))\b/i;
const SELECTIVE_SIGNALS = /\b(audition|callback|call back|limited spots?|limited openings?|only (a )?few|only \d+ (will be|to be) (selected|chosen|picked)|competitive|by invitation|invite only|invitation only|screening|must have experience|experienced only|highly selective|shortlist)\b/i;
function deriveSelectivity(o: any): { class: SelectivityClass; reason: string | null } {
  const text = [o.title, o.roles, o.eligibility, o.appearance, o.skills, o.category].map((x) => String(x || "")).join(" ");
  const g = GUARANTEED_SIGNALS.exec(text);
  const s = SELECTIVE_SIGNALS.exec(text);
  if (g && !s) return { class: "guaranteed", reason: g[0] };
  if (s) return { class: "selective", reason: s[0] };
  return { class: "unknown", reason: null };
}
const SELECTIVITY_RANK: Record<SelectivityClass, number> = { guaranteed: 0, unknown: 1, selective: 2 };

// ---------- matching ----------
function parseAgeRange(s: string | null | undefined): [number, number] | null {
  if (!s) return null;
  const m = String(s).match(/(\d+)\s*-\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function matchTalent(profile: any, opps: any[], stats?: { genderExcluded?: Array<{ opportunityId: string; requiredGender: "female" | "male"; source: string }> }): any[] {
  const out: any[] = [];
  const mySkills: Set<string> = new Set((profile.skills || []).map((s: string) => String(s).toLowerCase()));
  const myCats = new Set((profile.categories || []).map((s: string) => String(s).toLowerCase()));
  const myAvail = new Set((profile.availability || []).map((s: string) => String(s).toLowerCase()));
  const myAge = parseAgeRange(profile.ageRange);
  const myMin = profile.minCompensation != null ? Number(profile.minCompensation) : null;
  const tg = talentGender(profile);
  for (const o of opps) {
    if (oppExpired(o)) continue;
    // Gender gate FIRST: a listing that requires the other gender is never
    // a match — it is excluded, not down-scored, and the exclusion is
    // counted + named in stats so it is never a silent drop.
    const dg = deriveOppGenders(o);
    if (genderBlocksTalent(dg.genders, tg)) {
      if (stats) {
        stats.genderExcluded = stats.genderExcluded || [];
        stats.genderExcluded.push({ opportunityId: String(o.id), requiredGender: dg.genders as "female" | "male", source: dg.source });
      }
      continue;
    }
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
    // Gender fit is cited on the match itself when the listing restricts
    // by gender, so the talent can see WHY it fits — never a silent pass.
    const sel = deriveSelectivity(o);
    if (dg.genders !== "open") reasons.push(`Gender fit: ${dg.genders}-only role`);
    out.push({ opportunityId: o.id, classification, reasons, score, selectivity: sel.class, selectivityReason: sel.reason, genderRequirement: dg.genders === "open" ? null : dg.genders });
  }
  // Guaranteed (everybody-gets-picked) castings rank first, then unknown,
  // then selective — within each class, best score first. The score and
  // its classification thresholds are unchanged; only the order moves.
  out.sort((a, b) => (SELECTIVITY_RANK[a.selectivity as SelectivityClass] - SELECTIVITY_RANK[b.selectivity as SelectivityClass]) || (b.score - a.score));
  return out;
}

// ---------- automation eligibility (v1.3.1) ----------
// Jobs For You marks a job automationEligible only when the talent's
// automation/Fast-Track rules actually fit the listing. The match score
// alone is NOT enough: a high-scoring job can still violate a hard rule,
// and auto-send must never fire on it. Blocked jobs stay visible in the
// feed (and keep their match classification) for manual review — they
// are never auto-sent. The auto-runner only sends jobs with
// automationEligible === true, so this one gate protects both surfaces.
// Three hard rules, each returning a human-readable blocker:
//  (1) Geography — the listing's FIXED location must sit inside the
//      talent's geography (e.g. south-florida). A "nationwide" LABEL on
//      the listing does not move the job: Toronto/London/San Francisco/
//      Savannah/Orlando/Jacksonville all fail for a south-florida talent
//      even when labeled nationwide. Only a genuinely location-free or
//      remote listing passes without a place.
//  (2) Pay — undisclosed pay and unpaid/TFP work are never auto-eligible
//      (they go to manual review). Stated pay must meet the talent's
//      minDaily floor (normalized to a daily figure, as elsewhere).
//  (3) Role requirements — a listing that REQUIRES a language the talent
//      does not speak (or has not verified on their profile) is never
//      auto-eligible. "A plus"/"preferred" language is not a requirement
//      and never blocks; a bare mention ("a French plantation owner") is
//      not a requirement either.
const SOUTH_FLORIDA_COUNTIES = ["miami-dade", "broward", "palm beach"];
const SOUTH_FLORIDA_CITIES = ["miami", "miami beach", "fort lauderdale", "hollywood", "hialeah", "coral gables", "boca raton", "west palm beach", "pompano beach", "pembroke pines", "miramar", "davie", "plantation", "sunrise", "tamarac", "delray beach", "boynton beach", "deerfield beach", "doral", "kendall", "homestead", "aventura", "hallandale beach", "north miami", "north miami beach", "sunny isles beach", "key biscayne", "coconut creek", "margate", "lauderhill", "weston", "cooper city", "dania beach", "lake worth", "palm beach gardens", "jupiter", "wellington", "royal palm beach", "greenacres", "riviera beach", "lake park", "parkland", "miami gardens", "miami lakes", "miami springs", "opa-locka", "sweetwater", "palmetto bay", "pinecrest", "cutler bay", "florida city", "lighthouse point", "southwest ranches", "medley", "el portal", "biscayne park", "golden beach", "surfside", "bal harbour", "bay harbor islands", "indian creek"];
function locationInGeography(o: any, geography: string | null | undefined): boolean {
  const geo = String(geography || "").trim().toLowerCase();
  if (!geo) return true; // no geography rule set — nothing to enforce
  if (geo === "nationwide") return true; // talent opted into everywhere
  const loc = o.location || {};
  const city = normName(String(loc.city || ""));
  const county = normName(String(loc.county || ""));
  const state = normName(String(loc.state || ""));
  const raw = normName(String(loc.raw || ""));
  // Genuinely location-free / remote: nothing places the job anywhere.
  if (!city && !county && !state && !raw) return true;
  if (/\bremote\b|\bvirtual\b|work from home/i.test(raw) || /\bremote\b|\bvirtual\b/i.test(city)) return true;
  if (geo === "south-florida") {
    // A non-Florida state on the record fails outright. The seed sometimes
    // puts the city name in the state field ("London", "San Francisco") —
    // that is still not Florida.
    if (state && state !== "fl" && state !== "florida") return false;
    if (SOUTH_FLORIDA_COUNTIES.includes(county)) return true;
    if (SOUTH_FLORIDA_CITIES.includes(city)) return true;
    // Fallback: the raw text names a South Florida place (records where
    // city/county are empty but the raw string carries the location).
    const hay = ` ${raw} `;
    for (const name of [...SOUTH_FLORIDA_COUNTIES, ...SOUTH_FLORIDA_CITIES].sort((a, b) => b.length - a.length)) {
      if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay)) return true;
    }
    return false;
  }
  if (geo === "florida") {
    if (state === "fl" || state === "florida") return true;
    if (SOUTH_FLORIDA_COUNTIES.includes(county)) return true;
    if (/\bflorida\b|, fl\b/.test(raw)) return true;
    return false;
  }
  // Unknown geography value: do not invent a boundary — do not block.
  return true;
}
function payBlocker(o: any, automation: any, profile: any): string | null {
  const compType = String(o.compensation_type || "").trim().toLowerCase();
  const compText = String(o.compensation || "");
  if (compType === "unpaid" || compType === "tfp" || /\btfp\b/i.test(compText) || /\bunpaid\b/i.test(compText) || /\bvolunteer\b/i.test(compText) || /\bno pay\b/i.test(compText)) {
    return "Unpaid / TFP work is never auto-sent";
  }
  const daily = normalizedDaily(o.compensation_type, o.compensation, o.hours);
  if (daily === null || daily <= 0) return "Pay undisclosed — needs talent approval";
  const minDaily = automation?.minDaily != null ? Number(automation.minDaily) : (profile?.minCompensation != null ? Number(profile.minCompensation) : null);
  if (minDaily !== null && Number.isFinite(minDaily) && daily < minDaily) return `Pay $${daily}/day is below the $${minDaily}/day floor`;
  return null;
}
// Languages a listing can require, longest first so "Haitian Creole"
// matches before "Creole" and "American Sign Language" before "ASL".
const KNOWN_LANGUAGES = ["american sign language", "haitian creole", "mandarin", "cantonese", "portuguese", "spanish", "french", "hindi", "urdu", "arabic", "italian", "german", "russian", "korean", "japanese", "vietnamese", "tagalog", "creole", "asl", "dutch", "polish", "greek", "turkish", "farsi", "persian", "bengali", "punjabi", "tamil", "telugu", "gujarati", "hebrew", "yiddish", "swahili", "yoruba", "igbo", "amharic"];
const LANGUAGE_PREFERENCE = /\ba plus\b|\bplus\b|preferred|preference|bonus|nice to have|helpful|\bideal\b|optional|not required/i;
const LANGUAGE_REQUIRED = /\bmust\b|fluent|fluency|multilingual|\bspeak\b|speaks|speaking|required|requires|\brequire\b|requirement|native|bilingual/i;
function normalizeLanguage(s: string): string {
  const n = normName(s);
  if (n === "american sign language") return "asl";
  if (n === "haitian creole") return "creole";
  return n;
}
function requiredLanguages(o: any): string[] {
  const text = [o.roles, o.eligibility, o.skills].map((x) => String(x || "")).join("\n");
  const found = new Set<string>();
  // Split into clauses; a language only counts as REQUIRED when its own
  // clause demands it ("must be fluent in Hindi", "fluent in both English
  // and Spanish"). A clause that merely prefers it ("Spanish a plus",
  // "bilingual Spanish/English a plus") never blocks, and a bare mention
  // ("a French plantation owner") is not a requirement at all.
  for (const clause of text.split(/[;.\n\r—–]+/)) {
    const c = clause.trim();
    if (!c) continue;
    const langs: string[] = [];
    for (const lang of KNOWN_LANGUAGES) {
      const re = new RegExp(`\\b${lang.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(c)) langs.push(lang);
    }
    if (!langs.length) continue;
    if (LANGUAGE_PREFERENCE.test(c)) continue;
    if (!LANGUAGE_REQUIRED.test(c)) continue;
    for (const l of langs) found.add(normalizeLanguage(l));
  }
  return [...found];
}
function automationBlockers(profile: any, opp: any, automation: any): string[] {
  const blockers: string[] = [];
  // (1) Geography — the listing's own "nationwide" label never overrides
  // the talent's geography; only the fixed location (or a genuinely
  // location-free/remote listing) decides.
  if (!locationInGeography(opp, automation?.geography)) {
    const raw = String(opp.location?.raw || opp.location?.city || opp.geography || "unknown location");
    blockers.push(`Location ${raw} is outside your ${automation.geography} area`);
  }
  // (2) Pay — undisclosed/unpaid never auto-sends; stated pay must clear
  // the floor.
  const pay = payBlocker(opp, automation, profile);
  if (pay) blockers.push(pay);
  // (3) Role requirements — required languages the talent does not have.
  const required = requiredLanguages(opp);
  if (required.length) {
    const mine = new Set((profile?.languages || []).map((l: string) => normalizeLanguage(String(l))));
    if (!mine.size) {
      blockers.push(`Requires ${required.join(", ")} — no languages on your profile to verify against`);
    } else {
      const missing = required.filter((l) => !mine.has(l));
      if (missing.length) blockers.push(`Requires ${missing.join(", ")} — not on your profile`);
    }
  }
  return blockers;
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
  const tg = talentGender(profile);
  const live = opps.filter((o) => !oppExpired(o));
  const ranked = live
    .map((o) => ({ o, daily: normalizedDaily(o.compensation_type, o.compensation, o.hours), sel: deriveSelectivity(o) }))
    // Guaranteed (everybody-gets-picked) first, then unknown, then
    // selective — within each class, best pay first. (Before: pay-first
    // only, so a selective audition could outrank an open-call hire.)
    .sort((a, b) => (SELECTIVITY_RANK[a.sel.class] - SELECTIVITY_RANK[b.sel.class]) || ((b.daily ?? -1) - (a.daily ?? -1)));
  const selected: any[] = [];
  const queue: any[] = [];
  const bookedTokens = new Set<string>();
  for (const b of booked) for (const t of extractDateTokens(b.production_dates || b.deadline)) bookedTokens.add(t);
  const bookedLocs = new Set(booked.map((b) => normName(String(b.location?.raw || ""))));
  for (const { o, daily, sel } of ranked) {
    const dg = deriveOppGenders(o);
    const genderReq = dg.genders === "open" ? null : dg.genders;
    // Gender gate: a listing that requires the other gender is never
    // selected for auto-submit — SKIPPED with the reason on the row.
    if (genderBlocksTalent(dg.genders, tg)) {
      queue.push({ opportunityId: o.id, decision: "SKIPPED", reason: `Gender requirement is ${dg.genders}-only — does not match the talent's gender (derived from listing text, ${dg.source})`, normalizedDailyPay: daily, selectivity: sel.class, selectivityReason: sel.reason, genderRequirement: genderReq });
      continue;
    }
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
    queue.push({ opportunityId: o.id, decision, reason, normalizedDailyPay: daily, selectivity: sel.class, selectivityReason: sel.reason, genderRequirement: genderReq });
  }
  return queue;
}

// ---------- v1.3.0: live mail — build, queue, drain, send ----------
// The portfolio link goes in an application email ONLY when the talent
// agreed to be pitched: an active likeness release + sharing granted
// (profile not private, photos shared) + profile not paused. Anything
// else → the link is WITHHELD and the email carries no portfolio line.
async function portfolioLinkAllowed(talentId: string, profile: any): Promise<boolean> {
  if (profile.paused === true) return false;
  if (profile.visibility === "private" || profile.sharePhotos !== true) return false;
  const c = await db.all("SELECT signed FROM consents WHERE talent_id = ?", [talentId]);
  return c.length > 0 && Number(c[0].signed) === 1;
}

// ---------- v1.3.1: release button — 72-hour rule + one release template ----------
// Platform support / general-contact addresses are never destinations.
const PLATFORM_SUPPORT_EMAILS = ["support@allcasting.com", "support@projectcasting.com", "support@productionbeast.com", "hello@heybooker.app", "casting@backstage.com", "uigroup@ep.com"];
function isPlatformSupportEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return PLATFORM_SUPPORT_EMAILS.includes(String(email).trim().toLowerCase());
}

// An extractDateTokens token -> a Date at the START of that day (UTC).
// ISO tokens ("2026-11-23") parse directly; month tokens ("january-5-2026")
// need the month name mapped. Returns null for anything unparseable.
function parseEventDateToken(token: string): Date | null {
  const t = String(token || "").trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = t.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)-(\d{1,2})-(\d{4})$/i);
  if (!m) return null;
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const d = new Date(Date.UTC(Number(m[3]), months.indexOf(m[1].toLowerCase()), Number(m[2])));
  return Number.isNaN(d.getTime()) ? null : d;
}

// The booking's event date, in order: the event_date stored on the booking
// row (set at booking time), else the earliest date token in the
// opportunity's production_dates (the shoot start). The application
// deadline is NOT an event date — the shoot is after the deadline — so it
// is never used here. No date anywhere -> null, and a release with no
// date cannot be checked and is blocked.
function resolveBookingEventDate(booking: any, opp: any): { date: Date | null; source: "booking" | "opportunity" | null; display: string | null } {
  const stored = String(booking?.event_date ?? booking?.eventDate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(stored)) {
    const d = parseEventDateToken(stored);
    if (d) return { date: d, source: "booking", display: stored };
  }
  const tokens = extractDateTokens(opp?.production_dates);
  const parsed = tokens.map(parseEventDateToken).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime());
  if (parsed.length) return { date: parsed[0], source: "opportunity", display: parsed[0].toISOString().slice(0, 10) };
  return { date: null, source: null, display: null };
}

// buildMissingInfoEmail — the missing-info alert (v1.3.2). Lists exactly
// what is missing, nothing more. The talent answers in the in-profile form
// (link) or replies to this email; either way the answers land on her
// record. Never invents a missing item — the list IS the gap list.
async function buildMissingInfoEmail(talentName: string, gaps: any[], formUrl: string | null, opportunityTitle: string | null): Promise<any> {
  const from = await agencyEmail();
  const subject = `Top Tea Talents — ${gaps.length} detail${gaps.length === 1 ? "" : "s"} we need from you${opportunityTitle ? ` for ${opportunityTitle}` : ""}`;
  const lines: string[] = [];
  lines.push(`Hello ${talentName},`);
  lines.push(``);
  if (opportunityTitle) lines.push(`You match ${opportunityTitle}, but we cannot submit you yet — the details below are missing from your profile.`);
  else lines.push(`We cannot submit you for new roles yet — the details below are missing from your profile.`);
  lines.push(``);
  for (const g of gaps) {
    if (g.kind === "photos") lines.push(`- ${g.label} — upload them in your portfolio (2 photos: one close-up, one full body).`);
    else lines.push(`- ${g.label}`);
  }
  lines.push(``);
  if (formUrl) {
    lines.push(`Answer them here (mostly taps — typing only where a number or date is needed):`);
    lines.push(formUrl);
    lines.push(``);
  }
  lines.push(`Or just reply to this email with your answers — we will put them on your profile the moment they arrive.`);
  lines.push(`Once these are in, they stay on your record, so this never happens again unless a new role needs something new.`);
  lines.push(``);
  lines.push(`Thank you,`);
  lines.push(`TOP TEA TALENTS — ${from}`);
  return { from, subject, body: lines.join("\n"), replyTo: [from] };
}

// buildSubmissionSnapshotEmail — the receipt (v1.3.2). Exactly what went
// out: the job, the reference code, the destination or portal link, and
// when it went. The full sent email text is stored on the application
// record; this email carries the facts the talent needs at a glance.
async function buildSubmissionSnapshotEmail(talentName: string, snap: any): Promise<any> {
  const from = await agencyEmail();
  const subject = `Your submission receipt — ${snap.jobTitle || snap.opportunityId} — Ref ${snap.referenceCode || "—"}`;
  const lines: string[] = [];
  lines.push(`Hello ${talentName},`);
  lines.push(``);
  lines.push(`Here is exactly what TOP TEA TALENTS sent for you:`);
  lines.push(``);
  lines.push(`Job: ${snap.jobTitle || snap.opportunityId}`);
  if (snap.org) lines.push(`Agency: ${snap.org}`);
  lines.push(`Reference code: ${snap.referenceCode || "—"}`);
  lines.push(`Status: ${snap.status}`);
  if (snap.destination) lines.push(`Sent to: ${snap.destination}`);
  if (snap.submitVia) lines.push(`Submitted via: ${snap.submitVia}`);
  if (snap.sentAt) lines.push(`Sent: ${snap.sentAt}`);
  if (snap.payLine) lines.push(`Pay: ${snap.payLine}`);
  if (snap.portfolioLink) lines.push(`Portfolio link sent: ${snap.portfolioLink}`);
  if (snap.answersSummary) lines.push(`About you (as sent): ${snap.answersSummary}`);
  if (snap.photosSent !== null && snap.photosSent !== undefined) lines.push(`Photos sent: ${snap.photosSent}`);
  if (snap.note) lines.push(`Note: ${snap.note}`);
  lines.push(``);
  lines.push(`The full text we sent is stored on your application — ask the agency any time and we can show it to you.`);
  lines.push(``);
  lines.push(`Thank you,`);
  lines.push(`TOP TEA TALENTS — ${from}`);
  return { from, subject, body: lines.join("\n"), replyTo: [from] };
}

// buildOutcomeEmail — the outcome notification (v1.3.2). Every detail comes
// from the agency's reply as recorded — the system never invents a call
// time, location, or pay figure. Anything the reply did not say is listed
// under "Still to come", never guessed.
async function buildOutcomeEmail(talentName: string, outcome: string, opp: any, details: any, fromName: string | null): Promise<any> {
  const from = await agencyEmail();
  const title = String(opp?.title || opp?.id || "your application").slice(0, 80);
  const label = outcome === "accepted" ? "You're booked!" : outcome === "callback" ? "Callback / questions from the agency" : "Update on your application";
  const subject = `${label} — ${title}`;
  const lines: string[] = [];
  lines.push(`Hello ${talentName},`);
  lines.push(``);
  if (outcome === "accepted") {
    lines.push(`Good news — ${fromName || "the agency"} booked you for ${title}.`);
  } else if (outcome === "callback") {
    lines.push(`${fromName || "The agency"} came back on your application for ${title} — they have a question or a callback for you.`);
  } else {
    lines.push(`${fromName || "The agency"} came back on your application for ${title} — you were not selected for this one.`);
  }
  lines.push(``);
  const d = details || {};
  const shown: string[] = [];
  if (d.callTime) { lines.push(`Call time: ${d.callTime}`); shown.push("callTime"); }
  if (d.eventDate) { lines.push(`Date: ${d.eventDate}`); shown.push("eventDate"); }
  if (d.location) { lines.push(`Location: ${d.location}`); shown.push("location"); }
  if (d.whatToBring) { lines.push(`Bring: ${d.whatToBring}`); shown.push("whatToBring"); }
  if (d.contact) { lines.push(`Contact: ${d.contact}`); shown.push("contact"); }
  if (d.ask) { lines.push(`The agency asks: ${d.ask}`); shown.push("ask"); }
  if (d.notes) { lines.push(`Notes: ${d.notes}`); shown.push("notes"); }
  if (outcome === "accepted") {
    const missing: string[] = [];
    if (!d.callTime) missing.push("call time");
    if (!d.eventDate) missing.push("date");
    if (!d.location) missing.push("location");
    if (!d.whatToBring) missing.push("what to bring");
    if (missing.length) {
      lines.push(``);
      lines.push(`Still to come from the agency: ${missing.join(", ")}. We will send them the moment they arrive — nothing here is a guess.`);
    }
  }
  if (outcome === "rejected") {
    lines.push(`Nothing else was sent with this one — no call time, no booking. Your other applications are unaffected.`);
  }
  lines.push(``);
  lines.push(`Thank you,`);
  lines.push(`TOP TEA TALENTS — ${from}`);
  return { from, subject, body: lines.join("\n"), replyTo: [from] };
}

// buildReleaseEmail — the ONE release template. Only the talent's name and
// the agency name vary per email; the booking title/date/location are facts
// from the record, never invented. No per-release free text in v1.
async function buildReleaseEmail(talentName: string, agencyName: string, opp: any, eventDisplay: string | null): Promise<any> {
  const from = await agencyEmail();
  const title = String(opp?.title || opp?.id || "booking").slice(0, 80);
  const subject = `Release — ${title} — ${talentName}`;
  const lines: string[] = [];
  lines.push(`Hello ${agencyName} team,`);
  lines.push(``);
  lines.push(`TOP TEA TALENTS is writing on behalf of ${talentName}.`);
  lines.push(``);
  lines.push(`${talentName} will not be available for the booking below due to certain circumstances.`);
  lines.push(``);
  lines.push(`Booking: ${title}`);
  if (eventDisplay) lines.push(`Date: ${eventDisplay}`);
  if (opp?.location?.raw) lines.push(`Location: ${opp.location.raw}`);
  lines.push(`Agency: ${agencyName}`);
  lines.push(``);
  lines.push(`Please contact TOP TEA TALENTS if you need anything further.`);
  lines.push(``);
  lines.push(`Thank you,`);
  lines.push(`TOP TEA TALENTS — ${from}`);
  return { from, subject, body: lines.join("\n"), replyTo: [from] };
}

// buildApplicationEmail — the one email builder. Subject carries the
// per-(talent, job) reference code; the body carries the pay-ask line
// whenever the posting lists no parseable pay (normalizedDaily null);
// the portfolio link line appears only when portfolioLinkAllowed().
// Never invents a pay figure or a link. Pure except for the consent read.
async function buildApplicationEmail(talentId: string, profile: any, opp: any, publicUrl: string | null, automation: any): Promise<any> {
  const ref = refCode(talentId, String(opp.id));
  const name = `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim() || profile.professionalName || "Talent";
  const proName = profile.professionalName || name;
  const daily = normalizedDaily(opp.compensation_type, opp.compensation, opp.hours);
  const payAsk = daily === null;
  const linkOk = await portfolioLinkAllowed(talentId, profile);
  const portfolioLink = linkOk && publicUrl ? publicUrl : null;
  const from = await agencyEmail();
  const talentEmail = String(profile.email || "");
  const title = String(opp.title || opp.id).slice(0, 80);
  const subject = `Application — ${title} — Ref ${ref}`;
  const lines: string[] = [];
  lines.push(`Hello ${opp.casting_org || opp.employer || "Casting"} team,`);
  lines.push(``);
  lines.push(`TOP TEA TALENTS is submitting ${proName} (${name}) for the role below.`);
  lines.push(``);
  lines.push(`Role: ${opp.title || opp.id}`);
  if (opp.production) lines.push(`Production: ${opp.production}`);
  if (opp.location?.raw) lines.push(`Location: ${opp.location.raw}`);
  if (opp.production_dates) lines.push(`Dates: ${opp.production_dates}`);
  if (opp.roles) lines.push(`Roles: ${String(opp.roles).slice(0, 400)}`);
  lines.push(``);
  lines.push(`About ${proName}: ${[profile.city, profile.state].filter(Boolean).join(", ") || "South Florida"}. Categories: ${(profile.categories || []).join(", ") || "—"}. Skills: ${(profile.skills || []).join(", ") || "—"}. Experience: ${profile.experience || "—"}.`);
  if (daily !== null) lines.push(`Listed pay: $${daily}/day (per the posting).`);
  else lines.push(`Could you confirm the pay rate for this role? The posting does not list compensation.`);
  if (portfolioLink) lines.push(`Portfolio: ${portfolioLink}`);
  lines.push(``);
  lines.push(`Reference code: ${ref} — please include it in any reply so we can route it to the right talent and job.`);
  lines.push(`Replies to this email reach both the talent and the agency.`);
  lines.push(``);
  lines.push(`Thank you,`);
  lines.push(`TOP TEA TALENTS — ${from}`);
  return {
    from, subject, body: lines.join("\n"),
    cc: automation?.ccTalent === true && talentEmail ? [talentEmail] : [],
    replyTo: automation?.replyToTalent === true && talentEmail ? [from, talentEmail] : [from],
    referenceCode: ref, portfolioLink, payAsk,
  };
}

// Destination resolution, in order: an admin-supplied address, an address
// parsed from the listing's own instructions/contact fields, a contact
// email on file for the casting org / employer. Most listings carry NO
// address at all (verified Nov 22: 0 of 984 local records) — then the
// destination is null and the caller prepares the package instead of
// claiming a send. Never guesses an address.
async function resolveDestination(opp: any, explicitTo?: string): Promise<{ to: string | null; source: string | null }> {
  if (explicitTo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(explicitTo.trim())) return { to: explicitTo.trim(), source: "admin-supplied" };
  const fromText = extractEmail(opp.submission_instructions) || extractEmail(opp.contact_email) || extractEmail(opp.casting_professional);
  if (fromText) return { to: fromText, source: "listing" };
  const org = String(opp.casting_org || opp.employer || "").trim();
  if (org) {
    const rows = await db.all("SELECT email FROM contacts WHERE normalized = ? AND email IS NOT NULL AND email <> '' LIMIT 1", [normName(org)]);
    if (rows.length) return { to: String(rows[0].email), source: "contacts" };
  }
  return { to: null, source: null };
}

// ---------- v1.3.2: submission snapshots ----------
// storeSnapshot builds the receipt of exactly what went out for an
// application (email sent, package ready, or portal submission) and stores
// it on the application record. The full sent email text is kept in the
// snapshot so the agency can see it verbatim; the talent gets the summary
// by email. Nothing is invented: destination, link, time, and pay come
// from the send result and the listing.
async function storeSnapshot(appId: string, source: string, ctx: any): Promise<any> {
  const appRows = await db.all("SELECT * FROM applications WHERE id = ?", [appId]);
  if (!appRows.length) return null;
  const app = appRows[0];
  const oppRows = await db.all("SELECT data_json FROM opportunities WHERE id = ?", [app.opportunity_id]);
  const opp = oppRows.length ? JSON.parse(String(oppRows[0].data_json)) : null;
  const t = await loadTalent(String(app.talent_id));
  const ref = refCode(String(app.talent_id), String(app.opportunity_id));
  const email = ctx.email || null;
  const daily = opp ? normalizedDaily(opp.compensation_type, opp.compensation, opp.hours) : null;
  const photoRows = await db.all("SELECT COUNT(*) AS n FROM photos WHERE talent_id = ?", [app.talent_id]);
  const snap = {
    applicationId: appId, talentId: String(app.talent_id), opportunityId: String(app.opportunity_id),
    jobTitle: opp?.title || String(app.opportunity_id), org: opp?.casting_org || opp?.employer || null,
    referenceCode: ref, status: ctx.status || String(app.status),
    destination: ctx.destination ?? null, destinationSource: ctx.destinationSource ?? null,
    submitVia: ctx.submitVia ?? null, sentAt: ctx.sentAt ?? null, messageId: ctx.messageId ?? null,
    source,
    payLine: daily !== null ? `$${daily}/day (per the posting).` : "Pay not listed on the posting — the application asked the agency to confirm.",
    portfolioLink: email?.portfolioLink ?? null,
    answersSummary: t ? `${[t.profile.city, t.profile.state].filter(Boolean).join(", ") || "South Florida"}. Categories: ${(t.profile.categories || []).join(", ") || "—"}. Skills: ${(t.profile.skills || []).join(", ") || "—"}. Experience: ${t.profile.experience || "—"}.` : null,
    photosSent: Number(photoRows[0]?.n ?? 0),
    emailSubject: email?.subject ?? null, emailBody: email?.body ?? null,
    link: app.submission_link ?? null, note: ctx.note ?? null,
    recordedAt: nowIso(),
  };
  await db.run("UPDATE applications SET snapshot_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(snap), nowIso(), appId]);
  await audit("application.snapshot", "application", appId, "system", { source, status: snap.status, destination: snap.destination, submitVia: snap.submitVia, messageId: snap.messageId }, { snapshot: snap });
  return snap;
}
async function sendSnapshotEmailToTalent(appId: string, snap: any): Promise<{ queued: boolean; sent: boolean; messageId?: string; reason?: string }> {
  const t = await loadTalent(String(snap.talentId));
  const talentEmail = t ? String(t.profile.email || "") : "";
  if (!talentEmail) return { queued: false, sent: false, reason: "no talent email on file" };
  const name = t ? (`${t.profile.firstName ?? ""} ${t.profile.lastName ?? ""}`.trim() || t.profile.professionalName || "Talent") : "Talent";
  const email = await buildSubmissionSnapshotEmail(name, snap);
  const emailId = await enqueueEmail({ to: talentEmail, replyTo: email.replyTo, talentId: String(snap.talentId), applicationId: appId, kind: "snapshot", subject: email.subject, body: email.body });
  const attempt = await drainOneEmail(emailId);
  return { queued: true, sent: attempt.sent, messageId: attempt.messageId, reason: attempt.sent ? undefined : attempt.reason };
}

async function enqueueEmail(row: { to: string | null; cc?: string[]; replyTo?: string[]; talentId?: string | null; applicationId?: string | null; kind: string; subject: string; body: string }): Promise<string> {
  const id = genId("eml");
  const ts = nowIso();
  await db.run(
    "INSERT INTO email_queue (id, talent_id, subject, body, status, created_at, to_addr, cc, reply_to, application_id, kind, attempts) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, 0)",
    [id, row.talentId ?? null, row.subject, row.body, ts, row.to, (row.cc || []).join(",") || null, (row.replyTo || []).join(",") || null, row.applicationId ?? null, row.kind],
  );
  return id;
}

async function drainOneEmail(emailId: string): Promise<{ sent: boolean; messageId?: string; reason?: string }> {
  const rows = await db.all("SELECT * FROM email_queue WHERE id = ?", [emailId]);
  if (!rows.length) return { sent: false, reason: "email not found" };
  const row = rows[0];
  if (String(row.status) !== "QUEUED") return { sent: false, reason: `email is ${row.status}, not QUEUED` };
  if (!(await liveMode())) return { sent: false, reason: "TEST MODE: sending disabled" };
  const st = mailStatus();
  if (!st.configured) return { sent: false, reason: "mail not configured — missing: " + st.missing.join(", ") };
  const to = String(row.to_addr || "");
  if (!to) {
    await db.run("UPDATE email_queue SET status = 'FAILED', attempts = attempts + 1, last_error = ? WHERE id = ?", ["no recipient address", emailId]);
    return { sent: false, reason: "no recipient address" };
  }
  const from = await agencyEmail();
  try {
    const { messageId } = await sendGmail({
      from, to,
      cc: String(row.cc || "").split(",").map((s: string) => s.trim()).filter(Boolean),
      replyTo: String(row.reply_to || "").split(",").map((s: string) => s.trim()).filter(Boolean),
      subject: String(row.subject), body: String(row.body),
    });
    const ts = nowIso();
    await db.run("UPDATE email_queue SET status = 'SENT', attempts = attempts + 1, sent_at = ?, message_id = ? WHERE id = ?", [ts, messageId, emailId]);
    await audit("email.sent", "email", emailId, "system", { to, subject: String(row.subject), kind: String(row.kind), applicationId: row.application_id ?? null, messageId }, { email: { id: emailId, to_addr: to, subject: String(row.subject), status: "SENT", sent_at: ts, message_id: messageId } });
    if (row.application_id && String(row.kind) === "application") {
      const appRows = await db.all("SELECT * FROM applications WHERE id = ?", [row.application_id]);
      if (appRows.length && String(appRows[0].status) === "APPROVED") {
        await db.run("UPDATE applications SET status = 'SUBMITTED — SENT', updated_at = ? WHERE id = ?", [ts, row.application_id]);
        await audit("application.email.sent", "application", String(row.application_id), "system", { messageId, to }, { application: { id: String(row.application_id), status: "SUBMITTED — SENT" } });
        await notify(String(appRows[0].talent_id), `Application sent: ${String(row.subject).slice(0, 80)}`, `Your application was sent by the agency. Reference ${String(row.subject).match(/Ref (TTT-[A-Z0-9]+)/)?.[1] || ""}.`);
      }
    }
    return { sent: true, messageId };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    const attempts = Number(row.attempts || 0) + 1;
    const status = attempts >= 3 ? "FAILED" : "QUEUED";
    await db.run("UPDATE email_queue SET status = ?, attempts = ?, last_error = ? WHERE id = ?", [status, attempts, msg, emailId]);
    await audit("email.failed", "email", emailId, "system", { to, subject: String(row.subject), kind: String(row.kind), attempts, error: msg });
    return { sent: false, reason: msg };
  }
}

// Drain the queue (oldest first). Never claims a send: a row becomes SENT
// only after Gmail returns a message id. In TEST MODE or with no transport
// configured, rows stay QUEUED and the reason is reported.
async function drainEmailQueue(limit = 10): Promise<{ sent: number; failed: number; skipped: number; reason?: string; details: any[] }> {
  const rows = await db.all("SELECT * FROM email_queue WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT ?", [limit]);
  if (!rows.length) return { sent: 0, failed: 0, skipped: 0, details: [] };
  if (!(await liveMode())) return { sent: 0, failed: 0, skipped: rows.length, reason: "TEST MODE: sending disabled", details: rows.map((r: any) => ({ id: r.id, status: "QUEUED" })) };
  const st = mailStatus();
  if (!st.configured) return { sent: 0, failed: 0, skipped: rows.length, reason: "mail not configured — missing: " + st.missing.join(", "), details: rows.map((r: any) => ({ id: r.id, status: "QUEUED" })) };
  let sent = 0, failed = 0;
  const details: any[] = [];
  for (const row of rows) {
    const r = await drainOneEmail(String(row.id));
    if (r.sent) { sent++; details.push({ id: row.id, sent: true, messageId: r.messageId }); }
    else { failed++; details.push({ id: row.id, sent: false, reason: r.reason }); }
  }
  return { sent, failed, skipped: 0, details };
}

async function queueVerificationEmail(email: string, code: string, purpose: string, talentId: string | null): Promise<string> {
  const from = await agencyEmail();
  const subject = purpose === "password_reset" ? "TOP TEA TALENTS — password reset code" : "TOP TEA TALENTS — verification code";
  const body = [
    `Your TOP TEA TALENTS ${purpose === "password_reset" ? "password reset" : "verification"} code is: ${code}`,
    ``,
    `It expires in 15 minutes and can be used 5 times. If you did not request this, ignore this email.`,
    ``,
    `TOP TEA TALENTS — ${from}`,
  ].join("\n");
  return enqueueEmail({ to: email, talentId, kind: "verification", subject, body });
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
  const payments = books.map((b: any) => ({ bookingId: b.id, status: "TRACKING ONLY", grossCents: b.grossCents, commissionCents: b.commissionCents, netCents: b.netCents, note: "Payment tracking only — no payment processed." }));
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
    eventDate: r.event_date ?? null, releasedAt: r.released_at ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// v1.3.2 (receipts): parse a stored snapshot JSON; returns null when none.
function parseSnapshot(r: Row): any {
  if (!r.snapshot_json) return null;
  try { return JSON.parse(String(r.snapshot_json)); } catch { return null; }
}
function applicationView(r: Row): any {
  const snap = parseSnapshot(r);
  let outcomeDetails: any = null;
  if (r.outcome_detail_json) { try { outcomeDetails = JSON.parse(String(r.outcome_detail_json)); } catch { outcomeDetails = null; } }
  return {
    id: r.id, talentId: r.talent_id, opportunityId: r.opportunity_id, status: r.status,
    submissionLink: r.submission_link ?? null,
    outcome: r.outcome ?? null, outcomeAt: r.outcome_at ?? null, outcomeDetails,
    snapshot: snap,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
// List rows carry the small summary, NOT the full snapshot (which holds
// the entire sent email text). GET /applications/:id returns the full view.
function applicationSummary(r: Row): any {
  const snap = parseSnapshot(r);
  return {
    id: r.id, talentId: r.talent_id, opportunityId: r.opportunity_id, status: r.status,
    submissionLink: r.submission_link ?? null,
    outcome: r.outcome ?? null, outcomeAt: r.outcome_at ?? null,
    snapshotSummary: snap ? { status: snap.status, destination: snap.destination ?? null, submitVia: snap.submitVia ?? null, sentAt: snap.sentAt ?? null, messageId: snap.messageId ?? null, source: snap.source ?? null } : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---------- serve ----------
// v1.3.0: the mail drain runs inside the server every 60s — it is a
// no-op in TEST MODE and with no transport configured, so it is safe to
// run always. On Render's free tier the service sleeps after 15 min
// idle, so the drain also runs on demand: the auto-runner calls
// POST /email/drain after every approve, and the admin can call it
// any time. A send happens only after Gmail returns a message id.
setInterval(() => {
  drainEmailQueue(10).catch((e) => console.error("mail drain failed:", e?.message || e));
}, 60_000);
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
console.log(`TOP TEA TALENTS API listening on :${PORT} (storage: ${db.storage}, durable: ${db.durable}, live-mode env: ${process.env.TTT_LIVE_MODE || "off"} — DB setting live_mode can also enable)`);
