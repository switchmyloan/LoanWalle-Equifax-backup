-- =====================================================================
-- LoanWalle affiliate status tracking  (ClickHouse, database: webhook_data)
--
-- Model: one user = one PAN = one lender. The web server inserts a row into
-- loanwalle_users when a lender card is clicked; an hourly cron calls
-- /api/affiliate/user-status for the users that are due and appends the
-- response to that partner's event table.
--
-- Both partners share one endpoint and differ only by X-Affiliate-Key, so the
-- key is resolved per partner at call time from the environment. Keys are never
-- stored here - only the last 6 chars, as a receipt on each event row.
--
-- Everything below is CREATE ... IF NOT EXISTS. Nothing drops or alters an
-- existing object.
-- =====================================================================


-- =====================================================================
-- loanwalle_users -> user master, one logical row per PAN.
--
-- Grain is (pan, partnerName): a user may select more than one lender, and each
-- selection is polled independently. ClickHouse has no unique constraint, so
-- uniqueness is expressed as ReplacingMergeTree ORDER BY (pan, partnerName) -
-- re-inserting the same pair replaces the older row at merge time, highest
-- updatedAt winning. That makes the insert from the other server safely
-- repeatable, and lets a second lender be added without displacing the first.
--
-- Because merges are asynchronous, always read this table through FINAL (or
-- through the views below, which already do). At a few hundred thousand users
-- that is cheap.
-- =====================================================================
CREATE TABLE IF NOT EXISTS loanwalle_users
(
    pan          String,
    partnerName  LowCardinality(String),            -- 'Tejas' | 'F1' - the card clicked
    mobile       String DEFAULT '',
    name         String DEFAULT '',
    email        String DEFAULT '',
    utmSource    LowCardinality(String) DEFAULT '',
    utmMedium    LowCardinality(String) DEFAULT '',
    type         LowCardinality(String) DEFAULT '',   -- free-form lead/product tag from the app
    clickedAt    DateTime64(3, 'Asia/Kolkata') DEFAULT now64(3),
    createdAt    DateTime64(3, 'Asia/Kolkata') DEFAULT now64(3),
    updatedAt    DateTime64(3, 'Asia/Kolkata') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updatedAt)
ORDER BY (pan, partnerName)
;


-- =====================================================================
-- tejas_lead_status / f1_lead_status -> append-only event logs, one row per
-- API call, including the calls that failed. Source of truth: loanwalle_latest
-- is derived from these and can always be rebuilt.
--
-- Identical column lists in both, so the cron parameterizes the table name and
-- keeps a single INSERT statement.
--
-- statusBucket is our own normalized value, kept as LowCardinality(String)
-- rather than Enum8 so a new partner status never needs a schema change - it
-- lands in 'UNKNOWN' and shows up in a query. finalStatus keeps the partner's
-- exact string alongside it.
--
--   final_status                        statusBucket   final?
--   ----------------------------------  -------------  ------
--   DISBURSED                           DISBURSED      yes
--   REJECTED                            REJECTED       yes   (partner loan decision)
--   LEAD_ALREADY_EXIST_WITH_PARTNER     DUPLICATE      yes
--   HARD_REJECT                         INELIGIBLE     no    (eligibility - flips when the
--                                                             user verifies PAN/phone or
--                                                             their income data updates)
--   APPROVED                            APPROVED       no    (still to be disbursed)
--   WIP                                 ELIGIBLE       no
--   NOT_FOUND                           NOT_FOUND      no
--   anything else                       UNKNOWN        no    (polls on, so a new partner
--                                                             status announces itself)
--   (HTTP 400 - bad pan/mobile)         INVALID        yes   (the user row is unusable;
--                                                             retrying cannot fix it)
--
-- HARD_REJECT and REJECTED must NOT share a bucket: one is reversible, the
-- other ends the lead.
-- =====================================================================
CREATE TABLE IF NOT EXISTS tejas_lead_status
(
    pan                 String,
    httpStatus          Int32 DEFAULT 0,             -- 0 = call never completed
    found               UInt8 DEFAULT 0,
    finalStatus         LowCardinality(String) DEFAULT '',   -- verbatim: 'DISBURSED', 'WIP', 'HARD_REJECT'
    statusBucket        LowCardinality(String) DEFAULT '',
    rawStatus           String DEFAULT '',           -- 'Loan Disbursed'
    message             String DEFAULT '',
    rejectionReason     String DEFAULT '',
    ineligibilityReason String DEFAULT '',
    externalLoanId      String DEFAULT '',
    loanAmount          Nullable(Decimal(14, 2)),
    disbursedAmount     Nullable(Decimal(14, 2)),
    disbursedDate       Nullable(DateTime64(3, 'Asia/Kolkata')),
    rawResponse         String DEFAULT '',           -- full body as JSON text, unmodified
    errorMessage        String DEFAULT '',           -- timeout / 5xx / parse failure
    latencyMs           UInt32 DEFAULT 0,
    affiliateKeyLast6   FixedString(6) DEFAULT '      ',  -- receipt: which key went out
    checkedAt           DateTime64(3, 'Asia/Kolkata') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(checkedAt)
ORDER BY (pan, checkedAt)
;

CREATE TABLE IF NOT EXISTS f1_lead_status
(
    pan                 String,
    httpStatus          Int32 DEFAULT 0,
    found               UInt8 DEFAULT 0,
    finalStatus         LowCardinality(String) DEFAULT '',
    statusBucket        LowCardinality(String) DEFAULT '',
    rawStatus           String DEFAULT '',
    message             String DEFAULT '',
    rejectionReason     String DEFAULT '',
    ineligibilityReason String DEFAULT '',
    externalLoanId      String DEFAULT '',
    loanAmount          Nullable(Decimal(14, 2)),
    disbursedAmount     Nullable(Decimal(14, 2)),
    disbursedDate       Nullable(DateTime64(3, 'Asia/Kolkata')),
    rawResponse         String DEFAULT '',
    errorMessage        String DEFAULT '',
    latencyMs           UInt32 DEFAULT 0,
    affiliateKeyLast6   FixedString(6) DEFAULT '      ',
    checkedAt           DateTime64(3, 'Asia/Kolkata') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(checkedAt)
ORDER BY (pan, checkedAt)
;

-- Partners added later reuse the exact structure and engine of the first table
-- rather than repeating the column list, which is how they stay identical - the
-- cron parameterizes the table name and keeps a single INSERT for all of them.
CREATE TABLE IF NOT EXISTS toofan_lead_status        AS tejas_lead_status;
CREATE TABLE IF NOT EXISTS rupee_raftaar_lead_status AS tejas_lead_status;


-- =====================================================================
-- loanwalle_all_events -> both partner logs as one stream, so cross-partner
-- reporting stays a single query. Add the third lender to this UNION when it
-- arrives and every report built on this view keeps working untouched.
-- =====================================================================
CREATE VIEW IF NOT EXISTS loanwalle_all_events AS
SELECT 'Tejas'        AS partnerName, * FROM tejas_lead_status
UNION ALL SELECT 'F1'           AS partnerName, * FROM f1_lead_status
UNION ALL SELECT 'Toofan'       AS partnerName, * FROM toofan_lead_status
UNION ALL SELECT 'RupeeRaftaar' AS partnerName, * FROM rupee_raftaar_lead_status
;


-- =====================================================================
-- loanwalle_latest -> current status per (pan, partner), written by the cron in
-- the same batch as the event rows. A user who selected two lenders has two
-- rows here, one per lender.
--
-- ReplacingMergeTree ORDER BY pan: each cycle re-inserts the user's row and the
-- older copy collapses away at merge time, with the highest lastCheckedAt
-- winning. Read it with FINAL (or GROUP BY pan) so an unmerged duplicate can
-- never show up as two rows for one user.
--
-- Only calls that actually returned a status are written here: a partner outage
-- appends error rows to the event log but can never blank out a good status.
--
-- name/mobile deliberately live only in loanwalle_users - join when a dashboard
-- needs them, so there is one place a user's details can be corrected.
-- =====================================================================
CREATE TABLE IF NOT EXISTS loanwalle_latest
(
    pan                 String,
    partnerName         LowCardinality(String),
    -- The user's own details, copied from loanwalle_users on every check so a
    -- dashboard can read this table alone. loanwalle_users stays the source of
    -- truth: these are a snapshot as of lastCheckedAt, and a lead that has gone
    -- final is never polled again, so its snapshot stops updating there.
    name                String DEFAULT '',
    mobile              String DEFAULT '',
    email               String DEFAULT '',
    utmSource           LowCardinality(String) DEFAULT '',
    utmMedium           LowCardinality(String) DEFAULT '',
    type                LowCardinality(String) DEFAULT '',
    clickedAt           Nullable(DateTime64(3, 'Asia/Kolkata')),
    finalStatus         LowCardinality(String),      -- partner's verbatim string
    statusBucket        LowCardinality(String),      -- our normalized value
    rawStatus           String DEFAULT '',
    message             String DEFAULT '',
    rejectionReason     String DEFAULT '',
    ineligibilityReason String DEFAULT '',
    externalLoanId      String DEFAULT '',
    loanAmount          Nullable(Decimal(14, 2)),
    disbursedAmount     Nullable(Decimal(14, 2)),
    disbursedDate       Nullable(DateTime64(3, 'Asia/Kolkata')),
    isFinal             UInt8 DEFAULT 0,             -- 1 = will never be polled again
    statusChangedAt     DateTime64(3, 'Asia/Kolkata'),  -- when the bucket last MOVED
    firstCheckedAt      DateTime64(3, 'Asia/Kolkata'),
    lastCheckedAt       DateTime64(3, 'Asia/Kolkata'),  -- also the Replacing version
    checkCount          UInt32 DEFAULT 1
)
ENGINE = ReplacingMergeTree(lastCheckedAt)
ORDER BY (pan, partnerName)
;


-- =====================================================================
-- loanwalle_due_users -> the cron's work queue: who to call this run, and with
-- which partner's key. Computed, not stored, so nothing has to be UPDATEd -
-- which ClickHouse is bad at.
--
-- Events are matched on (pan, partnerName), not pan alone: a lead re-posted with
-- a different lender must be polled for the NEW partner, and would otherwise
-- inherit the old partner's final status and never be called again.
--
-- Final statuses are never re-checked: DISBURSED, REJECTED (the partner's loan
-- decision) and DUPLICATE (LEAD_ALREADY_EXIST_WITH_PARTNER) end the lead, and
-- INVALID means the partner rejected our request itself (HTTP 400 - the pan on
-- the user row is malformed), which no amount of retrying will fix.
-- INELIGIBLE (HARD_REJECT) and APPROVED are NOT final and keep polling - the
-- first can flip once the user verifies PAN/phone or their income updates, the
-- second still has to reach disbursal. Everything else backs off by bucket, so an
-- unconditional hourly sweep of every user never develops into a flood of
-- pointless partner calls.
-- =====================================================================
CREATE VIEW IF NOT EXISTS loanwalle_due_users AS
SELECT
    u.pan          AS pan,
    u.partnerName  AS partnerName,
    u.name         AS name,
    u.mobile       AS mobile,
    u.email        AS email,
    u.utmSource    AS utmSource,
    u.utmMedium    AS utmMedium,
    u.type         AS type,
    u.clickedAt    AS clickedAt,
    s.bucket       AS statusBucket,
    s.lastCheckedAt AS lastCheckedAt,
    s.attempts     AS attempts
FROM ( SELECT pan, partnerName, name, mobile, email, utmSource, utmMedium, type, clickedAt
       FROM loanwalle_users FINAL ) AS u
LEFT JOIN
(
    SELECT
        pan,
        partnerName,
        argMax(statusBucket, checkedAt) AS bucket,
        argMax(errorMessage, checkedAt) AS lastError,
        max(checkedAt)                  AS lastCheckedAt,
        count()                         AS attempts
    FROM loanwalle_all_events
    GROUP BY pan, partnerName
) AS s ON s.pan = u.pan AND s.partnerName = u.partnerName
WHERE
    s.attempts = 0        -- never called yet -> due on the next run
    OR (
        s.bucket NOT IN ('DISBURSED', 'REJECTED', 'DUPLICATE', 'INVALID')
        AND now64(3) >= s.lastCheckedAt + INTERVAL multiIf(
              s.lastError != '', least(60, 5 * s.attempts),   -- error backoff, capped at 1h
              s.bucket = 'NOT_FOUND' AND s.attempts < 4, 15,
              60                                              -- WIP / APPROVED / INELIGIBLE / UNKNOWN
            ) MINUTE
    )
;
