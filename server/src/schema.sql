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

-- Social links (v11): a talent links THEIR OWN Instagram/Facebook.
-- begin = talent-attested claim (status PENDING), confirm = talent
-- confirms the link (status LINKED). bio_checked = the talent confirmed
-- their social bio carries the TOP TEA TALENTS link. There is no OAuth
-- integration yet — linking is talent-attested, preview only.
CREATE TABLE IF NOT EXISTS social_links (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  bio_checked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_talent ON social_links(talent_id);

-- Extended portfolio preview (v11): a few photos from the talent's
-- linked social accounts, shown alongside the 8-photo portfolio.
-- URL-only references (no bytes stored); talent chooses what shows.
CREATE TABLE IF NOT EXISTS social_photos (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  photo_url TEXT NOT NULL,
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
