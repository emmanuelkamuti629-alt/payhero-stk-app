// server.js - PayHero STK + Admin Auto-Push Scheduler (with enhanced error logging)
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Credentials ----
const PAYHERO_BASIC_AUTH_TOKEN = process.env.PAYHERO_BASIC_AUTH_TOKEN?.trim();
const PAYHERO_CHANNEL_ID = parseInt(process.env.PAYHERO_CHANNEL_ID, 10);
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'admin123').trim();
const RENDER_URL = process.env.RENDER_URL || 'https://payhero-stk-app.onrender.com';

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
console.log('🚀 PAYHERO STK + AUTO-PUSH SERVER');
console.log('=============================================');
console.log('Token loaded :', PAYHERO_BASIC_AUTH_TOKEN ? '✅ YES' : '❌ NO');
console.log('Channel ID   :', PAYHERO_CHANNEL_ID || '❌ MISSING');
console.log('Admin pass   :', ADMIN_PASSWORD ? '✅ set' : '❌ missing');
console.log('Callback URL :', `${RENDER_URL}/api/payhero/callback`);
console.log('=============================================');

// =========================================================
// PERSISTENT STORE (numbers + settings)
// =========================================================
const DATA_FILE = path.join(__dirname, 'data.json');

let settings = {
  autoEnabled: false,
  intervalSeconds: 30,       // gap between each number
  cycleDelaySeconds: 60,     // wait after one full round before repeating
  defaultAmount: 1,
  defaultReference: 'AUTO-STK',
  repeat: true,
};

let numbers = []; // saved numbers
const transactions = []; // in-memory transaction log

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw.settings && typeof raw.settings === 'object') {
        settings = { ...settings, ...raw.settings };
      }
      if (Array.isArray(raw.numbers)) numbers = raw.numbers;
      console.log(`💾 Loaded ${numbers.length} saved numbers from data.json`);
    }
  } catch (e) {
    console.error('⚠ loadData failed:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ settings, numbers }, null, 2));
  } catch (e) {
    console.error('⚠ saveData failed:', e.message);
  }
}

loadData();

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
    
    // 🔍 DEBUG: Log the exact PayHero response to your server console
    console.log('📥 PayHero API Raw Response:', JSON.stringify(data, null, 2));
    
  } catch (err) {
    const reason = err.message;
    recordTransaction({
      type: 'STK',
      phone: msisdn,
      amount: Number(amount),
      status: 'error',
      reason,
      reference: externalRef,
      source,
      numberId,
      raw: reason,
    });
    return { status: false, reason, reference: externalRef, data: null };
  }

  const ok =
    httpStatus >= 200 &&
    httpStatus < 300 &&
    (data?.success === true || data?.status === true);

  // 🔍 IMPROVED ERROR PARSING: Look for 'detail', then fallback to stringifying the whole object
  const reason = ok ? null : (
    data?.message || 
    data?.error || 
    data?.detail || 
    (typeof data === 'string' ? data : JSON.stringify(data)) || 
    'Request failed'
  );

  recordTransaction({
    type: 'STK',
    phone: msisdn,
    amount: Number(amount),
    status: ok ? 'pending' : 'failed',
    reason,
    reference: externalRef,
    checkout_request_id: data?.CheckoutRequestID || data?.checkout_request_id || null,
    source,
    numberId,
    raw: data,
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

  const active = numbers.filter((n) => n.active);

  if (active.length === 0) {
    console.log('ℹ no active numbers — waiting %ds before re-check', settings.cycleDelaySeconds);
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
        phone: num.phone,
        amount,
        reference,
        source: 'auto',
        numberId: num.id,
      });

      const idx = numbers.findIndex((n) => n.id === num.id);
      if (idx >= 0) {
        numbers[idx].sendCount = (numbers[idx].sendCount || 0) + 1;
        numbers[idx].lastSentAt = new Date().toISOString();
        numbers[idx].lastStatus = result.status ? 'pending' : 'failed';
        numbers[idx].lastReason = result.status ? null : result.reason;
        saveData();
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
    saveData();
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
// PUBLIC: STK (manual from index.html)
// =========================================================
app.post('/api/stk', async (req, res) => {
  const { amount, phone, reference } = req.body || {};
  if (!amount || !phone) {
    return res.status(400).json({ status: false, message: 'amount and phone are required' });
  }

  const result = await sendStk({ phone, amount, reference, source: 'manual' });

  if (result.status) {
    return res.json({ status: true, data: result.data });
  }
  return res.status(502).json({
    status: false,
    message: result.reason,
    data: result.data || { message: result.reason },
  });
});

// ---- Public: transactions list ----
app.get('/api/transactions', (_req, res) => {
  res.json({ status: true, data: transactions });
});

// =========================================================
// PAYHERO CALLBACK
// =========================================================
app.post('/api/payhero/callback', (req, res) => {
  console.log('📬 Callback:', JSON.stringify(req.body, null, 2));

  const details = req.body?.response || req.body || {};

  const phone =
    details.Phone || details.phone || details.phone_number || details.MSISDN || null;
  const amount = details.Amount || details.amount || null;
  const reference =
    details.User_Reference ||
    details.external_reference ||
    details.Transaction_Reference ||
    null;
  const checkoutId =
    details.CheckoutRequestID || details.checkout_request_id || null;

  const resultCode =
    details.ResultCode !== undefined ? details.ResultCode : details.result_code;
  const resultDesc = details.ResultDesc || details.result_desc || 'Transaction failed';

  let status = 'failed';
  let reason = resultDesc;

  if (resultCode === 0 || resultCode === '0') {
    status = 'success';
    reason = 'Payment successful';
  } else if (resultCode === 1032) reason = 'Request cancelled by user';
  else if (resultCode === 1037) reason = 'Request timed out';
  else if (resultCode === 1) reason = 'Insufficient funds';

  const tx = findTransaction(reference, checkoutId);

  if (tx) {
    Object.assign(tx, {
      status,
      reason,
      phone: phone || tx.phone,
      amount: amount || tx.amount,
      raw: req.body,
      updatedAt: new Date().toISOString(),
    });

    // Update the saved number's status if this was an auto-send
    if (tx.numberId) {
      const num = numbers.find((n) => n.id === tx.numberId);
      if (num) {
        num.lastStatus = status;
        num.lastReason = status === 'success' ? null : reason;
        saveData();
      }
    }
  } else {
    recordTransaction({
      type: 'CALLBACK',
      phone,
      amount,
      status,
      reason,
      reference,
      checkout_request_id: checkoutId,
      raw: req.body,
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

// ---- Status ----
app.get('/api/admin/status', requireAdmin, (_req, res) => {
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
});

// =========================================================
// ADMIN: NUMBERS CRUD
// =========================================================
app.get('/api/admin/numbers', requireAdmin, (_req, res) => {
  res.json({ status: true, data: numbers });
});

app.post('/api/admin/numbers', requireAdmin, (req, res) => {
  const { phone, amount, reference } = req.body || {};
  const msisdn = normalizePhone(phone);

  if (!msisdn || msisdn.length < 12) {
    return res.status(400).json({ status: false, message: 'Invalid phone number' });
  }
  if (numbers.some((n) => n.phone === msisdn)) {
    return res.status(400).json({ status: false, message: 'Number already saved' });
  }

  const num = {
    id: 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    phone: msisdn,
    amount: amount ? Number(amount) : null,
    reference: reference ? String(reference).trim() : '',
    active: true,
    sendCount: 0,
    lastSentAt: null,
    lastStatus: null,
    lastReason: null,
    createdAt: new Date().toISOString(),
  };

  numbers.push(num);
  saveData();
  res.json({ status: true, data: num });
});

app.put('/api/admin/numbers/:id', requireAdmin, (req, res) => {
  const num = numbers.find((n) => n.id === req.params.id);
  if (!num) return res.status(404).json({ status: false, message: 'Not found' });

  const { amount, reference, phone } = req.body || {};
  if (amount !== undefined) num.amount = amount ? Number(amount) : null;
  if (reference !== undefined) num.reference = String(reference || '').trim();
  if (phone) num.phone = normalizePhone(phone);

  saveData();
  res.json({ status: true, data: num });
});

app.delete('/api/admin/numbers/:id', requireAdmin, (req, res) => {
  const idx = numbers.findIndex((n) => n.id === req.params.id);
  if (idx < 0) return res.status(404).json({ status: false, message: 'Not found' });
  numbers.splice(idx, 1);
  saveData();
  res.json({ status: true });
});

// ---- Toggle one number active/inactive ----
app.patch('/api/admin/numbers/:id/toggle', requireAdmin, (req, res) => {
  const num = numbers.find((n) => n.id === req.params.id);
  if (!num) return res.status(404).json({ status: false, message: 'Not found' });
  num.active = !num.active;
  saveData();
  res.json({ status: true, data: num });
});

// ---- Bulk activate / deactivate ----
app.patch('/api/admin/numbers/bulk', requireAdmin, (req, res) => {
  const { active } = req.body || {};
  numbers.forEach((n) => { n.active = !!active; });
  saveData();
  res.json({ status: true, data: numbers });
});

// ---- Send STK to a single saved number right now ----
app.post('/api/admin/numbers/:id/send', requireAdmin, async (req, res) => {
  const num = numbers.find((n) => n.id === req.params.id);
  if (!num) return res.status(404).json({ status: false, message: 'Not found' });

  const amount = num.amount || settings.defaultAmount || 1;
  const reference = num.reference || settings.defaultReference || 'AUTO-STK';

  const result = await sendStk({
    phone: num.phone,
    amount,
    reference,
    source: 'manual',
    numberId: num.id,
  });

  num.sendCount = (num.sendCount || 0) + 1;
  num.lastSentAt = new Date().toISOString();
  num.lastStatus = result.status ? 'pending' : 'failed';
  num.lastReason = result.status ? null : result.reason;
  saveData();

  res.json({ status: result.status, reason: result.reason, data: result.data });
});

// =========================================================
// ADMIN: SETTINGS
// =========================================================
app.put('/api/admin/settings', requireAdmin, (req, res) => {
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

  saveData();

  // React to auto toggle changes
  if (settings.autoEnabled && !prevAuto) {
    startScheduler();
  } else if (!settings.autoEnabled && prevAuto) {
    stopScheduler();
  } else if (settings.autoEnabled && prevAuto) {
    // restart to apply new timing
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
});

// =========================================================
// START
// =========================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Server ready at ${RENDER_URL}`);
  console.log(`   Admin panel: ${RENDER_URL}/admin\n`);

  if (settings.autoEnabled) {
    console.log('⏩ Auto-push was enabled before restart — resuming…');
    setTimeout(() => startScheduler(), 1500);
  }
});
