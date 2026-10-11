/**
 * RSMine Desktop (план Step 6, вариант Electron вместо Tauri — без Rust/MSVC).
 * — LZT-токен: safeStorage (DPAPI Windows), файл в userData, никогда не в JSON.
 * — Релей: WebSocket к api-воркеру (auth slug+appSecret), приёмы create_invoice,
 *   вызов LZT, ответы invoice_ok/error, ping каждые 30 сек, автопереподключение.
 * — Оплата: поллинг статуса инвойса → donation_paid (реестр на сервере + алерт в SSE оверлея).
 * — Трей + окно настроек; автозапуск с Windows.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');

const API_BASE_DEFAULT = 'https://rsmine-api.jdankinloh.workers.dev';
const APP_VERSION = '1.3.1';
const PING_MS = 30_000;
const POLL_MS = 5_000;

let tray = null;
let settingsWindow = null;
let ws = null;
let reconnectDelay = 1000;
let pingTimer = null;
let histTimer = null;
let reconnectTimer = null;
/** метка последнего сообщения ОТ сервера (pong/история/инвойс).
 *  Если сервер молчит >45с — сокет half-open (мёртв, но readyState=1):
 *  рвём и переподключаемся, иначе пинги уходят в пустоту. */
let lastServerMsg = 0;
/** инвойсы, ожидающие оплаты (id → {status, paymentId}) */
const watching = new Map();

// ── журнал донатов для вкладки «Сообщения» (свои данные программы,
// сервер не дёргаем; хранится рядом с настройками, последние 100) ──
const donationsPath = () => path.join(app.getPath('userData'), 'donations.json');
function loadDonations() {
  try {
    const d = JSON.parse(fs.readFileSync(donationsPath(), 'utf8'));
    if (d && Array.isArray(d.items)) {
      return { items: d.items.slice(0, 100), hidden: Array.isArray(d.hidden) ? d.hidden : [] };
    }
  } catch { /* первый запуск */ }
  return { items: [], hidden: [] };
}
function saveDonations() {
  try {
    fs.mkdirSync(path.dirname(donationsPath()), { recursive: true });
    fs.writeFileSync(donationsPath(), JSON.stringify({
      items: donLog.items.slice(0, 100),
      hidden: donLog.hidden.slice(0, 200),
    }));
  } catch { /* диск недоступен — живём в памяти */ }
}
const donLog = loadDonations();
function getDonations() {
  return { items: donLog.items, hidden: donLog.hidden };
}
/** Слияние серверного реестра в журнал (дедуп по invoiceId, метки времени сервера). */
function mergeHistory(rows) {
  const seen = new Set(donLog.items.map((d) => d.invoiceId));
  let added = 0;
  for (const r of rows) {
    const id = Number(r.invoice_id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    donLog.items.push({
      invoiceId: id,
      sum: Number(r.sum) || 0,
      username: String(r.username || 'зритель'),
      text: String(r.text || ''),
      ts: Number(r.ts) || Date.now(),
    });
    added += 1;
  }
  if (!added) return;
  donLog.items.sort((a, b) => b.ts - a.ts);
  donLog.items = donLog.items.slice(0, 100);
  saveDonations();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('donations', getDonations());
  }
}
function pushDonation(entry) {
  donLog.items.unshift({ invoiceId: entry.invoiceId, sum: entry.sum, username: entry.username, text: entry.text, ts: Date.now() });
  donLog.items = donLog.items.slice(0, 100);
  saveDonations();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('donations', getDonations());
  }
}

// ── хранилище настроек ─────────────────────────────────────────────
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const tokenPath = () => path.join(app.getPath('userData'), 'lzt.bin');
const ttsKeyPath = () => path.join(app.getPath('userData'), 'cartesia.bin');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return { slug: '', appSecret: '', merchantId: '', apiBase: API_BASE_DEFAULT, autostart: true };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  // токен сюда НЕ пишется никогда
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

function saveToken(token) {
  fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
  const encrypted = require('electron').safeStorage.encryptString(token);
  fs.writeFileSync(tokenPath(), encrypted);
}

function loadToken() {
  try {
    const raw = fs.readFileSync(tokenPath());
    return require('electron').safeStorage.decryptString(raw);
  } catch {
    return '';
  }
}

// ключ Cartesia — тот же safeStorage, что и LZT-токен (Step 10)
function saveTtsKey(key) {
  fs.mkdirSync(path.dirname(ttsKeyPath()), { recursive: true });
  const encrypted = require('electron').safeStorage.encryptString(key);
  fs.writeFileSync(ttsKeyPath(), encrypted);
}

function loadTtsKey() {
  try {
    const raw = fs.readFileSync(ttsKeyPath());
    return require('electron').safeStorage.decryptString(raw);
  } catch {
    return '';
  }
}

// ключ уходит на воркер по уже установленному релею (KV tts:slug:<slug>)
function sendTtsKey(socket) {
  const key = loadTtsKey();
  if (key && socket && socket.readyState === 1) {
    socket.send(JSON.stringify({ type: 'tts_key', key }));
  }
}

// ── LZT API ────────────────────────────────────────────────────────
async function lztCreateInvoice(token, { sum, comment, merchantId, urlSuccess }) {
  const paymentId = `rsmine_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const res = await fetch('https://prod-api.lzt.market/invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      currency: 'rub',
      amount: sum,
      payment_id: paymentId,
      comment,
      merchant_id: merchantId,
      url_success: urlSuccess,
      lifetime: 3600,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LZT HTTP ${res.status} — ${text.slice(0, 160)}`);
  const json = JSON.parse(text);
  const payUrl = json?.invoice?.url;
  const invoiceId = json?.invoice?.invoice_id ?? 0;
  if (!payUrl) throw new Error('LZT: нет url счёта');
  return { payUrl, invoiceId, paymentId };
}

async function lztInvoiceStatus(token, invoiceId, merchantId) {
  const url = `https://prod-api.lzt.market/invoice/${invoiceId}` +
    (merchantId ? `?merchant_id=${encodeURIComponent(merchantId)}` : '');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { state: 'unknown' };
  const json = await res.json();
  return { state: String(json?.invoice?.status ?? 'unknown'), amount: Number(json?.invoice?.amount ?? 0) };
}

// ── релей (WebSocket клиент) ───────────────────────────────────────
function relayConnect() {
  const s = loadSettings();
  const token = loadToken();
  setStatus('relay', 'подключение…');
  if (!s.slug || !s.appSecret || !token) {
    setStatus('relay', 'не настроено');
    return; // не настроено
  }
  if (ws && (ws.readyState === 1 || ws.readyState === 0)) return;

  const base = s.apiBase || API_BASE_DEFAULT;
  const wsUrl = base.replace(/^http/, 'ws') +
    `/api/relay/${encodeURIComponent(s.slug)}/ws?slug=${encodeURIComponent(s.slug)}&secret=${encodeURIComponent(s.appSecret)}`;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    lastServerMsg = Date.now();
    setStatus('relay', 'подключён');
    ws.send(JSON.stringify({ type: 'ready' }));
    sendTtsKey(ws);
    // подтягиваем реестр (старые донаты, ручные внесения) в журнал вкладки
    ws.send(JSON.stringify({ type: 'get_history', limit: 50 }));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      // сервер дольше 45с не отвечает (нет даже pong) — сокет мёртв, рвём:
      // 'close' сам запустит переподключение через scheduleReconnect
      if (Date.now() - lastServerMsg > 45_000) {
        setStatus('relay', 'переподключение…');
        try { ws.close(); } catch { /* noop */ }
        return;
      }
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now(), version: APP_VERSION }));
    }, PING_MS);
    if (histTimer) clearInterval(histTimer);
    histTimer = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'get_history', limit: 50 }));
    }, 60_000);
  });

  ws.addEventListener('message', async (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    // любое сообщение сервера (pong/история/инвойс) = соединение живо
    lastServerMsg = Date.now();
    // ответ реестра: сливаем недостающее в журнал (свои свежие не трогаем)
    if (msg.type === 'history') {
      mergeHistory(Array.isArray(msg.donations) ? msg.donations : []);
      return;
    }
    if (msg.type !== 'create_invoice') return;
    try {
      const inv = await lztCreateInvoice(token, {
        sum: Number(msg.sum),
        comment: String(msg.comment ?? ''),
        merchantId: s.merchantId,
        urlSuccess: String(msg.urlSuccess ?? ''),
      });
      ws.send(JSON.stringify({ type: 'invoice_ok', requestId: msg.requestId, payUrl: inv.payUrl, invoiceId: inv.invoiceId }));
      // следим за оплатой: paid → алерт в оверлей (текст = комментарий перевода, обычно LD1-payload)
      watching.set(inv.invoiceId, { paymentId: inv.paymentId, tries: 0, comment: String(msg.comment ?? '') });
      pollLoop();
    } catch (e) {
      ws.send(JSON.stringify({ type: 'invoice_error', requestId: msg.requestId, error: String(e.message || e).slice(0, 200) }));
    }
  });

  ws.addEventListener('close', () => {
    setStatus('relay', 'отключён');
    if (pingTimer) clearInterval(pingTimer);
    scheduleReconnect();
  });
  ws.addEventListener('error', (err) => {
    setStatus('relay', 'ошибка соединения');
    try { ws.close(); } catch { /* noop */ }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    relayConnect();
  }, reconnectDelay);
}

// поллинг оплат: paid → donation_paid (сервер пишет в реестр и шлёт алерт в SSE) + трей-уведомление
let pollTimer = null;
function pollLoop() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (watching.size === 0) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    const token = loadToken();
    const s = loadSettings();
    for (const [invoiceId, meta] of [...watching]) {
      if (meta.tries > 360) { watching.delete(invoiceId); continue; }
      meta.tries += 1;
      try {
        const st = await lztInvoiceStatus(token, invoiceId, s.merchantId);
        if (st.state === 'paid') {
          watching.delete(invoiceId);
          const entry = { invoiceId, sum: st.amount, username: 'зритель', text: meta.comment || '' };
          pushDonation(entry);
          if (ws && ws.readyState === 1) {
            // реестр на сервере (дедуп по invoiceId) + алерт в оверлей одним сообщением
            ws.send(JSON.stringify({ type: 'donation_paid', ...entry }));
          }
          if (tray) tray.displayBalloon?.({ iconType: 'info', title: 'RSMine', content: `Донат оплачен: ${st.amount} ₽` });
        } else if (st.state === 'cancelled' || st.state === 'expired') {
          watching.delete(invoiceId);
        }
      } catch {
        /* сеть мигнула — попробуем на следующем тике */
      }
    }
  }, POLL_MS);
}

function relayStop() {
  if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
  if (pingTimer) clearInterval(pingTimer);
  if (histTimer) clearInterval(histTimer);
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

// ── статус для окна настроек ───────────────────────────────────────
const status = { relay: '—', lzt: '—' };
function setStatus(key, value) {
  status[key] = value;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('status', getStatus());
  }
}
function getStatus() {
  const s = loadSettings();
  const hasToken = !!loadToken();
  return {
    ...status,
    lzt: hasToken ? 'токен сохранён' : 'токен не задан',
    tts: loadTtsKey() ? 'ключ сохранён' : 'ключ не задан',
    slug: s.slug,
    configured: !!(s.slug && s.appSecret && hasToken && s.merchantId),
  };
}

// ── IPC окна настроек ──────────────────────────────────────────────
ipcMain.handle('settings:load', () => {
  const s = loadSettings();
  return { slug: s.slug, appSecret: s.appSecret, merchantId: s.merchantId, apiBase: s.apiBase, autostart: s.autostart, tokenSet: !!loadToken(), ttsKeySet: !!loadTtsKey() };
});
ipcMain.handle('settings:save', (_e, data) => {
  const s = loadSettings();
  const next = { ...s, ...data };
  if (typeof data.token === 'string' && data.token.trim()) saveToken(data.token.trim());
  if (typeof data.cartesiaKey === 'string' && data.cartesiaKey.trim()) {
    saveTtsKey(data.cartesiaKey.trim());
    // если релей уже подключён — ключ улетает сразу, не дожидаясь переподключения
    sendTtsKey(ws);
  }
  saveSettings(next);
  app.setLoginItemSettings({ openAtLogin: !!next.autostart });
  relayStop();
  relayConnect();
  return getStatus();
});
ipcMain.handle('status:get', () => getStatus());
// ── вкладка «Сообщения»: список, повтор в оверлей, скрыть/показать ──
ipcMain.handle('donations:list', () => getDonations());
ipcMain.handle('donations:replay', (_e, invoiceId) => {
  const item = donLog.items.find((d) => d.invoiceId === Number(invoiceId));
  if (!item) return { ok: false };
  // повтор — только алерт в оверлей, в реестр не пишем (дедуп по invoiceId и так бы съел)
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'donation_alert', sum: item.sum, username: item.username, text: item.text }));
  }
  return { ok: true };
});
ipcMain.handle('donations:hide', (_e, invoiceId) => {
  const id = Number(invoiceId);
  if (!donLog.hidden.includes(id)) donLog.hidden.push(id);
  saveDonations();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('donations', getDonations());
  return getDonations();
});
ipcMain.handle('donations:unhide', (_e, invoiceId) => {
  donLog.hidden = donLog.hidden.filter((x) => x !== Number(invoiceId));
  saveDonations();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('donations', getDonations());
  return getDonations();
});
ipcMain.handle('test:lzt', async () => {
  const token = loadToken();
  if (!token) return { ok: false, error: 'токен не задан' };
  try {
    // проверка LZT: пробуем создать инвойс 1 ₽ с lifetime 60 сек — он сам истечёт
    const s = loadSettings();
    const r = await fetch('https://prod-api.lzt.market/invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currency: 'rub', amount: 1, payment_id: `rsmine_check_${Date.now()}`, comment: 'RSMine проверка', merchant_id: s.merchantId, url_success: 'https://rsmine.ru', lifetime: 300 }),
    });
    const text = await r.text();
    if (r.ok) return { ok: true, note: 'связь с LZT есть, токен принят' };
    return { ok: false, error: `LZT ${r.status} — ${text.slice(0, 140)}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ── окно и трей ────────────────────────────────────────────────────
function createWindow() {
  settingsWindow = new BrowserWindow({
    width: 600,
    height: 840,
    show: false,
    backgroundColor: '#0b0b0c',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  settingsWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('close', (e) => {
    // закрытие = сворачивание в трей
    if (!(app.isQuitting ?? false)) {
      e.preventDefault();
      settingsWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('RSMine');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Настройки', click: () => { settingsWindow.show(); } },
    { label: 'Переподключить релей', click: () => { relayStop(); relayConnect(); } },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { settingsWindow.isVisible() ? settingsWindow.hide() : settingsWindow.show(); });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  const s = loadSettings();
  app.setLoginItemSettings({ openAtLogin: s.autostart !== false });
  relayConnect();
});
app.on('window-all-closed', (e) => { /* живём в трее */ });
app.on('before-quit', () => { app.isQuitting = true; relayStop(); });
