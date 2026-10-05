// final_status (the partner's own vocabulary) -> statusBucket (ours).
//
// Kept as a plain lookup, NOT a database enum, so a status the partner adds
// tomorrow does not need a migration: it falls through to UNKNOWN, keeps being
// polled, and shows up in a query so we can classify it deliberately.
//
// Which of these are final lives in the loanwalle_due_users view, not here -
// this file only names the status.
const BUCKETS = {
  DISBURSED: 'DISBURSED',                             // final
  REJECTED: 'REJECTED',                               // final - partner's loan decision
  LEAD_ALREADY_EXIST_WITH_PARTNER: 'DUPLICATE',       // final
  HARD_REJECT: 'INELIGIBLE',                          // NOT final - flips when the user
                                                      // verifies PAN/phone or income updates
  APPROVED: 'APPROVED',                               // NOT final - still to be disbursed
  WIP: 'ELIGIBLE',
  NOT_FOUND: 'NOT_FOUND',
};

export const bucketFor = (finalStatus) => BUCKETS[finalStatus] || 'UNKNOWN';

// The API omits fields rather than sending them as null - a LEAD_ALREADY_EXIST
// response contains only found/final_status/message - so every optional field
// is read defensively. Never assume a key is present.
const str = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// '2026-09-03T15:00:07.275Z' (UTC, as the partner sends it) -> IST wall-clock
// for a DateTime64(3, 'Asia/Kolkata') column: '2026-09-03 20:30:07.275'.
//
// Writing the UTC clock verbatim into an IST-declared column - which this used
// to do - puts every disbursal 5h30m early, so anything disbursed after 18:30
// UTC is reported on the previous IST day. Same reasoning as nowIST() below.
//
// Anything unparseable becomes null rather than throwing: a surprise format
// must not cost us the rest of the response.
function toClickHouseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const wall = d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
  return `${wall}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// The DateTime64 columns are declared in Asia/Kolkata, so a value must be IST
// wall-clock. Node's toISOString() is UTC and would land every row 5h30m early.
// 'sv-SE' formats as YYYY-MM-DD HH:mm:ss, which is exactly what ClickHouse wants.
export function nowIST() {
  const d = new Date();
  const wall = d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
  return `${wall}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function rowFromResponse({ pan, keyLast6, httpStatus, body, latencyMs }) {
  // One timestamp shared by the event row and the loanwalle_latest row it feeds,
  // so the two can never disagree about when this check happened.
  const row = { pan, affiliateKeyLast6: keyLast6, httpStatus, latencyMs, checkedAt: nowIST(), rawResponse: JSON.stringify(body ?? '') };

  if (httpStatus === 200 && body && typeof body === 'object') {
    const finalStatus = str(body.final_status);
    return {
      ...row,
      found: body.found ? 1 : 0,
      finalStatus,
      statusBucket: bucketFor(finalStatus),
      rawStatus: str(body.raw_status),
      message: str(body.message),
      rejectionReason: str(body.rejection_reason),
      ineligibilityReason: str(body.ineligibility_reason),
      externalLoanId: str(body.external_loan_id),
      loanAmount: num(body.loan_amount),
      disbursedAmount: num(body.disbursed_amount),
      disbursedDate: toClickHouseDate(body.disbursed_date),
    };
  }

  // HTTP 400 = the partner refused the request itself ("Provide at least one of:
  // pan or mobile"), i.e. the pan on our user row is unusable. Retrying an hour
  // later cannot fix that, so it gets a terminal bucket instead of an error row
  // that the queue would re-serve forever.
  if (httpStatus === 400) {
    return { ...row, statusBucket: 'INVALID', errorMessage: str(body?.message).slice(0, 200) };
  }

  // Everything else - 5xx, timeouts, transport failures - is transient. No
  // statusBucket is written, so loanwalle_latest keeps the last good status and
  // the queue re-serves this user on a backoff.
  return { ...row, errorMessage: str(body?.message || body?.error || 'request failed').slice(0, 200) };
}

// Buckets that end the lead - these users are never polled again. Kept in sync
// with the NOT IN list in the loanwalle_due_users view.
export const FINAL_BUCKETS = new Set(['DISBURSED', 'REJECTED', 'DUPLICATE', 'INVALID']);

// Build the loanwalle_latest row for a user from the event row just written plus
// whatever loanwalle_latest already holds for them.
//
// statusChangedAt tracks when the bucket last MOVED, so a lead sitting in WIP for
// three days keeps its original timestamp while lastCheckedAt advances hourly -
// that difference is what "stuck in stage X for N days" reporting needs.
export function latestFromEvent(event, user, previousRow) {
  const now = event.checkedAt;
  // A lead that has been moved to a different lender starts its history over:
  // the old partner's statusChangedAt and checkCount describe a different
  // application and would misreport this one.
  const previous = previousRow && previousRow.partnerName === user.partnerName ? previousRow : null;
  return {
    pan: event.pan,
    partnerName: user.partnerName,
    // Snapshot of the user's details as of this check, so loanwalle_latest can
    // be read on its own without joining loanwalle_users.
    name: user.name || '',
    mobile: user.mobile || '',
    email: user.email || '',
    utmSource: user.utmSource || '',
    utmMedium: user.utmMedium || '',
    type: user.type || '',
    clickedAt: user.clickedAt || null,
    finalStatus: event.finalStatus,
    statusBucket: event.statusBucket,
    rawStatus: event.rawStatus,
    message: event.message,
    rejectionReason: event.rejectionReason,
    ineligibilityReason: event.ineligibilityReason,
    externalLoanId: event.externalLoanId,
    loanAmount: event.loanAmount,
    disbursedAmount: event.disbursedAmount,
    disbursedDate: event.disbursedDate,
    isFinal: FINAL_BUCKETS.has(event.statusBucket) ? 1 : 0,
    statusChangedAt: previous && previous.statusBucket === event.statusBucket ? previous.statusChangedAt : now,
    firstCheckedAt: previous ? previous.firstCheckedAt : now,
    lastCheckedAt: now,
    checkCount: previous ? Number(previous.checkCount) + 1 : 1,
  };
}
