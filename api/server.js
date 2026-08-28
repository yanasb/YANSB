import 'dotenv/config';

import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import pg from 'pg';

const { Pool } = pg;

const app = express();

app.disable('x-powered-by');

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: 'cross-origin'
    }
  })
);

app.use(
  express.json({
    limit: '256kb',
    type: ['application/json', 'application/*+json']
  })
);

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const BASE_URL = String(
  process.env.BASE_URL || `http://localhost:${PORT}`
).replace(/\/$/, '');

const NOWPAYMENTS_API_KEY =
  String(process.env.NOWPAYMENTS_API_KEY || '').trim();

const NOWPAYMENTS_IPN_SECRET =
  String(process.env.NOWPAYMENTS_IPN_SECRET || '').trim();

const NOWPAYMENTS_IPN_CALLBACK_URL =
  String(
    process.env.NOWPAYMENTS_IPN_CALLBACK_URL ||
      `${BASE_URL}/api/deposits/ipn`
  ).trim();

const JWT_SECRET =
  String(process.env.JWT_SECRET || '').trim();

const DATABASE_URL =
  String(process.env.DATABASE_URL || '').trim();

const CORS_ORIGIN =
  String(process.env.CORS_ORIGIN || '').trim();

const NOWPAYMENTS_URL =
  'https://api.nowpayments.io';

/*
  IMPORTANT:

  We intentionally do NOT enable Permanent Deposit Addresses
  automatically.

  A normal NOWPayments pay_address must NOT be assumed to be
  permanent.

  The system will return a clear 503 until the account has
  the required NOWPayments permanent-address capability and
  this code is explicitly enabled after verification.
*/
const PERMANENT_ADDRESS_CAPABILITY_CONFIRMED = false;

/*
  NOWPayments currently documents permanent deposit addresses
  with restrictions. We therefore expose only currencies that
  have actually been approved for this account.

  Start with an empty list.

  After NOWPayments confirms the capability for your account,
  this constant can be changed in code to the exact supported
  currency returned/confirmed by NOWPayments.

  Do NOT add unsupported networks just because the frontend
  wants them.
*/
const APPROVED_PERMANENT_CURRENCIES = new Set([
  // Example after NOWPayments confirms it:
  // 'usdttrc20'
]);

const MIN_DEPOSIT_AMOUNT = 1;

/*
  Internal application statuses requested by the project.
*/
const STATUS = Object.freeze({
  WAITING: 'waiting',
  CONFIRMING: 'confirming',
  FINISHED: 'finished',
  FAILED: 'failed',
  EXPIRED: 'expired'
});

const PUBLIC_STATUSES = new Set([
  STATUS.WAITING,
  STATUS.CONFIRMING,
  STATUS.FINISHED,
  STATUS.FAILED,
  STATUS.EXPIRED
]);

const NOWPAYMENTS_TO_INTERNAL_STATUS = {
  waiting: STATUS.WAITING,
  confirming: STATUS.CONFIRMING,
  confirmed: STATUS.CONFIRMING,
  sending: STATUS.CONFIRMING,
  partially_paid: STATUS.CONFIRMING,
  finished: STATUS.FINISHED,
  failed: STATUS.FAILED,
  expired: STATUS.EXPIRED,
  refunded: STATUS.FAILED
};

/* =========================================================
   CORS
========================================================= */

if (CORS_ORIGIN) {
  app.use((req, res, next) => {
    const requestOrigin = req.get('Origin');

    if (
      requestOrigin &&
      requestOrigin === CORS_ORIGIN
    ) {
      res.setHeader(
        'Access-Control-Allow-Origin',
        CORS_ORIGIN
      );
    }

    res.setHeader('Vary', 'Origin');

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type'
    );

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, OPTIONS'
    );

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  });
}

/* =========================================================
   DATABASE
========================================================= */

if (!DATABASE_URL) {
  console.error(
    'DATABASE_URL is not configured.'
  );
}

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,

  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,

  max: 10,

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000
});

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {
  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required for production.'
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance NUMERIC(30, 8) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  /*
    Authentication columns.

    Added with ALTER TABLE ... ADD COLUMN IF NOT EXISTS so this
    is safe to run against a database that was already created
    by an earlier version of this project (deposits-only).
  */

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS username TEXT,
      ADD COLUMN IF NOT EXISTS password_hash TEXT,
      ADD COLUMN IF NOT EXISTS email TEXT;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username
    ON users(username)
    WHERE username IS NOT NULL;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email
    ON users(email)
    WHERE email IS NOT NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposit_addresses (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      network TEXT NOT NULL,
      currency TEXT NOT NULL,
      address TEXT NOT NULL,
      provider_payment_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT uq_deposit_address
        UNIQUE(address),

      CONSTRAINT uq_user_network
        UNIQUE(user_id, network),

      CONSTRAINT fk_deposit_address_user
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id UUID PRIMARY KEY,

      order_id TEXT NOT NULL UNIQUE,

      user_id TEXT NOT NULL,

      network TEXT NOT NULL,

      currency TEXT NOT NULL,

      requested_amount NUMERIC(30, 8) NOT NULL,

      status TEXT NOT NULL,

      payment_id TEXT UNIQUE,

      pay_address TEXT,

      tx_hash TEXT UNIQUE,

      paid_amount NUMERIC(30, 8),

      credited_amount NUMERIC(30, 8)
        NOT NULL DEFAULT 0,

      raw_json JSONB,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      CONSTRAINT fk_deposit_user
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

      CONSTRAINT chk_deposit_status
        CHECK(
          status IN (
            'waiting',
            'confirming',
            'finished',
            'failed',
            'expired'
          )
        ),

      CONSTRAINT chk_requested_amount
        CHECK(requested_amount > 0),

      CONSTRAINT chk_credited_amount
        CHECK(credited_amount >= 0)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id UUID PRIMARY KEY,

      user_id TEXT NOT NULL,

      deposit_id UUID NOT NULL UNIQUE,

      payment_id TEXT UNIQUE,

      tx_hash TEXT UNIQUE,

      type TEXT NOT NULL,

      amount NUMERIC(30, 8) NOT NULL,

      network TEXT NOT NULL,

      currency TEXT NOT NULL,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      CONSTRAINT fk_transaction_user
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

      CONSTRAINT fk_transaction_deposit
        FOREIGN KEY(deposit_id)
        REFERENCES deposits(id)
        ON DELETE RESTRICT
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_deposits_user_created
    ON deposits(user_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_deposits_payment
    ON deposits(payment_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_deposits_status
    ON deposits(status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_deposits_address
    ON deposits(pay_address);
  `);

  console.log('PostgreSQL database initialized.');
}

/* =========================================================
   HELPERS
========================================================= */

function normalizeCurrency(value) {
  const currency =
    String(value || '')
      .trim()
      .toLowerCase();

  if (!currency) {
    throw new Error(
      'Currency/network is required.'
    );
  }

  if (
    !APPROVED_PERMANENT_CURRENCIES.has(currency)
  ) {
    throw new Error(
      `The ${currency} network is not enabled for Permanent Deposit Addresses on this account.`
    );
  }

  return currency;
}

function networkFor(currency) {
  const map = {
    usdttrc20: 'TRC20',
    usdtbsc: 'BEP20',
    usdt: 'ERC20',
    usdtsol: 'SOLANA'
  };

  return map[currency] || currency.toUpperCase();
}

function roundMoney(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Math.round(n * 1e8) / 1e8;
}

function getPaymentId(payload) {
  if (
    payload?.payment_id !== undefined &&
    payload?.payment_id !== null
  ) {
    return String(payload.payment_id);
  }

  return null;
}

function getTxHash(payload) {
  const value =
    payload?.payin_hash ??
    payload?.tx_hash ??
    payload?.hash ??
    payload?.transaction_hash ??
    null;

  return value ? String(value) : null;
}

function getPayAddress(payload) {
  return payload?.pay_address
    ? String(payload.pay_address)
    : null;
}

function getActualPaid(payload) {
  const candidates = [
    payload?.actually_paid,
    payload?.outcome_amount,
    payload?.pay_amount
  ];

  for (const value of candidates) {
    const number = Number(value);

    if (
      Number.isFinite(number) &&
      number > 0
    ) {
      return number;
    }
  }

  return 0;
}

function normalizeStatus(paymentStatus) {
  const raw =
    String(paymentStatus || '')
      .trim()
      .toLowerCase();

  return (
    NOWPAYMENTS_TO_INTERNAL_STATUS[raw] ||
    null
  );
}

function isFinalNowPaymentsStatus(value) {
  return (
    String(value || '').toLowerCase() ===
    'finished'
  );
}

function makeOrderId(userId, depositId) {
  return `PT-${String(userId)}-${String(depositId)}`.slice(
    0,
    100
  );
}

/* =========================================================
   AUTHENTICATION
========================================================= */

function authenticate(req) {
  const header =
    req.get('authorization') || '';

  if (!header.startsWith('Bearer ')) {
    throw new Error(
      'Authentication required.'
    );
  }

  if (!JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is not configured.'
    );
  }

  const token =
    header.slice('Bearer '.length).trim();

  if (!token) {
    throw new Error(
      'Authentication token is missing.'
    );
  }

  try {
    const payload = jwt.verify(
      token,
      JWT_SECRET
    );

    const userId =
      payload?.userId ??
      payload?.sub;

    if (!userId) {
      throw new Error(
        'JWT does not contain a user id.'
      );
    }

    return String(userId);
  } catch {
    throw new Error(
      'Invalid authentication token.'
    );
  }
}

async function ensureUser(client, userId) {
  await client.query(
    `
      INSERT INTO users(id)
      VALUES($1)
      ON CONFLICT(id) DO NOTHING
    `,
    [userId]
  );
}

/* =========================================================
   AUTH: REGISTER / LOGIN
========================================================= */

const JWT_EXPIRES_IN = '30d';

const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

function normalizeUsername(value) {
  const username =
    String(value || '')
      .trim()
      .toLowerCase();

  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      'Username must be 3-32 characters and contain only lowercase letters, numbers, and underscores.'
    );
  }

  return username;
}

function normalizeEmail(value) {
  const email =
    String(value || '')
      .trim()
      .toLowerCase();

  if (!email) {
    return null;
  }

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      email
    )
  ) {
    throw new Error(
      'Invalid email address.'
    );
  }

  return email;
}

function validatePassword(value) {
  const password =
    String(value || '');

  if (password.length < 8) {
    throw new Error(
      'Password must be at least 8 characters.'
    );
  }

  if (password.length > 200) {
    throw new Error(
      'Password is too long.'
    );
  }

  return password;
}

function issueToken(userId) {
  if (!JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is not configured.'
    );
  }

  return jwt.sign(
    {
      userId,
      sub: userId
    },
    JWT_SECRET,
    {
      expiresIn:
        JWT_EXPIRES_IN
    }
  );
}

app.post(
  '/api/auth/register',
  async (req, res) => {
    try {
      const username =
        normalizeUsername(
          req.body?.username
        );

      const email =
        normalizeEmail(
          req.body?.email
        );

      const password =
        validatePassword(
          req.body?.password
        );

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const userId =
        crypto.randomUUID();

      try {
        await pool.query(
          `
            INSERT INTO users(
              id,
              username,
              password_hash,
              email
            )
            VALUES(
              $1,
              $2,
              $3,
              $4
            )
          `,
          [
            userId,
            username,
            passwordHash,
            email
          ]
        );
      } catch (error) {
        if (
          error.code ===
          '23505'
        ) {
          return res
            .status(409)
            .json({
              error:
                'Username or email is already registered.'
            });
        }

        throw error;
      }

      const token =
        issueToken(userId);

      res.status(201).json({
        token,
        user: {
          id: userId,
          username,
          email,
          balance: 0
        }
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

app.post(
  '/api/auth/login',
  async (req, res) => {
    try {
      const username =
        normalizeUsername(
          req.body?.username
        );

      const password =
        String(
          req.body?.password || ''
        );

      if (!password) {
        throw new Error(
          'Password is required.'
        );
      }

      const result =
        await pool.query(
          `
            SELECT
              id,
              username,
              email,
              balance,
              password_hash
            FROM users
            WHERE username = $1
            LIMIT 1
          `,
          [username]
        );

      const row =
        result.rows[0];

      const passwordMatches =
        row?.password_hash
          ? await bcrypt.compare(
              password,
              row.password_hash
            )
          : false;

      if (
        !row ||
        !passwordMatches
      ) {
        return res
          .status(401)
          .json({
            error:
              'Invalid username or password.'
          });
      }

      const token =
        issueToken(row.id);

      res.json({
        token,
        user: {
          id: row.id,
          username:
            row.username,
          email: row.email,
          balance:
            row.balance
        }
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

app.get(
  '/api/auth/me',
  async (req, res) => {
    try {
      const userId =
        authenticate(req);

      const result =
        await pool.query(
          `
            SELECT
              id,
              username,
              email,
              balance
            FROM users
            WHERE id = $1
            LIMIT 1
          `,
          [userId]
        );

      if (!result.rows[0]) {
        return res
          .status(404)
          .json({
            error:
              'User not found.'
          });
      }

      res.json(
        result.rows[0]
      );
    } catch (error) {
      res.status(401).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   IPN SIGNATURE
========================================================= */

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortObject(
          value[key]
        );

        return result;
      }, {});
  }

  return value;
}

function verifyIpnSignature(
  body,
  signature
) {
  if (
    !NOWPAYMENTS_IPN_SECRET ||
    !signature
  ) {
    return false;
  }

  const normalized =
    JSON.stringify(
      sortObject(body)
    );

  const expected =
    crypto
      .createHmac(
        'sha512',
        NOWPAYMENTS_IPN_SECRET
      )
      .update(normalized)
      .digest('hex');

  const expectedBuffer =
    Buffer.from(expected, 'utf8');

  const suppliedBuffer =
    Buffer.from(
      String(signature),
      'utf8'
    );

  if (
    expectedBuffer.length !==
    suppliedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    suppliedBuffer
  );
}

/* =========================================================
   NOWPAYMENTS CLIENT
========================================================= */

async function nowPaymentsRequest(
  path,
  options = {}
) {
  if (!NOWPAYMENTS_API_KEY) {
    throw new Error(
      'NOWPAYMENTS_API_KEY is not configured.'
    );
  }

  const response =
    await fetch(
      `${NOWPAYMENTS_URL}${path}`,
      {
        ...options,

        headers: {
          'x-api-key':
            NOWPAYMENTS_API_KEY,

          'Content-Type':
            'application/json',

          ...(options.headers || {})
        }
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    throw new Error(
      `NOWPayments ${response.status}: ${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}

/* =========================================================
   PUBLIC HEALTH
========================================================= */

app.get(
  '/api/health',
  async (_req, res) => {
    let databaseOk = false;

    try {
      await pool.query(
        'SELECT 1'
      );

      databaseOk = true;
    } catch {
      databaseOk = false;
    }

    const configured =
      Boolean(
        NOWPAYMENTS_API_KEY &&
        NOWPAYMENTS_IPN_SECRET &&
        NOWPAYMENTS_IPN_CALLBACK_URL &&
        JWT_SECRET &&
        DATABASE_URL
      );

    res.json({
      ok:
        configured &&
        databaseOk,

      database:
        databaseOk
          ? 'ok'
          : 'error',

      nowpayments:
        NOWPAYMENTS_API_KEY
          ? 'configured'
          : 'missing',

      ipn:
        NOWPAYMENTS_IPN_SECRET
          ? 'configured'
          : 'missing',

      permanentDepositAddresses:
        PERMANENT_ADDRESS_CAPABILITY_CONFIRMED
          ? 'enabled'
          : 'disabled',

      supportedNetworks:
        Array.from(
          APPROVED_PERMANENT_CURRENCIES
        ).map(networkFor)
    });
  }
);

/* =========================================================
   GET SUPPORTED DEPOSIT NETWORKS
========================================================= */

app.get(
  '/api/deposits/networks',
  async (_req, res) => {
    res.json(
      Array.from(
        APPROVED_PERMANENT_CURRENCIES
      ).map(currency => ({
        currency,
        network:
          networkFor(currency)
      }))
    );
  }
);

/* =========================================================
   BALANCE
========================================================= */

app.get(
  '/api/me/balance',
  async (req, res) => {
    try {
      const userId =
        authenticate(req);

      const client =
        await pool.connect();

      try {
        await ensureUser(
          client,
          userId
        );

        const result =
          await client.query(
            `
              SELECT
                id,
                balance
              FROM users
              WHERE id = $1
            `,
            [userId]
          );

        res.json(
          result.rows[0]
        );
      } finally {
        client.release();
      }
    } catch (error) {
      res.status(401).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   PERMANENT ADDRESS
========================================================= */

async function getPermanentAddress(
  userId,
  currency
) {
  /*
    This is intentionally blocked until NOWPayments confirms
    that Permanent Deposit Addresses are enabled for the
    merchant account.

    We do NOT create a normal one-time pay address and falsely
    call it permanent.
  */

  if (
    !PERMANENT_ADDRESS_CAPABILITY_CONFIRMED
  ) {
    const error =
      new Error(
        'Permanent Deposit Addresses are not enabled/confirmed for this NOWPayments account. Please contact NOWPayments and enable the permanent-address capability before creating a user deposit address.'
      );

    error.code =
      'PERMANENT_ADDRESS_DISABLED';

    throw error;
  }

  if (
    !APPROVED_PERMANENT_CURRENCIES.has(
      currency
    )
  ) {
    const error =
      new Error(
        `The ${currency} network is not approved for Permanent Deposit Addresses on this account.`
      );

    error.code =
      'NETWORK_NOT_SUPPORTED';

    throw error;
  }

  const client =
    await pool.connect();

  try {
    await ensureUser(
      client,
      userId
    );

    const existing =
      await client.query(
        `
          SELECT
            user_id,
            network,
            currency,
            address,
            created_at
          FROM deposit_addresses
          WHERE user_id = $1
            AND network = $2
          LIMIT 1
        `,
        [
          userId,
          networkFor(currency)
        ]
      );

    if (existing.rows[0]) {
      return {
        ...existing.rows[0],
        permanent: true
      };
    }

    /*
      IMPORTANT:

      We do not fabricate an address.

      NOWPayments' permanent-address flow requires account
      capability/partner support. Once that is explicitly
      confirmed, this block can be connected to the exact
      NOWPayments-supported payment allocation flow for the
      enabled network.
    */

    const error =
      new Error(
        'Permanent Deposit Address allocation is unavailable until NOWPayments confirms the feature for this account.'
      );

    error.code =
      'PERMANENT_ADDRESS_ALLOCATION_UNAVAILABLE';

    throw error;
  } finally {
    client.release();
  }
}

app.get(
  '/api/me/deposit-address',
  async (req, res) => {
    try {
      const userId =
        authenticate(req);

      const currency =
        normalizeCurrency(
          req.query.currency
        );

      const address =
        await getPermanentAddress(
          userId,
          currency
        );

      res.json(address);
    } catch (error) {
      const status =
        error.code ===
          'PERMANENT_ADDRESS_DISABLED'
          ? 503
          : 400;

      res.status(status).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   QR
========================================================= */

app.get(
  '/api/me/deposit-qr',
  async (req, res) => {
    try {
      const userId =
        authenticate(req);

      const currency =
        normalizeCurrency(
          req.query.currency
        );

      const network =
        networkFor(currency);

      const result =
        await pool.query(
          `
            SELECT
              address
            FROM deposit_addresses
            WHERE user_id = $1
              AND network = $2
            LIMIT 1
          `,
          [
            userId,
            network
          ]
        );

      if (!result.rows[0]) {
        return res
          .status(404)
          .json({
            error:
              'No permanent deposit address exists for this user/network.'
          });
      }

      const address =
        result.rows[0].address;

      const qr =
        await QRCode.toDataURL(
          address,
          {
            errorCorrectionLevel:
              'M',
            margin: 2,
            width: 320
          }
        );

      res.json({
        currency,
        network,
        address,
        qr
      });
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   CREATE DEPOSIT
========================================================= */

async function createDeposit(
  userId,
  amount,
  currency
) {
  if (
    !Number.isFinite(amount) ||
    amount < MIN_DEPOSIT_AMOUNT
  ) {
    throw new Error(
      `Minimum deposit amount is ${MIN_DEPOSIT_AMOUNT}.`
    );
  }

  const network =
    networkFor(currency);

  const client =
    await pool.connect();

  try {
    await client.query(
      'BEGIN'
    );

    await ensureUser(
      client,
      userId
    );

    const addressResult =
      await client.query(
        `
          SELECT
            address
          FROM deposit_addresses
          WHERE user_id = $1
            AND network = $2
          LIMIT 1
        `,
        [
          userId,
          network
        ]
      );

    if (
      !addressResult.rows[0]
    ) {
      throw new Error(
        'No permanent deposit address exists for this user/network.'
      );
    }

    const depositId =
      crypto.randomUUID();

    const orderId =
      `PT-${userId}-${depositId}`.slice(
        0,
        100
      );

    const requestedAmount =
      roundMoney(amount);

    await client.query(
      `
        INSERT INTO deposits(
          id,
          order_id,
          user_id,
          network,
          currency,
          requested_amount,
          status,
          pay_address
        )
        VALUES(
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8
        )
      `,
      [
        depositId,
        orderId,
        userId,
        network,
        currency,
        requestedAmount,
        STATUS.WAITING,
        addressResult.rows[0]
          .address
      ]
    );

    await client.query(
      'COMMIT'
    );

    return {
      id: depositId,
      order_id: orderId,
      user_id: userId,
      network,
      currency,
      requested_amount:
        requestedAmount,
      status:
        STATUS.WAITING,
      pay_address:
        addressResult.rows[0]
          .address
    };
  } catch (error) {
    await client.query(
      'ROLLBACK'
    );

    throw error;
  } finally {
    client.release();
  }
}

/*
  Required endpoint:
  POST /api/deposits/create
*/

app.post(
  '/api/deposits/create',
  async (req, res) => {
    try {
      const userId =
        authenticate(req);

      const amount =
        Number(
          req.body?.amount
        );

      const currency =
        normalizeCurrency(
          req.body?.currency
        );

      const deposit =
        await createDeposit(
          userId,
          amount,
          currency
        );

      res.status(201).json(
        deposit
      );
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/*
  Backward-compatible endpoint.
*/

app.post(
  '/api/me/deposits',
  async (req, res) => {
    try {
      const userId =
        authenticate(req);

      const amount =
        Number(
          req.body?.amount
        );

      const currency =
        normalizeCurrency(
          req.body?.currency
        );

      const deposit =
        await createDeposit(
          userId,
          amount,
          currency
        );

      res.status(201).json(
        deposit
      );
    } catch (error) {
      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   GET SINGLE DEPOSIT
========================================================= */

async function getDepositForUser(
  userId,
  depositId
) {
  const result =
    await pool.query(
      `
        SELECT
          id,
          order_id,
          user_id,
          network,
          currency,
          requested_amount,
          status,
          payment_id,
          pay_address,
          tx_hash,
          paid_amount,
          credited_amount,
          created_at,
          updated_at
        FROM deposits
        WHERE id = $1
          AND user_id = $2
        LIMIT 1
      `,
      [
        depositId,
        userId
      ]
    );

  return result.rows[0] || null;
}

app.get(
  '/api/deposits/:id',
  async (req, res) => {
    try {
      const userId =
        authenticate(req);

      const row =
        await getDepositForUser(
          userId,
          req.params.id
        );

      if (!row) {
        return res
          .status(404)
          .json({
            error:
              'Deposit not found.'
          });
      }

      res.json(row);
    } catch (error) {
      res.status(401).json({
        error:
          error.message
      });
    }
  }
);

/*
  Backward-compatible endpoint.
*/

app.get(
  '/api/me/deposits/:id',
  async (req, res) => {
    try {
      const userId =
        authenticate(req);

      const row =
        await getDepositForUser(
          userId,
          req.params.id
        );

      if (!row) {
        return res
          .status(404)
          .json({
            error:
              'Deposit not found.'
          });
      }

      res.json(row);
    } catch (error) {
      res.status(401).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   LIST DEPOSITS
========================================================= */

async function listDeposits(
  userId
) {
  const result =
    await pool.query(
      `
        SELECT
          id,
          order_id,
          user_id,
          amount,
          network,
          currency,
          pay_address,
          created_at,
          status,
          tx_hash,
          payment_id,
          requested_amount,
          paid_amount,
          credited_amount,
          updated_at
        FROM (
          SELECT
            id,
            order_id,
            user_id,
            requested_amount AS amount,
            network,
            currency,
            pay_address,
            created_at,
            status,
            tx_hash,
            payment_id,
            requested_amount,
            paid_amount,
            credited_amount,
            updated_at
          FROM deposits
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 100
        ) d
      `,
      [userId]
    );

  return result.rows;
}

app.get(
  '/api/deposits',
  async (req, res) => {
    try {
      const userId =
        authenticate(req);

      const rows =
        await listDeposits(
          userId
        );

      res.json(rows);
    } catch (error) {
      res.status(401).json({
        error:
          error.message
      });
    }
  }
);

/*
  Backward-compatible endpoint.
*/

app.get(
  '/api/me/deposits',
  async (req, res) => {
    try {
      const userId =
        authenticate(req);

      const rows =
        await listDeposits(
          userId
        );

      res.json(rows);
    } catch (error) {
      res.status(401).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   IPN
========================================================= */

async function processIpn(
  ipnPayload
) {
  const ipnPaymentId =
    getPaymentId(ipnPayload);

  if (!ipnPaymentId) {
    throw new Error(
      'IPN payment_id is missing.'
    );
  }

  /*
    CRITICAL:

    We never act on the raw IPN body alone.

    After signature verification, we re-fetch the payment
    directly from the NOWPayments API using the payment ID
    and use ONLY that verified response for all further
    decisions (status, amounts, currency, network, address,
    tx hash).

    The original IPN body is kept purely for audit purposes
    inside raw_json.
  */

  let verifiedPayment;

  try {
    verifiedPayment =
      await nowPaymentsRequest(
        `/v1/payment/${encodeURIComponent(ipnPaymentId)}`
      );
  } catch (error) {
    throw new Error(
      `Unable to verify payment with NOWPayments API: ${error.message}`
    );
  }

  const verifiedPaymentId =
    getPaymentId(verifiedPayment);

  if (
    !verifiedPaymentId ||
    verifiedPaymentId !== ipnPaymentId
  ) {
    throw new Error(
      'NOWPayments payment verification failed: payment ID mismatch.'
    );
  }

  /*
    From this point on, `payload` refers to the VERIFIED
    NOWPayments API response, not the incoming IPN body.
  */

  const payload = verifiedPayment;

  const auditPayload = {
    ipn: ipnPayload,
    verified: verifiedPayment
  };

  const paymentId = verifiedPaymentId;

  const txHash =
    getTxHash(payload);

  const payAddress =
    getPayAddress(payload);

  const rawStatus =
    String(
      payload?.payment_status || ''
    )
      .trim()
      .toLowerCase();

  const internalStatus =
    normalizeStatus(
      rawStatus
    );

  if (!internalStatus) {
    throw new Error(
      `Unsupported NOWPayments status: ${rawStatus}`
    );
  }

  /*
    First find by payment ID.
  */

  const existingByPayment =
    await pool.query(
      `
        SELECT *
        FROM deposits
        WHERE payment_id = $1
        LIMIT 1
      `,
      [paymentId]
    );

  let deposit =
    existingByPayment.rows[0] ||
    null;

  /*
    If payment_id was not previously attached, use the
    destination address only to locate a known user address.

    We never create a new user or a fake address here.
  */

  if (!deposit && payAddress) {
    const addressResult =
      await pool.query(
        `
          SELECT
            user_id,
            network,
            currency,
            address
          FROM deposit_addresses
          WHERE address = $1
          LIMIT 1
        `,
        [payAddress]
      );

    if (
      addressResult.rows[0]
    ) {
      const address =
        addressResult.rows[0];

      const matchingDeposit =
        await pool.query(
          `
            SELECT *
            FROM deposits
            WHERE user_id = $1
              AND pay_address = $2
              AND status IN(
                'waiting',
                'confirming'
              )
            ORDER BY created_at DESC
            LIMIT 1
          `,
          [
            address.user_id,
            payAddress
          ]
        );

      deposit =
        matchingDeposit.rows[0] ||
        null;
    }
  }

  /*
    Unknown payment is ignored safely.

    We DO NOT create a balance transaction just because an IPN
    arrived.
  */

  if (!deposit) {
    return {
      ok: true,
      ignored: true,
      reason:
        'No matching deposit request.'
    };
  }

  const payloadCurrency =
    String(
      payload?.pay_currency ||
        payload?.currency ||
        deposit.currency
    ).toLowerCase();

  const payloadNetwork =
    networkFor(
      payloadCurrency
    );

  /*
    Currency verification.
  */

  if (
    payloadCurrency !==
    String(
      deposit.currency
    ).toLowerCase()
  ) {
    await pool.query(
      `
        UPDATE deposits
        SET
          status = 'failed',
          raw_json = $1::jsonb,
          updated_at = NOW()
        WHERE id = $2
      `,
      [
        JSON.stringify({
          ...auditPayload,
          rejection:
            'currency_mismatch'
        }),
        deposit.id
      ]
    );

    throw new Error(
      'Payment currency mismatch.'
    );
  }

  /*
    Network verification.
  */

  if (
    payloadNetwork !==
    deposit.network
  ) {
    await pool.query(
      `
        UPDATE deposits
        SET
          status = 'failed',
          raw_json = $1::jsonb,
          updated_at = NOW()
        WHERE id = $2
      `,
      [
        JSON.stringify({
          ...auditPayload,
          rejection:
            'network_mismatch'
        }),
        deposit.id
      ]
    );

    throw new Error(
      'Payment network mismatch.'
    );
  }

  /*
    Destination address verification.
  */

  if (
    payAddress &&
    payAddress !==
      deposit.pay_address
  ) {
    await pool.query(
      `
        UPDATE deposits
        SET
          status = 'failed',
          raw_json = $1::jsonb,
          updated_at = NOW()
        WHERE id = $2
      `,
      [
        JSON.stringify({
          ...auditPayload,
          rejection:
            'address_mismatch'
        }),
        deposit.id
      ]
    );

    throw new Error(
      'Payment destination address mismatch.'
    );
  }

  const actualPaid =
    getActualPaid(
      payload
    );

  const client =
    await pool.connect();

  try {
    await client.query(
      'BEGIN'
    );

    /*
      Lock the deposit row.

      This is critical for idempotency.
    */

    const lockedResult =
      await client.query(
        `
          SELECT *
          FROM deposits
          WHERE id = $1
          FOR UPDATE
        `,
        [deposit.id]
      );

    const locked =
      lockedResult.rows[0];

    if (!locked) {
      throw new Error(
        'Deposit no longer exists.'
      );
    }

    /*
      Payment ID must not belong to another deposit.
    */

    const paymentOwner =
      await client.query(
        `
          SELECT id
          FROM deposits
          WHERE payment_id = $1
            AND id <> $2
          LIMIT 1
        `,
        [
          paymentId,
          locked.id
        ]
      );

    if (
      paymentOwner.rows.length
    ) {
      throw new Error(
        'Payment ID is already linked to another deposit.'
      );
    }

    /*
      Transaction hash must not belong to another transaction.
    */

    if (txHash) {
      const txOwner =
        await client.query(
          `
            SELECT id
            FROM transactions
            WHERE tx_hash = $1
              AND deposit_id <> $2
            LIMIT 1
          `,
          [
            txHash,
            locked.id
          ]
        );

      if (
        txOwner.rows.length
      ) {
        throw new Error(
          'Transaction hash is already credited to another deposit.'
        );
      }
    }

    /*
      Attach NOWPayments payment ID if this is the first IPN.
    */

    if (
      !locked.payment_id
    ) {
      await client.query(
        `
          UPDATE deposits
          SET
            payment_id = $1,
            updated_at = NOW()
          WHERE id = $2
        `,
        [
          paymentId,
          locked.id
        ]
      );
    } else if (
      String(
        locked.payment_id
      ) !== paymentId
    ) {
      throw new Error(
        'Payment ID does not match the existing deposit.'
      );
    }

    /*
      Check already credited.

      If the same IPN arrives again, nothing is credited.
    */

    if (
      Number(
        locked.credited_amount
      ) > 0 ||
      locked.status ===
        STATUS.FINISHED
    ) {
      await client.query(
        `
          UPDATE deposits
          SET
            status = 'finished',
            tx_hash = COALESCE($1, tx_hash),
            paid_amount =
              CASE
                WHEN $2 > 0
                THEN $2
                ELSE paid_amount
              END,
            raw_json = $3::jsonb,
            updated_at = NOW()
          WHERE id = $4
        `,
        [
          txHash,
          actualPaid,
          JSON.stringify(auditPayload),
          locked.id
        ]
      );

      await client.query(
        'COMMIT'
      );

      return {
        ok: true,
        credited: false,
        duplicate: true
      };
    }

    /*
      Non-final statuses NEVER add balance.
    */

    if (
      !isFinalNowPaymentsStatus(
        rawStatus
      )
    ) {
      await client.query(
        `
          UPDATE deposits
          SET
            status = $1,
            tx_hash = COALESCE($2, tx_hash),
            paid_amount =
              CASE
                WHEN $3 > 0
                THEN $3
                ELSE paid_amount
              END,
            raw_json = $4::jsonb,
            updated_at = NOW()
          WHERE id = $5
        `,
        [
          internalStatus,
          txHash,
          actualPaid,
          JSON.stringify(auditPayload),
          locked.id
        ]
      );

      await client.query(
        'COMMIT'
      );

      return {
        ok: true,
        credited: false,
        status:
          internalStatus
      };
    }

    /*
      FINISHED requires a positive processor-reported amount.
    */

    if (
      !Number.isFinite(
        actualPaid
      ) ||
      actualPaid <= 0
    ) {
      throw new Error(
        'Finished payment has no valid actually_paid amount.'
      );
    }

    /*
      Important:
      The requested amount from the frontend is NEVER used
      to credit the balance.

      Only the verified processor-reported amount is used.
    */

    const credit =
      roundMoney(
        actualPaid
      );

    if (
      credit <= 0
    ) {
      throw new Error(
        'Credit amount is invalid.'
      );
    }

    /*
      Update deposit first.
    */

    const updateResult =
      await client.query(
        `
          UPDATE deposits
          SET
            status = 'finished',
            payment_id = $1,
            tx_hash = $2,
            paid_amount = $3,
            credited_amount = $4,
            raw_json = $5::jsonb,
            updated_at = NOW()
          WHERE id = $6
            AND credited_amount = 0
        `,
        [
          paymentId,
          txHash,
          credit,
          credit,
          JSON.stringify(auditPayload),
          locked.id
        ]
      );

    /*
      If no row was updated, another concurrent IPN already
      credited this deposit.
    */

    if (
      updateResult.rowCount !== 1
    ) {
      await client.query(
        'ROLLBACK'
      );

      return {
        ok: true,
        credited: false,
        duplicate: true
      };
    }

    /*
      Add balance inside SAME database transaction.
    */

    const balanceResult =
      await client.query(
        `
          UPDATE users
          SET
            balance =
              balance + $1
          WHERE id = $2
        `,
        [
          credit,
          locked.user_id
        ]
      );

    if (
      balanceResult.rowCount !== 1
    ) {
      throw new Error(
        'User balance could not be updated.'
      );
    }

    /*
      Record transaction.

      Unique deposit_id + payment_id + tx_hash prevent duplicate
      financial transaction records.
    */

    await client.query(
      `
        INSERT INTO transactions(
          id,
          user_id,
          deposit_id,
          payment_id,
          tx_hash,
          type,
          amount,
          network,
          currency
        )
        VALUES(
          $1,
          $2,
          $3,
          $4,
          $5,
          'deposit',
          $6,
          $7,
          $8
        )
      `,
      [
        crypto.randomUUID(),
        locked.user_id,
        locked.id,
        paymentId,
        txHash,
        credit,
        locked.network,
        locked.currency
      ]
    );

    await client.query(
      'COMMIT'
    );

    return {
      ok: true,
      credited: true,
      amount: credit,
      status:
        STATUS.FINISHED
    };
  } catch (error) {
    try {
      await client.query(
        'ROLLBACK'
      );
    } catch {}

    throw error;
  } finally {
    client.release();
  }
}

/* =========================================================
   REQUIRED IPN ENDPOINT
========================================================= */

app.post(
  '/api/deposits/ipn',
  async (req, res) => {
    const signature =
      req.get(
        'x-nowpayments-sig'
      );

    if (
      !verifyIpnSignature(
        req.body,
        signature
      )
    ) {
      return res
        .status(401)
        .json({
          error:
            'Invalid IPN signature.'
        });
    }

    try {
      const result =
        await processIpn(
          req.body
        );

      res.json(result);
    } catch (error) {
      console.error(
        'NOWPayments IPN error:',
        error
      );

      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/*
  Backward-compatible IPN URL.
*/

app.post(
  '/api/webhooks/nowpayments',
  async (req, res) => {
    const signature =
      req.get(
        'x-nowpayments-sig'
      );

    if (
      !verifyIpnSignature(
        req.body,
        signature
      )
    ) {
      return res
        .status(401)
        .json({
          error:
            'Invalid IPN signature.'
        });
    }

    try {
      const result =
        await processIpn(
          req.body
        );

      res.json(result);
    } catch (error) {
      console.error(
        'NOWPayments legacy IPN error:',
        error
      );

      res.status(400).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
      'Unhandled server error:',
      error
    );

    if (
      res.headersSent
    ) {
      return;
    }

    res.status(500).json({
      error:
        'Internal server error.'
    });
  }
);

/* =========================================================
   START
========================================================= */

async function start() {
  try {
    await initializeDatabase();

    app.listen(
      PORT,
      () => {
        console.log(
          `Palm Deposit API listening on port ${PORT}`
        );

        console.log(
          `BASE_URL: ${BASE_URL}`
        );

        console.log(
          `Permanent Deposit Addresses confirmed: ${PERMANENT_ADDRESS_CAPABILITY_CONFIRMED}`
        );
      }
    );
  } catch (error) {
    console.error(
      'Startup failed:',
      error
    );

    process.exit(1);
  }
}

start();
