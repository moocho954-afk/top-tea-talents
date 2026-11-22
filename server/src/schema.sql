-- TOP TEA TALENTS schema. SQLite-compatible; works on bun:sqlite and Turso/libSQL.
-- Ledger is append-only: NEVER UPDATE or DELETE ledger_events rows; corrections are new entries.

CREATE TABLE IF NOT EXISTS talents (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  label TEXT NOT NULL,
  caption TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fast_track (
  talent_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL DEFAULT '{}',
  version TEXT NOT NULL DEFAULT 'v1.0',
  authorized_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guardians (
  talent_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consents (
  talent_id TEXT PRIMARY KEY,
  signed INTEGER NOT NULL DEFAULT 0,
  signed_at TEXT,
  signature TEXT,
  status TEXT NOT NULL DEFAULT 'UNSIGNED',
  version TEXT NOT NULL DEFAULT 'TTT-LIKENESS-v1.0',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS production_intel (
  id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AWAITING APPROVAL',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  talent_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'BOOKED',
  evidence TEXT,
  gross_cents INTEGER,
  rate REAL,
  commission_cents INTEGER,
  net_cents INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_queue (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cubicles (
  id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);

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

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  city TEXT,
  state TEXT,
  source TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_entity ON ledger_events(entity_id);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger_events(ts);
CREATE INDEX IF NOT EXISTS idx_apps_talent ON applications(talent_id);
CREATE INDEX IF NOT EXISTS idx_bookings_talent ON bookings(talent_id);
CREATE INDEX IF NOT EXISTS idx_photos_talent ON photos(talent_id);
CREATE INDEX IF NOT EXISTS idx_contacts_norm ON contacts(normalized);

-- v11 parity additions (2026-11-21): email verification + password reset,
-- owner gate, automation, social links, inbound replies.
-- Verification/reset codes are stored HASH-ONLY (sha256), never plaintext,
-- and never in the ledger mirror. Codes expire after 15 minutes; 5 failed
-- attempts lock the code (a resend issues a fresh one).
CREATE TABLE IF NOT EXISTS verification_codes (
  id TEXT PRIMARY KEY,
  talent_id TEXT,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'email_verify',
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vcodes_email ON verification_codes(email, purpose);

-- Owner gate (v10): the owner passcode hash lives in settings under
-- owner_passcode_hash (NEVER in the ledger or mirror). Owner sessions
-- last 12 hours; agency money is only served to a valid owner session
-- (or the admin token, which is the owner's credential).
CREATE TABLE IF NOT EXISTS owner_sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Automation toggle (v8): one row per talent. enabled=false by default.
-- Agency-send email route (agency mailbox sends, talent CC'd, Reply-To
-- the talent) + per-(talent, job) reference codes are computed
-- deterministically (see refCode in server.ts) — nothing is ever sent
-- live in TEST MODE; armed automation only queues for review.
CREATE TABLE IF NOT EXISTS automation_settings (
  talent_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- Social links (v12–v14): a talent links THEIR OWN Instagram/Facebook.
-- begin = talent states the account is theirs; the server issues a unique
-- ownership code the talent places in their own bio. confirm = the talent
-- signs (typed name must match the profile, same standard as the Likeness
-- Release) and states the code is in their bio; signing does NOT authorize
-- the account — it starts the live bio check. AUTHORIZED exists ONLY when
-- verification_status = 'code_confirmed' (v13 hardening): no read path may
-- report AUTHORIZED otherwise; inconsistent rows are demoted to pending.
-- The live bio check is dispatched from the agency app (the standalone
-- public site has no background-task dispatch): the agency reports the
-- outcome through the admin bio-check route. The code itself is public by
-- design (it goes in the talent's public bio), so it may appear in the
-- mirror; it is never a password, token, or secret.
-- pull_status (v14): browser auto-pull of Instagram photos. The pull is
-- dispatched from the agency app; the standalone site records a request as
-- 'unavailable' and says so honestly. Pulled snapshots arrive through the
-- admin pull callback, only ever from the talent's own authorized account,
-- and only photos the identity check calls a match are placed.
CREATE TABLE IF NOT EXISTS social_links (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  profile_url TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
  verification_status TEXT NOT NULL DEFAULT 'code_issued',
  ownership_code TEXT,
  signature_name TEXT,
  signed_at TEXT,
  check_detail TEXT,
  checked_at TEXT,
  pull_status TEXT NOT NULL DEFAULT '',
  pull_detail TEXT,
  pulled_at TEXT,
  pull_rejected_count INTEGER NOT NULL DEFAULT 0,
  bio_checked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_talent ON social_links(talent_id);

-- Extended portfolio preview (v12–v14): a few photos from the talent's
-- OWN linked social accounts, shown alongside the 8-photo portfolio.
-- v12: the talent uploads the photo bytes AND pastes the link to the
-- original post on their own AUTHORIZED account, so every preview photo is
-- traceable to the talent's own post. v14: browser-pulled snapshots carry
-- source='browser_pull' + selection + identity verdict; only verdict 'match'
-- photos are ever placed. Bytes live in data_base64 (same pattern as the
-- 8-photo portfolio); legacy v11 URL-only rows keep photo_url.
CREATE TABLE IF NOT EXISTS social_photos (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  photo_url TEXT,
  mime TEXT,
  data_base64 TEXT,
  source_post_url TEXT,
  source TEXT NOT NULL DEFAULT 'upload',
  selection TEXT,
  identity_verdict TEXT,
  identity_note TEXT,
  likes_label TEXT,
  caption TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_socialphotos_talent ON social_photos(talent_id);

-- Inbound replies (v8/v11): replies from agencies/casting to an
-- application, recorded by staff (admin) and visible to the talent.
CREATE TABLE IF NOT EXISTS application_replies (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  talent_id TEXT NOT NULL,
  from_name TEXT,
  channel TEXT,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_app ON application_replies(application_id);
CREATE INDEX IF NOT EXISTS idx_replies_talent ON application_replies(talent_id);

-- Community board (v16, Phase 0 — MODULE-COMMUNITY-LEARNING.md §7 +
-- REQUIREMENT-COMMUNITY-BOARD-2026-11-21.md; artifact top-tea-talents
-- v16). ONE public board: everybody sees everybody's posts; there are
-- no private DMs — the direct-talk bubble is only a filtered view of
-- these same public posts. @ mentions are resolved at post time from
-- the autocomplete selection, so board_mentions stores the talent id,
-- never just parsed text. Media is photo-only in v1 (jpeg/png/webp,
-- 500KB decoded cap); audio/carousel kinds exist in the design but are
-- refused honestly by the API ("coming soon") until a later phase.
-- Board posts + photo bytes live in this same ephemeral SQLite, like
-- portfolio photos: the ledger mirror carries the board ledger EVENTS
-- (ids + counts only, never post bodies or photo bytes), not the posts
-- themselves — a full restart wipes board posts, same as photos.
CREATE TABLE IF NOT EXISTS board_posts (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  deleted_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_board_posts_talent ON board_posts(talent_id);
CREATE INDEX IF NOT EXISTS idx_board_posts_created ON board_posts(created_at);

CREATE TABLE IF NOT EXISTS board_post_media (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'photo',
  mime TEXT,
  data_base64 TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_media_post ON board_post_media(post_id);

CREATE TABLE IF NOT EXISTS board_mentions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  mentioned_talent_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_mentions_post ON board_mentions(post_id);
CREATE INDEX IF NOT EXISTS idx_board_mentions_talent ON board_mentions(mentioned_talent_id);

-- Board reports: a report on a post, for owner review. No automated
-- action is ever taken from a report in v1 — the owner reviews it.
CREATE TABLE IF NOT EXISTS board_reports (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  reporter_talent_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_reports_post ON board_reports(post_id);
