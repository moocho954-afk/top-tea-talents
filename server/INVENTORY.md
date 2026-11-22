# TOP TEA TALENTS public backend — inventory (read-only)

Date inventoried: 2026-11-21. Scope: `server/src/server.ts` (1,440 lines),
`server/src/schema.sql` (176 lines), `server/src/libsql.ts` (107 lines),
`server/selftest.sh` (281 lines, 37 `check` calls), `server/package.json`,
`render.yaml` (repo root, `~/workspace/top-tea-talents-public/render.yaml` —
**not** under `server/`), `Dockerfile` (repo root), `server/seed/`.
Nothing was run and nothing was edited except creating this file.

Stack: Bun + TypeScript, **zero npm dependencies** (only devDep `bun-types`
`^1.4.5`). `package.json` scripts: `dev` = `bun --watch run src/server.ts`,
`start` = `bun run src/server.ts`, `typecheck` = `bun x tsc --noEmit`.
`VERSION = "1.0.0"`, `PORT = env PORT || 3000`, admin = `Bearer $ADMIN_TOKEN`
(`server.ts:5-7`). TEST MODE is always on: no external submission calls,
no payments, email is queued only, never sent (`server.ts:2-5`).

## 0. How writes work — the two shared primitives

Every durable mutation goes through `db.run` / `db.exec` on the `Db`
interface in `libsql.ts` (`all` / `run` / `exec`). **There are no
transactions anywhere** — no `BEGIN`/`COMMIT`/`ROLLBACK` in `server.ts`.
A multi-write route (e.g. register: talent + session + contact + audit)
is a sequence of separate statements; a failure midway leaves a partial
write. There is also no `ON CONFLICT` handling on most inserts (dupes are
pre-checked with a `SELECT`).

### `audit()` — `server.ts:125-132`

```ts
async function audit(action, entityType, entityId, actor, data) {
  await db.run("INSERT INTO audit_log (id, ts, actor, action, entity_type, entity_id, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [genId("aud"), ts, actor, action, entityType, entityId, JSON.stringify(data ?? {})]).catch(() => {});
  await ledgerAppend(action, entityType, entityId, actor, data ?? {});
}
```

Every `audit(...)` call therefore writes **two** rows: one `audit_log` row
(the insert is `.catch(()=>{})`-swallowed — a failed audit_log write is
silent) and one `ledger_events` row via `ledgerAppend`. The ledger write
is **not** swallowed. The `data` passed to `audit` is the same object that
lands in both tables — see §2 for what it does/does not contain.

### `saveProfile()` / `refreshStatus()` — `server.ts:186-187, 219-225`

```ts
async function saveProfile(id, profile) {
  await db.run("UPDATE talents SET profile_json = ?, updated_at = ? WHERE id = ?",
    [JSON.stringify(profile), nowIso(), id]);
}
async function refreshStatus(talentId) {
  const t = await loadTalent(talentId); if (!t) return "";
  const status = await deriveStatus(talentId, t.profile);
  const p = { ...t.profile, status, completion: completionOf(t.profile).percent };
  await saveProfile(talentId, p);   // line 224
  return status;
}
```

`refreshStatus` re-derives `status`/`completion` and persists the whole
`profile_json` blob. It is called after consent sign (line 764), consent
revoke (773), review decision (785), and PATCH talent (857, after the
direct `saveProfile` at 856 — so PATCH writes `profile_json` twice).

### `notify()` — `server.ts:1164-1169`

```ts
async function notify(talentId, title, body) {
  const id = genId("ntf");
  await db.run("INSERT INTO notifications (id, talent_id, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)", [id, talentId, title, body, nowIso()]);
  await audit("notification.create", "notification", id, "system", { talentId, title });
  return id;
}
```

One `notifications` row + one audit/ledger pair. Callers: review FAIL
(line 787), booking create (1084), booking status → BOOKED (1111).

### `setSetting()` — `server.ts:68-70`

```ts
await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
```

Single-row upsert into `settings`. Keys in use: `submissions_paused`
(default `"true"`), `repeat_agency_threshold` (default `3`),
`repeat_agency_top_percent` (default `10`), `commission_floor_daily`
(`100`), `commission_floor_rate` (`10`), `commission_ceiling_daily`
(`1000`), `commission_ceiling_rate` (`15`).

### `upsertContact()` — `server.ts:135-152`

Deterministic id `ctc_` + first 16 hex of `sha256(kind + "|" + normalized-name)`.
- Existing (line 143): `UPDATE contacts SET name=?, email=?, phone=?, city=?, state=?, source=?, data_json=?, updated_at=? WHERE id=?` — merges new `extra` over stored `data_json`, keeps `name`.
- New (line 146): `INSERT INTO contacts (id, kind, name, normalized, email, phone, city, state, source, data_json, created_at, updated_at) VALUES (...)`.
Callers: register (line 430, kind `talent`), `loadSeed` (lines 287, 294 —
agency / casting-professional / production-company contacts derived from
seed opportunities and intel).

---

## 1. EVERY route/mutation that writes durable state

Routes are `POST/PATCH/DELETE /api/v1/...` in `handle()` (`server.ts:359`).
Auth: `requireAdmin` = `Bearer $ADMIN_TOKEN` (503 if unset); talent routes
use `requireTalentOrAdmin` (own token or admin). "Ledger" column = the
`audit(...)` event type (each also inserts an `audit_log` row); "—" means
no ledger/audit write for that route.

| # | Route | File:line (route) | DB write (exact statement / function:line) | Row/data written | Ledger event |
|---|---|---|---|---|---|
| 1 | `POST /auth/register` | `server.ts:419` | `INSERT INTO talents …` `426`; `INSERT INTO sessions …` `429`; `upsertContact("talent", …)` `430` → contacts insert/update `143/146`; `audit` `431` | `talents`: id `tal_<16hex>`, email (lowercased), `password_hash` (`Bun.password.hash`), full default `profile_json` (status `PROFILE INCOMPLETE`, completion 0), `created_at`/`updated_at`. `sessions`: 64-hex token, talent_id. `contacts`: talent contact row | `talent.register` (data: `{email, firstName, lastName}` only — no password/hash) |
| 2 | `POST /auth/login` | `server.ts:433` | `INSERT INTO sessions (token, talent_id, created_at)` `445` | New 64-hex session token row (old tokens never deleted/expired; no logout route) | — (no audit/ledger) |
| 3 | `POST /sources` (admin) | `server.ts:453` | `INSERT INTO sources (id, data_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json` `458`; `audit` `459` | `sources`: id (`src_…` or supplied), whole record JSON `{id,name,url,category,tier,status,connectionMethod,provides,tosStatus,updateFrequency,verificationBasis}` | `source.create` `{name}` |
| 4 | `POST /settings` (admin) | `server.ts:470` | `setSetting` `472` (`submissions_paused`), `476` (`repeat_agency_threshold`), `481` (`repeat_agency_top_percent`); `audit` `483` | `settings` rows, one per key supplied (stringified values) | `settings.update` (snapshot of all three values + TEST MODE note) |
| 5 | `PATCH /commission-settings` (admin) | `server.ts:491` | `setSetting` `503-506` (four keys: `commission_floor_daily`, `commission_floor_rate`, `commission_ceiling_daily`, `commission_ceiling_rate`); `audit` `507` | `settings` rows for the four commission keys | `commission.settings.update` (the full `next` object) |
| 6 | `POST /admin/seed` (admin) | `server.ts:525` | `loadSeed()` `527` → inserts `262` (opportunities), `270` (production_intel), `278` (sources), `upsertContact` `287/294`; `ledgerAppend("seed.import", …)` `530` only if something was inserted | Seed rows skipped if id already exists (insert-if-absent); see §4 | `seed.import` (summary only — see §2) |
| 7 | `POST /cubicles` (admin) | `server.ts:544` | `INSERT INTO cubicles (id, data_json, status, created_at)` `547`; `audit` `548` | `cubicles`: id `cub_…`, record = whole body + `status` (default `OPEN`) as JSON | `cubicle.create` `{name}` |
| 8 | `PATCH /cubicles/:id/status` (admin) | `server.ts:555` | `UPDATE cubicles SET data_json=?, status=? WHERE id=?` `558`; `audit` `559` | Rewritten `data_json` (old JSON + new status) and `status` column | `cubicle.status` `{status}` |
| 9 | `POST /ledger/note` (admin) | `server.ts:583` | `ledgerAppend("ledger.note", entity_type‖"note", entity_id‖"manual", "admin", noteData)` `586` | One `ledger_events` row only — **no** `audit_log` row (direct `ledgerAppend`, not `audit()`). `data_json` = `{note, event_type?}` | itself (`ledger.note`) |
| 10 | `POST /talent/:id/photos` | `server.ts:671` | If slot 1 / first photo: `UPDATE photos SET is_primary=0 WHERE talent_id=?` `684`; `INSERT INTO photos (id, talent_id, slot, label, caption, is_primary, sort_order, mime, data_base64, created_at)` `685-686`; `audit` `687` | `photos`: id `ph_…`, slot 1–8, `SLOT_LABELS[slot]`, caption, `is_primary`, `sort_order`=slot, mime `image/jpeg|png|webp`, **base64 image data (≤500 KB decoded, ≤8 photos/talent)** | `talent.photo.add` `{photoId, slot, label}` — base64 NOT in ledger |
| 11 | `PATCH /photos/:id` | `server.ts:888` | If `isPrimary`: `UPDATE photos SET is_primary=0 WHERE talent_id=?` `891`; `UPDATE photos SET caption=?, is_primary=?, sort_order=? WHERE id=?` `892-893`; `audit` `894` | Caption / primary flag / sort order only | `talent.photo.update` `{photoId}` |
| 12 | `DELETE /photos/:id` | `server.ts:896` | `DELETE FROM photos WHERE id=?` `898`; `audit` `899` | Row deleted (hard delete) | `talent.photo.delete` `{photoId}` |
| 13 | `PATCH /talent/:id` (profile update) | `server.ts:848` | `saveProfile` → `UPDATE talents SET profile_json=?, updated_at=?` `187` (called line 856); then `refreshStatus` → second `saveProfile` `224` (line 857); `audit` `858` | Whole `profile_json` rewritten (only allow-listed fields, `allowed` list at `851`; email change rejected). `status` + `completion` recomputed and stored | `talent.update` `{fields: Object.keys(body), status}` — **field names only, not values** |
| 14 | `DELETE /talent/:id` | `server.ts:861` | `DELETE FROM photos` `864`; `DELETE FROM fast_track` `865`; `DELETE FROM guardians` `866`; `DELETE FROM consents` `867`; `DELETE FROM notifications` `868`; `DELETE FROM sessions` `869`; `DELETE FROM talents` `870`; `audit` `871` | Hard-deletes the talent and all dependent rows **except** `reviews`, `applications`, `bookings`, `email_queue`, `contacts`, `audit_log`, `ledger_events` (those survive; ledger is append-only by design) | `talent.delete` (note only) |
| 15 | `POST /talent/:id/fast-track` | `server.ts:701` | `INSERT INTO fast_track (talent_id, data_json, version, authorized_at, updated_at) VALUES (…) ON CONFLICT(talent_id) DO UPDATE SET data_json=…, version=…, authorized_at=…, updated_at=…` `714-715`; `audit` `716` | `fast_track`: `{controls, rules, autoSubmit}` JSON; version auto-bumps `v1.0 → v1.1 → …` (+0.1 per save) | `talent.fast-track.save` `{version, autoSubmit}` |
| 16 | `POST /talent/:id/guardian` | `server.ts:720` | `INSERT INTO guardians (talent_id, data_json, created_at) VALUES (…) ON CONFLICT(talent_id) DO UPDATE SET data_json=excluded.data_json` `727-728`; `audit` `729` | `guardians`: `{guardianName, guardianEmail, guardianPhone, relationship, consentGiven}` JSON | `talent.guardian.save` `{guardianName, consentGiven}` |
| 17 | `POST /talent/:id/likeness-release/sign` | `server.ts:752` | `INSERT INTO consents (…) VALUES (?, 1, ?, ?, 'SIGNED', 'TTT-LIKENESS-v1.0', ?) ON CONFLICT(talent_id) DO UPDATE SET signed=1, signed_at=…, signature=…, status='SIGNED', version=…, updated_at=…` `762-763`; `refreshStatus` `764` → `saveProfile` `224`; `audit` `765` | `consents`: signed=1, `signed_at`, signature (must equal legal or professional name), status `SIGNED`, version `TTT-LIKENESS-v1.0`. Requires 100% profile completion. Also rewrites `profile_json` status/completion | `consent.sign` `{version, signedAt, signature, status}` — **signature text IS in the ledger** |
| 18 | `POST /talent/:id/likeness-release/revoke` | `server.ts:768` | `INSERT INTO consents (…) VALUES (?, 0, NULL, NULL, 'REVOKED', 'TTT-LIKENESS-v1.0', ?) ON CONFLICT … DO UPDATE SET signed=0, status='REVOKED', updated_at=…` `771-772`; `refreshStatus` `773`; `audit` `774` | `consents`: signed=0, status `REVOKED` (signed_at/signature left as-is on conflict path — only `signed`, `status`, `updated_at` are overwritten). Status → `REVOKED` | `consent.revoke` `{status, note}` |
| 19 | `POST /talent/:id/review` (admin) | `server.ts:779` | `INSERT INTO reviews (id, talent_id, decision, reason, created_at)` `784`; `refreshStatus` `785` → `saveProfile` `224`; FAIL also `notify` `787` → notification insert `1166` + audit; `audit` `789` | `reviews`: id `rvw_…`, decision `PASS`/`FAIL`, reason (required for FAIL). Profile status recomputed | `review.decision` `{decision, reason, status}`; FAIL additionally `notification.create` |
| 20 | `POST /talent/:id/match` | `server.ts:792` | No domain write. `audit` `797` only | Ledger/audit only: `{evaluated, strong}` counts | `talent.match` |
| 21 | `POST /talent/:id/rotation-queue` | `server.ts:800` | No domain write (gated by `rotationGate`: unpaused, signed, `READY FOR MATCHING`, fast-track on file, minor/guardian rules). `audit` `809` only | Ledger/audit only: `{selected, caps}` | `talent.rotation-queue` |
| 22 | `POST /talent/:id/queue-selected` | `server.ts:814` | Per opportunity (dupes/missing skipped): `INSERT INTO applications (id, talent_id, opportunity_id, status, created_at, updated_at) VALUES (?, ?, ?, 'AWAITING APPROVAL', ?, ?)` `826`; `audit` per created application `827` | `applications`: id `app_…`, status `AWAITING APPROVAL` | `application.create` per app `{talentId, opportunityId, status, note: "TEST MODE: nothing was sent."}` |
| 23 | `POST /applications` | `server.ts:1013` | `INSERT INTO applications (…) VALUES (?, ?, ?, 'AWAITING APPROVAL', ?, ?)` `1023`; `audit` `1024` | Same shape as #22 (single application) | `application.create` |
| 24 | `PATCH /applications/:id/status` | `server.ts:1036` | `UPDATE applications SET status=?, updated_at=? WHERE id=?` `1044`; `audit` `1045` | Status only. `SUBMITTED — CONFIRMED` (all spellings) is **blocked 400 in TEST MODE** | `application.status` `{status}` |
| 25 | `DELETE /applications/:id` (admin) | `server.ts:1048` | `DELETE FROM applications WHERE id=?` `1050`; `audit` `1051` | Hard delete | `application.delete` `{}` |
| 26 | `POST /bookings` (admin) | `server.ts:1062` | `INSERT INTO bookings (id, application_id, talent_id, opportunity_id, status, evidence, gross_cents, rate, commission_cents, net_cents, created_at, updated_at)` `1078-1079`; `notify` `1084` → notification insert `1166` + audit; `INSERT INTO email_queue (id, talent_id, subject, body, status, created_at) VALUES (…, 'QUEUED', ?)` `1086-1087`; `audit` `1088` | `bookings`: id `bkg_…`, status (default `BOOKED`), evidence (required), money in integer cents (`grossCents`, `rate`, `commissionCents`, `netCents`; `gross-fee=net` exactly). `email_queue`: subject/body = booking summary, status `QUEUED` (never sent — no sender exists) | `booking.create` `{applicationId, talentId, opportunityId, status, grossCents, rate, commissionCents, netCents, agency, email: "email pending: integration not connected"}` + `notification.create` |
| 27 | `PATCH /bookings/:id/status` (admin) | `server.ts:1100` | `UPDATE bookings SET status=?, evidence=?, updated_at=? WHERE id=?` `1107`; if BOOKED: `notify` `1111`; `audit` `1114` | Status/evidence only; money columns untouched. BOOKED requires evidence | `booking.status` `{status}` (+ `notification.create` when BOOKED) |
| 28 | `PATCH /bookings/:id/payment` (admin) | `server.ts:1119` | `UPDATE bookings SET updated_at=? WHERE id=?` `1124` (touches **only** `updated_at` — the payment status is **not** stored in any column); `audit` `1125` | No durable payment state: the `PAYMENT_PENDING`/`PAID` value lives only in the ledger/audit `data_json` and the response body | `booking.payment` `{paymentStatus, note: "Payment tracking only — no payment processed (TEST MODE)."}` |
| 29 | `PATCH /notifications/:id/read` | `server.ts:1133` | `UPDATE notifications SET read=1 WHERE id=?` `1137`; `audit` `1138` | Read flag only | `notification.read` `{}` |
| 30 | `DELETE /notifications/:id` | `server.ts:1141` | `DELETE FROM notifications WHERE id=?` `1145`; `audit` `1146` | Hard delete | `notification.delete` `{}` |
| 31 | `POST /opportunities` (admin) | `server.ts:965` | `INSERT INTO opportunities (id, data_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json` `972`; `audit` `973` | `opportunities`: whole record JSON (id `opp_…` or supplied; `verification_status` default `UNVERIFIED`, `discovered_at` default now) | `opportunity.create` `{title, source}` |
| 32 | `PATCH /opportunities/:id/verification` (admin) | `server.ts:976` | `UPDATE opportunities SET data_json=? WHERE id=?` `984`; `audit` `985` | Rewritten `data_json` with new `verification_status`, `verified_at`, `verification_notes` | `opportunity.verification` `{verification_status}` |
| 33 | `DELETE /opportunities/:id` (admin) | `server.ts:988` | `DELETE FROM opportunities WHERE id=?` `990`; `audit` `991` | Hard delete (applications/bookings referencing it are **not** deleted) | `opportunity.delete` `{}` |
| 34 | First boot / empty DB (no HTTP route) | `server.ts:301-313` | `db.exec(SCHEMA)` `301`; if `opportunities` count = 0 → `loadSeed()` `305` → inserts `262/270/278` + contacts `287/294`; `ledgerAppend("seed.import", …)` `306` | 423 opportunities, 96 production-intel, 23 sources (idempotent — existing ids skipped) + derived contacts | `seed.import` (summary only) |

### Writes that are ledger/audit-only (no domain table touched)

- `POST /talent/:id/match` (#20) and `POST /talent/:id/rotation-queue` (#21):
  only `audit_log` + `ledger_events` rows. The match/queue results themselves
  are computed in memory and never stored.
- `POST /ledger/note` (#9): ledger only, no `audit_log` row.
- `PATCH /bookings/:id/payment` (#28): only `updated_at` + audit/ledger;
  the payment status itself is not persisted in any column.

### Read-only routes (for completeness — no writes at all)

`GET /health`, `GET /stats`, `GET /sources`, `GET /settings`,
`GET /commission-settings`, `GET /commission/calculate`,
`GET /cubicles`, `GET /ledger`, `GET /ledger/verify`, `GET /ledger/export`,
`GET /contacts`, `GET /agencies`, `GET /agencies/:id/history`,
`GET /talent` (admin list), `GET /talent/:id`, `GET /talent/:id/audit`,
`GET /talent/:id/photos`, `GET /talent/:id/fast-track`,
`GET /talent/:id/likeness-release`, `GET /talent/:id/notifications`,
`GET /photos/:id` (returns image bytes), `GET /reviews`,
`GET /opportunities`, `GET /opportunities/:id`, `GET /production-intel`,
`GET /production-intel/:id`, `GET /applications`, `GET /bookings`.
Note `GET /talent/:id` calls `deriveStatus` but does not persist it
(`talentView` computes status in memory; only `refreshStatus` writes).

---

## 2. Ledger — DDL, append, verify, export

### `ledger_events` DDL — verbatim from `schema.sql:139-150`

```sql
CREATE TABLE IF NOT EXISTS ledger_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
```

Indexes (`schema.sql:163-165`): `idx_ledger_entity ON ledger_events(entity_id)`,
`idx_ledger_type ON ledger_events(event_type)`, `idx_ledger_ts ON ledger_events(ts)`.
Schema comment (`schema.sql:1-2`): *"Ledger is append-only: NEVER UPDATE or
DELETE ledger_events rows; corrections are new entries."* — enforced by
convention only; nothing in code prevents an UPDATE/DELETE, and no code
ever issues one.

### `ledgerAppend` — `server.ts:105-123`

```ts
async function ledgerAppend(eventType, entityType, entityId, actor, data): Promise<number> {
  const rows = await db.all("SELECT MAX(seq) AS m, hash FROM ledger_events GROUP BY seq ORDER BY seq DESC LIMIT 1").catch(() => []);
  let prevHash = "GENESIS";
  let seq = 1;
  if (rows.length) { prevHash = String(rows[0].hash); seq = Number(rows[0].m) + 1; }
  else {
    const all = await db.all("SELECT seq, hash FROM ledger_events ORDER BY seq DESC LIMIT 1");
    if (all.length) { prevHash = String(all[0].hash); seq = Number(all[0].seq) + 1; }
  }
  const ts = nowIso();
  const hash = sha256(prevHash + "|" + canonical({ seq, ts, event_type: eventType, entity_type: entityType, entity_id: entityId, actor, data }));
  await db.run("INSERT INTO ledger_events (seq, ts, event_type, entity_type, entity_id, actor, data_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [seq, ts, eventType, entityType, entityId, actor, JSON.stringify(data ?? {}), prevHash, hash]);
  return seq;
}
```

- **Hash algorithm:** SHA-256 (`node:crypto` `createHash("sha256")`,
  `sha256()` helper at `server.ts:15`).
- **Genesis / prev_hash:** the literal string `"GENESIS"` for the first
  event (`prevHash = "GENESIS"`, `seq = 1`). Every later event's
  `prev_hash` is the previous row's `hash`.
- **Hash input:** `prevHash + "|" + canonical({seq, ts, event_type,
  entity_type, entity_id, actor, data})` where `canonical()` (`server.ts:17-22`)
  is a deterministic JSON serialisation (object keys sorted recursively,
  arrays in order). Note the hash is computed over the canonical object,
  while `data_json` stores plain `JSON.stringify(data)` — same content,
  different key order is possible, which is why verify re-parses and
  re-canonicalises.
- **Quirk:** the head lookup is `SELECT MAX(seq) AS m, hash … GROUP BY seq
  ORDER BY seq DESC LIMIT 1` — `hash` is a bare column under `GROUP BY`,
  so which hash SQLite returns for the max seq is not guaranteed by the
  query text (in practice the single-row group returns that row's hash);
  the `else` branch re-queries the head as a fallback. Worth knowing if
  the chain is ever rebuilt: the head is found by max `seq`, not by
  following `prev_hash` links.
- **Race note:** no transaction/lock around read-head → insert, so two
  concurrent appends could compute the same `seq`/`prev_hash`. `seq` is
  `AUTOINCREMENT` primary key, so the second insert would fail rather
  than fork the chain — but the caller (`audit`) does not catch that.

### What each event carries — summaries, not full state

`data_json` holds a **small summary object**, never a full record snapshot:

| Event | `data` contents |
|---|---|
| `seed.import` | Counts only: `{opportunities: 423, productionIntel: 96, sources: 23, inserted, skipped, intelInserted, sourcesInserted, note}` (boot, `306-312`) / admin re-seed variant (`530`). One event for the whole import, not one per record. |
| `talent.register` | `{email, firstName, lastName}` |
| `talent.update` | `{fields: [names…], status}` — field names only |
| `talent.delete` | `{note}` |
| `talent.photo.add` | `{photoId, slot, label}` — no image data |
| `talent.photo.update` / `.delete` | `{photoId}` |
| `talent.fast-track.save` | `{version, autoSubmit}` — not the rules/controls |
| `talent.guardian.save` | `{guardianName, consentGiven}` |
| `consent.sign` | `{version, signedAt, signature, status}` — signature text included |
| `consent.revoke` | `{status, note}` |
| `review.decision` | `{decision, reason, status}` |
| `talent.match` | `{evaluated, strong}` counts |
| `talent.rotation-queue` | `{selected, caps}` |
| `application.create` | `{talentId, opportunityId, status, note}` |
| `application.status` | `{status}` |
| `application.delete` | `{}` |
| `booking.create` | `{applicationId, talentId, opportunityId, status, grossCents, rate, commissionCents, netCents, agency, email}` — money figures included, evidence text NOT included |
| `booking.status` | `{status}` |
| `booking.payment` | `{paymentStatus, note}` — the only place the payment status is recorded (see #28) |
| `notification.create` | `{talentId, title}` — body NOT included |
| `notification.read` / `.delete` | `{}` |
| `source.create` | `{name}` |
| `opportunity.create` | `{title, source}` |
| `opportunity.verification` | `{verification_status}` |
| `opportunity.delete` | `{}` |
| `settings.update` | Snapshot of the three settings values + note |
| `commission.settings.update` | Full `next` commission object |
| `cubicle.create` | `{name}`; `cubicle.status` `{status}` |
| `ledger.note` | `{note, event_type?}` — free-text manual correction |

**Consequence for restore/rebuild:** the ledger alone cannot reconstruct
the database — it carries summaries/counts, not full payloads (no profile
JSON, no photo bytes, no fast-track rules, no opportunity records). The
`audit_log` table mirrors the same summaries (same `data` object) plus its
own `id`/`action` columns; it is not hash-chained.

### `GET /ledger/verify` — `server.ts:590-603`

- Loads **all** events `ORDER BY seq ASC`, replays from `prev = "GENESIS"`.
- For each row: re-parses `data_json`, recomputes
  `sha256(prev_hash + "|" + canonical({seq, ts, event_type, entity_type, entity_id, actor, data}))`,
  checks `prev_hash === prev` (running previous hash) **and** recomputed
  hash === stored `hash`. First mismatch stops the loop.
- Response: `{events, head_seq, head_hash, valid, first_bad_seq}` —
  `head_seq` is the last row's `seq`, `head_hash` its `hash` (or `"GENESIS"`
  when empty), `first_bad_seq` is `null` when valid.

### `GET /ledger/export` — `server.ts:604-608`

- `SELECT * FROM ledger_events ORDER BY seq ASC`, one JSON object per line
  (NDJSON), `Content-Type: application/x-ndjson`,
  `Content-Disposition: attachment; filename="top-tea-talents-ledger.jsonl"`.
- Each line is `ledgerRow()` (`server.ts:1219-1224`): `{seq, ts, event_type,
  entity_type, entity_id, actor, data, prev_hash, hash}` with `data` parsed
  from `data_json`.
- `GET /ledger` (list, `server.ts:566-580`): newest-first (`ORDER BY seq
  DESC`), `limit` 1–500 (default 100), `offset`, filters `event_type`,
  `entity_id`, `from`, `to`; returns `{events, total}`.
- `GET /talent/:id/audit` (`server.ts:661-665`): ledger rows for that
  `entity_id`, oldest-first.

---

## 3. `selftest.sh` — how it works end to end

File: `server/selftest.sh`, 281 lines, `set -u`, `cd "$(dirname "$0")"`
(so it runs from `server/` regardless of caller cwd). **37 `check` calls.**

### Start / environment

```sh
PORT="${TEST_PORT:-3457}"
DB="$(mktemp /tmp/ttt-test-XXXXXX.db)"
rm -f "$DB"
export PORT DATABASE_PATH="$DB" ADMIN_TOKEN="test-admin-token"
bun run src/server.ts > /tmp/ttt-selftest-server.log 2>&1 &
SERVER_PID=$!
```

- Server: `bun run src/server.ts`, backgrounded, stdout+stderr to
  `/tmp/ttt-selftest-server.log`. Port **3457** by default (override with
  `TEST_PORT`). Fresh empty temp DB via `mktemp /tmp/ttt-test-XXXXXX.db`
  (deleted first so the server creates it); `DATABASE_PATH` points at it,
  so the server runs on local SQLite (`storage: sqlite`, `durable: false`).
  `ADMIN_TOKEN` is the fixed string `test-admin-token`.
- Because the DB is empty, boot runs the first-boot seed path (§4):
  423 opportunities / 96 intel / 23 sources + one `seed.import` ledger event.

### Readiness wait

```sh
for i in $(seq 1 30); do
  if curl -sf "$BASE/health" -o /tmp/ttt-body.json 2>/dev/null; then break; fi
  sleep 0.5
done
```

Up to 30 × 0.5 s (≈15 s) polling `GET $BASE/health`
(`BASE=http://127.0.0.1:$PORT/api/v1`) until it succeeds. No failure branch —
if health never comes up the checks just fail against a stale/empty body.

### Assertion style — `check()` + shared body file

```sh
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@" > /tmp/ttt-check.out 2>&1; then PASS=$((PASS+1)); echo "PASS: $name";
  else FAIL=$((FAIL+1)); echo "FAIL: $name"; sed 's/^/  /' /tmp/ttt-check.out | head -n 20; fi
}
```

- Every HTTP call writes its response body to the shared scratch file
  **`/tmp/ttt-body.json`** (`curl -sf … -o /tmp/ttt-body.json`); a copy of
  the stats response is kept at `/tmp/ttt-stats.json` for cross-checks.
- Each `check "<name>" <command>` runs the command, captures its output to
  `/tmp/ttt-check.out`, prints `PASS: <name>` / `FAIL: <name>` (+ first 20
  lines of output, indented) and bumps `PASS`/`FAIL` counters.
- Assertions are inline `python3` (heredoc `python3 - <<'PY'`, one-liner
  `python3 -c "…"`, or `python3 -c` inside `bash -c`) that `json.load`
  `/tmp/ttt-body.json` and `assert …`. Negative HTTP-status checks use
  `bash -c "curl -s -o /dev/null -w '%{http_code}' … | grep -q 409"`
  (or 400). There is one unused helper: `jget()` (defined, never called).
- Test data flows through shell variables captured from responses:
  `OPP_ID` (first opportunity), `TALENT_ID` + `TOKEN` (registered test
  talent `test@toptea.example` / `Testy Talent`), `APP_ID`, `AGENCY_ID`.

### The 37 checks, in order

1. health returns ok + test_mode + sqlite storage
2. stats: opportunities 423, intel 96, sources 23, expired+live consistent
3. sources count 23 incl. EXCLUDED StudioBinder
4. opportunities list returns live opp with expired flag
5. include_expired=true returns all 423
6. opportunity detail resolves a URL-encoded id (colon in id)
7. browse: status=expired returns only expired
8. browse: status=live + sort=oldest is live-only, date ascending
9. browse: sort=newest is date descending
10. browse: pay_type + source filters combine
11. browse: county filter matches location.county
12. register returns talentId + token
13. duplicate email returns 409
14. login works
15. profile completion 100%
16. consent sign with wrong signature returns 400
17. consent sign with legal name succeeds
18. fast-track saves as v1.0
19. review PASS -> READY FOR MATCHING
20. rotation queue returns pay-first ranked queue with caps
21. commission calc $550/day -> 12.5% fee $68.75 net $481.25
22. application created AWAITING APPROVAL (TEST MODE)
23. duplicate application returns 409
24. booking without evidence returns 400
25. booking with evidence succeeds + gross-fee=net in cents
26. booking created an in-app notification
27. SUBMITTED-CONFIRMED blocked in TEST MODE (400)
28. ledger has register event for the talent
29. ledger verify valid, head_seq matches event count
30. ledger export is JSONL with seed.import event
31. ledger note appends a manual correction entry
32. ledger still verifies after the manual note
33. ledger list is newest-first
34. talent audit reads from ledger
35. contacts lists the registered talent
36. agencies ranked; the 1 test booking flags Project Casting spike + top-10% repeat badge
37. agency history returns full history (jobs + the 1 test booking + tracking-only payment)

Note the hard-coded expectations that will drift over time: `expiredOppCount >= 101`
("101 expired at seed time; deadlines keep passing"), `verifiedOppCount == 0`.

### Stop / cleanup / exit

```sh
cleanup() { kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null; rm -f "$DB" "$DB-wal" "$DB-shm"; }
trap cleanup EXIT
…
echo "SELFTEST: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```

- `trap cleanup EXIT`: kills the server PID, waits for it, deletes the temp
  DB **and its WAL/SHM sidecars** (`$DB-wal`, `$DB-shm`). Runs on success
  and failure alike, so no test DB survives a run.
- Final line prints `SELFTEST: $PASS passed, $FAIL failed` and exits
  non-zero iff `FAIL > 0` (`[ "$FAIL" -eq 0 ]`).

### How to add a new test (same style)

1. Issue the HTTP call with `curl -sf … -o /tmp/ttt-body.json` (or
   `curl -s -o /dev/null -w '%{http_code}'` for a status-only check).
   Reuse `$BASE`, `$TOKEN`, `$TALENT_ID`, `$APP_ID`, `$OPP_ID`,
   `test-admin-token` for admin calls.
2. Add one line: `check "<descriptive name>" python3 - <<'PY'` (heredoc
   for multi-assert) or `python3 -c "…"` (one-liner) or `bash -c "curl …
   | grep -q <code>"` for a status check — asserting on
   `json.load(open('/tmp/ttt-body.json'))`.
3. Place it in flow order (register → profile → consent → fast-track →
   review → rotation → application → booking → ledger → contacts/agencies),
   before the final `echo`/`[ "$FAIL" -eq 0 ]` lines. No test count
   constant to update — `PASS`/`FAIL` are counted dynamically.
4. Caveat: `/tmp/ttt-body.json` is shared and overwritten by every call,
   so a check must assert immediately after its own `curl`; do not rely
   on a body fetched several steps earlier (except `/tmp/ttt-stats.json`,
   which is the one deliberate snapshot).

---

## 4. Where the SQLite file lives; fresh-DB behaviour; what survives a deleted DB

### Location

`libsql.ts:101-106` (`createDb()`):

```ts
if (TURSO_DATABASE_URL && TURSO_AUTH_TOKEN) return new TursoDb(url, token);
const path = process.env.DATABASE_PATH || "./data/top-tea-talents.db";
return new SqliteDb(path);
```

- **Local default:** `./data/top-tea-talents.db`, relative to the server
  process cwd (i.e. `server/data/top-tea-talents.db` when run from
  `server/`). `SqliteDb` creates the parent dir (`mkdirSync recursive`)
  and opens with `PRAGMA journal_mode = WAL` (`libsql.ts:83-88`) — so a
  live DB is three files: `.db`, `.db-wal`, `.db-shm`.
- **Render:** `render.yaml` sets `DATABASE_PATH=/data/top-tea-talents.db`
  (also the `Dockerfile` default `ENV PORT=3000
  DATABASE_PATH=/data/top-tea-talents.db`, with `RUN mkdir -p /data`).
- **Turso (durable path):** if both `TURSO_DATABASE_URL` and
  `TURSO_AUTH_TOKEN` are set, all reads/writes go to Turso via its
  `/v2/pipeline` HTTP API (plain `fetch`, no SDK) instead of a file.
- **`db.storage` / `db.durable`:** `SqliteDb` reports
  `storage: "sqlite"`, `durable: false`; `TursoDb` reports
  `storage: "turso"`, `durable: true`. Both are surfaced verbatim in
  `GET /health` (`server.ts:392`). **There is no `data/` directory in the
  repo right now** — no local DB file is checked in.

### Fresh empty DB (boot sequence, `server.ts:300-313`)

1. `const SCHEMA = await Bun.file(import.meta.dir + "/schema.sql").text();`
   `await db.exec(SCHEMA);` — `CREATE TABLE IF NOT EXISTS` for all 19
   tables + 7 indexes. Safe to run on every boot.
2. `SELECT COUNT(*) FROM opportunities` — if 0, `loadSeed()` runs:
   reads `seed/opportunities.json`, `seed/production-intel.json`,
   `seed/sources.json` (`SEED_DIR = src/../seed`), inserts each record
   **only if its id is absent**, then upserts derived contacts from the
   seed (agency / casting-professional / production-company names).
   Seed sizes: **423 opportunities, 96 production-intel, 23 sources**
   (per `seed/manifest.json`: 437 collected, 423 unique after 9 dup
   groups merged).
3. One `ledgerAppend("seed.import", "seed", "seed-2026-11-21", "system",
   {opportunities: 423, productionIntel: 96, sources: 23, inserted, …})`.
4. Note the trigger is `opportunities == 0` only — a DB that has
   opportunities but is missing e.g. sources will **not** re-seed.
   `POST /admin/seed` re-runs `loadSeed()` on demand (same idempotent
   insert-if-absent; ledger event only if something was inserted).

### What survives a deleted DB file

- **Local SQLite (`durable: false`): nothing.** Deleting
  `data/top-tea-talents.db` (or a Render redeploy/restart/spin-down on the
  free tier, whose filesystem is ephemeral — `render.yaml` header comment
  says so explicitly) destroys **all** user data: talents, sessions,
  photos (base64 lives in the DB), fast-track, guardians, consents,
  reviews, applications, bookings, notifications, email queue, settings,
  commission settings, cubicles, contacts, audit_log, and the entire
  ledger. On next boot only the seed is restored: 423 opportunities,
  96 intel, 23 sources, derived seed contacts, and a single fresh
  `seed.import` ledger event (seq 1, genesis `GENESIS`). The old ledger
  chain is gone, not recoverable from the new one.
- **Turso (`durable: true`): everything survives** — the DB lives in
  Turso, not on the Render filesystem; deleting/redeploying the service
  loses nothing. But Turso is **not configured by default**:
  `render.yaml` ships `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` as empty
  values with `sync: false` (operator must fill them in); without them
  the server silently falls back to ephemeral SQLite.
- **Ledger export is not a restore path:** `GET /ledger/export` gives
  NDJSON of summary events only (§2) — it cannot rebuild profiles,
  photos, opportunities, or bookings.

---

## 5. Backup / mirror / restore code

**None exists.** Verified by searching `src/`, `selftest.sh`,
`render.yaml`, and `Dockerfile` for backup/mirror/restore/dump/sync/copy
of the DB file:

- No scheduled backup, no cron, no DB-file copy, no `sqlite3 .dump`,
  no S3/object-store upload, no second Turso/database mirror, no
  replication, no restore/import endpoint (the only import is the seed
  loader, which only inserts bundled seed JSON, never user data).
- The closest things to a backup are read-only exports, neither of which
  restores anything:
  - `GET /ledger/export` → NDJSON of ledger summary events (§2).
  - `GET /ledger/verify` → chain-integrity check only.
- `render.yaml` documents the gap honestly: free-tier filesystem is
  ephemeral, *"the SQLite file is LOST on every redeploy, restart, or
  spin-down"*; the stated durable path is Turso (free tier) via env vars,
  with an explicit no-paid-tier rule. `autoDeployTrigger: off` is set
  deliberately so redeploys (and their wipes) are manual only.
- Implication for any future backup work: the durable-state surface to
  cover is §1 (19 tables) plus the live DB location in §4; the ledger
  alone is insufficient as a backup (§2). A backup would need to copy
  the SQLite file (ideally via SQLite backup API / `.backup` while WAL is
  checkpointed, or a Turso-side snapshot) or dump all tables — none of
  which exists today.

---

## Appendix A. Full table list (`schema.sql`, 19 tables)

`talents`, `sessions`, `photos`, `fast_track`, `guardians`, `consents`,
`reviews`, `opportunities`, `production_intel`, `sources`, `applications`,
`bookings`, `notifications`, `email_queue`, `settings`, `cubicles`,
`audit_log`, `ledger_events`, `contacts`. Indexes: `idx_ledger_entity`,
`idx_ledger_type`, `idx_ledger_ts`, `idx_apps_talent`,
`idx_bookings_talent`, `idx_photos_talent`, `idx_contacts_norm`.
No foreign keys are declared anywhere; relationships are by convention
(`talent_id`, `opportunity_id`, `application_id` columns).

## Appendix B. Full `ledger_events` DDL

See §2 (verbatim, `schema.sql:139-150`).

## Appendix C. Files read

- `server/src/server.ts` — 1,440 lines (all routes, helpers, ledger, seed, matching, rotation, agencies; `Bun.serve` at `1429`).
- `server/src/schema.sql` — 176 lines (all DDL).
- `server/src/libsql.ts` — 107 lines (Turso vs SQLite, `Db` interface).
- `server/selftest.sh` — 281 lines, 37 checks.
- `server/package.json` — Bun scripts, zero deps, `bun-types ^1.4.5`.
- `render.yaml` (repo root) — free Render web service, `DATABASE_PATH=/data/top-tea-talents.db`, empty Turso vars, `ADMIN_TOKEN` generated, `autoDeployTrigger: off`, health check `/api/v1/health`.
- `Dockerfile` (repo root) — `oven/bun:1.3-slim`, copies `server/src` + `server/seed`, `mkdir -p /data`, `CMD ["bun", "run", "src/server.ts"]`.
- `server/seed/manifest.json` — seed provenance (423 unique opportunities from 437 collected, 96 intel, 23 sources).
