#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const BACKEND_URL = process.env.SIGNAL_BACKEND_URL || 'https://provider.hipobot.xyz';
const POLL_MS = parseInt(process.env.CLIENT_POLL_MS, 10) || 15000;
const HEARTBEAT_MS = parseInt(process.env.CLIENT_HEARTBEAT_MS, 10) || 10000;
const ORDER_SIZE = parseInt(process.env.KUCOIN_ORDER_SIZE, 10) || 1;
// KuCoin Futures requires a `leverage` on position-opening orders; omitting it (or
// sending an invalid value) is rejected with {"code":"100001","msg":"Leverage
// parameter invalid."}. Match the strategy's configured leverage (config LEVERAGE=20).
// Not sent on reduceOnly (closing) orders — those close existing size and take no leverage.
const KUCOIN_LEVERAGE = parseFloat(process.env.KUCOIN_LEVERAGE) || 20;
const CLOSE_RETRY_MAX = parseInt(process.env.KUCOIN_CLOSE_RETRY_MAX, 10) || 3;
const ORDER_STATUS_TIMEOUT_MS = parseInt(process.env.KUCOIN_ORDER_STATUS_TIMEOUT_MS, 10) || 20000;
const ORDER_STATUS_POLL_MS = parseInt(process.env.KUCOIN_ORDER_STATUS_POLL_MS, 10) || 1500;
// Futures wallet currency for the account-overview balance report (USDT-margined).
const ACCOUNT_CURRENCY = process.env.KUCOIN_ACCOUNT_CURRENCY || 'USDT';
// Optional hard cap on contracts per order (0 = uncapped). A safety rail on top of risk sizing.
const MAX_ORDER_SIZE = parseInt(process.env.KUCOIN_MAX_ORDER_SIZE, 10) || 0;
// Client-chosen trading capital. When set (>0) this — not the full account equity —
// is the base the backend's risk% is applied to, so a client can allocate only part
// of their account to the bot. Capped at actual equity so it can never over-allocate.
const TRADING_CAPITAL = parseFloat(process.env.TRADING_CAPITAL) || 0;

// ─── Licensing / verification ───
// The bot authenticates to signal-backend with a per-client API key issued from
// the admin panel. The backend verifies the key + allowed IP + authorized flag,
// and enforces a single running bot per key via a heartbeat session lock.
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || '';

// A stable instanceId identifies THIS running bot to the session lock. Persisted
// so a restart re-claims the same session instead of tripping the double-bot
// guard against its own previous (still-alive) session.
const INSTANCE_FILE = path.join(__dirname, '.instance-id');
function loadInstanceId() {
  if (process.env.CLIENT_INSTANCE_ID) return process.env.CLIENT_INSTANCE_ID.trim();
  try {
    const v = fs.readFileSync(INSTANCE_FILE, 'utf8').trim();
    if (v) return v;
  } catch (_) { /* first run */ }
  const id = 'bot_' + crypto.randomBytes(8).toString('hex');
  try { fs.writeFileSync(INSTANCE_FILE, id); } catch (_) { /* read-only fs: keep in-memory */ }
  return id;
}
const INSTANCE_ID = loadInstanceId();

const KUCOIN_BASE = process.env.KUCOIN_BASE_URL || 'https://api-futures.kucoin.com';
const API_KEY = process.env.KUCOIN_API_KEY || '';
const API_SECRET = process.env.KUCOIN_API_SECRET || '';
const API_PASSPHRASE = process.env.KUCOIN_API_PASSPHRASE || '';
const API_KEY_VERSION = process.env.KUCOIN_API_KEY_VERSION || '2';

const SYMBOLS = {
  BTC: 'XBTUSDTM',
  ETH: 'ETHUSDTM',
  SOL: 'SOLUSDTM',
  XRP: 'XRPUSDTM',
  DOGE: 'DOGEUSDTM',
};

const botState = {};
const lastProcessedSignal = {};

// Licensing runtime state
let sessionActive = false;   // holds the backend session lock
let authorized = false;      // admin-approved
let paused = false;          // desiredState from backend (running/paused) OR not authorized
let licenseFatal = false;    // unrecoverable (bad key / IP blocked / double bot) → stop

// Sizing runtime state. The backend owns the risk policy and pushes the effective
// risk% (per-bot override, else its global default) in the session/heartbeat
// response — the bot never computes the strategy, only sizes to this one number.
let riskPerTradePct = null;  // effective risk% from backend; null → fall back to fixed ORDER_SIZE
let accountBalance = null;   // { equity, available, currency } last read from KuCoin (reported to backend)

function requireCredentials() {
  if (!API_KEY || !API_SECRET || !API_PASSPHRASE) {
    throw new Error('Missing KuCoin credentials. Set KUCOIN_API_KEY, KUCOIN_API_SECRET, KUCOIN_API_PASSPHRASE.');
  }
}

function sign(timestamp, method, endpoint, bodyText) {
  const payload = `${timestamp}${method.toUpperCase()}${endpoint}${bodyText || ''}`;
  return crypto.createHmac('sha256', API_SECRET).update(payload).digest('base64');
}

function signPassphrase() {
  return crypto.createHmac('sha256', API_SECRET).update(API_PASSPHRASE).digest('base64');
}

async function kucoinRequest(method, endpoint, body) {
  const timestamp = Date.now().toString();
  const bodyText = body ? JSON.stringify(body) : '';
  const signature = sign(timestamp, method, endpoint, bodyText);
  const passphrase = signPassphrase();

  const res = await axios({
    method,
    url: `${KUCOIN_BASE}${endpoint}`,
    headers: {
      'KC-API-KEY': API_KEY,
      'KC-API-SIGN': signature,
      'KC-API-TIMESTAMP': timestamp,
      'KC-API-PASSPHRASE': passphrase,
      'KC-API-KEY-VERSION': API_KEY_VERSION,
      'Content-Type': 'application/json',
    },
    data: body || undefined,
    timeout: 30000,
  });

  if (!res.data || String(res.data.code) !== '200000') {
    throw new Error(`KuCoin error: ${JSON.stringify(res.data)}`);
  }
  return res.data.data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOrderStatus(data) {
  const dealSize = Number(data.dealSize || 0);
  const size = Number(data.size || 0);
  const isActive = !!data.isActive;
  const done = !isActive && size > 0 && dealSize >= size;
  const unfilled = !isActive && dealSize === 0;
  return { done, unfilled, partial: dealSize > 0 && dealSize < size };
}

async function waitForOrderFinal(orderId) {
  const start = Date.now();
  while (Date.now() - start < ORDER_STATUS_TIMEOUT_MS) {
    const ord = await kucoinRequest('GET', `/api/v1/orders/${orderId}`);
    const status = normalizeOrderStatus(ord);
    if (status.done) return { status: 'filled', raw: ord };
    if (status.unfilled) return { status: 'unfilled', raw: ord };
    if (status.partial) return { status: 'partial', raw: ord };
    await sleep(ORDER_STATUS_POLL_MS);
  }
  return { status: 'timeout' };
}

async function cancelOrder(orderId) {
  try {
    await kucoinRequest('DELETE', `/api/v1/orders/${orderId}`);
  } catch (_) {}
}

async function placeMarketOrder({ coin, side, size, reduceOnly }) {
  const symbol = SYMBOLS[coin];
  if (!symbol) throw new Error(`Unsupported coin: ${coin}`);
  const clientOid = `${coin}-${side}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const payload = {
    clientOid,
    symbol,
    side,
    type: 'market',
    size: String(size),
    reduceOnly: !!reduceOnly,
  };
  // Opening orders must carry a valid leverage or KuCoin rejects them (code 100001).
  // Closing orders (reduceOnly) reduce existing size and must not send leverage.
  if (!reduceOnly) payload.leverage = String(KUCOIN_LEVERAGE);
  const data = await kucoinRequest('POST', '/api/v1/orders', payload);
  return data.orderId || data.id;
}

// ─── Balance + risk-based sizing ───
// Public (unsigned) KuCoin GET for reference data (contract specs, mark price).
async function kucoinPublic(endpoint) {
  const res = await axios.get(`${KUCOIN_BASE}${endpoint}`, { timeout: 15000 });
  if (!res.data || String(res.data.code) !== '200000') {
    throw new Error(`KuCoin error: ${JSON.stringify(res.data)}`);
  }
  return res.data.data;
}

const contractMultipliers = {}; // symbol -> lot multiplier (base units per contract), cached
async function getMultiplier(symbol) {
  if (contractMultipliers[symbol] != null) return contractMultipliers[symbol];
  const d = await kucoinPublic(`/api/v1/contracts/${symbol}`);
  const m = Number(d && d.multiplier);
  if (Number.isFinite(m) && m > 0) contractMultipliers[symbol] = m;
  return contractMultipliers[symbol];
}

async function getMarkPrice(symbol) {
  const d = await kucoinPublic(`/api/v1/mark-price/${symbol}/current`);
  const v = Number(d && d.value);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Read the futures account balance for ACCOUNT_CURRENCY; keep last value on failure. */
async function refreshBalance() {
  const capital = TRADING_CAPITAL > 0 ? TRADING_CAPITAL : null;
  try {
    const d = await kucoinRequest('GET', `/api/v1/account-overview?currency=${ACCOUNT_CURRENCY}`);
    accountBalance = {
      equity: Number(d.accountEquity),
      available: Number(d.availableBalance),
      currency: ACCOUNT_CURRENCY,
      capital, // client-set trading capital (null = use full equity)
    };
  } catch (e) {
    console.error('[client-bot] balance fetch failed:', e.message);
    // Still surface the client-set capital even if the exchange read failed.
    accountBalance = { ...(accountBalance || { currency: ACCOUNT_CURRENCY }), capital };
  }
  return accountBalance;
}

/**
 * Contracts to trade for `coin`. The bot has no stop-loss, so risk% is applied as
 * position notional: notional = equity * risk% / 100, converted to lots via the
 * contract multiplier and current mark price. Falls back to the fixed ORDER_SIZE
 * whenever an input is missing so behavior degrades safely; returns 0 (skip) only
 * when risk sizing is fully available but too small for a single lot.
 */
async function computeOrderSize(coin) {
  const symbol = SYMBOLS[coin];
  const equity = accountBalance && Number(accountBalance.equity);
  // Sizing base: the client-set trading capital when configured (never above real
  // equity), otherwise the full account equity.
  let capitalBase;
  if (TRADING_CAPITAL > 0) capitalBase = equity > 0 ? Math.min(TRADING_CAPITAL, equity) : TRADING_CAPITAL;
  else capitalBase = equity;
  if (!(riskPerTradePct > 0) || !(capitalBase > 0)) return { size: ORDER_SIZE, basis: 'fixed' };
  try {
    const [mult, mark] = await Promise.all([getMultiplier(symbol), getMarkPrice(symbol)]);
    if (!(mult > 0) || !(mark > 0)) return { size: ORDER_SIZE, basis: 'fixed' };
    const notional = capitalBase * (riskPerTradePct / 100);
    const contractValue = mark * mult; // quote-currency value of one lot
    let size = Math.floor(notional / contractValue);
    if (MAX_ORDER_SIZE > 0) size = Math.min(size, MAX_ORDER_SIZE);
    if (size < 1) return { size: 0, basis: 'risk-too-small' };
    return { size, basis: 'risk' };
  } catch (e) {
    console.error('[client-bot] size calc failed, using fixed size:', e.message);
    return { size: ORDER_SIZE, basis: 'fixed' };
  }
}

async function openPositionFromSignal(coin, signal) {
  const side = signal.action === 'LONG' ? 'buy' : 'sell';
  const state = botState[coin];
  if (state && state.open) return;
  const { size, basis } = await computeOrderSize(coin);
  if (size < 1) {
    console.log(`[client-bot] OPEN ${coin} skipped — ${basis} (risk=${riskPerTradePct}% equity=${accountBalance && accountBalance.equity})`);
    return;
  }
  const orderId = await placeMarketOrder({ coin, side, size, reduceOnly: false });
  const final = await waitForOrderFinal(orderId);
  if (final.status !== 'filled') {
    await cancelOrder(orderId);
    console.log(`[client-bot] OPEN ${coin} ${side} not filled (${final.status})`);
    return;
  }
  botState[coin] = {
    open: true,
    side,
    size,
    openedAt: signal.barTime,
    entryOrderId: orderId,
  };
  console.log(`[client-bot] OPEN filled ${coin} ${side} size=${size} (${basis})`);
}

async function closePosition(coin, reason) {
  const state = botState[coin];
  if (!state || !state.open) return;

  const closeSide = state.side === 'buy' ? 'sell' : 'buy';
  for (let attempt = 1; attempt <= CLOSE_RETRY_MAX; attempt += 1) {
    const orderId = await placeMarketOrder({
      coin,
      side: closeSide,
      size: state.size,
      reduceOnly: true,
    });
    const final = await waitForOrderFinal(orderId);
    if (final.status === 'filled') {
      botState[coin] = { open: false, lastCloseReason: reason, closedAt: Date.now() };
      console.log(`[client-bot] CLOSE filled ${coin} reason=${reason} attempt=${attempt}`);
      return;
    }
    await cancelOrder(orderId);
    console.log(`[client-bot] CLOSE ${coin} not filled (${final.status}), retry ${attempt}/${CLOSE_RETRY_MAX}`);
  }
  console.error(`[client-bot] CLOSE FAILED ${coin}: order remained unfilled after ${CLOSE_RETRY_MAX} attempts`);
}

// ─── Licensing helpers ───

function licenseHeaders() {
  return { 'X-Client-Api-Key': CLIENT_API_KEY, 'X-Client-Instance-Id': INSTANCE_ID };
}

function openPositionsSummary() {
  return Object.entries(botState)
    .filter(([, s]) => s && s.open)
    .map(([coin, s]) => ({ coin, side: s.side, size: s.size, openedAt: s.openedAt }));
}

/** Interpret a non-OK licensing response; set runtime flags. */
function handleLicenseError(res, ctx) {
  const data = (res && res.data) || {};
  const code = data.code || (res && res.status);
  const msg = data.error || `HTTP ${res && res.status}`;
  const status = res && res.status;

  if (status === 409) {
    console.error(`[client-bot] ${ctx}: DOUBLE-BOT BLOCKED — ${msg}`);
    licenseFatal = true;
  } else if (status === 401) {
    console.error(`[client-bot] ${ctx}: API key rejected — ${msg}`);
    licenseFatal = true;
  } else if (status === 403 && code === 'IP_NOT_ALLOWED') {
    console.error(`[client-bot] ${ctx}: IP not allowed — ${msg}`);
    licenseFatal = true;
  } else if (status === 403) {
    // NOT_AUTHORIZED — awaiting admin approval; keep polling (non-fatal).
    console.warn(`[client-bot] ${ctx}: ${msg} (will retry)`);
    authorized = false;
    paused = true;
    sessionActive = false;
  } else if (status === 425) {
    // Session expired/lost — re-claim on next loop.
    console.warn(`[client-bot] ${ctx}: ${msg} (re-claiming session)`);
    sessionActive = false;
  } else {
    console.error(`[client-bot] ${ctx}: ${msg}`);
  }
}

async function startSession() {
  await refreshBalance();
  const res = await axios.post(
    `${BACKEND_URL}/client/session/start`,
    { instanceId: INSTANCE_ID, positions: openPositionsSummary(), balance: accountBalance },
    { headers: licenseHeaders(), timeout: 20000, validateStatus: () => true }
  );
  if (res.status === 200 && res.data && res.data.ok) {
    const c = res.data.client || {};
    authorized = c.authorized !== false;
    paused = c.desiredState === 'paused' || !authorized;
    if (c.riskPerTradePct != null) riskPerTradePct = Number(c.riskPerTradePct);
    sessionActive = true;
    console.log(`[client-bot] session claimed | client=${c.name || c.id} authorized=${authorized} state=${paused ? 'paused' : 'running'} risk=${riskPerTradePct != null ? riskPerTradePct + '%' : 'fixed'}`);
    return true;
  }
  handleLicenseError(res, 'session start');
  return false;
}

async function heartbeat() {
  await refreshBalance();
  const res = await axios.post(
    `${BACKEND_URL}/client/session/heartbeat`,
    { instanceId: INSTANCE_ID, status: paused ? 'paused' : 'running', positions: openPositionsSummary(), balance: accountBalance },
    { headers: licenseHeaders(), timeout: 15000, validateStatus: () => true }
  );
  if (res.status === 200 && res.data && res.data.ok) {
    const wasPaused = paused;
    authorized = res.data.authorized !== false;
    paused = res.data.desiredState === 'paused' || !authorized;
    if (res.data.riskPerTradePct != null) riskPerTradePct = Number(res.data.riskPerTradePct);
    if (wasPaused !== paused) console.log(`[client-bot] state -> ${paused ? 'PAUSED' : 'RUNNING'}`);
    return true;
  }
  handleLicenseError(res, 'heartbeat');
  return false;
}

async function stopSession() {
  try {
    await axios.post(
      `${BACKEND_URL}/client/session/stop`,
      { instanceId: INSTANCE_ID },
      { headers: licenseHeaders(), timeout: 8000, validateStatus: () => true }
    );
  } catch (_) {}
}

async function fetchSignals() {
  const res = await axios.get(`${BACKEND_URL}/client/signals`, {
    headers: licenseHeaders(),
    timeout: 20000,
    validateStatus: () => true,
  });
  if (res.status === 200 && res.data && res.data.signals) return res.data.signals;
  handleLicenseError(res, 'fetch signals');
  return {};
}

async function handleSignals(signals) {
  const coins = Object.keys(SYMBOLS);

  for (const coin of coins) {
    const sig = signals[coin];
    if (!sig) continue;
    const action = sig.action || 'SKIP';
    const key = `${action}:${sig.barTime || 0}`;
    if (lastProcessedSignal[coin] === key) continue;
    lastProcessedSignal[coin] = key;

    const state = botState[coin] || { open: false };
    const actionable = (action === 'LONG' || action === 'SHORT') && !!sig.confOk;

    // Paused / unauthorized: do not open NEW positions. Existing positions are
    // still managed (closed on flip/invalid) so risk isn't left unmanaged.
    if (!state.open && actionable) {
      if (paused || !authorized) continue;
      await openPositionFromSignal(coin, sig);
      continue;
    }

    if (state.open) {
      const sameDirection =
        (state.side === 'buy' && action === 'LONG') ||
        (state.side === 'sell' && action === 'SHORT');
      if (!actionable || !sameDirection) {
        await closePosition(coin, !actionable ? 'SIGNAL_INVALID' : 'FLIP_DIRECTION');
      }
    }
  }
}

async function ensureSession() {
  if (licenseFatal) return false;
  if (sessionActive) return true;
  return startSession();
}

async function tick() {
  if (licenseFatal) return;
  if (!(await ensureSession())) return; // awaiting authorization / transient — retry next tick
  const signals = await fetchSignals();
  if (licenseFatal || !sessionActive) return;
  await handleSignals(signals);
}

let pollTimer = null;
let hbTimer = null;

function shutdownFatal() {
  if (pollTimer) clearInterval(pollTimer);
  if (hbTimer) clearInterval(hbTimer);
  console.error('[client-bot] LICENSE CHECK FAILED — bot stopped. Resolve in the admin panel, then restart.');
  process.exit(1);
}

async function main() {
  requireCredentials();
  if (!CLIENT_API_KEY) {
    throw new Error('Missing CLIENT_API_KEY. Create a client in the admin panel and copy its API key into .env.');
  }
  console.log(`[client-bot] started | backend=${BACKEND_URL} | instance=${INSTANCE_ID} | poll=${POLL_MS}ms heartbeat=${HEARTBEAT_MS}ms | capital=${TRADING_CAPITAL > 0 ? TRADING_CAPITAL + ' ' + ACCOUNT_CURRENCY : 'full equity'}`);

  await tick();
  if (licenseFatal) return shutdownFatal();

  pollTimer = setInterval(() => {
    if (licenseFatal) return shutdownFatal();
    tick().catch((err) => console.error('[client-bot] tick error:', err.message));
  }, POLL_MS);

  hbTimer = setInterval(async () => {
    if (licenseFatal) return shutdownFatal();
    if (!sessionActive) { await ensureSession().catch((e) => console.error('[client-bot] session error:', e.message)); return; }
    await heartbeat().catch((err) => console.error('[client-bot] heartbeat error:', err.message));
  }, HEARTBEAT_MS);
}

async function gracefulExit() {
  console.log('[client-bot] shutting down — releasing session lock...');
  await stopSession();
  process.exit(0);
}
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

main().catch((err) => {
  console.error('[client-bot] fatal:', err.message);
  process.exit(1);
});
