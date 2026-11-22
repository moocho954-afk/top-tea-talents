// TOP TEA TALENTS — wipe-proof ledger mirror.
//
// PROBLEM: the server's ledger (ledger_events) lives in the SQLite file.
// On Render's free tier that file is wiped on every redeploy / restart /
// spin-down, and with it every talent, consent, review, booking and the
// ledger itself. Only the bundled seed comes back.
//
// PATTERN (from the ReacheR ledger — see the wipe-proof-ledger skill):
// the wipeable DB is a derived cache, never the source of truth. The
// source of truth is an append-only, hash-chained event log kept OUTSIDE
// the wipeable store. This module keeps that log as a JSONL mirror file
// next to the DB, written on every ledger append, carrying FULL STATE
// snapshots so a wiped DB can be rebuilt from the mirror alone. On boot,
// if the local DB is empty and a mirror exists, the server replays the
// mirror before serving (boot-restore). The durable copy beyond this
// machine is the mirror file itself, pushed to the repo by a collector
// (see prototype/ledger-mirror-recorder.yml — NOT activated yet; until
// it is, the mirror protects against in-container DB loss, and a full
// Render wipe still needs the push or Turso — stated plainly in MIRROR.md).
//
// INVARIANTS (same as the ledger itself):
//  - Append only. Corrections are new events, never edits.
//  - Every mirror line carries its own chain: mirror_prev / mirror_hash
//    over the WHOLE line (event + state), so tampering with state breaks
//    verification just like tampering with data does.
//  - Never store secrets in the mirror: no password hashes, no session
//    tokens, no photo bytes. A restored talent keeps their profile but
//    must reset their password (recorded in the restore report).
//  - If the mirror chain fails verify, the server REFUSES to restore
//    from it and boots from seed only. A tampered log restores nothing.
//  - The mirror append is fsync'd before ledgerAppend returns, and
//    serialised through an in-process queue so concurrent appends can't
//    interleave lines out of order.
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { Db } from "./libsql.js";

export const MIRROR_GENESIS = "GENESIS";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function canonical(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

// Mirror file sits next to the DB file: /data/top-tea-talents.db ->
// /data/top-tea-talents-mirror.jsonl. Same derivation the storage layer
// uses for the DB path (libsql.ts: DATABASE_PATH or ./data/top-tea-talents.db).
export function mirrorPathFor(dbPath: string): string {
  if (dbPath.endsWith(".db")) return dbPath.slice(0, -3) + "-mirror.jsonl";
  return dbPath + ".mirror.jsonl";
}

export function defaultMirrorPath(): string {
  return mirrorPathFor(process.env.DATABASE_PATH || "./data/top-tea-talents.db");
}

export interface MirrorEvent {
  seq: number;
  ts: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  data: any;
  prev_hash: string;
  hash: string;
}

export interface MirrorLine extends MirrorEvent {
  state: any; // full record snapshot after the change, or null
  mirror_prev: string;
  mirror_hash: string;
}

function mirrorHashFor(line: Omit<MirrorLine, "mirror_hash">): string {
  // The mirror hash covers the whole line (event + state + mirror_prev).
  return sha256(String(line.mirror_prev) + "|" + canonical({
    seq: line.seq, ts: line.ts, event_type: line.event_type, entity_type: line.entity_type,
    entity_id: line.entity_id, actor: line.actor, data: line.data ?? {},
    prev_hash: line.prev_hash, hash: line.hash, state: line.state ?? null,
    mirror_prev: line.mirror_prev,
  }));
}

function readLines(mirrorPath: string): string[] {
  try {
    const text = fs.readFileSync(mirrorPath, "utf-8");
    return text.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

export function readMirrorLines(mirrorPath: string): MirrorLine[] {
  const out: MirrorLine[] = [];
  for (const l of readLines(mirrorPath)) {
    try { out.push(JSON.parse(l)); } catch { /* corrupt line: verify reports it */ }
  }
  return out;
}

export function readMirrorText(mirrorPath: string): string | null {
  try { return fs.readFileSync(mirrorPath, "utf-8"); } catch { return null; }
}

// In-memory tail of the mirror chain, so an append doesn't re-read the
// whole file to find its previous hash. Reset whenever the file is
// (re)created outside the append path (rebuild, fetch) or disappears.
let tailHash: string | null = null;

function appendMirrorSync(mirrorPath: string, event: MirrorEvent, state: any): { ok: boolean; error?: string } {
  try {
    const dir = mirrorPath.split("/").slice(0, -1).join("/");
    if (dir) fs.mkdirSync(dir, { recursive: true });
    let mirrorPrev = MIRROR_GENESIS;
    if (fs.existsSync(mirrorPath)) {
      if (tailHash) {
        mirrorPrev = tailHash;
      } else {
        const existing = readLines(mirrorPath);
        if (existing.length) {
          try {
            const last = JSON.parse(existing[existing.length - 1]);
            if (last && typeof last.mirror_hash === "string") mirrorPrev = last.mirror_hash;
          } catch { /* last line unreadable: verify will flag it; fail loud instead of chaining wrongly */ return { ok: false, error: "mirror tail unreadable" }; }
        }
      }
    } else {
      tailHash = null; // file gone: a fresh mirror starts at genesis
    }
    const line: MirrorLine = {
      seq: event.seq, ts: event.ts, event_type: event.event_type, entity_type: event.entity_type,
      entity_id: event.entity_id, actor: event.actor, data: event.data ?? {},
      prev_hash: event.prev_hash, hash: event.hash, state: state ?? null,
      mirror_prev: mirrorPrev, mirror_hash: "",
    };
    line.mirror_hash = mirrorHashFor(line);
    fs.appendFileSync(mirrorPath, JSON.stringify(line) + "\n", "utf-8");
    const fd = fs.openSync(mirrorPath, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    tailHash = line.mirror_hash;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Serialised queue: concurrent ledgerAppend calls can't interleave mirror
// lines out of order. The append is awaited by ledgerAppend, so the mirror
// is durable before the HTTP response returns.
let mirrorChain: Promise<void> = Promise.resolve();
export function appendMirror(mirrorPath: string, event: MirrorEvent, state: any): Promise<{ ok: boolean; error?: string }> {
  const run = mirrorChain.then(() => appendMirrorSync(mirrorPath, event, state));
  mirrorChain = run.then(() => undefined, () => undefined);
  return run.then((r) => {
    if (!r.ok) console.error(`MIRROR APPEND FAILED (${mirrorPath}): ${r.error} — event seq ${event.seq} is in the DB but NOT in the mirror; run POST /ledger/mirror/rebuild to re-sync.`);
    return r;
  });
}

export interface MirrorVerify {
  exists: boolean;
  events: number;
  head_seq: number;
  head_hash: string;
  valid: boolean;
  first_bad_seq: number | null;
  error?: string;
}

// Recomputes BOTH chains: the ledger event hash (prev_hash + canonical
// event) and the mirror hash (mirror_prev + canonical whole line). A bad
// line stops the check at the first bad seq — never a silent skip.
export function verifyMirrorFile(mirrorPath: string): MirrorVerify {
  const bad: MirrorVerify = { exists: false, events: 0, head_seq: 0, head_hash: MIRROR_GENESIS, valid: false, first_bad_seq: null };
  let raw: string;
  try {
    raw = fs.readFileSync(mirrorPath, "utf-8");
  } catch {
    return { ...bad, error: "mirror file not found" };
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let prevEvent = MIRROR_GENESIS;
  let prevMirror = MIRROR_GENESIS;
  let headSeq = 0;
  let headHash = MIRROR_GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const expectedSeq = i + 1;
    let line: any;
    try {
      line = JSON.parse(lines[i]);
    } catch {
      return { exists: true, events: lines.length, head_seq: headSeq, head_hash: headHash, valid: false, first_bad_seq: expectedSeq, error: "unparsable line" };
    }
    const expectEvent = sha256(String(line.prev_hash) + "|" + canonical({
      seq: Number(line.seq), ts: String(line.ts), event_type: String(line.event_type),
      entity_type: String(line.entity_type), entity_id: String(line.entity_id),
      actor: String(line.actor), data: line.data ?? {},
    }));
    const expectMirror = mirrorHashFor({
      seq: Number(line.seq), ts: String(line.ts), event_type: String(line.event_type),
      entity_type: String(line.entity_type), entity_id: String(line.entity_id),
      actor: String(line.actor), data: line.data ?? {}, prev_hash: String(line.prev_hash),
      hash: String(line.hash), state: line.state ?? null, mirror_prev: String(line.mirror_prev),
    });
    if (
      Number(line.seq) !== expectedSeq ||
      String(line.prev_hash) !== prevEvent ||
      expectEvent !== String(line.hash) ||
      String(line.mirror_prev) !== prevMirror ||
      expectMirror !== String(line.mirror_hash)
    ) {
      return { exists: true, events: lines.length, head_seq: headSeq, head_hash: headHash, valid: false, first_bad_seq: expectedSeq };
    }
    prevEvent = String(line.hash);
    prevMirror = String(line.mirror_hash);
    headSeq = Number(line.seq);
    headHash = String(line.hash);
  }
  return { exists: true, events: lines.length, head_seq: headSeq, head_hash: headHash, valid: true, first_bad_seq: null };
}

// ---------- boot-restore ----------
export interface RestoreReport {
  restored: boolean;
  reason?: string;
  source?: string;
  events?: number;
  applied?: Record<string, number>;
  gaps?: string[];
  needsPasswordReset?: string[];
  first_bad_seq?: number | null;
}

const normName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

function bump(applied: Record<string, number>, k: string) {
  applied[k] = (applied[k] ?? 0) + 1;
}

// Applies ONE mirror line's state to the DB. Latest-state-wins: replay is
// in seq order and every state write is an upsert, so a later event for
// the same entity overwrites an earlier one. Tombstones delete.
// Secrets are NEVER restored: password_hash is set to "" (the talent must
// reset their password — recorded in needsPasswordReset) and sessions are
// never replayed. Photo bytes are never in the mirror — counted as a gap.
async function applyState(db: Db, line: MirrorLine, applied: Record<string, number>, gaps: string[], needsPasswordReset: string[]): Promise<void> {
  const st = line.state ?? {};
  const eid = String(line.entity_id);
  switch (line.event_type) {
    case "talent.register": {
      const t = st.talent;
      if (t && t.id && t.email) {
        await db.run(
          "INSERT OR IGNORE INTO talents (id, email, password_hash, profile_json, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?)",
          [t.id, t.email, JSON.stringify(t.profile ?? {}), t.created_at ?? line.ts, t.updated_at ?? line.ts],
        );
        bump(applied, "talents");
        if (!needsPasswordReset.includes(t.id)) needsPasswordReset.push(t.id);
        const name = `${t.profile?.firstName ?? ""} ${t.profile?.lastName ?? ""}`.trim();
        if (name) {
          const cid = "ctc_" + sha256("talent|" + normName(name)).slice(0, 16);
          const ts = line.ts;
          await db.run(
            "INSERT OR IGNORE INTO contacts (id, kind, name, normalized, email, phone, city, state, source, data_json, created_at, updated_at) VALUES (?, 'talent', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)",
            [cid, name, normName(name), t.email, t.profile?.phone ?? null, JSON.stringify({ talentId: t.id, name }), ts, ts],
          );
          bump(applied, "contacts");
        }
      }
      break;
    }
    case "talent.update": {
      if (st.profile) {
        await db.run("UPDATE talents SET profile_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(st.profile), line.ts, eid]);
        bump(applied, "talents");
      }
      break;
    }
    case "talent.delete": {
      await db.run("DELETE FROM photos WHERE talent_id = ?", [eid]);
      await db.run("DELETE FROM fast_track WHERE talent_id = ?", [eid]);
      await db.run("DELETE FROM guardians WHERE talent_id = ?", [eid]);
      await db.run("DELETE FROM consents WHERE talent_id = ?", [eid]);
      await db.run("DELETE FROM notifications WHERE talent_id = ?", [eid]);
      await db.run("DELETE FROM sessions WHERE talent_id = ?", [eid]);
      await db.run("DELETE FROM talents WHERE id = ?", [eid]);
      bump(applied, "talents");
      break;
    }
    case "consent.sign":
    case "consent.revoke": {
      const c = st.consent;
      if (c) {
        await db.run(
          "INSERT INTO consents (talent_id, signed, signed_at, signature, status, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(talent_id) DO UPDATE SET signed = excluded.signed, signed_at = excluded.signed_at, signature = excluded.signature, status = excluded.status, version = excluded.version, updated_at = excluded.updated_at",
          [eid, c.signed ? 1 : 0, c.signed_at ?? null, c.signature ?? null, c.status ?? "UNSIGNED", c.version ?? "TTT-LIKENESS-v1.0", c.updated_at ?? line.ts],
        );
        bump(applied, "consents");
      }
      if (st.profile) {
        await db.run("UPDATE talents SET profile_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(st.profile), line.ts, eid]);
      }
      break;
    }
    case "review.decision": {
      const r = st.review;
      if (r && r.id) {
        await db.run("INSERT OR IGNORE INTO reviews (id, talent_id, decision, reason, created_at) VALUES (?, ?, ?, ?, ?)",
          [r.id, r.talent_id ?? eid, r.decision, r.reason ?? null, r.created_at ?? line.ts]);
        bump(applied, "reviews");
      }
      if (st.profile) {
        await db.run("UPDATE talents SET profile_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(st.profile), line.ts, eid]);
      }
      break;
    }
    case "application.create": {
      const a = st.application;
      if (a && a.id) {
        await db.run("INSERT OR IGNORE INTO applications (id, talent_id, opportunity_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          [a.id, a.talent_id ?? eid, a.opportunity_id, a.status ?? "AWAITING APPROVAL", a.created_at ?? line.ts, a.updated_at ?? line.ts]);
        bump(applied, "applications");
      }
      break;
    }
    case "application.status": {
      if (st.status) {
        await db.run("UPDATE applications SET status = ?, updated_at = ? WHERE id = ?", [String(st.status), line.ts, eid]);
        bump(applied, "applications");
      }
      break;
    }
    case "application.delete": {
      await db.run("DELETE FROM applications WHERE id = ?", [eid]);
      bump(applied, "applications");
      break;
    }
    case "booking.create": {
      const b = st.booking;
      if (b && b.id) {
        await db.run(
          "INSERT OR IGNORE INTO bookings (id, application_id, talent_id, opportunity_id, status, evidence, gross_cents, rate, commission_cents, net_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [b.id, b.application_id, b.talent_id, b.opportunity_id, b.status ?? "BOOKED", b.evidence ?? null, b.gross_cents ?? 0, b.rate ?? null, b.commission_cents ?? 0, b.net_cents ?? 0, b.created_at ?? line.ts, b.updated_at ?? line.ts],
        );
        bump(applied, "bookings");
      }
      const n = st.notification;
      if (n && n.id) {
        await db.run("INSERT OR IGNORE INTO notifications (id, talent_id, title, body, read, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [n.id, n.talent_id, n.title, n.body ?? "", n.read ? 1 : 0, n.created_at ?? line.ts]);
        bump(applied, "notifications");
      }
      const e = st.email;
      if (e && e.id) {
        await db.run("INSERT OR IGNORE INTO email_queue (id, talent_id, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [e.id, e.talent_id, e.subject, e.body ?? "", e.status ?? "QUEUED", e.created_at ?? line.ts]);
        bump(applied, "email_queue");
      }
      break;
    }
    case "booking.status": {
      if (st.status) {
        await db.run("UPDATE bookings SET status = ?, evidence = ?, updated_at = ? WHERE id = ?",
          [String(st.status), st.evidence ?? null, line.ts, eid]);
        bump(applied, "bookings");
      }
      break;
    }
    case "notification.create": {
      const n = st.notification;
      if (n && n.id) {
        await db.run("INSERT OR IGNORE INTO notifications (id, talent_id, title, body, read, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [n.id, n.talent_id, n.title, n.body ?? "", n.read ? 1 : 0, n.created_at ?? line.ts]);
        bump(applied, "notifications");
      }
      break;
    }
    case "notification.read": {
      await db.run("UPDATE notifications SET read = 1 WHERE id = ?", [eid]);
      bump(applied, "notifications");
      break;
    }
    case "notification.delete": {
      await db.run("DELETE FROM notifications WHERE id = ?", [eid]);
      bump(applied, "notifications");
      break;
    }
    case "talent.photo.add":
    case "talent.photo.update": {
      // KNOWN GAP: photo bytes are never in the mirror (same as ReacheR
      // message bodies). The ledger event is restored; the photo itself
      // is not — the talent re-uploads. Counted, never silently skipped.
      gaps.push(`photo bytes not restorable (event seq ${line.seq}, talent ${eid})`);
      break;
    }
    case "talent.photo.delete": {
      await db.run("DELETE FROM photos WHERE id = ?", [String(st.photoId ?? line.data?.photoId ?? "")]);
      break;
    }
    case "talent.fast-track.save": {
      const f = st.fastTrack;
      if (f) {
        await db.run(
          "INSERT INTO fast_track (talent_id, data_json, version, authorized_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(talent_id) DO UPDATE SET data_json = excluded.data_json, version = excluded.version, authorized_at = excluded.authorized_at, updated_at = excluded.updated_at",
          [eid, JSON.stringify(f.data ?? {}), f.version ?? "v1.0", f.authorized_at ?? null, f.updated_at ?? line.ts],
        );
        bump(applied, "fast_track");
      }
      break;
    }
    case "talent.guardian.save": {
      const g = st.guardian;
      if (g) {
        await db.run(
          "INSERT INTO guardians (talent_id, data_json, created_at) VALUES (?, ?, ?) ON CONFLICT(talent_id) DO UPDATE SET data_json = excluded.data_json",
          [eid, JSON.stringify(g.data ?? {}), g.created_at ?? line.ts],
        );
        bump(applied, "guardians");
      }
      break;
    }
    case "settings.update":
    case "commission.settings.update": {
      const s = st.settings ?? {};
      for (const [k, v] of Object.entries(s)) {
        await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, String(v)]);
        bump(applied, "settings");
      }
      break;
    }
    case "source.create": {
      const s = st.source;
      if (s && s.id) {
        await db.run("INSERT INTO sources (id, data_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json", [s.id, JSON.stringify(s)]);
        bump(applied, "sources");
      }
      break;
    }
    case "cubicle.create":
    case "cubicle.status": {
      const c = st.cubicle;
      if (c && c.id) {
        await db.run("INSERT INTO cubicles (id, data_json, status, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, status = excluded.status",
          [c.id, JSON.stringify(c), c.status ?? "OPEN", c.created_at ?? line.ts]);
        bump(applied, "cubicles");
      }
      break;
    }
    case "opportunity.create":
    case "opportunity.verification": {
      const o = st.opportunity;
      if (o && o.id) {
        await db.run("INSERT INTO opportunities (id, data_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json", [o.id, JSON.stringify(o)]);
        bump(applied, "opportunities");
      }
      break;
    }
    case "opportunity.delete": {
      await db.run("DELETE FROM opportunities WHERE id = ?", [eid]);
      bump(applied, "opportunities");
      break;
    }
    // ---- v11: email verification / automation / social / replies / completion ----
    case "talent.email.verified": {
      if (st.profile) {
        await db.run("UPDATE talents SET profile_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(st.profile), line.ts, eid]);
        bump(applied, "talents");
      }
      break;
    }
    case "talent.automation.save": {
      const a = st.automation;
      if (a) {
        await db.run(
          "INSERT INTO automation_settings (talent_id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(talent_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at",
          [eid, JSON.stringify(a.data ?? {}), a.updated_at ?? line.ts],
        );
        bump(applied, "automation_settings");
      }
      break;
    }
    case "talent.social-link.begin":
    case "talent.social-link.confirm":
    case "talent.social-link.bio-checked": {
      const s = st.socialLink;
      if (s && s.id) {
        await db.run(
          "INSERT INTO social_links (id, talent_id, platform, handle, status, bio_checked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, handle = excluded.handle, status = excluded.status, bio_checked = excluded.bio_checked, updated_at = excluded.updated_at",
          [s.id, eid, s.platform, s.handle, s.status ?? "PENDING", s.bio_checked ? 1 : 0, s.created_at ?? line.ts, s.updated_at ?? line.ts],
        );
        bump(applied, "social_links");
      }
      break;
    }
    case "talent.social-link.unlink": {
      await db.run("DELETE FROM social_links WHERE id = ?", [String(st.socialLinkId ?? "")]);
      bump(applied, "social_links");
      break;
    }
    case "talent.social-photo.add": {
      const p = st.socialPhoto;
      if (p && p.id) {
        await db.run("INSERT OR IGNORE INTO social_photos (id, talent_id, platform, photo_url, caption, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [p.id, eid, p.platform, p.photo_url, p.caption ?? null, p.created_at ?? line.ts]);
        bump(applied, "social_photos");
      }
      break;
    }
    case "talent.social-photo.remove": {
      await db.run("DELETE FROM social_photos WHERE id = ?", [String(st.socialPhotoId ?? "")]);
      bump(applied, "social_photos");
      break;
    }
    case "application.reply.record": {
      const r = st.applicationReply;
      if (r && r.id) {
        await db.run("INSERT OR IGNORE INTO application_replies (id, application_id, talent_id, from_name, channel, body, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [r.id, r.application_id, r.talent_id, r.from_name ?? null, r.channel ?? null, r.body ?? "", r.received_at ?? line.ts, r.created_at ?? line.ts]);
        bump(applied, "application_replies");
      }
      break;
    }
    case "booking.complete": {
      const b = st.booking;
      if (b && b.id) {
        await db.run(
          "INSERT INTO bookings (id, application_id, talent_id, opportunity_id, status, evidence, gross_cents, rate, commission_cents, net_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
          [b.id, b.application_id, b.talent_id, b.opportunity_id, b.status ?? "COMPLETED", b.evidence ?? null, b.gross_cents ?? 0, b.rate ?? null, b.commission_cents ?? 0, b.net_cents ?? 0, b.created_at ?? line.ts, b.updated_at ?? line.ts],
        );
        bump(applied, "bookings");
      }
      break;
    }
    // Secrets are never restored: owner passcode (owner.passcode.set),
    // verification/reset codes (never stored plaintext anywhere), and
    // passwords (talent.password.reset) are intentionally absent here —
    // the ledger rows survive, the secrets do not, by design.
    default:
      // Ledger-only events (seed.import, ledger.note, talent.match,
      // talent.rotation-queue, booking.payment): the ledger row itself
      // is the record — restored by the replay below, nothing to apply.
      break;
  }
}

// Replays a verified mirror into a fresh DB: the ledger rows first (so
// the chain survives the wipe), then each event's state. Returns the
// report; on an invalid chain it restores NOTHING.
export async function restoreFromMirror(db: Db, mirrorPath: string): Promise<RestoreReport> {
  const v = verifyMirrorFile(mirrorPath);
  if (!v.exists) return { restored: false, reason: "no-mirror" };
  if (!v.valid) {
    console.error(`MIRROR REFUSED: ${mirrorPath} chain invalid at seq ${v.first_bad_seq} — refusing restore; server will boot from seed only.`);
    return { restored: false, reason: "mirror-invalid", first_bad_seq: v.first_bad_seq, events: v.events };
  }
  const lines = readMirrorLines(mirrorPath);
  const applied: Record<string, number> = {};
  const gaps: string[] = [];
  const needsPasswordReset: string[] = [];
  for (const line of lines) {
    await db.run(
      "INSERT OR IGNORE INTO ledger_events (seq, ts, event_type, entity_type, entity_id, actor, data_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [line.seq, line.ts, line.event_type, line.entity_type, line.entity_id, line.actor, JSON.stringify(line.data ?? {}), line.prev_hash, line.hash],
    );
    bump(applied, "ledger");
    await applyState(db, line, applied, gaps, needsPasswordReset);
  }
  console.error(`MIRROR RESTORE: replayed ${lines.length} events from ${mirrorPath} — applied ${JSON.stringify(applied)}${gaps.length ? ` — gaps: ${gaps.length} (${gaps[0]})` : ""}${needsPasswordReset.length ? ` — ${needsPasswordReset.length} talent(s) need a password reset (passwords are never stored in the mirror)` : ""}.`);
  return { restored: true, source: "file", events: lines.length, applied, gaps, needsPasswordReset };
}

// Boot hook: call after SCHEMA, before the seed check. Restores only when
// the local ledger is EMPTY (a wipe) and a mirror exists. If MIRROR_URL is
// set and no local mirror exists, fetches the durable copy, verifies it
// BEFORE writing it locally, then restores from it (the ReacheR
// boot-restore pattern). Appends a ledger.restore event recording the
// restore itself — heal events are history too.
export async function bootRestoreIfNeeded(
  db: Db,
  mirrorPath: string,
  appendLedger: (eventType: string, entityType: string, entityId: string, actor: string, data: any) => Promise<number>,
): Promise<RestoreReport> {
  const rows = await db.all("SELECT COUNT(*) AS n FROM ledger_events").catch(() => [{ n: 0 }]);
  if (Number(rows[0]?.n ?? 0) > 0) return { restored: false, reason: "db-alive" };
  const local = readLines(mirrorPath);
  let source = "file";
  if (!local.length && process.env.MIRROR_URL) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(process.env.MIRROR_URL, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const text = await res.text();
        if (text.trim()) {
          const tmp = mirrorPath + ".fetch-tmp";
          fs.writeFileSync(tmp, text, "utf-8");
          const chk = verifyMirrorFile(tmp);
          if (chk.valid && chk.events > 0) {
            fs.renameSync(tmp, mirrorPath);
            tailHash = null; // fetched file replaced the mirror; next append re-reads the tail
            source = "url";
          } else {
            fs.unlinkSync(tmp);
            console.error(`MIRROR REFUSED: fetched mirror from MIRROR_URL failed verify (first bad seq ${chk.first_bad_seq}) — ignoring it.`);
          }
        }
      }
    } catch (e: any) {
      console.error(`MIRROR FETCH FAILED (MIRROR_URL): ${String(e?.message ?? e)} — continuing with local mirror only.`);
    }
  }
  if (!readLines(mirrorPath).length) {
    console.error(`MIRROR: no mirror at ${mirrorPath} — fresh boot, seed path will run.`);
    return { restored: false, reason: "no-mirror" };
  }
  const report = await restoreFromMirror(db, mirrorPath);
  if (report.restored) {
    report.source = source;
    await appendLedger("ledger.restore", "mirror", "boot-restore", "system", {
      restoredEvents: report.events,
      applied: report.applied,
      gaps: (report.gaps ?? []).length,
      needsPasswordReset: (report.needsPasswordReset ?? []).length,
      source,
      note: "Local DB was empty (wipe); state replayed from the ledger mirror before serving.",
    }).catch((e) => console.error(`MIRROR: ledger.restore event failed: ${String(e?.message ?? e)}`));
  } else if (report.reason === "mirror-invalid") {
    // Quarantine the untrustworthy file for forensics and start a fresh
    // mirror — appending to a broken chain would only make it worse.
    // The bytes are preserved; nothing is silently deleted.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const q = `${mirrorPath}.tampered-${stamp}`;
    try {
      fs.renameSync(mirrorPath, q);
      tailHash = null;
      console.error(`MIRROR QUARANTINED: tampered mirror moved to ${q} — a fresh mirror starts from the next append.`);
    } catch (e: any) {
      console.error(`MIRROR QUARANTINE FAILED (${mirrorPath}): ${String(e?.message ?? e)} — leaving the tampered file in place; appends will fail loudly until it is moved.`);
    }
  }
  return report;
}

// ---------- rebuild ----------
// Rebuilds the mirror from the live DB (repair path: the mirror file was
// lost or fell behind while the DB lived). State is re-attached ONLY to
// the latest event per entity — older events get state null, because the
// DB holds current state, not history. Rebuilt lines are marked
// state_rebuilt: true inside their state object so a later reader can
// tell them apart from states captured at write time.
export async function rebuildMirrorFromDb(db: Db, mirrorPath: string): Promise<{ rebuilt: boolean; events: number; withState: number; withoutState: number; error?: string }> {
  const rows = await db.all("SELECT * FROM ledger_events ORDER BY seq ASC").catch(() => []);
  if (!rows.length) return { rebuilt: false, events: 0, withState: 0, withoutState: 0, error: "no ledger events in DB" };
  const latestSeq = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.entity_type}|${r.entity_id}|${r.event_type}`;
    latestSeq.set(k, Math.max(latestSeq.get(k) ?? 0, Number(r.seq)));
  }
  const tmp = mirrorPath + ".rebuild-tmp";
  const dir = mirrorPath.split("/").slice(0, -1).join("/");
  if (dir) fs.mkdirSync(dir, { recursive: true });
  let mirrorPrev = MIRROR_GENESIS;
  let withState = 0;
  try {
    const out: string[] = [];
    for (const r of rows) {
      let data: any = {};
      try { data = JSON.parse(String(r.data_json || "{}")); } catch { data = {}; }
      const key = `${r.entity_type}|${r.entity_id}|${r.event_type}`;
      const isLatest = latestSeq.get(key) === Number(r.seq);
      const state = isLatest ? await currentStateFor(db, String(r.event_type), String(r.entity_type), String(r.entity_id)) : null;
      if (state) withState++;
      const line: MirrorLine = {
        seq: Number(r.seq), ts: String(r.ts), event_type: String(r.event_type), entity_type: String(r.entity_type),
        entity_id: String(r.entity_id), actor: String(r.actor), data,
        prev_hash: String(r.prev_hash), hash: String(r.hash), state,
        mirror_prev: mirrorPrev, mirror_hash: "",
      };
      line.mirror_hash = mirrorHashFor(line);
      mirrorPrev = line.mirror_hash;
      out.push(JSON.stringify(line));
    }
    fs.writeFileSync(tmp, out.join("\n") + "\n", "utf-8");
    const chk = verifyMirrorFile(tmp);
    if (!chk.valid) {
      fs.unlinkSync(tmp);
      return { rebuilt: false, events: rows.length, withState, withoutState: rows.length - withState, error: `rebuilt mirror failed verify at seq ${chk.first_bad_seq}` };
    }
    fs.renameSync(tmp, mirrorPath);
    tailHash = mirrorPrev; // rebuilt file's tail is the last hash written
    return { rebuilt: true, events: rows.length, withState, withoutState: rows.length - withState };
  } catch (e: any) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { rebuilt: false, events: rows.length, withState, withoutState: rows.length - withState, error: String(e?.message ?? e) };
  }
}

async function currentStateFor(db: Db, eventType: string, entityType: string, entityId: string): Promise<any> {
  const one = async (sql: string, args: any[]) => {
    const rows = await db.all(sql, args).catch(() => []);
    return rows.length ? rows[0] : null;
  };
  const mark = (s: any) => (s ? { ...s, state_rebuilt: true } : null);
  switch (eventType) {
    case "talent.register":
    case "talent.update": {
      const t = await one("SELECT * FROM talents WHERE id = ?", [entityId]);
      if (!t) return null;
      let profile: any = {};
      try { profile = JSON.parse(String(t.profile_json || "{}")); } catch { profile = {}; }
      return mark({ talent: { id: t.id, email: t.email, profile, created_at: t.created_at, updated_at: t.updated_at }, ...(eventType === "talent.update" ? { profile } : {}) });
    }
    case "consent.sign":
    case "consent.revoke": {
      const c = await one("SELECT * FROM consents WHERE talent_id = ?", [entityId]);
      const t = await one("SELECT profile_json FROM talents WHERE id = ?", [entityId]);
      let profile: any = {};
      try { profile = JSON.parse(String(t?.profile_json || "{}")); } catch { profile = {}; }
      if (!c) return null;
      return mark({ consent: { talent_id: entityId, signed: Number(c.signed) === 1, signed_at: c.signed_at, signature: c.signature, status: c.status, version: c.version, updated_at: c.updated_at }, profile });
    }
    case "review.decision": {
      const r = await one("SELECT * FROM reviews WHERE id = ?", [entityId]);
      if (!r) return null;
      const t = await one("SELECT profile_json FROM talents WHERE id = ?", [String(r.talent_id)]);
      let profile: any = {};
      try { profile = JSON.parse(String(t?.profile_json || "{}")); } catch { profile = {}; }
      return mark({ review: { id: r.id, talent_id: r.talent_id, decision: r.decision, reason: r.reason, created_at: r.created_at }, profile });
    }
    case "application.create":
    case "application.status": {
      const a = await one("SELECT * FROM applications WHERE id = ?", [entityId]);
      if (!a) return null;
      return mark(eventType === "application.create"
        ? { application: { id: a.id, talent_id: a.talent_id, opportunity_id: a.opportunity_id, status: a.status, created_at: a.created_at, updated_at: a.updated_at } }
        : { status: a.status });
    }
    case "booking.create":
    case "booking.status": {
      const b = await one("SELECT * FROM bookings WHERE id = ?", [entityId]);
      if (!b) return null;
      return mark(eventType === "booking.create"
        ? { booking: { id: b.id, application_id: b.application_id, talent_id: b.talent_id, opportunity_id: b.opportunity_id, status: b.status, evidence: b.evidence, gross_cents: b.gross_cents, rate: b.rate, commission_cents: b.commission_cents, net_cents: b.net_cents, created_at: b.created_at, updated_at: b.updated_at } }
        : { status: b.status, evidence: b.evidence });
    }
    case "notification.create": {
      const n = await one("SELECT * FROM notifications WHERE id = ?", [entityId]);
      if (!n) return null;
      return mark({ notification: { id: n.id, talent_id: n.talent_id, title: n.title, body: n.body, read: Number(n.read) === 1, created_at: n.created_at } });
    }
    case "talent.fast-track.save": {
      const f = await one("SELECT * FROM fast_track WHERE talent_id = ?", [entityId]);
      if (!f) return null;
      let data: any = {};
      try { data = JSON.parse(String(f.data_json || "{}")); } catch { data = {}; }
      return mark({ fastTrack: { talent_id: entityId, data, version: f.version, authorized_at: f.authorized_at, updated_at: f.updated_at } });
    }
    case "talent.guardian.save": {
      const g = await one("SELECT * FROM guardians WHERE talent_id = ?", [entityId]);
      if (!g) return null;
      let data: any = {};
      try { data = JSON.parse(String(g.data_json || "{}")); } catch { data = {}; }
      return mark({ guardian: { talent_id: entityId, data, created_at: g.created_at } });
    }
    case "settings.update":
    case "commission.settings.update": {
      const keys = eventType === "settings.update"
        ? ["submissions_paused", "repeat_agency_threshold", "repeat_agency_top_percent"]
        : ["commission_floor_daily", "commission_floor_rate", "commission_ceiling_daily", "commission_ceiling_rate"];
      const settings: Record<string, string> = {};
      for (const k of keys) {
        const row = await one("SELECT value FROM settings WHERE key = ?", [k]);
        if (row) settings[k] = String(row.value);
      }
      return mark({ settings });
    }
    case "source.create": {
      const s = await one("SELECT data_json FROM sources WHERE id = ?", [entityId]);
      if (!s) return null;
      try { return mark({ source: JSON.parse(String(s.data_json)) }); } catch { return null; }
    }
    case "cubicle.create":
    case "cubicle.status": {
      const c = await one("SELECT * FROM cubicles WHERE id = ?", [entityId]);
      if (!c) return null;
      let rec: any = {};
      try { rec = JSON.parse(String(c.data_json || "{}")); } catch { rec = {}; }
      return mark({ cubicle: { ...rec, id: entityId, status: c.status, created_at: c.created_at } });
    }
    case "opportunity.create":
    case "opportunity.verification": {
      const o = await one("SELECT data_json FROM opportunities WHERE id = ?", [entityId]);
      if (!o) return null;
      try { return mark({ opportunity: JSON.parse(String(o.data_json)) }); } catch { return null; }
    }
    case "talent.email.verified": {
      const t = await one("SELECT profile_json FROM talents WHERE id = ?", [entityId]);
      if (!t) return null;
      let profile: any = {};
      try { profile = JSON.parse(String(t.profile_json || "{}")); } catch { profile = {}; }
      return mark({ profile });
    }
    case "talent.automation.save": {
      const a = await one("SELECT * FROM automation_settings WHERE talent_id = ?", [entityId]);
      if (!a) return null;
      let data: any = {};
      try { data = JSON.parse(String(a.data_json || "{}")); } catch { data = {}; }
      return mark({ automation: { talent_id: entityId, data, updated_at: a.updated_at } });
    }
    case "booking.complete": {
      const b = await one("SELECT * FROM bookings WHERE id = ?", [entityId]);
      if (!b) return null;
      return mark({ booking: { id: b.id, application_id: b.application_id, talent_id: b.talent_id, opportunity_id: b.opportunity_id, status: b.status, evidence: b.evidence, gross_cents: b.gross_cents, rate: b.rate, commission_cents: b.commission_cents, net_cents: b.net_cents, created_at: b.created_at, updated_at: b.updated_at } });
    }
    default:
      return null;
  }
}
