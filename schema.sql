-- LoanWalle affiliate status tracking (PostgreSQL)
--
-- Model: one user = one PAN = one lender (a user commits to a single partner).
--
--   loanwalle_users     user data pushed in from the other server on card click,
--                       unique PAN + the partner they chose. Also the cron queue.
--   tejas_lead_status   append-only event log, Tejas responses only
--   f1_lead_status      append-only event log, F1 responses only
--   loanwalle_latest    latest status per PAN, upserted from whichever event
--                       table the cron just wrote to
--
-- Both partners share one endpoint and differ only by X-Affiliate-Key, so the
-- key is resolved per partner at call time from env / Secrets Manager. Keys are
-- never stored here - only the last 6 chars, as a receipt on each event row.

-- Our own normalized bucket for the partner's final_status. Small and stable so
-- the UI and the cron can switch on it; the partner's exact string is kept
-- alongside in final_status. A new partner status lands in UNKNOWN instead of
-- requiring a migration.
CREATE TYPE loanwalle_status_bucket AS ENUM (
  'NOT_FOUND',    -- no lead with this PAN under our UTM source
  'ELIGIBLE',     -- WIP - referable
  'IN_PROGRESS',  -- with partner, non-terminal
  'DUPLICATE',    -- LEAD_ALREADY_EXIST_WITH_PARTNER
  'REJECTED',     -- HARD_REJECT / partner rejection - terminal
  'DISBURSED',    -- terminal, happy path
  'UNKNOWN'       -- partner sent something we do not classify yet
);


-- ---------------------------------------------------------------------------
-- 1. Users: written by the other server the moment a lender card is clicked.
-- ---------------------------------------------------------------------------
CREATE TABLE loanwalle_users (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pan          TEXT NOT NULL,
  partner_name TEXT NOT NULL,          -- the card they clicked
  mobile       TEXT,
  name         TEXT,
  email        TEXT,
  utm_source   TEXT,
  clicked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Cron scheduling lives here because this row exists from the first click,
  -- before any status has ever been fetched.
  next_check_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- new user = check on the next run
  last_checked_at    TIMESTAMPTZ,
  check_count        INT NOT NULL DEFAULT 0,
  consecutive_errors INT NOT NULL DEFAULT 0,
  is_terminal        BOOLEAN NOT NULL DEFAULT FALSE,      -- stop polling

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One lender per user: PAN alone is the natural key. Also makes the insert
  -- from the other server safely repeatable (ON CONFLICT (pan) DO UPDATE).
  CONSTRAINT loanwalle_users_pan_key UNIQUE (pan),
  CONSTRAINT loanwalle_users_partner_chk CHECK (partner_name IN ('Tejas', 'F1'))
);
-- The cron's only query - "who is due?" - reads just this partial index.
CREATE INDEX loanwalle_users_due_idx
  ON loanwalle_users (next_check_at)
  WHERE is_terminal = FALSE;
CREATE INDEX ON loanwalle_users (mobile);
CREATE INDEX ON loanwalle_users (partner_name);


-- ---------------------------------------------------------------------------
-- 2. Per-partner event logs. Append-only: one row per API call, including
--    failed ones. Identical columns in both, so the cron can parameterize the
--    table name and keep a single INSERT.
-- ---------------------------------------------------------------------------
CREATE TABLE tejas_lead_status (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES loanwalle_users(id),
  pan           TEXT   NOT NULL,        -- denormalized so the log reads standalone

  http_status   INT,                    -- NULL when the call never completed
  found         BOOLEAN,
  final_status  TEXT,                   -- verbatim: 'DISBURSED', 'WIP', 'HARD_REJECT'
  status_bucket loanwalle_status_bucket,
  raw_status    TEXT,                   -- 'Loan Disbursed'
  message       TEXT,
  rejection_reason     TEXT,
  ineligibility_reason TEXT,
  external_loan_id     TEXT,
  loan_amount          NUMERIC(14,2),
  disbursed_amount     NUMERIC(14,2),
  disbursed_date       TIMESTAMPTZ,

  raw_response  JSONB,                  -- full body, unmodified - source of truth
  error_message TEXT,                   -- timeout / 5xx / parse failure
  latency_ms    INT,
  affiliate_key_last6 TEXT,             -- receipt: which key actually went out
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON tejas_lead_status (user_id, checked_at DESC);
CREATE INDEX ON tejas_lead_status (pan);
CREATE INDEX ON tejas_lead_status (status_bucket, checked_at DESC);

CREATE TABLE f1_lead_status (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES loanwalle_users(id),
  pan           TEXT   NOT NULL,

  http_status   INT,
  found         BOOLEAN,
  final_status  TEXT,
  status_bucket loanwalle_status_bucket,
  raw_status    TEXT,
  message       TEXT,
  rejection_reason     TEXT,
  ineligibility_reason TEXT,
  external_loan_id     TEXT,
  loan_amount          NUMERIC(14,2),
  disbursed_amount     NUMERIC(14,2),
  disbursed_date       TIMESTAMPTZ,

  raw_response  JSONB,
  error_message TEXT,
  latency_ms    INT,
  affiliate_key_last6 TEXT,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON f1_lead_status (user_id, checked_at DESC);
CREATE INDEX ON f1_lead_status (pan);
CREATE INDEX ON f1_lead_status (status_bucket, checked_at DESC);


-- ---------------------------------------------------------------------------
-- 3. Latest status per PAN, upserted by the cron right after it writes the
--    event row. This is what the app and the dashboards read - never compute a
--    "latest" by scanning the event tables at request time.
-- ---------------------------------------------------------------------------
CREATE TABLE loanwalle_latest (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES loanwalle_users(id),
  pan          TEXT   NOT NULL,
  partner_name TEXT   NOT NULL,

  final_status         TEXT NOT NULL,
  status_bucket        loanwalle_status_bucket NOT NULL,
  raw_status           TEXT,
  message              TEXT,
  rejection_reason     TEXT,
  ineligibility_reason TEXT,
  external_loan_id     TEXT,
  loan_amount          NUMERIC(14,2),
  disbursed_amount     NUMERIC(14,2),
  disbursed_date       TIMESTAMPTZ,

  -- points back at the row in tejas_lead_status / f1_lead_status this came from
  source_event_id   BIGINT,
  status_changed_at TIMESTAMPTZ,        -- only bumped when the status actually moves
  last_checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT loanwalle_latest_pan_key  UNIQUE (pan),
  CONSTRAINT loanwalle_latest_user_key UNIQUE (user_id),
  CONSTRAINT loanwalle_latest_partner_chk CHECK (partner_name IN ('Tejas', 'F1'))
);
CREATE INDEX ON loanwalle_latest (partner_name, status_bucket);
CREATE INDEX ON loanwalle_latest (status_bucket, last_checked_at);


-- ---------------------------------------------------------------------------
-- One view over both event tables, so cross-partner reporting stays a single
-- query. Extend the UNION here when a third lender is added, and every report
-- built on this view keeps working untouched.
-- ---------------------------------------------------------------------------
CREATE VIEW loanwalle_all_events AS
  SELECT 'Tejas' AS partner_name, * FROM tejas_lead_status
  UNION ALL
  SELECT 'F1'    AS partner_name, * FROM f1_lead_status;
