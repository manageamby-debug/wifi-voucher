import crypto from 'crypto';

// ── ClickPesa API client ──────────────────────────────────────────────────
// Docs: https://docs.clickpesa.com/payment-api/mobile-money-payment-api/mobile-money-payment-api-overview
//
// Flow used here:
//   1. generate-token       (JWT, cached ~1hr, auto-refreshed)
//   2. initiate-ussd-push   (sends the USSD prompt to the customer's phone)
//   3. query payment status (poll GET /payments/{orderReference} as a fallback
//                            to the PAYMENT RECEIVED / PAYMENT FAILED webhooks)

const BASE_URL = process.env.CLICKPESA_BASE_URL || 'https://api.clickpesa.com/third-parties';
const CLIENT_ID = process.env.CLICKPESA_CLIENT_ID;
const API_KEY = process.env.CLICKPESA_API_KEY;
const CHECKSUM_KEY = process.env.CLICKPESA_CHECKSUM_KEY; // optional — only if checksums are enabled on your ClickPesa app

let cachedToken = null;   // string, already includes the "Bearer " prefix per ClickPesa's docs
let cachedTokenExp = 0;   // ms epoch

function assertConfigured() {
  if (!CLIENT_ID || !API_KEY) {
    throw new Error(
      'ClickPesa is not configured. Set CLICKPESA_CLIENT_ID and CLICKPESA_API_KEY in your .env ' +
      '(see .env.example). Get these from the ClickPesa Merchant Dashboard → Settings → Developers.'
    );
  }
}

// ── 1. Auth ─────────────────────────────────────────────────────────────────
async function getToken() {
  assertConfigured();

  const now = Date.now();
  if (cachedToken && now < cachedTokenExp) return cachedToken;

  const res = await fetch(`${BASE_URL}/generate-token`, {
    method: 'POST',
    headers: {
      'client-id': CLIENT_ID,
      'api-key': API_KEY,
      'Content-Type': 'application/json',
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(`ClickPesa authentication failed: ${data.message || res.status}`);
  }

  cachedToken = data.token; // already prefixed with "Bearer "
  // Tokens are valid 1 hour — refresh a couple of minutes early to be safe.
  cachedTokenExp = now + 55 * 60 * 1000;
  return cachedToken;
}

// ── Checksum (only needed if you've enabled checksums on your ClickPesa app) ─
// https://docs.clickpesa.com/home/checksum
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  return Object.keys(obj).sort().reduce((acc, key) => {
    acc[key] = canonicalize(obj[key]);
    return acc;
  }, {});
}

function computeChecksum(payload, checksumKey = CHECKSUM_KEY) {
  if (!checksumKey) return undefined;
  const payloadString = JSON.stringify(canonicalize(payload));
  return crypto.createHmac('sha256', checksumKey).update(payloadString).digest('hex');
}

// Verify a webhook's checksum using a timing-safe comparison.
// `payload` should be the `data` object from the webhook body.
function verifyWebhookChecksum(payload, checksum) {
  if (!CHECKSUM_KEY) return true; // checksums not enabled on this app — nothing to verify
  if (!checksum) return false;
  const expected = computeChecksum(payload);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(checksum), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── 2. Initiate a USSD push payment ─────────────────────────────────────────
// phoneNumber must be in the 255XXXXXXXXX format (no leading +).
async function initiateUssdPush({ amount, orderReference, phoneNumber, currency = 'TZS' }) {
  const token = await getToken();

  const payload = { amount: String(amount), currency, orderReference, phoneNumber };
  const checksum = computeChecksum(payload);
  if (checksum) payload.checksum = checksum;

  const res = await fetch(`${BASE_URL}/payments/initiate-ussd-push-request`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ClickPesa payment request failed: ${data.message || res.status}`);
  }
  return data; // { id, status: 'PROCESSING', channel, orderReference, ... }
}

// ── 3. Query payment status ──────────────────────────────────────────────────
async function queryPaymentStatus(orderReference) {
  const token = await getToken();

  const res = await fetch(`${BASE_URL}/payments/${encodeURIComponent(orderReference)}`, {
    headers: { Authorization: token },
  });

  const data = await res.json().catch(() => ({}));
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`ClickPesa status query failed: ${data.message || res.status}`);
  }
  // API returns an array of matching transactions — take the most recent.
  return Array.isArray(data) ? data[0] || null : data;
}

export { initiateUssdPush, queryPaymentStatus, verifyWebhookChecksum, computeChecksum };
