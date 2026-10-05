import { createClient } from '@clickhouse/client';
import { config } from './config.js';

export const clickhouse = createClient({
  url: config.clickhouse.url,
  username: config.clickhouse.username,
  password: config.clickhouse.password,
  database: config.clickhouse.database,
});

// The work queue is a view, so "who is due" is decided by the database, not by
// scheduling columns this service has to keep updated. See clickhouse/schema.sql.
export async function fetchDueUsers(limit) {
  const rs = await clickhouse.query({
    query: `SELECT pan, partnerName, name, mobile, email, utmSource, utmMedium, type, clickedAt
            FROM loanwalle_due_users ORDER BY lastCheckedAt LIMIT {limit:UInt32}`,
    query_params: { limit },
    format: 'JSONEachRow',
  });
  return rs.json();
}

// One INSERT per partner table per cycle rather than one per user: ClickHouse
// is built for large batched inserts and punishes a stream of tiny ones.
export async function insertEvents(table, rows) {
  if (!rows.length) return;
  await clickhouse.insert({ table, values: rows, format: 'JSONEachRow' });
}

// The current loanwalle_latest rows for the PANs in this batch, so a new row can
// carry forward statusChangedAt and checkCount instead of resetting them.
// FINAL because ReplacingMergeTree may not have merged the last cycle's copy yet.
//
// Keyed on pan + partner, not pan: a user may hold a row per lender, and keying
// on pan alone would hand one lender's counters to another lender's check.
export async function fetchCurrentLatest(pans) {
  if (!pans.length) return new Map();
  const rs = await clickhouse.query({
    query: `SELECT pan, partnerName, statusBucket, statusChangedAt, firstCheckedAt, checkCount
            FROM loanwalle_latest FINAL WHERE pan IN {pans:Array(String)}`,
    query_params: { pans },
    format: 'JSONEachRow',
  });
  return new Map((await rs.json()).map((r) => [`${r.pan}|${r.partnerName}`, r]));
}

// ReplacingMergeTree ORDER BY pan: re-inserting a PAN replaces the previous row
// at merge time (highest lastCheckedAt wins), so this is an upsert.
export async function upsertLatest(rows) {
  if (!rows.length) return;
  await clickhouse.insert({ table: 'loanwalle_latest', values: rows, format: 'JSONEachRow' });
}

// Written by the app server's card-click call, never by the cron.
// async_insert lets ClickHouse buffer many single-row inserts into one part -
// without it, a row per click would litter the table with tiny parts.
export async function insertUsers(rows) {
  if (!rows.length) return;
  await clickhouse.insert({
    table: 'loanwalle_users',
    values: rows,
    format: 'JSONEachRow',
    clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
  });
}

// FINAL: loanwalle_latest is a ReplacingMergeTree, so without it a row that has
// not merged yet can come back twice for one PAN.
export async function fetchLeadStatus(pan) {
  // Returns one row per lender this PAN has selected - a user may have several.
  // Columns are listed explicitly rather than with l.*: pan and partnerName exist
  // on both sides, and ClickHouse returns those as "l.partnerName" in the JSON,
  // which does not match the field name the caller reads.
  const rs = await clickhouse.query({
    query: `SELECT u.pan AS pan, u.partnerName AS partnerName, u.name AS name,
                   u.mobile AS mobile, u.clickedAt AS clickedAt,
                   l.finalStatus AS finalStatus, l.statusBucket AS statusBucket,
                   l.message AS message, l.rejectionReason AS rejectionReason,
                   l.ineligibilityReason AS ineligibilityReason,
                   l.externalLoanId AS externalLoanId, l.loanAmount AS loanAmount,
                   l.disbursedAmount AS disbursedAmount, l.disbursedDate AS disbursedDate,
                   l.isFinal AS isFinal, l.statusChangedAt AS statusChangedAt,
                   l.lastCheckedAt AS lastCheckedAt, l.checkCount AS checkCount
            FROM (SELECT * FROM loanwalle_users FINAL WHERE pan = {pan:String}) u
            LEFT JOIN (SELECT * FROM loanwalle_latest FINAL WHERE pan = {pan:String}) l
              ON l.pan = u.pan AND l.partnerName = u.partnerName
            ORDER BY u.partnerName`,
    query_params: { pan },
    format: 'JSONEachRow',
  });
  return rs.json();
}
