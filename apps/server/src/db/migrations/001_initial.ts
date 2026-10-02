/** Schéma initial. Dates : texte ISO 8601 ; horodatages de session : millisecondes epoch. */
export default `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  oidc_subject TEXT UNIQUE,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE groups (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);

CREATE TABLE user_groups (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL REFERENCES groups(name) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (user_id, group_name)
);

CREATE TABLE recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('anon', 'mfa', 'enroll', 'full')),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  elevated_at INTEGER,
  ip TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE credentials (
  ref TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  masked_key_id TEXT,
  envelope TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  file TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('scan', 'import', 'demo')),
  account_id TEXT NOT NULL,
  resource_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL
);
CREATE INDEX snapshots_profile ON snapshots(profile_id, created_at);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  username TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  profile_id TEXT,
  result TEXT NOT NULL,
  details TEXT
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'journal d''audit en ajout seul'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'journal d''audit en ajout seul'); END;

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  lock_level INTEGER NOT NULL DEFAULT 0
);
`;
