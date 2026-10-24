PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX users_single_admin_idx ON users(role) WHERE role = 'admin';

CREATE TABLE credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);

CREATE TABLE quizzes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id),
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL UNIQUE,
  imported_by TEXT NOT NULL REFERENCES users(id),
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX import_batches_imported_at_idx ON import_batches(imported_at);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  source_row INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  total_score REAL,
  questions_json TEXT NOT NULL CHECK (json_valid(questions_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(import_id, source_row)
);
CREATE INDEX attempts_user_submitted_idx ON attempts(user_id, submitted_at DESC);
CREATE INDEX attempts_quiz_idx ON attempts(quiz_id);
CREATE INDEX attempts_import_idx ON attempts(import_id);

CREATE TABLE login_rate_limits (
  email_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_started INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL
);
