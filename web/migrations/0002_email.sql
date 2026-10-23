-- notes.markets on Cloudflare D1: email alerts. Emails and their salts live only here (never on-chain, never in
-- logs); on-chain the engine sees only the salted hash attestation. These tables mirror the storage interface
-- the email work defines; wiring its code to them is mechanical.

-- One verified (or pending) email per wallet address. email_hash = keccak256(abi.encode(salt, lower(trim(email)))).
CREATE TABLE subscriptions (
  address     TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  salt        TEXT NOT NULL,
  email_hash  TEXT NOT NULL,
  verified_at INTEGER,
  attested_at INTEGER,
  unsub_token TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX subscriptions_email ON subscriptions (email);
CREATE UNIQUE INDEX subscriptions_unsub ON subscriptions (unsub_token);

-- One-time verification codes (6 digits, stored hashed) and confirmation-link tokens, with attempts for limits.
CREATE TABLE email_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  address    TEXT NOT NULL,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  link_token TEXT,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX email_codes_address ON email_codes (address, created_at DESC);
CREATE UNIQUE INDEX email_codes_link ON email_codes (link_token) WHERE link_token IS NOT NULL;

-- Per-address alert categories: payments_due (issuer), payouts (holder), risk (defaults, margin calls),
-- book (book updates). A missing row means the category's default (on).
CREATE TABLE preferences (
  address  TEXT NOT NULL,
  category TEXT NOT NULL,
  enabled  INTEGER NOT NULL,
  PRIMARY KEY (address, category)
);

-- The notification outbox: one row per (note, step, period, kind, recipient), so a restart or a replayed
-- event never sends twice. `not_before` schedules reminders.
CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key      TEXT NOT NULL UNIQUE,
  address         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  note_id         TEXT,
  subject         TEXT NOT NULL,
  html            TEXT NOT NULL,
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  not_before      INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  message_id      TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX outbox_due ON outbox (status, next_attempt_at);
