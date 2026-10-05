# loanwalle-status-cron

Polls the LoanWalle affiliate `user-status` API for every lead that is due and
appends the response to ClickHouse (`webhook_data`).

The web server inserts a row into `loanwalle_users` when a lender card is
clicked. This service does the rest.

## How it fits together

    other server            this service                 ClickHouse
    ------------            ------------                 ----------
    card click  ---------------------------------------> loanwalle_users
                            loanwalle_due_users  <------- (view: who is due)
                            GET /user-status
                            map final_status -> bucket
                            INSERT --------------------> tejas_lead_status
                                                         f1_lead_status
                                                         loanwalle_latest (view)

The database decides *who* to call and derives the latest status; this service
only fetches and maps. Nothing here does UPDATEs.

## Two processes

| Process | Script | Job |
|---|---|---|
| `loanwalle-api` | `src/server.js` | ingest endpoint the app server posts leads to |
| `loanwalle-status-cron` | `src/index.js` | hourly polling of the partner APIs |

They are separate so restarting the API never interrupts a polling cycle, and a
crash in one cannot take the other down.

## Run

    npm install
    npm run serve    # ingest API only
    npm run due      # dry run - print the work queue, call nothing
    npm run once     # one polling cycle, then exit  (use this with system cron)
    npm start        # long-running poller (use this with pm2)

    pm2 start ecosystem.config.json     # starts both

## Endpoints

    POST /api/leads         # app server posts a lead on card click (X-API-Key)
    GET  /api/leads/:pan    # current status for a lead
    GET  /health            # liveness + ClickHouse reachability

See docs/INSERT-FROM-YOUR-SERVER.md for the integration guide.

Or hourly via system cron instead of pm2:

    0 * * * * /usr/bin/npm run once >> logs/cron.log 2>&1

## Environment

    CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE
    PORT=4010                         # ingest API
    INGEST_API_KEY                    # shared secret; the API refuses to start without it
    LOANWALLE_TEJAS_AFFILIATE_KEY     # partner is identified ONLY by this key
    LOANWALLE_F1_AFFILIATE_KEY
    BATCH_SIZE=500  CONCURRENCY=5  REQUEST_TIMEOUT_MS=20000  INTERVAL_MS=3600000

## Behaviour worth knowing

| Situation | What happens |
|---|---|
| 200 with a known `final_status` | mapped to a bucket, row inserted |
| 200 with an unknown `final_status` | bucket `UNKNOWN`, keeps polling, shows up in a query |
| 400 (bad pan) | bucket `INVALID` - terminal, no retry (retrying cannot fix the user row) |
| 401/403 | nothing written; that partner is skipped for the rest of the cycle and logged |
| 5xx / timeout | error row only - `loanwalle_latest` keeps the last good status, queue retries on backoff |

Final buckets (`DISBURSED`, `REJECTED`, `DUPLICATE`, `INVALID`) leave the queue
permanently. `INELIGIBLE` (HARD_REJECT) and `APPROVED` are NOT final and keep
being polled - the first flips when the user verifies PAN/phone or their income
updates, the second still has to reach disbursal.

Partners: Tejas, F1, Toofan, RupeeRaftaar. `partnerName` is accepted in any
case and ignores spaces/underscores, so 'Rupee Raftaar', 'rupee_raftaar' and
'RupeeRaftaar' all resolve to the same partner.

Adding a lender:
1. `CREATE TABLE <name>_lead_status AS tejas_lead_status;`
2. add it to the `loanwalle_all_events` UNION
3. add it to `PARTNERS` in `src/config.js`
4. add `LOANWALLE_<NAME>_AFFILIATE_KEY` to `.env`
5. `pm2 restart 36 37 --update-env`

Watch for unmapped statuses:

    SELECT finalStatus, count() FROM loanwalle_latest WHERE statusBucket='UNKNOWN' GROUP BY finalStatus
# LoanWalle-Equifax-backup
