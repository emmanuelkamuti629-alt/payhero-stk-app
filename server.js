// server.js - FIXED FOR PAYHERO V2 (with Status & Reason)
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Load credentials ----
const PAYHERO_BASIC_AUTH_TOKEN = process.env.PAYHERO_BASIC_AUTH_TOKEN?.trim();
const PAYHERO_CHANNEL_ID = parseInt(process.env.PAYHERO_CHANNEL_ID, 10);

// CORRECT base url - endpoint is /payments
const PAYHERO_BASE_URL = 'https://backend.payhero.co.ke/api/v2';
const PAYHERO_ENDPOINT = 'payments';

app.use(express.json());

// ---- Static files ----
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

console.log('📂 Public dir:', PUBLIC_DIR);
console.log('📂 Public dir exists:', fs.existsSync(PUBLIC_DIR));
console.log('📂 index.html exists:', fs.existsSync(INDEX_FILE));

app.use(express.static(PUBLIC_DIR));

// ---- EXPLICIT ROOT ROUTE ----
app.get('/', (req, res) => {
  if (fs.existsSync(INDEX_FILE)) {
    return res.sendFile(INDEX_FILE);
  }
  return res.status(500).send(`
    <html>
      <body style="font-family:sans-serif;padding:40px;background:#FDF6E3;color:#1F2937;">
        <h2 style="color:#DC2626;">❌ public/index.html not found</h2>
        <p>Render looked for the file at:</p>
        <pre style="background:#fff;padding:12px;border-radius:8px;border:1px solid #E5E7EB;">${INDEX_FILE}</pre>
        <p><strong>Fix:</strong> Make sure <code>public/index.html</code> is committed to your GitHub repository at the top level.</p>
        <p>Check your repo: <a href="https://github.com/emmanuelkamuti629-alt/payhero-stk-app">github.com/emmanuelkamuti629-alt/payhero-stk-app</a></p>
      </body>
    </html>
  `);
});

// ---- Startup diagnostic ----
console.log('=============================================');
console.log('🚀 PAYHERO DIAGNOSTIC MODE');
console.log('=============================================');
console.log('1. Token loaded:', PAYHERO_BASIC_AUTH_TOKEN ? '✅ YES' : '❌ NO');
console.log('2. Channel ID:', PAYHERO_CHANNEL_ID || '❌ MISSING - check .env');
console.log('3. Base URL:', `${PAYHERO_BASE_URL}/${PAYHERO_ENDPOINT}`);
console.log('=============================================');

// ---- Simple store ----
const transactions = [];
function recordTransaction(entry) {
  transactions.unshift({ ...entry, createdAt: new Date().toISOString() });
  if (transactions.length > 200) transactions.pop();
}

function normalizePhone(input) {
  let p = String(input || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  else if (p.startsWith('254')) p = p;
  return p;
}

// ---- PayHero Request Helper ----
async function payheroPost(payload) {
  if (!PAYHERO_BASIC_AUTH_TOKEN || !PAYHERO_CHANNEL_ID) {
    throw new Error('Token or Channel ID missing in .env');
  }

  const url = `${PAYHERO_BASE_URL}/${PAYHERO_ENDPOINT}`;

  const authHeader = PAYHERO_BASIC_AUTH_TOKEN.startsWith('Basic ')
    ? PAYHERO_BASIC_AUTH_TOKEN
    : `Basic ${PAYHERO_BASIC_AUTH_TOKEN}`;

  console.log('\n📤 SENDING TO PAYHERO');
  console.log('URL:', url);
  console.log('Body:', JSON.stringify(payload, null, 2));

  const response = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  console.log('\n✅ PAYHERO RESPONDED');
  console.log('HTTP Status:', response.status);
  console.log('Body:', JSON.stringify(response.data, null, 2));

  return { httpStatus: response.status, data: response.data };
}

// =========================================================
// POST /api/stk
// =========================================================
app.post('/api/stk', async (req, res) => {
  const { amount, phone, reference } = req.body;

  if (!amount || !phone) {
    return res.status(400).json({ status: false, message: 'amount and phone are required' });
  }

  const msisdn = normalizePhone(phone);

  if (!msisdn.startsWith('254') || msisdn.length !== 12) {
    return res.status(400).json({ status: false, message: 'Invalid phone format. Use 07... or 2547...' });
  }

  const payload = {
    amount: Number(amount),
    phone_number: msisdn,
    channel_id: PAYHERO_CHANNEL_ID,
    provider: 'm-pesa',
    external_reference: reference || `INV-${Date.now()}`,
  };

  try {
    const { httpStatus, data } = await payheroPost(payload);

    const isSuccess = httpStatus >= 200 && httpStatus < 300 && (data?.success === true || data?.status === true);

    recordTransaction({
      type: 'STK',
      phone: msisdn,
      amount,
      status: isSuccess ? 'sent' : 'failed',
      reason: isSuccess ? null : (data?.message || data?.error || 'Request failed'),
      reference: payload.external_reference,
      raw: data,
    });

    return res.status(httpStatus).json({ status: isSuccess, data: data });
  } catch (err) {
    console.error('❌ REQUEST FAILED:', err.message);
    recordTransaction({
      type: 'STK',
      phone: msisdn,
      amount,
      status: 'error',
      reason: err.message,
      raw: err.message
    });
    return res.status(502).json({ status: false, message: err.message });
  }
});

// ---- List transactions ----
app.get('/api/transactions', (_req, res) => {
  res.json({ status: true, data: transactions });
});

// ---- PayHero callback ----
app.post('/api/payhero/callback', (req, res) => {
  console.log('📬 Callback:', JSON.stringify(req.body, null, 2));

  const details = req.body?.response || req.body;

  const phone = details?.Source || details?.phone || details?.phone_number || details?.MSISDN || null;
  const amount = details?.Amount || details?.amount || null;
  const reference = details?.User_Reference || details?.external_reference || details?.Transaction_Reference || null;

  const status = details?.Status || details?.status || 'received';
  const reason = details?.Message || details?.message || null;

  recordTransaction({
    type: 'CALLBACK',
    phone: phone,
    amount: amount,
    status: status,
    reason: reason,
    reference: reference,
    raw: req.body,
  });

  res.status(200).json({ status: 'received' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Server ready at http://localhost:${PORT}\n`);
});
