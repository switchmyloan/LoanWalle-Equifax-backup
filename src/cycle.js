import { config, PARTNERS } from './config.js';
import { fetchDueUsers, insertEvents, fetchCurrentLatest, upsertLatest } from './clickhouse.js';
import { fetchStatus, AuthError } from './api.js';
import { rowFromResponse, latestFromEvent } from './mapper.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// Simple worker-pool: `concurrency` workers pulling from one shared queue, so a
// few slow responses never leave the rest of the batch waiting on them.
async function mapWithConcurrency(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runCycle() {
  const startedAt = Date.now();
  const due = await fetchDueUsers(config.batchSize);
  if (!due.length) {
    log('cycle: nothing due');
    return { checked: 0, inserted: 0 };
  }
  log(`cycle: ${due.length} user(s) due`);

  // Partners whose key has been rejected this cycle. Users belonging to them are
  // skipped rather than retried one by one.
  const deadPartners = new Set();
  const byTable = new Map();
  // Previous loanwalle_latest state for this batch, read once up front so each
  // user's new row can carry forward statusChangedAt / firstCheckedAt.
  const previous = await fetchCurrentLatest([...new Set(due.map((u) => u.pan))]);
  const latestRows = [];

  await mapWithConcurrency(due, config.concurrency, async (user) => {
    const { pan, partnerName } = user;
    if (deadPartners.has(partnerName)) return;
    const partner = PARTNERS[partnerName];
    if (!partner) {
      // A partnerName nothing maps to: the user row is wrong, or a lender was
      // added to the site without being added here. Loud, and skipped.
      log(`WARN unknown partnerName ${JSON.stringify(partnerName)} for pan ending ${pan.slice(-4)} - skipped`);
      return;
    }

    let result;
    try {
      result = await fetchStatus(pan, partnerName);
    } catch (err) {
      if (err instanceof AuthError) {
        // Nothing this service can do about it - the key must be fixed. Stop
        // calling for this partner so the run does not hammer a dead credential.
        log(`ERROR ${err.message} - skipping all remaining ${partnerName} users this cycle`);
        deadPartners.add(partnerName);
        return;
      }
      throw err;
    }

    const row = rowFromResponse({ pan, ...result });
    if (!byTable.has(partner.table)) byTable.set(partner.table, []);
    byTable.get(partner.table).push(row);

    // Only a call that actually returned a status updates loanwalle_latest. A
    // timeout or 5xx appends its event row above and stops there, leaving the
    // last good status standing.
    if (row.statusBucket) latestRows.push(latestFromEvent(row, user, previous.get(`${pan}|${partnerName}`)));
  });

  let inserted = 0;
  for (const [table, rows] of byTable) {
    await insertEvents(table, rows);
    inserted += rows.length;
    const summary = rows.reduce((acc, r) => {
      const k = r.statusBucket || `error(${r.httpStatus})`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    log(`cycle: ${table} <- ${rows.length} row(s)`, summary);
  }

  // After the events, so loanwalle_latest can never claim a status that is not
  // in the log behind it.
  await upsertLatest(latestRows);
  if (latestRows.length) log(`cycle: loanwalle_latest <- ${latestRows.length} row(s)`);

  log(`cycle: done in ${Date.now() - startedAt}ms`);
  return { checked: due.length, inserted, latest: latestRows.length, deadPartners: [...deadPartners] };
}
