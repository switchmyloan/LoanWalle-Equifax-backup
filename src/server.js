// Ingest API. The app server posts a lead here on a lender-card click instead of
// talking to ClickHouse directly, so it never holds database credentials, never
// hardcodes a table name, and cannot write anything but leads.
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { clickhouse, insertUsers, fetchLeadStatus } from './clickhouse.js';
import { normalizeLead, ValidationError } from './validate.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

if (!config.api.ingestKey) {
  throw new Error('INGEST_API_KEY is not set - refusing to start an unauthenticated ingest endpoint');
}

const app = express();
app.use(helmet());

// Browsers refuse a cross-origin call unless the server says the origin is
// allowed, and they send a preflight OPTIONS first because X-API-Key is a custom
// header. An explicit allowlist rather than '*': credentials aside, '*' would let
// any page on the internet drive this API using a key it has scraped.
app.use(cors({
  origin(origin, cb) {
    // No Origin header at all = curl, Postman, server-to-server. Always allowed;
    // CORS is a browser mechanism and blocking these would break the app server.
    if (!origin) return cb(null, true);
    cb(null, config.api.corsOrigins.includes(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '1mb' }));
// PANs are personal data: log the route, never the body.
app.use(morgan(':method :url :status :response-time ms'));

// Constant-time compare so the key cannot be recovered by timing the responses.
function authorized(req) {
  const sent = req.get('X-API-Key') || '';
  const expected = config.api.ingestKey;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use('/api', (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'invalid or missing X-API-Key' });
  next();
});

// POST /api/leads
// Body: a single lead object, or { leads: [...] } / a bare array for a batch.
//
// Idempotent: loanwalle_users is a ReplacingMergeTree keyed on pan, so posting
// the same lead twice updates the user rather than duplicating them. Safe to
// retry, and safe to call again later with more fields filled in.
app.post('/api/leads', async (req, res) => {
  const payload = Array.isArray(req.body) ? req.body : req.body?.leads ?? [req.body];
  if (!Array.isArray(payload) || payload.length === 0) {
    return res.status(400).json({ ok: false, error: 'body must be a lead object or a non-empty array of leads' });
  }
  if (payload.length > config.api.maxBatch) {
    return res.status(413).json({ ok: false, error: `at most ${config.api.maxBatch} leads per request` });
  }

  let rows;
  try {
    // All-or-nothing: a batch with one bad PAN is rejected whole, so the caller
    // never has to reconcile a partial write.
    rows = payload.map((lead, i) => normalizeLead(lead, payload.length > 1 ? i : null));
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ ok: false, errors: err.errors });
    throw err;
  }

  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
  await insertUsers(rows.map((r) => ({ ...r, updatedAt: now })));
  log(`ingest: ${rows.length} lead(s)`, rows.map((r) => `${r.partnerName}:***${r.pan.slice(-4)}`).join(' '));

  res.status(201).json({
    ok: true,
    count: rows.length,
    leads: rows.map(({ pan, partnerName }) => ({ pan, partnerName })),
  });
});

// GET /api/leads/:pan - what the cards page can poll to show the user's status.
// 'PENDING' means the lead is queued but has not been checked yet, which is
// different from a partner saying NOT_FOUND.
// GET /api/leads/:pan - every lender this PAN has selected, one entry each.
// 'PENDING' means the lead is queued but not yet checked, which is not the same
// as the partner replying NOT_FOUND.
// A LEFT JOIN with no match yields ClickHouse's zero date rather than null, and
// "1970-01-01" reads as a real timestamp to a caller. Blank it out.
const nullIfEpoch = (v) => (!v || String(v).startsWith('1970-01-01') ? null : v);

app.get('/api/leads/:pan', async (req, res) => {
  const pan = String(req.params.pan || '').trim().toUpperCase();
  const rows = await fetchLeadStatus(pan);
  if (!rows.length) return res.status(404).json({ ok: false, error: 'no lead for this PAN' });

  res.json({
    ok: true,
    pan,
    count: rows.length,
    leads: rows.map((row) => ({
      partnerName: row.partnerName,
      status: row.statusBucket || 'PENDING',
      finalStatus: row.finalStatus || null,
      message: row.message || null,
      isFinal: Boolean(row.isFinal),
      loanAmount: row.loanAmount ?? null,
      disbursedAmount: row.disbursedAmount ?? null,
      disbursedDate: row.disbursedDate ?? null,
      clickedAt: nullIfEpoch(row.clickedAt),
      lastCheckedAt: nullIfEpoch(row.lastCheckedAt),
    })),
  });
});

app.get('/health', async (_req, res) => {
  try {
    await clickhouse.query({ query: 'SELECT 1', format: 'JSONEachRow' });
    res.json({ ok: true, clickhouse: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, clickhouse: 'down', error: err.message });
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: `no route ${req.method} ${req.path}` }));

// Malformed JSON never reaches a route - express.json() throws first. Without
// this it would surface as a bare 500 "internal error", which tells the caller
// nothing about the trailing comma or stray quote that actually caused it.
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: `malformed JSON: ${err.message}` });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'request body too large' });
  }
  next(err);
});

// Never leak a stack trace or a ClickHouse error string to the caller.
app.use((err, _req, res, _next) => {
  console.error(new Date().toISOString(), 'unhandled', err);
  res.status(500).json({ ok: false, error: 'internal error' });
});

const server = app.listen(config.api.port, () => log(`ingest api listening on :${config.api.port}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    server.close(async () => { await clickhouse.close(); process.exit(0); });
  });
}
