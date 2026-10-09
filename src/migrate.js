// Creates or updates the database tables. Safe to run every time the app starts.
const { pool } = require('./db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  timezone         TEXT NOT NULL DEFAULT 'America/New_York',
  week_start       SMALLINT NOT NULL DEFAULT 1,          -- 0=Sun .. 6=Sat
  main_label       TEXT NOT NULL DEFAULT 'Work time',
  other_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  other_label      TEXT NOT NULL DEFAULT 'Other time',
  other_options    JSONB NOT NULL DEFAULT '["Shop time","Drive time","Pickup / delivery"]',
  overtime_after   NUMERIC NOT NULL DEFAULT 40,
  max_days_back    INTEGER NOT NULL DEFAULT 14,
  workdays         JSONB NOT NULL DEFAULT '[1,2,3,4,5]',
  summary_hour     SMALLINT NOT NULL DEFAULT 7,
  missing_hour     SMALLINT NOT NULL DEFAULT 18,
  report_emails    TEXT NOT NULL DEFAULT '',
  plan_status      TEXT NOT NULL DEFAULT 'trialing',     -- trialing | active | past_due | canceled
  trial_ends_at    TIMESTAMPTZ,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS owners (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS crew (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  pin_hmac    TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  is_manager  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, pin_hmac)
);

CREATE TABLE IF NOT EXISTS crew_sessions (
  token_hash TEXT PRIMARY KEY,
  crew_id    INTEGER NOT NULL REFERENCES crew(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  crew_id    INTEGER NOT NULL REFERENCES crew(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  start_t TEXT NOT NULL DEFAULT '', end_t TEXT NOT NULL DEFAULT '', out_t TEXT NOT NULL DEFAULT '', back_t TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  o_job TEXT NOT NULL DEFAULT '',
  o_start TEXT NOT NULL DEFAULT '', o_end TEXT NOT NULL DEFAULT '', o_out TEXT NOT NULL DEFAULT '', o_back TEXT NOT NULL DEFAULT '',
  o_summary TEXT NOT NULL DEFAULT '',
  hours   NUMERIC NOT NULL DEFAULT 0,
  o_hours NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (crew_id, day)
);
CREATE INDEX IF NOT EXISTS entries_company_day ON entries (company_id, day);

CREATE TABLE IF NOT EXISTS approvals (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  approved   BOOLEAN NOT NULL DEFAULT FALSE,
  changed_by TEXT NOT NULL DEFAULT '',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, week_start)
);

CREATE TABLE IF NOT EXISTS email_log (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  period     DATE NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, kind, period)
);
`;

async function migrate() { await pool.query(SCHEMA); }

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => { console.log('Database is up to date.'); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
