// server.js - FINAL VERSION (MERGES STK & CALLBACK INTO ONE TRANSACTION)
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

const PAYHERO_BASE_URL = 'https://backend.payhero.co.ke/api/v2';
const PAYHERO_ENDPOINT = 'payments';
const RENDER_URL = 'https://payhero-stk-app.onrender.com';

app.use(express.json());

// ---- Static files ----
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  if (fs.existsSync(INDEX_FILE)) {
    return res.sendFile(INDEX_FILE);
  }
  return res.status(500).send('index.html not found');
});

// ---- Startup diagnostic ----
console.log('=============================================');
console.log('🚀 PAYHERO DIAGNOSTIC MODE');
console.log('=============================================');
console.log('1. Token loaded:', PAYHERO_BASIC_AUTH_TOKEN ? '✅ YES' : '❌ NO');
console.log('2. Channel ID:', PAYHERO_CHANNEL_ID || '❌ MISSING');
console.log('3. Callback URL:', `${RENDER_URL}/api/payhero/callback`);
console.log('=============================================');

// ---- Simple store ----
const transactions = [];

// Helper to find a transaction by its CheckoutRequestID OR external reference
function findTransaction(ref, checkoutId) {
  if (checkoutId) {
    const byCheckout = transactions.find((t) => t.checkout_request_id === checkoutId);
    if (byCheckout) return byCheckout;
  }
  if (ref) {
    return transactions.find((t) => t.reference === ref);
  }
  return null;
}

// Helper to update an existing transaction
function updateTransaction(ref, checkoutId, updates) {
  const tx = findTransaction(ref, checkoutId);
  if (tx) {
    Object.assign(tx, updates, { updatedAt: new Date().toISOString() });
    return true;
  }
  return false;
}

function recordTransaction(entry) {
  transactions.unshift({ ...entry, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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

  const response = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    timeout: 30000,
    validateStatus: () => true,
  });

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
  const externalRef = reference || `INV-${Date.now()}`;

  const payload = {
    amount: Number(amount),
    phone_number: msisdn,
    channel_id: PAYHERO_CHANNEL_ID,
    provider: 'm-pesa',
    external_reference: externalRef,
    callback_url: `${RENDER_URL}/api/payhero/callback`
  };

  try {
    const { httpStatus, data } = await payheroPost(payload);

    const isSuccess = httpStatus >= 200 && httpStatus < 300 && (data?.success === true || data?.status === true);

    // Record the initial request as "pending"
    recordTransaction({
      type: 'STK',
      phone: msisdn,
      amount: Number(amount),
      status: isSuccess ? 'pending' : 'failed',
      reason: isSuccess ? null : (data?.message || data?.error || 'Request failed'),
      reference: externalRef,
      checkout_request_id: data?.CheckoutRequestID || null, // 👈 SAVE THIS FOR MATCHING
      raw: data,
    });

    return res.status(httpStatus).json({ status: isSuccess, data: data });
  } catch (err) {
    console.error('❌ REQUEST FAILED:', err.message);
    recordTransaction({
      type: 'STK',
      phone: msisdn,
      amount: Number(amount),
      status: 'error',
      reason: err.message,
      reference: externalRef,
      raw: err.message
    });
    return res.status(502).json({ status: false, message: err.message });
  }
});

// ---- List transactions ----
app.get('/api/transactions', (_req, res) => {
  res.json({ status: true, data: transactions });
});

// =========================================================
// PayHero callback - UPDATES THE ORIGINAL TRANSACTION
// =========================================================
app.post('/api/payhero/callback', (req, res) => {
  console.log('📬 Callback:', JSON.stringify(req.body, null, 2));

  const details = req.body?.response || req.body;

  const phone = details?.Phone || details?.phone || details?.phone_number || details?.MSISDN || null;
  const amount = details?.Amount || details?.amount || null;
  const reference = details?.User_Reference || details?.external_reference || details?.Transaction_Reference || null;
  const checkoutId = details?.CheckoutRequestID || details?.checkout_request_id || null;
  
  // ResultCode 0 = Success, anything else = Failed
  const resultCode = details?.ResultCode !== undefined ? details.ResultCode : details?.result_code;
  const resultDesc = details?.ResultDesc || details?.result_desc || 'Transaction failed';

  let status = 'failed';
  let reason = resultDesc;

  if (resultCode === 0 || resultCode === '0') {
    status = 'success';
    reason = 'Payment successful';
  } else {
    // Friendly messages for common codes
    if (resultCode === 1032) reason = 'Request cancelled by user';
    else if (resultCode === 1037) reason = 'Request timed out';
    else if (resultCode === 1) reason = 'Insufficient funds';
  }

  // Try to update the original STK transaction
  const updated = updateTransaction(reference, checkoutId, {
    status: status,
    reason: reason,
    phone: phone || undefined,
    amount: amount || undefined,
    raw: req.body,
  });

  if (!updated) {
    // Fallback: if we can't find the original, log it as a standalone entry
    recordTransaction({
      type: 'CALLBACK',
      phone: phone,
      amount: amount,
      status: status,
      reason: reason,
      reference: reference,
      checkout_request_id: checkoutId,
      raw: req.body,
    });
  }

  res.status(200).json({ status: 'received' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Server ready at ${RENDER_URL}\n`);
});
