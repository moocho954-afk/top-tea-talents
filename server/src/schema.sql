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
