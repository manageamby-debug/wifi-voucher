import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as clickpesa from './clickpesa.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 4001;

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:4001,http://127.0.0.1:4001')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  }
}));
app.use(express.json());

// ── ENV ──────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'wifi-voucher-dev-secret-change-in-prod';

// ── JWT helpers (same pattern as landlink) ────────────────────────────────────
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signJWT(payload) {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body   = base64url(Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 60*60*24*7 })));
  const sig    = base64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expectedSig = base64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64').toString());
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

function hashPassword(password) {
  return crypto.createHmac('sha256', JWT_SECRET).update(password).digest('hex');
}

// ── Seed data ─────────────────────────────────────────────────────────────────
const SEED_PLANS = [
  { id: 1, name: '1 Hour',  price: 500,   durationHours: 1,   speedMbps: 5,  description: 'Quick browsing session' },
  { id: 2, name: '1 Day',   price: 1500,  durationHours: 24,  speedMbps: 10, description: 'Full day access' },
  { id: 3, name: '1 Week',  price: 8000,  durationHours: 168, speedMbps: 10, description: 'A week of unlimited access' },
  { id: 4, name: '1 Month', price: 25000, durationHours: 720, speedMbps: 20, description: 'Best value for regular use' },
];

const SEED_ADMIN = {
  id: 'admin_001',
  name: 'WiFi Voucher Admin',
  username: 'admin',
  passwordHash: hashPassword('admin123'),
  role: 'admin',
  createdAt: new Date().toISOString(),
};

// ── Persistent storage (flat JSON file — same approach as landlink) ─────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadDB() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch (e) {
      console.error('Could not parse data.json — starting from seed data:', e.message);
    }
  }
  return {
    admins: [SEED_ADMIN],
    plans: [...SEED_PLANS],
    vouchers: [],
    transactions: [],
    payments: [],
  };
}

const db = loadDB();

function saveDB() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

if (!db.admins || !db.admins.length) {
  db.admins = [SEED_ADMIN];
  saveDB();
}

// Backfill for data.json files created before mobile money payments existed.
if (!db.payments) {
  db.payments = [];
  saveDB();
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const payload = verifyJWT(auth.slice(7));
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = payload;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── Voucher code generator ────────────────────────────────────────────────────
// Avoids ambiguous characters (0/O, 1/I) and formats as XXXX-XXXX-XXXX.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateVoucherCode() {
  let code;
  do {
    const groups = [];
    for (let g = 0; g < 3; g++) {
      let group = '';
      for (let i = 0; i < 4; i++) {
        group += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      }
      groups.push(group);
    }
    code = groups.join('-');
  } while (db.vouchers.some(v => v.code === code));
  return code;
}

// Order reference for ClickPesa payments — alphanumeric only per their validation rules.
function generateOrderReference() {
  return `WVP${Date.now()}${crypto.randomInt(1000, 9999)}`;
}

// Creates the voucher + transaction for a payment that has been confirmed as
// paid (via status poll or webhook). Safe to call more than once — a payment
// only ever gets one voucher.
function activateVoucherForPayment(payment) {
  if (payment.voucherCode) {
    return db.vouchers.find(v => v.code === payment.voucherCode);
  }
  const plan = db.plans.find(p => p.id === payment.planId);
  if (!plan) throw new Error('Plan for this payment no longer exists');

  const voucher = {
    code: generateVoucherCode(),
    planId: plan.id,
    status: 'unused',
    createdAt: new Date().toISOString(),
    activatedAt: null,
    expiresAt: null,
  };
  db.vouchers.push(voucher);

  const transaction = {
    id: `txn_${Date.now()}_${crypto.randomInt(1e6)}`,
    voucherCode: voucher.code,
    amount: plan.price,
    method: 'clickpesa',
    orderReference: payment.orderReference,
    paidAt: new Date().toISOString(),
  };
  db.transactions.push(transaction);

  payment.voucherCode = voucher.code;
  payment.status = 'completed';
  payment.updatedAt = new Date().toISOString();

  saveDB();
  return voucher;
}

// ════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════

// POST /api/auth/login  (admin only)
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const admin = db.admins.find(a => a.username === username);
  if (!admin || admin.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = signJWT({ id: admin.id, role: admin.role, name: admin.name });
  res.json({ token, user: { id: admin.id, name: admin.name, username: admin.username, role: admin.role } });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, role: req.user.role });
});

// ════════════════════════════════════════════════════════════════════════════
// PLAN ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/plans  (public)
app.get('/api/plans', (req, res) => {
  res.json(db.plans);
});

// POST /api/admin/plans  (admin: create a plan)
app.post('/api/admin/plans', requireAuth, requireAdmin, (req, res) => {
  const { name, price, durationHours, speedMbps, description } = req.body;
  if (!name || !price || !durationHours) {
    return res.status(400).json({ error: 'name, price, and durationHours are required' });
  }
  const plan = {
    id: db.plans.length ? Math.max(...db.plans.map(p => p.id)) + 1 : 1,
    name,
    price: Number(price),
    durationHours: Number(durationHours),
    speedMbps: Number(speedMbps) || 5,
    description: description || '',
  };
  db.plans.push(plan);
  saveDB();
  res.status(201).json(plan);
});

// PATCH /api/admin/plans/:id  (admin: edit a plan)
app.patch('/api/admin/plans/:id', requireAuth, requireAdmin, (req, res) => {
  const plan = db.plans.find(p => p.id === Number(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const editable = ['name', 'price', 'durationHours', 'speedMbps', 'description'];
  for (const key of editable) {
    if (req.body[key] !== undefined) plan[key] = req.body[key];
  }
  saveDB();
  res.json(plan);
});

// DELETE /api/admin/plans/:id
app.delete('/api/admin/plans/:id', requireAuth, requireAdmin, (req, res) => {
  const idx = db.plans.findIndex(p => p.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Plan not found' });
  db.plans.splice(idx, 1);
  saveDB();
  res.json({ deleted: true });
});

// ════════════════════════════════════════════════════════════════════════════
// VOUCHER ROUTES
// ════════════════════════════════════════════════════════════════════════════

// POST /api/vouchers  (public: "buy" a plan → generates a voucher + transaction)
app.post('/api/vouchers', (req, res) => {
  const { planId } = req.body;
  const plan = db.plans.find(p => p.id === Number(planId));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const voucher = {
    code: generateVoucherCode(),
    planId: plan.id,
    status: 'unused',          // unused → active → expired
    createdAt: new Date().toISOString(),
    activatedAt: null,
    expiresAt: null,
  };
  db.vouchers.push(voucher);

  const transaction = {
    id: `txn_${Date.now()}_${crypto.randomInt(1e6)}`,
    voucherCode: voucher.code,
    amount: plan.price,
    paidAt: new Date().toISOString(),
  };
  db.transactions.push(transaction);
  saveDB();

  res.status(201).json({ voucher, plan, transaction });
});

// GET /api/vouchers/:code  (public: check status)
app.get('/api/vouchers/:code', (req, res) => {
  const voucher = db.vouchers.find(v => v.code === req.params.code.toUpperCase());
  if (!voucher) return res.status(404).json({ error: 'Voucher not found' });

  // Lazily flip to expired if past expiry
  if (voucher.status === 'active' && voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
    voucher.status = 'expired';
    saveDB();
  }

  const plan = db.plans.find(p => p.id === voucher.planId);
  res.json({ voucher, plan });
});

// POST /api/vouchers/:code/redeem  (public: activate an unused voucher)
app.post('/api/vouchers/:code/redeem', (req, res) => {
  const voucher = db.vouchers.find(v => v.code === req.params.code.toUpperCase());
  if (!voucher) return res.status(404).json({ error: 'Voucher not found' });
  if (voucher.status !== 'unused') {
    return res.status(409).json({ error: `Voucher is already ${voucher.status}` });
  }
  const plan = db.plans.find(p => p.id === voucher.planId);
  if (!plan) return res.status(500).json({ error: 'Plan for this voucher no longer exists' });

  const now = new Date();
  voucher.status = 'active';
  voucher.activatedAt = now.toISOString();
  voucher.expiresAt = new Date(now.getTime() + plan.durationHours * 60 * 60 * 1000).toISOString();
  saveDB();

  res.json({ voucher, plan });
});

// ════════════════════════════════════════════════════════════════════════════
// PAYMENT ROUTES (ClickPesa mobile money — M-Pesa, Tigo Pesa/Mixx, Airtel Money, HaloPesa)
// Docs: https://docs.clickpesa.com/payment-api/mobile-money-payment-api/mobile-money-payment-api-overview
// ════════════════════════════════════════════════════════════════════════════

const PHONE_RE = /^255\d{9}$/;

// POST /api/payments/mobile-money  (public: start a USSD push payment for a plan)
app.post('/api/payments/mobile-money', async (req, res) => {
  const { planId, phoneNumber } = req.body;
  const plan = db.plans.find(p => p.id === Number(planId));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (!phoneNumber || !PHONE_RE.test(phoneNumber)) {
    return res.status(400).json({ error: 'phoneNumber must be in the format 255XXXXXXXXX' });
  }

  const orderReference = generateOrderReference();
  const payment = {
    orderReference,
    planId: plan.id,
    phoneNumber,
    amount: plan.price,
    status: 'PROCESSING',   // PROCESSING → completed | FAILED
    clickpesaId: null,
    voucherCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    const result = await clickpesa.initiateUssdPush({
      amount: plan.price,
      orderReference,
      phoneNumber,
    });
    payment.clickpesaId = result.id || null;
    db.payments.push(payment);
    saveDB();
    res.status(201).json({
      orderReference,
      status: payment.status,
      message: 'Check your phone and enter your mobile money PIN to approve the payment.',
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/payments/:orderReference/status  (public: poll for completion)
// Falls back to querying ClickPesa directly in case the webhook hasn't arrived yet.
app.get('/api/payments/:orderReference/status', async (req, res) => {
  const payment = db.payments.find(p => p.orderReference === req.params.orderReference);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  if (payment.status === 'PROCESSING') {
    try {
      const remote = await clickpesa.queryPaymentStatus(payment.orderReference);
      if (remote) {
        if (['SUCCESS', 'SETTLED'].includes(remote.status)) {
          activateVoucherForPayment(payment);
        } else if (remote.status === 'FAILED') {
          payment.status = 'FAILED';
          payment.updatedAt = new Date().toISOString();
          saveDB();
        }
      }
    } catch (err) {
      // Swallow — the client will just poll again. Log for visibility.
      console.error('ClickPesa status check failed:', err.message);
    }
  }

  const voucher = payment.voucherCode ? db.vouchers.find(v => v.code === payment.voucherCode) : null;
  const plan = db.plans.find(p => p.id === payment.planId);
  res.json({ payment, voucher, plan });
});

// POST /api/webhooks/clickpesa  (ClickPesa → us: PAYMENT RECEIVED / PAYMENT FAILED)
// Configure this URL in the ClickPesa Merchant Dashboard → Settings → Developers
// → your application → Application Webhooks. Must be HTTPS in production.
app.post('/api/webhooks/clickpesa', (req, res) => {
  const { event, data, checksum } = req.body || {};
  if (!data || !data.orderReference) return res.status(400).json({ error: 'Missing data.orderReference' });

  if (!clickpesa.verifyWebhookChecksum(data, checksum)) {
    return res.status(401).json({ error: 'Invalid checksum' });
  }

  const payment = db.payments.find(p => p.orderReference === data.orderReference);
  // Always 2xx quickly, even if we don't recognise the reference — ClickPesa
  // just wants acknowledgement of receipt, not confirmation we acted on it.
  if (!payment) return res.status(200).json({ received: true });

  if (event === 'PAYMENT RECEIVED' && data.status === 'SUCCESS') {
    try {
      activateVoucherForPayment(payment);
    } catch (err) {
      console.error('Failed to activate voucher from webhook:', err.message);
    }
  } else if (event === 'PAYMENT FAILED') {
    payment.status = 'FAILED';
    payment.updatedAt = new Date().toISOString();
    saveDB();
  }

  res.status(200).json({ received: true });
});

// GET /api/admin/payments  (admin: list all mobile money payment attempts)
app.get('/api/admin/payments', requireAuth, requireAdmin, (req, res) => {
  res.json(db.payments);
});

// GET /api/admin/vouchers  (admin: list all vouchers)
app.get('/api/admin/vouchers', requireAuth, requireAdmin, (req, res) => {
  res.json(db.vouchers);
});

// GET /api/admin/transactions  (admin: list all transactions)
app.get('/api/admin/transactions', requireAuth, requireAdmin, (req, res) => {
  res.json(db.transactions);
});

// POST /api/admin/reset-demo-data
app.post('/api/admin/reset-demo-data', requireAuth, requireAdmin, (req, res) => {
  db.plans = JSON.parse(JSON.stringify(SEED_PLANS));
  db.vouchers = [];
  db.transactions = [];
  db.payments = [];
  saveDB();
  res.json({ reset: true, plans: db.plans.length });
});

// ── Static frontend ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── ROUTE: /api/health ────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'WiFi Voucher Backend',
    port: PORT,
    plans: db.plans.length,
    vouchers: db.vouchers.length,
  });
});

app.listen(PORT, () => {
  console.log('\nWiFi Voucher Backend');
  console.log(`   App       -> http://localhost:${PORT}`);
  console.log(`   Health    -> http://localhost:${PORT}/api/health`);
  console.log(`   Plans     -> GET /api/plans   POST/PATCH/DELETE /api/admin/plans`);
  console.log(`   Vouchers  -> POST /api/vouchers   GET /api/vouchers/:code   POST /api/vouchers/:code/redeem`);
  console.log(`   Payments  -> POST /api/payments/mobile-money   GET /api/payments/:orderReference/status   POST /api/webhooks/clickpesa`);
  console.log(`   Admin     -> GET /api/admin/vouchers   GET /api/admin/transactions   GET /api/admin/payments   POST /api/admin/reset-demo-data`);
  console.log(`               (login username: admin / password: admin123)`);
  console.log(`   Data file -> ${DATA_FILE}\n`);
});
