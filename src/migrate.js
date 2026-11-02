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

// Changes added after launch (each is safe to run again).
const UPGRADES = `
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'starter';
-- Old crew links keep working after a company changes its link.
-- Tasks the boss gives the crew; the crew marks them done with notes and photos.
CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  assigned_to INTEGER REFERENCES crew(id) ON DELETE SET NULL,
  due         DATE,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at     TIMESTAMPTZ,
  done_by     INTEGER REFERENCES crew(id) ON DELETE SET NULL,
  done_notes  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tasks_company ON tasks (company_id, status);
CREATE TABLE IF NOT EXISTS task_photos (
  id         SERIAL PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_photos_task ON task_photos (task_id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES crew(id) ON DELETE SET NULL;
-- Roads the crew mows, with each time they were mowed (date, who, notes, photos).
CREATE TABLE IF NOT EXISTS roads (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (company_id, name)
);
ALTER TABLE roads ADD COLUMN IF NOT EXISTS length_mi NUMERIC;
ALTER TABLE roads ADD COLUMN IF NOT EXISTS p_road SMALLINT;
ALTER TABLE roads ADD COLUMN IF NOT EXISTS p_ditch SMALLINT;
ALTER TABLE roads ADD COLUMN IF NOT EXISTS p_trees SMALLINT;
ALTER TABLE roads ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT '';
ALTER TABLE roads ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
-- Roads and water system sites share one table: kind is 'road' or 'water'.
ALTER TABLE roads ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'road';
ALTER TABLE roads DROP CONSTRAINT IF EXISTS roads_company_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS roads_kind_name ON roads (company_id, kind, name);
-- Tasks and water repairs share one table: kind is 'task' or 'repair'.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'task';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cost NUMERIC;   -- rough cost, for "needs to order" items
-- Which parts of the app each crew member can use (null = everything).
ALTER TABLE crew ADD COLUMN IF NOT EXISTS features JSONB;
-- Members list (searchable database): rows are {column: value}; the column list is kept on the company.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS member_columns JSONB;
CREATE TABLE IF NOT EXISTS members (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '{}',
  search     TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS members_company ON members (company_id, position);
-- Customer water meters, read in route order each month.
CREATE TABLE IF NOT EXISTS meters (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL DEFAULT 0,
  account     TEXT NOT NULL DEFAULT '',
  meter_no    TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  start_reading NUMERIC,            -- the last reading from the old sheet, before any reads in the app
  name_check  BOOLEAN NOT NULL DEFAULT FALSE,   -- name not confirmed against the members list
  old_name    TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS meters_company ON meters (company_id, seq);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS qb_customer TEXT NOT NULL DEFAULT '';   -- the customer's name exactly as in QuickBooks
-- Properties the boss marked "not needed" on the "not on the route" list.
CREATE TABLE IF NOT EXISTS meter_skips (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  address    TEXT NOT NULL,
  PRIMARY KEY (company_id, address)
);
CREATE TABLE IF NOT EXISTS meter_reads (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  meter_id   INTEGER NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  reading    NUMERIC NOT NULL,
  month      TEXT NOT NULL,         -- YYYY-MM billing month
  read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  crew_id    INTEGER REFERENCES crew(id) ON DELETE SET NULL,
  notes      TEXT NOT NULL DEFAULT '',
  UNIQUE (meter_id, month)
);
-- Meters are read quarterly: turn any monthly keys (YYYY-MM) into quarters (YYYY-Q#), keeping the latest read per quarter.
DELETE FROM meter_reads a USING meter_reads b
  WHERE a.month ~ '^[0-9]{4}-[0-9]{2}$' AND b.month ~ '^[0-9]{4}-[0-9]{2}$' AND a.meter_id=b.meter_id
    AND substr(a.month,1,4)=substr(b.month,1,4) AND (substr(a.month,6,2)::int-1)/3=(substr(b.month,6,2)::int-1)/3
    AND (a.month < b.month OR (a.month=b.month AND a.id<b.id));
UPDATE meter_reads SET month = substr(month,1,4) || '-Q' || ((substr(month,6,2)::int-1)/3+1) WHERE month ~ '^[0-9]{4}-[0-9]{2}$';
-- Nightly backup to the owner's Google Drive.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS gdrive_token TEXT;          -- encrypted refresh token
ALTER TABLE companies ADD COLUMN IF NOT EXISTS gdrive_email TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS gdrive_folder TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS gdrive_photos_folder TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS gdrive_last_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS gdrive_error TEXT;
CREATE TABLE IF NOT EXISTS gdrive_uploaded (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  photo_id   INTEGER NOT NULL,
  PRIMARY KEY (company_id, kind, photo_id)
);
-- Water system readings: the boss picks what to record; the crew logs values.
CREATE TABLE IF NOT EXISTS reading_types (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (company_id, name)
);
CREATE TABLE IF NOT EXISTS readings (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  crew_id    INTEGER REFERENCES crew(id) ON DELETE SET NULL,
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  vals       JSONB NOT NULL DEFAULT '{}',
  notes      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS readings_company ON readings (company_id, taken_at);
CREATE TABLE IF NOT EXISTS road_mows (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  road_id    INTEGER NOT NULL REFERENCES roads(id) ON DELETE CASCADE,
  crew_id    INTEGER REFERENCES crew(id) ON DELETE SET NULL,
  day        DATE NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS road_mows_road ON road_mows (road_id, day);
CREATE TABLE IF NOT EXISTS road_mow_photos (
  id         SERIAL PRIMARY KEY,
  mow_id     INTEGER NOT NULL REFERENCES road_mows(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS road_mow_photos_mow ON road_mow_photos (mow_id);
-- Readings taken at a water site, as part of a site check.
ALTER TABLE readings ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES roads(id) ON DELETE SET NULL;
ALTER TABLE readings ADD COLUMN IF NOT EXISTS mow_id INTEGER REFERENCES road_mows(id) ON DELETE CASCADE;
-- Which readings apply at each site (null = all of them).
ALTER TABLE roads ADD COLUMN IF NOT EXISTS reading_ids JSONB;
-- Photos the crew adds to a day's hours.
CREATE TABLE IF NOT EXISTS day_photos (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  crew_id    INTEGER NOT NULL REFERENCES crew(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS day_photos_day ON day_photos (company_id, day);
CREATE TABLE IF NOT EXISTS slug_redirects (old_slug TEXT PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE);
`;

async function migrate() { await pool.query(SCHEMA); await pool.query(UPGRADES); }

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => { console.log('Database is up to date.'); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
