// Long-running scheduler for pm2. For a system-cron deployment use `npm run once`
// instead and do not run this.
import { config } from './config.js';
import { clickhouse } from './clickhouse.js';
import { runCycle } from './cycle.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// Cycles never overlap: a run that outlives its interval simply delays the next
// tick rather than putting a second copy of the queue in flight.
let running = false;
async function tick() {
  if (running) return log('skip: previous cycle still running');
  running = true;
  try {
    await runCycle();
  } catch (err) {
    // Never let one bad cycle kill the process - the next tick may well succeed.
    console.error(new Date().toISOString(), 'cycle failed', err);
  } finally {
    running = false;
  }
}

log(`loanwalle-status-cron up; interval ${config.intervalMs / 60000}min, batch ${config.batchSize}, concurrency ${config.concurrency}`);
if (config.runOnBoot) await tick();
const timer = setInterval(tick, config.intervalMs);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    log(`${sig} received, shutting down`);
    clearInterval(timer);
    await clickhouse.close();
    process.exit(0);
  });
}
