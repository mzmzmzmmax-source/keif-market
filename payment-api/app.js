'use strict';

// Kif Market payment API reference implementation.
// Node.js 20+; built-in fetch only. Do not deploy until Sandbox tests pass.
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://mzmzmzmmax-source.github.io';
const SITE_PATH = '/keif-market';
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'https://api.kif-market.ir';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ZARINPAL_MERCHANT_ID = process.env.ZARINPAL_MERCHANT_ID || '';
const ZARINPAL_BASE_URL = (process.env.ZARINPAL_BASE_URL || 'https://sandbox.zarinpal.com').replace(/\/$/, '');
const ZARINPAL_VERIFY_UNIT = process.env.ZARINPAL_VERIFY_UNIT || '';

const CALLBACK_URL = API_PUBLIC_URL + '/payments/zarinpal/callback';
const ALLOWED_ORIGINS = new Set([
  'https://mzmzmzmmax-source.github.io',
  'https://kif-market.ir',
  'https://www.kif-market.ir'
]);

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function redirect(res, status, url) {
  res.writeHead(status, { Location: url, 'Cache-Control': 'no-store' });
  res.end();
}
function resultUrl(state, orderId) {
  const u = new URL(SITE_ORIGIN + SITE_PATH + '/payment-result.html');
  u.searchParams.set('state', state);
  if (orderId) u.searchParams.set('order_id', String(orderId));
  return u.toString();
}
function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}
function configReady() {
  return SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && ZARINPAL_MERCHANT_ID;
}
async function readJson(req, maxBytes = 16_384) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('request too large');
  }
  return raw ? JSON.parse(raw) : {};
}
async function sb(path, options = {}) {
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const err = new Error('database request failed');
    err.status = response.status;
    err.detail = data;
    throw err;
  }
  return data;
}
async function rpc(name, body) {
  return sb('rpc/' + name, { method: 'POST', body: JSON.stringify(body) });
}
async function zarinpal(path, body) {
  const response = await fetch(ZARINPAL_BASE_URL + '/pg/v4/payment/' + path + '.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error('Zarinpal service unavailable');
  return data;
}
async function getAttemptById(id) {
  const rows = await sb('payment_attempts?select=id,order_id,amount_toman,authority,status&id=eq.' + encodeURIComponent(id) + '&limit=1');
  return rows && rows[0];
}
async function getAttemptByAuthority(authority) {
  const rows = await sb('payment_attempts?select=id,order_id,amount_toman,authority,status&id=not.is.null&authority=eq.' + encodeURIComponent(authority) + '&limit=1');
  return rows && rows[0];
}
async function updateAttempt(id, patch) {
  await sb('payment_attempts?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
}

async function createPayment(req, res) {
  if (!configReady()) return send(res, 503, { success: false, error: 'payment service is not configured' });
  const input = await readJson(req);
  const orderId = Number(input.order_id);
  if (!Number.isSafeInteger(orderId) || orderId <= 0 || !isUuid(input.idempotency_key)) {
    return send(res, 400, { success: false, error: 'invalid order or idempotency key' });
  }

  const orders = await sb('orders?select=id,subtotal,payment_status,status,customer_phone&id=eq.' + orderId + '&limit=1');
  const order = orders && orders[0];
  if (!order) return send(res, 404, { success: false, error: 'order not found' });
  if (order.payment_status === 'paid') return send(res, 409, { success: false, error: 'order already paid' });
  if (order.status === 'cancelled' || !Number.isSafeInteger(Number(order.subtotal)) || Number(order.subtotal) <= 0) {
    return send(res, 409, { success: false, error: 'order is not payable' });
  }

  const started = await rpc('begin_product_payment', {
    p_order_id: orderId,
    p_idempotency_key: input.idempotency_key
  });
  const attemptInfo = Array.isArray(started) ? started[0] : started;
  if (!attemptInfo || !attemptInfo.attempt_id) throw new Error('could not start payment attempt');

  const attempt = await getAttemptById(attemptInfo.attempt_id);
  if (!attempt) throw new Error('payment attempt not found after creation');

  if (attempt.status === 'pending' && attempt.authority) {
    const host = ZARINPAL_BASE_URL.replace(/\/$/, '');
    return send(res, 200, {
      success: true,
      order_id: orderId,
      redirect_url: host + '/pg/StartPay/' + encodeURIComponent(attempt.authority)
    });
  }
  if (attempt.status !== 'creating') {
    return send(res, 409, { success: false, error: 'payment attempt is not startable' });
  }

  try {
    // Product subtotal is in Toman. Shipping is postpaid and deliberately excluded.
    const requestPayload = {
      merchant_id: ZARINPAL_MERCHANT_ID,
      amount: Number(attempt.amount_toman),
      currency: 'IRT',
      description: 'پرداخت بهای کالاهای سفارش کیف مارکت شماره ' + orderId,
      callback_url: CALLBACK_URL,
      metadata: {
        mobile: String(order.customer_phone || ''),
        order_id: String(orderId),
        auto_verify: false
      }
    };
    const response = await zarinpal('request', requestPayload);
    const data = response && response.data;
    const authority = data && data.authority;
    if (!data || Number(data.code) !== 100 || !authority) {
      await rpc('fail_product_payment_attempt', {
        p_attempt_id: attempt.id,
        p_error_message: 'Zarinpal request rejected',
        p_request_code: data && Number.isInteger(Number(data.code)) ? Number(data.code) : null
      }).catch(() => {});
      return send(res, 502, { success: false, error: 'درخواست پرداخت از درگاه پذیرفته نشد.' });
    }

    const saved = await rpc('set_product_payment_authority', {
      p_attempt_id: attempt.id,
      p_authority: String(authority),
      p_request_code: Number(data.code)
    });
    if (saved !== true) throw new Error('could not persist payment authority');

    return send(res, 200, {
      success: true,
      order_id: orderId,
      redirect_url: ZARINPAL_BASE_URL + '/pg/StartPay/' + encodeURIComponent(authority)
    });
  } catch (error) {
    await rpc('fail_product_payment_attempt', {
      p_attempt_id: attempt.id,
      p_error_message: 'payment request could not be completed',
      p_request_code: null
    }).catch(() => {});
    throw error;
  }
}

async function handleCallback(url, res) {
  const authority = url.searchParams.get('Authority') || '';
  const gatewayStatus = (url.searchParams.get('Status') || '').toUpperCase();
  if (!authority || authority.length > 128) return redirect(res, 302, resultUrl('unknown'));
  const attempt = await getAttemptByAuthority(authority);
  if (!attempt) return redirect(res, 302, resultUrl('unknown'));

  if (attempt.status === 'verified') return redirect(res, 302, resultUrl('success', attempt.order_id));
  if (attempt.status !== 'pending') return redirect(res, 302, resultUrl('not-paid', attempt.order_id));
  if (gatewayStatus !== 'OK') {
    await updateAttempt(attempt.id, { status: 'failed', callback_status: gatewayStatus || 'NOK', error_message: 'customer did not complete payment' });
    return redirect(res, 302, resultUrl('not-paid', attempt.order_id));
  }

  // Verify's unit differs in the supplied docs from Request(IRT); fail closed until Sandbox confirms it.
  if (!['rial', 'toman'].includes(ZARINPAL_VERIFY_UNIT)) {
    await updateAttempt(attempt.id, { callback_status: 'OK', error_message: 'verify unit is not configured; manual reconciliation required' });
    return redirect(res, 302, resultUrl('checking', attempt.order_id));
  }

  const verifyAmount = Number(attempt.amount_toman) * (ZARINPAL_VERIFY_UNIT === 'rial' ? 10 : 1);
  const verification = await zarinpal('verify', {
    merchant_id: ZARINPAL_MERCHANT_ID,
    amount: verifyAmount,
    authority
  });
  const data = verification && verification.data;
  const code = data && Number(data.code);

  // Code 101 is not accepted unless this database already recorded verification.
  if (code === 101) {
    await updateAttempt(attempt.id, { callback_status: 'OK', verify_code: 101, error_message: 'already verified by provider; requires reconciliation' });
    return redirect(res, 302, resultUrl('checking', attempt.order_id));
  }
  if (code !== 100) {
    await updateAttempt(attempt.id, {
      callback_status: 'OK',
      verify_code: Number.isInteger(code) ? code : null,
      error_message: 'provider verification did not succeed'
    });
    return redirect(res, 302, resultUrl('not-paid', attempt.order_id));
  }

  await rpc('complete_product_payment', {
    p_authority: authority,
    p_ref_id: data.ref_id == null ? null : String(data.ref_id),
    p_verify_code: code,
    p_callback_status: gatewayStatus
  });
  return redirect(res, 302, resultUrl('success', attempt.order_id));
}

async function paymentStatus(orderId, res) {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return send(res, 400, { success: false });
  const rows = await sb('orders?select=id,payment_status,status&id=eq.' + orderId + '&limit=1');
  if (!rows || !rows[0]) return send(res, 404, { success: false });
  const attempts = await sb('payment_attempts?select=status,ref_id,created_at&order_id=eq.' + orderId + '&order=created_at.desc&limit=1');
  return send(res, 200, {
    success: true,
    order_id: orderId,
    payment_status: rows[0].payment_status,
    order_status: rows[0].status,
    payment_attempt_status: attempts && attempts[0] ? attempts[0].status : null,
    ref_id: attempts && attempts[0] && attempts[0].status === 'verified' ? attempts[0].ref_id : null
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { success: true, service: 'Kif Market API', node: process.versions.node });
    }
    if (req.method === 'GET' && url.pathname === '/ip-check') {
      const ip = await fetch('https://api.ipify.org?format=json').then(r => r.json());
      return send(res, 200, ip);
    }
    if (req.method === 'POST' && url.pathname === '/payments/create') {
      return await createPayment(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/payments/zarinpal/callback') {
      return await handleCallback(url, res);
    }
    if (req.method === 'GET' && url.pathname === '/payments/status') {
      return await paymentStatus(Number(url.searchParams.get('order_id')), res);
    }
    return send(res, 404, { success: false, error: 'not found' });
  } catch (error) {
    // Never expose provider payloads, database details, or credentials to the browser.
    console.error('API error:', error && error.message ? error.message : 'unknown');
    return send(res, 500, { success: false, error: 'خطای موقت سرور؛ وضعیت سفارش را از صفحه پیگیری بررسی کنید.' });
  }
});

server.listen(PORT, () => {
  console.log('Kif Market API listening on port', PORT);
});
