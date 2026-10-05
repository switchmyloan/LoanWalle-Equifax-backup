import { PARTNERS } from './config.js';

// Standard Indian PAN: 5 letters, 4 digits, 1 letter.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export class ValidationError extends Error {
  constructor(errors) {
    super('validation failed');
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

// Accepts the partner name in any case ('tejas', 'F1', 'Tejas') and returns the
// canonical form, because a mismatch here silently strands a lead: the cron
// looks the name up in PARTNERS and skips anything it cannot resolve.
function canonicalPartner(value) {
  if (typeof value !== 'string') return null;
  // Compare with spaces, underscores and hyphens removed, so a partner whose
  // name is two words ('Rupee Raftaar') matches however the caller spells it.
  const squash = (v) => v.replace(/[\s_-]+/g, '').toLowerCase();
  const target = squash(value.trim());
  return Object.keys(PARTNERS).find((p) => squash(p) === target) || null;
}

// Normalizes as well as validates, so a caller sending ' caapb5467n ' does not
// become a second user alongside 'CAAPB5467N' - loanwalle_users is keyed on pan.
export function normalizeLead(input, index = null) {
  const errors = [];
  const at = index === null ? '' : `[${index}] `;

  const pan = typeof input?.pan === 'string' ? input.pan.trim().toUpperCase() : '';
  if (!pan) errors.push(`${at}pan is required`);
  else if (!PAN_RE.test(pan)) errors.push(`${at}pan '${pan}' is not a valid PAN (expected ABCDE1234F)`);

  const partnerName = canonicalPartner(input?.partnerName);
  if (!partnerName) {
    errors.push(`${at}partnerName must be one of: ${Object.keys(PARTNERS).join(', ')}`);
  }

  // Callers send mobiles in every shape: '+91 99999-00000', '09999900000',
  // '919999900000'. Strip to digits, then drop an Indian country code or a
  // trunk zero so all of those normalize to the same 10 digits.
  let mobile = String(input?.mobile ?? '').replace(/\D/g, '');
  if (mobile.length > 10) mobile = mobile.replace(/^(?:91|0)/, '');
  if (mobile && !/^[6-9]\d{9}$/.test(mobile)) {
    errors.push(`${at}mobile '${input.mobile}' is not a valid 10-digit Indian mobile`);
  }

  if (errors.length) throw new ValidationError(errors);

  return {
    pan,
    partnerName,
    mobile,
    name: String(input?.name ?? '').trim().slice(0, 200),
    email: String(input?.email ?? '').trim().toLowerCase().slice(0, 200),
    utmSource: String(input?.utmSource ?? '').trim().slice(0, 100),
    utmMedium: String(input?.utmMedium ?? '').trim().slice(0, 100),
    type: String(input?.type ?? '').trim().slice(0, 100),
  };
}
