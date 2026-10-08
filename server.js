// server.js - PayHero STK + Admin Auto-Push (MongoDB version, crash-proof)
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Credentials ----
const PAYHERO_BASIC_AUTH_TOKEN = process.env.PAYHERO_BASIC_AUTH_TOKEN?.trim();
const PAYHERO_CHANNEL_ID = parseInt(process.env.PAYHERO_CHANNEL_ID, 10);
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'admin123').trim();
const RENDER_URL = (process.env.RENDER_URL || 'https://payhero-stk-app.onrender.com').replace(/\/+$/, '');
const MONGODB_URI = process.env.MONGODB_URI;

const PAYHERO_BASE_URL = 'https://backend.payhero.co.ke/api/v2';
const PAYHERO_ENDPOINT = 'payments';

app.use(express.json());

// ---- Static files ----
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const ADMIN_FILE = path.join(PUBLIC_DIR, 'admin.html');

app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  if (fs.existsSync(INDEX_FILE)) return res.sendFile(INDEX_FILE);
  return res.status(500).send('index.html not found');
});

app.get('/admin', (req, res) => {
  if (fs.existsSync(ADMIN_FILE)) return res.sendFile(ADMIN_FILE);
  return res.status(500).send('admin.html not found');
});

// ---- Startup diagnostic ----
console.log('=============================================');
console.log('🚀 PAYHERO STK + AUTO-PUSH (MongoDB)');
console.log('=============================================');
console.log('Token loaded :', PAYHERO_BASIC_AUTH_TOKEN ? '✅ YES' : '❌ NO');
console.log('Channel ID   :', PAYHERO_CHANNEL_ID || '❌ MISSING');
console.log('Admin pass   :', ADMIN_PASSWORD ? '✅ set' : '❌ missing');
console.log('Mongo URI    :', MONGODB_URI ? '✅ set' : '❌ MISSING');
console.log('Callback URL :', `${RENDER_URL}/api/payhero/callback`);
console.log('=============================================');

// =========================================================
// MONGOOSE MODELS
// =========================================================

// ---- Settings ----
// NOTE: We deliberately use collection name "app_settings" (not "settings")
// so any old broken indexes on the legacy "settings" collection are ignored.
const SettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  autoEnabled: { type: Boolean, default: false },
  intervalSeconds: { type: Number, default: 30 },
  cycleDelaySeconds: { type: Number, default: 60 },
  defaultAmount: { type: Number, default: 1 },
  defaultReference: { type: String, default: 'AUTO-STK' },
  repeat: { type: Boolean, default: true },
}, { timestamps: true, _id: false });

const Settings = mongoose.model('Settings', SettingsSchema, 'app_settings');

// ---- Saved Numbers ----
const SavedNumberSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  amount: { type: Number, default: null },
  reference: { type: String, default: '' },
  active: { type: Boolean, default: true },
  sendCount: { type: Number, default: 0 },
  lastSentAt: { type: Date, default: null },
  lastStatus: { type: String, default: null },
  lastReason: { type: String, default: null },
}, { timestamps: true });

SavedNumberSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => { ret.id = ret._id.toString(); delete ret._id; return ret; },
});

const SavedNumber = mongoose.model('SavedNumber', SavedNumberSchema);

// =========================================================
// IN-MEMORY CACHE
// =========================================================
let settings = {
  autoEnabled: false,
  intervalSeconds: 30,
  cycleDelaySeconds: 60,
  defaultAmount: 1,
  defaultReference: 'AUTO-STK',
  repeat: true,
};

let numbers = [];
const transactions = [];

// =========================================================
// AUTO-CLEAN stale indexes on the "app_settings" collection
// =========================================================
async function cleanStaleIndexes() {
  try {
    const collection = Settings.collection;
    const indexes = await collection.indexes();
    for (const idx of indexes) {
      const name = idx.name;
      if (name && name !== '_id_') {
        try {
          await collection.dropIndex(name);
          console.log(`🧹 Dropped stale index on app_settings: ${name}`);
        } catch (e) {
          // ignore
        }
      }
    }
  } catch (e) {
    // Collection doesn't exist yet — that's fine
  }
}

async function loadSettingsFromDB() {
  await cleanStaleIndexes();

  let doc = await Settings.findById('global');
  if (!doc) {
    doc = new Settings({ _id: 'global' });
    await doc.save();
  }

  settings = {
    autoEnabled: doc.autoEnabled,
    intervalSeconds: doc.intervalSeconds,
    cycleDelaySeconds: doc.cycleDelaySeconds,
    defaultAmount: doc.defaultAmount,
    defaultReference: doc.defaultReference,
    repeat: doc.repeat,
  };
  return settings;
}

async function saveSettingsToDB() {
  await Settings.findByIdAndUpdate(
    'global',
    { ...settings, _id: 'global' },
    { upsert: true, new: true }
  );
}

async function loadNumbersFromDB() {
  const docs = await SavedNumber.find().sort({ createdAt: 1 }).lean();
  numbers = docs.map(d => ({ ...d, id: d._id.toString() }));
  return numbers;
}

// =========================================================
// HELPERS
// =========================================================
function normalizePhone(input) {
  let p = String(input || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  else if (p.startsWith('254')) p = p;
  return p;
}

function makeRef(userRef) {
  const base = (userRef && String(userRef).trim()) || 'INV';
  return `${base}-${Date.now().toString(36)}${Math.floor(Math.random() * 100).toString(36)}`;
}

function findTransaction(ref, checkoutId) {
  if (checkoutId) {
    const byCheckout = transactions.find((t) => t.checkout_request_id === checkoutId);
    if (byCheckout) return byCheckout;
  }
  if (ref) return transactions.find((t) => t.reference === ref);
  return null;
}

function recordTransaction(entry) {
  const now = new Date().toISOString();
  transactions.unshift({ ...entry, createdAt: now, updatedAt: now });
  if (transactions.length > 300) transactions.pop();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =========================================================
// PAYHERO REQUEST
// =========================================================
async function payheroPost(payload) {
  if (!PAYHERO_BASIC_AUTH_TOKEN || !PAYHERO_CHANNEL_ID) {
    throw new Error('Token or Channel ID missing in .env');
  }
  const url = `${PAYHERO_BASE_URL}/${PAYHERO_ENDPOINT}`;
  const authHeader = PAYHERO_BASIC_AUTH_TOKEN.startsWith('Basic ')
    ? PAYHERO_BASIC_AUTH_TOKEN
    : `Basic ${PAYHERO_BASIC_AUTH_TOKEN}`;

  const response = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    timeout: 30000,
    validateStatus: () => true,
  });
  return { httpStatus: response.status, data: response.data };
}

// =========================================================
// CORE STK SENDER
// =========================================================
async function sendStk({ phone, amount, reference, source = 'manual', numberId = null }) {
  const msisdn = normalizePhone(phone);
  const externalRef = makeRef(reference);

  const payload = {
    amount: Number(amount),
    phone_number: msisdn,
    channel_id: PAYHERO_CHANNEL_ID,
    provider: 'm-pesa',
    external_reference: externalRef,
    callback_url: `${RENDER_URL}/api/payhero/callback`,
  };

  let httpStatus = 0;
  let data = {};

  try {
    const r = await payheroPost(payload);
    httpStatus = r.httpStatus;
    data = r.data;
    console.log('📥 PayHero API Raw Response:', JSON.stringify(data, null, 2));
  } catch (err) {
    const reason = err.message;
    recordTransaction({
      type: 'STK', phone: msisdn, amount: Number(amount), status: 'error',
      reason, reference: externalRef, source, numberId, raw: reason,
    });
    return { status: false, reason, reference: externalRef, data: null };
  }

  const ok =
    httpStatus >= 200 && httpStatus < 300 &&
    (data?.success === true || data?.status === true);

  const reason = ok ? null : (
    data?.message || data?.error || data?.detail ||
    (typeof data === 'string' ? data : JSON.stringify(data)) ||
    'Request failed'
  );

  recordTransaction({
    type: 'STK', phone: msisdn, amount: Number(amount),
    status: ok ? 'pending' : 'failed', reason,
    reference: externalRef,
    checkout_request_id: data?.CheckoutRequestID || data?.checkout_request_id || null,
    source, numberId, raw: data,
  });

  return { status: ok, reason, reference: externalRef, data };
}

// =========================================================
// AUTO-SCHEDULER
// =========================================================
const scheduler = {
  running: false,
  roundCount: 0,
  nextRunAt: null,
  currentIndex: 0,
  generation: 0,
  timer: null,
};

function startScheduler() {
  if (scheduler.running) return;
  scheduler.generation++;
  scheduler.running = true;
  scheduler.roundCount = 0;
  scheduler.currentIndex = 0;
  scheduler.nextRunAt = null;
  console.log('▶️ Auto-scheduler STARTED');
  runRound(scheduler.generation);
}

function stopScheduler() {
  scheduler.generation++;
  if (scheduler.timer) {
    clearTimeout(scheduler.timer);
    scheduler.timer = null;
  }
  scheduler.running = false;
  scheduler.nextRunAt = null;
  scheduler.currentIndex = 0;
  console.log('⏹ Auto-scheduler STOPPED');
}

async function runRound(gen) {
  if (gen !== scheduler.generation || !settings.autoEnabled) return;

  await loadNumbersFromDB();
  const active = numbers.filter((n) => n.active);

  if (active.length === 0) {
    console.log(`ℹ no active numbers — waiting ${settings.cycleDelaySeconds}s`);
    scheduler.nextRunAt = new Date(Date.now() + settings.cycleDelaySeconds * 1000).toISOString();
    scheduler.timer = setTimeout(() => runRound(gen), settings.cycleDelaySeconds * 1000);
    return;
  }

  console.log(`🔁 Round starting — ${active.length} active number(s)`);

  for (let i = 0; i < active.length; i++) {
    if (gen !== scheduler.generation || !settings.autoEnabled) return;

    const num = active[i];
    scheduler.currentIndex = i;

    const amount = num.amount || settings.defaultAmount || 1;
    const reference = num.reference || settings.defaultReference || 'AUTO-STK';

    try {
      const result = await sendStk({
        phone: num.phone, amount, reference,
        source: 'auto', numberId: num.id,
      });

      await SavedNumber.findByIdAndUpdate(num.id, {
        $inc: { sendCount: 1 },
        $set: {
          lastSentAt: new Date(),
          lastStatus: result.status ? 'pending' : 'failed',
          lastReason: result.status ? null : result.reason,
        },
      });

      const idx = numbers.findIndex((n) => n.id === num.id);
      if (idx >= 0) {
        numbers[idx].sendCount = (numbers[idx].sendCount || 0) + 1;
        numbers[idx].lastSentAt = new Date().toISOString();
        numbers[idx].lastStatus = result.status ? 'pending' : 'failed';
        numbers[idx].lastReason = result.status ? null : result.reason;
      }

      console.log(`   → ${num.phone}: ${result.status ? '✅ sent' : '❌ ' + result.reason}`);
    } catch (err) {
      console.error('   → auto send failed:', err.message);
    }

    if (i < active.length - 1) {
      scheduler.nextRunAt = new Date(Date.now() + settings.intervalSeconds * 1000).toISOString();
      await sleep(settings.intervalSeconds * 1000);
      if (gen !== scheduler.generation || !settings.autoEnabled) return;
    }
  }

  scheduler.roundCount++;
  scheduler.currentIndex = 0;
  console.log(`✅ Round complete (total rounds: ${scheduler.roundCount})`);

  if (!settings.repeat) {
    settings.autoEnabled = false;
    await saveSettingsToDB();
    stopScheduler();
    console.log('ℹ repeat=false → auto disabled after single round');
    return;
  }

  scheduler.nextRunAt = new Date(Date.now() + settings.cycleDelaySeconds * 1000).toISOString();
  await sleep(settings.cycleDelaySeconds * 1000);
  if (gen !== scheduler.generation || !settings.autoEnabled) return;
  runRound(gen);
}

// =========================================================
// PUBLIC: STK
// =========================================================
app.post('/api/stk', async (req, res) => {
  const { amount, phone, reference } = req.body || {};
  if (!amount || !phone) {
    return res.status(400).json({ status: false, message: 'amount and phone are required' });
  }

  const result = await sendStk({ phone, amount, reference, source: 'manual' });

  if (result.status) return res.json({ status: true, data: result.data });
  return res.status(502).json({
    status: false,
    message: result.reason,
    data: result.data || { message: result.reason },
  });
});

app.get('/api/transactions', (_req, res) => {
  res.json({ status: true, data: transactions });
});

// =========================================================
// PAYHERO CALLBACK
// =========================================================
app.post('/api/payhero/callback', async (req, res) => {
  console.log('📬 Callback:', JSON.stringify(req.body, null, 2));

  const details = req.body?.response || req.body || {};
  const phone = details.Phone || details.phone || details.phone_number || details.MSISDN || null;
  const amount = details.Amount || details.amount || null;
  const reference = details.User_Reference || details.external_reference || details.Transaction_Reference || null;
  const checkoutId = details.CheckoutRequestID || details.checkout_request_id || null;

  const resultCode = details.ResultCode !== undefined ? details.ResultCode : details.result_code;
  const resultDesc = details.ResultDesc || details.result_desc || 'Transaction failed';

  let status = 'failed';
  let reason = resultDesc;

  if (resultCode === 0 || resultCode === '0') { status = 'success'; reason = 'Payment successful'; }
  else if (resultCode === 1032) reason = 'Request cancelled by user';
  else if (resultCode === 1037) reason = 'Request timed out';
  else if (resultCode === 1) reason = 'Insufficient funds';

  const tx = findTransaction(reference, checkoutId);

  if (tx) {
    Object.assign(tx, {
      status, reason,
      phone: phone || tx.phone,
      amount: amount || tx.amount,
      raw: req.body,
      updatedAt: new Date().toISOString(),
    });

    if (tx.numberId) {
      try {
        await SavedNumber.findByIdAndUpdate(tx.numberId, {
          $set: {
            lastStatus: status,
            lastReason: status === 'success' ? null : reason,
          },
        });
        const idx = numbers.findIndex(n => n.id === tx.numberId);
        if (idx >= 0) {
          numbers[idx].lastStatus = status;
          numbers[idx].lastReason = status === 'success' ? null : reason;
        }
      } catch (e) { console.error('callback number update failed:', e.message); }
    }
  } else {
    recordTransaction({
      type: 'CALLBACK', phone, amount, status, reason, reference,
      checkout_request_id: checkoutId, raw: req.body,
    });
  }

  res.status(200).json({ status: 'received' });
});

// =========================================================
// ADMIN AUTH
// =========================================================
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!ADMIN_PASSWORD || key !== ADMIN_PASSWORD) {
    return res.status(401).json({ status: false, message: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/status', requireAdmin, async (_req, res) => {
  try {
    await loadNumbersFromDB();
    res.json({
      status: true,
      data: {
        settings,
        scheduler: {
          running: scheduler.running,
          roundCount: scheduler.roundCount,
          nextRunAt: scheduler.nextRunAt,
          currentIndex: scheduler.currentIndex,
        },
        numbers,
      },
    });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// =========================================================
// ADMIN: NUMBERS CRUD
// =========================================================
app.get('/api/admin/numbers', requireAdmin, async (_req, res) => {
  try {
    await loadNumbersFromDB();
    res.json({ status: true, data: numbers });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

app.post('/api/admin/numbers', requireAdmin, async (req, res) => {
  try {
    const { phone, amount, reference } = req.body || {};
    const msisdn = normalizePhone(phone);

    if (!msisdn || msisdn.length < 12) {
      return res.status(400).json({ status: false, message: 'Invalid phone number' });
    }

    const exists = await SavedNumber.findOne({ phone: msisdn });
    if (exists) {
      return res.status(400).json({ status: false, message: 'Number already saved' });
    }

    const doc = await SavedNumber.create({
      phone: msisdn,
      amount: amount ? Number(amount) : null,
      reference: reference ? String(reference).trim() : '',
      active: true,
    });

    await loadNumbersFromDB();
    res.json({ status: true, data: doc.toJSON() });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

app.put('/api/admin/numbers/:id', requireAdmin, async (req, res) => {
  try {
    const { amount, reference, phone } = req.body || {};
    const update = {};
    if (amount !== undefined) update.amount = amount ? Number(amount) : null;
    if (reference !== undefined) update.reference = String(reference || '').trim();
    if (phone) update.phone = normalizePhone(phone);

    const doc = await SavedNumber.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!doc) return res.status(404).json({ status: false, message: 'Not found' });

    await loadNumbersFromDB();
    res.json({ status: true, data: doc.toJSON() });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

app.delete('/api/admin/numbers/:id', requireAdmin, async (req, res) => {
  try {
    const doc = await SavedNumber.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ status: false, message: 'Not found' });
    await loadNumbersFromDB();
    res.json({ status: true });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

app.patch('/api/admin/numbers/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const doc = await SavedNumber.findById(req.params.id);
    if (!doc) return res.status(404).json({ status: false, message: 'Not found' });

    doc.active = !doc.active;
    await doc.save();

    await loadNumbersFromDB();
    res.json({ status: true, data: doc.toJSON() });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

app.patch('/api/admin/numbers/bulk', requireAdmin, async (req, res) => {
  try {
    const { active } = req.body || {};
    await SavedNumber.updateMany({}, { $set: { active: !!active } });
    await loadNumbersFromDB();
    res.json({ status: true, data: numbers });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

app.post('/api/admin/numbers/:id/send', requireAdmin, async (req, res) => {
  try {
    const doc = await SavedNumber.findById(req.params.id);
    if (!doc) return res.status(404).json({ status: false, message: 'Not found' });

    const amount = doc.amount || settings.defaultAmount || 1;
    const reference = doc.reference || settings.defaultReference || 'AUTO-STK';

    const result = await sendStk({
      phone: doc.phone, amount, reference,
      source: 'manual', numberId: doc.id,
    });

    doc.sendCount = (doc.sendCount || 0) + 1;
    doc.lastSentAt = new Date();
    doc.lastStatus = result.status ? 'pending' : 'failed';
    doc.lastReason = result.status ? null : result.reason;
    await doc.save();

    await loadNumbersFromDB();
    res.json({ status: result.status, reason: result.reason, data: result.data });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// =========================================================
// ADMIN: SETTINGS
// =========================================================
app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const prevAuto = !!settings.autoEnabled;

    if (body.intervalSeconds !== undefined) {
      settings.intervalSeconds = Math.max(2, parseInt(body.intervalSeconds, 10) || 30);
    }
    if (body.cycleDelaySeconds !== undefined) {
      settings.cycleDelaySeconds = Math.max(5, parseInt(body.cycleDelaySeconds, 10) || 60);
    }
    if (body.defaultAmount !== undefined) {
      settings.defaultAmount = Math.max(1, Number(body.defaultAmount) || 1);
    }
    if (body.defaultReference !== undefined) {
      settings.defaultReference = String(body.defaultReference || '').trim() || 'AUTO-STK';
    }
    if (body.repeat !== undefined) settings.repeat = !!body.repeat;
    if (body.autoEnabled !== undefined) settings.autoEnabled = !!body.autoEnabled;

    await saveSettingsToDB();

    if (settings.autoEnabled && !prevAuto) {
      startScheduler();
    } else if (!settings.autoEnabled && prevAuto) {
      stopScheduler();
    } else if (settings.autoEnabled && prevAuto) {
      stopScheduler();
      setTimeout(() => { if (settings.autoEnabled) startScheduler(); }, 50);
    }

    res.json({
      status: true,
      data: {
        settings,
        scheduler: {
          running: scheduler.running,
          roundCount: scheduler.roundCount,
          nextRunAt: scheduler.nextRunAt,
          currentIndex: scheduler.currentIndex,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// =========================================================
// CONNECT TO MONGO + START
// =========================================================
async function start() {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI missing in .env — cannot start');
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ MongoDB connected');

    await loadSettingsFromDB();
    await loadNumbersFromDB();
    console.log(`💾 Loaded ${numbers.length} saved numbers from MongoDB`);

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n✅ Server ready at ${RENDER_URL}`);
      console.log(`   Admin panel: ${RENDER_URL}/admin\n`);

      if (settings.autoEnabled) {
        console.log('⏩ Auto-push was enabled before restart — resuming…');
        setTimeout(() => startScheduler(), 1500);
      }
    });
  } catch (err) {
    console.error('❌ Startup failed:', err.message);
    process.exit(1);
  }
}

// Catch any unexpected errors so the app doesn't crash silently
process.on('unhandledRejection', (err) => {
  console.error('⚠ Unhandled rejection:', err?.message || err);
});

start();
