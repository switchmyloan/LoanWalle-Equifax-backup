// Single cycle, then exit. Use for a system-cron deployment, or to run the
// service by hand. `npm run due` (--dry-run) only prints the work queue.
import { config } from './config.js';
import { clickhouse, fetchDueUsers } from './clickhouse.js';
import { runCycle } from './cycle.js';

const dryRun = process.argv.includes('--dry-run');

try {
  if (dryRun) {
    const due = await fetchDueUsers(config.batchSize);
    console.log(`${due.length} user(s) due`);
    for (const u of due) console.log(` ${u.partnerName.padEnd(6)} ${u.pan}`);
  } else {
    await runCycle();
  }
  await clickhouse.close();
} catch (err) {
  console.error('FATAL', err);
  await clickhouse.close();
  process.exit(1);
}
