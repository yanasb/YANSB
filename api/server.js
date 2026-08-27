import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const app = express();
app.use(helmet());
app.use(express.json({ limit: '256kb' }));

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const NP_URL = process.env.NOWPAYMENTS_API_URL || 'https://api.nowpayments.io';
const NP_KEY = process.env.NOWPAYMENTS_API_KEY || '';
const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || '';
const MODE = process.env.DEPOSIT_ADDRESS_MODE || 'permanent';
const DEFAULT_CURRENCY = process.env.DEFAULT_PAY_CURRENCY || 'usdttrc20';
const PRICE_CURRENCY = process.env.PRICE_CURRENCY || 'usd';

const db = new Database(process.env.DB_FILE || './deposits.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS deposit_addresses (
  user_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  address TEXT NOT NULL,
  payment_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, currency),
  UNIQUE(address)
);
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  payment_id TEXT,
  pay_address TEXT,
  tx_hash TEXT,
  credited_amount REAL NOT NULL DEFAULT 0,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_payment_id ON deposits(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_tx_hash ON deposits(tx_hash) WHERE tx_hash IS NOT NULL;
`);

function ensureUser(userId) {
  if (!userId) throw new Error('userId is required');
  db.prepare('INSERT OR IGNORE INTO users(id) VALUES (?)').run(String(userId));
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((o, k) => { o[k] = sortedObject(value[k]); return o; }, {});
  }
  return value;
}

function verifyIpn(body, signature) {
  if (!IPN_SECRET || !signature) return false;
  const payload = JSON.stringify(sortedObject(body));
  const expected = crypto.createHmac('sha512', IPN_SECRET).update(payload).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); } catch { return false; }
}

async function np(path, options = {}) {
  if (!NP_KEY) throw new Error('NOWPAYMENTS_API_KEY is not configured');
  const r = await fetch(`${NP_URL}${path}`, {
    ...options,
    headers: { 'x-api-key': NP_KEY, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`NOWPayments ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: MODE, configured: Boolean(NP_KEY && IPN_SECRET) }));

app.get('/api/users/:userId/balance', (req, res) => {
  ensureUser(req.params.userId);
  const row = db.prepare('SELECT id,balance FROM users WHERE id=?').get(req.params.userId);
  res.json(row);
});

app.get('/api/users/:userId/deposit-address', async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const currency = String(req.query.currency || DEFAULT_CURRENCY).toLowerCase();
    ensureUser(userId);
    const existing = db.prepare('SELECT * FROM deposit_addresses WHERE user_id=? AND currency=?').get(userId, currency);
    if (existing) return res.json({ ...existing, permanent: MODE === 'permanent' });

    // NOWPayments documents permanent deposit addresses as a partner/iGaming feature.
    // The documented workflow is to create a payment near the minimum, save its pay_address,
    // and associate it with the player. Your NOWPayments account must have that feature enabled.
    const payment = await np('/v1/payment', {
      method: 'POST',
      body: JSON.stringify({
        price_amount: 1,
        price_currency: PRICE_CURRENCY,
        pay_currency: currency,
        order_id: `user-${userId}-${crypto.randomUUID()}`,
        order_description: `Permanent deposit address for user ${userId}`,
        ipn_callback_url: `${BASE_URL}/api/webhooks/nowpayments`
      })
    });
    if (!payment.pay_address) throw new Error('NOWPayments did not return pay_address');
    db.prepare('INSERT INTO deposit_addresses(user_id,currency,address,payment_id) VALUES(?,?,?,?)')
      .run(userId, currency, payment.pay_address, String(payment.payment_id || ''));
    res.json({ user_id:userId, currency, address:payment.pay_address, payment_id:payment.payment_id, permanent:MODE==='permanent' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/deposits', async (req, res) => {
  try {
    const userId = String(req.body.userId || '');
    const amount = Number(req.body.amount);
    const currency = String(req.body.currency || DEFAULT_CURRENCY).toLowerCase();
    if (!userId || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error:'Invalid userId or amount' });
    ensureUser(userId);
    const address = db.prepare('SELECT * FROM deposit_addresses WHERE user_id=? AND currency=?').get(userId,currency);
    if (!address) return res.status(400).json({ error:'User has no deposit address. Create it first.' });
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO deposits(id,user_id,currency,amount,status,payment_id,pay_address) VALUES(?,?,?,?,?,?,?)`)
      .run(id,userId,currency,amount,'waiting',address.payment_id,address.address);
    res.json({ id,userId,currency,amount,status:'waiting',address:address.address,payment_id:address.payment_id });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/webhooks/nowpayments', (req,res) => {
  const signature = req.get('x-nowpayments-sig');
  if (!verifyIpn(req.body, signature)) return res.status(401).json({error:'Invalid IPN signature'});
  try {
    const p = req.body;
    const paymentId = p.payment_id ? String(p.payment_id) : null;
    const txHash = p.payin_hash || p.tx_hash || null;
    const payAddress = p.pay_address || null;
    const status = String(p.payment_status || '').toLowerCase();
    let deposit = paymentId ? db.prepare('SELECT * FROM deposits WHERE payment_id=? ORDER BY created_at DESC LIMIT 1').get(paymentId) : null;
    if (!deposit && payAddress) deposit = db.prepare('SELECT * FROM deposits WHERE pay_address=? ORDER BY created_at DESC LIMIT 1').get(payAddress);
    if (!deposit && payAddress) {
      const addr = db.prepare('SELECT * FROM deposit_addresses WHERE address=?').get(payAddress);
      if (addr) {
        const amount = Number(p.actually_paid || p.pay_amount || 0);
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO deposits(id,user_id,currency,amount,status,payment_id,pay_address,tx_hash,raw_json) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(id,addr.user_id,String(p.pay_currency || addr.currency),amount,status,paymentId,payAddress,txHash,JSON.stringify(p));
        deposit = db.prepare('SELECT * FROM deposits WHERE id=?').get(id);
      }
    }
    if (!deposit) return res.json({ok:true,ignored:true});

    const terminal = new Set(['finished','confirmed']);
    if (terminal.has(status) && deposit.credited_amount <= 0) {
      const amount = Number(p.actually_paid || p.outcome_amount || p.pay_amount || deposit.amount);
      const txAlready = txHash ? db.prepare('SELECT * FROM deposits WHERE tx_hash=? AND credited_amount>0 AND id<>?').get(txHash,deposit.id) : null;
      if (!txAlready && amount > 0) {
        const tx = db.transaction(() => {
          db.prepare(`UPDATE deposits SET status=?,tx_hash=?,credited_amount=?,raw_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(status,txHash,amount,JSON.stringify(p),deposit.id);
          db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amount,deposit.user_id);
        });
        tx();
      }
    } else {
      db.prepare(`UPDATE deposits SET status=?,tx_hash=COALESCE(?,tx_hash),raw_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(status,txHash,JSON.stringify(p),deposit.id);
    }
    res.json({ok:true});
  } catch(e) { console.error(e); res.status(500).json({error:e.message}); }
});

app.get('/api/users/:userId/deposits', (req,res) => {
  const rows = db.prepare('SELECT * FROM deposits WHERE user_id=? ORDER BY created_at DESC').all(req.params.userId);
  res.json(rows);
});

app.listen(PORT, () => console.log(`Deposit API listening on ${PORT}`));
