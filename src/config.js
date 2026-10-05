import dotenv from 'dotenv';

// override: .env is the single source of truth for this service's config.
// Without it, a value pm2 has cached in its saved process env (from an earlier
// `pm2 restart --update-env`) silently outranks the .env file, so editing .env
// and restarting appears to do nothing. That cost an afternoon once.
dotenv.config({ override: true });

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};




// Both partners share one endpoint and are told apart ONLY by the affiliate key,
// so the key is the single most important thing to get right per partner. The
// response body carries no partner field: send the wrong key and you would
// silently store another lender's status under this one. keyLast6 is recorded on
// every event row so a mix-up is detectable after the fact.
export const PARTNERS = {
  Tejas:        { table: 'tejas_lead_status',         keyEnv: 'LOANWALLE_TEJAS_AFFILIATE_KEY' },
  F1:           { table: 'f1_lead_status',            keyEnv: 'LOANWALLE_F1_AFFILIATE_KEY' },
  Toofan:       { table: 'toofan_lead_status',        keyEnv: 'LOANWALLE_TOOFAN_AFFILIATE_KEY' },
  RupeeRaftaar: { table: 'rupee_raftaar_lead_status', keyEnv: 'LOANWALLE_RUPEE_RAFTAAR_AFFILIATE_KEY' },
};

export const config = {
  clickhouse: {
    url: required('CLICKHOUSE_URL'),
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: required('CLICKHOUSE_DATABASE'),
  },
  statusUrl: process.env.LOANWALLE_STATUS_URL || 'https://api.loanwalle.com/api/affiliate/user-status',
  // How many users one cycle will process, and how many calls are in flight at
  // once. Deliberately modest: the partner API is shared infrastructure and a
  // burst of hundreds of parallel requests is how you get rate-limited.
  batchSize: Number(process.env.BATCH_SIZE || 500),
  concurrency: Number(process.env.CONCURRENCY || 5),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 20000),
  intervalMs: Number(process.env.INTERVAL_MS || 60 * 60 * 1000), // hourly
  runOnBoot: process.env.RUN_ON_BOOT !== 'false',
  api: {
    port: Number(process.env.PORT || 4010),
    // Shared secret the app server sends as X-API-Key. Required: without it the
    // endpoint would let anyone on the network write leads.
    ingestKey: process.env.INGEST_API_KEY || '',
    maxBatch: Number(process.env.MAX_BATCH || 200),
    // Browser origins allowed to call this API. Comma-separated, exact matches
    // (scheme + host + port). An empty list disables CORS entirely, which is
    // the right setting when only server-to-server callers exist.
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
      .split(',').map((o) => o.trim()).filter(Boolean),
  },
};

export function partnerKey(partnerName) {
  const partner = PARTNERS[partnerName];
  if (!partner) throw new Error(`Unknown partner: ${partnerName}`);
  const key = process.env[partner.keyEnv];
  if (!key) throw new Error(`Missing affiliate key for ${partnerName} (${partner.keyEnv})`);
  return key;
}
