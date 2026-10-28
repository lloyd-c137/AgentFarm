-- Accounts: email + password (PBKDF2), and login sessions (only the hash of the session token is stored).
CREATE TABLE users (
  email TEXT PRIMARY KEY,             -- lower-case; also the owner of farms.email
  pw TEXT NOT NULL,                   -- pbkdf2$<iterations>$<salt b64url>$<hash b64url>
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES users(email),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_email ON sessions(email);
CREATE INDEX sessions_exp ON sessions(expires_at);
-- failed logins per email, for a simple lockout
CREATE TABLE login_fails (
  email TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);
