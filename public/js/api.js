// Small shared API client. All requests go through here so pages stay thin.
const API = '';

function authHeaders() {
  const token = localStorage.getItem('wv_admin_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiGet(path, auth = false) {
  const res = await fetch(`${API}${path}`, { headers: auth ? authHeaders() : {} });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function apiPost(path, body, auth = false) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? authHeaders() : {}) },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function formatMoney(amount) {
  return `TZS ${Number(amount).toLocaleString()}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// Normalizes a locally-typed Tanzanian number (0781..., 781..., +255781...)
// into ClickPesa's required 255XXXXXXXXX format. Returns null if it can't.
function normalizeTzPhone(input) {
  let digits = String(input || '').replace(/[^\d]/g, '');
  if (digits.startsWith('0') && digits.length === 10) digits = '255' + digits.slice(1);
  if (digits.length === 9) digits = '255' + digits;
  if (!/^255\d{9}$/.test(digits)) return null;
  return digits;
}
