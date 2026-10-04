/*
 * HESTIA GATEWAY — Bot Telegram pembelian paket
 * Alur: /start -> Beli Paket -> (pilih model Sultan bila perlu) -> Gmail
 * -> bayar via DANA -> kirim bukti -> admin Setujui/Tolak -> key otomatis.
 *
 * Env: BOT_TOKEN, GATEWAY_URL, BOT_API_TOKEN, ADMIN_CHAT_ID, DATA_DIR
 */
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const GATEWAY_URL = String(process.env.GATEWAY_URL || 'https://hestia-gateway-production.up.railway.app').replace(/\/+$/, '');
const BOT_API_TOKEN = String(process.env.BOT_API_TOKEN || '').trim();
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DANA_QR = path.join(__dirname, 'assets', 'dana-qr.jpg');
const DANA_NUMBER = '083124856095';
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

if (!BOT_TOKEN) {
  console.error('[hestia-bot] BOT_TOKEN belum diisi. Isi di Railway Variables lalu restart service.');
  process.exit(1);
}
if (!BOT_API_TOKEN) console.warn('[hestia-bot] BOT_API_TOKEN kosong — panggilan ke gateway akan ditolak.');
if (!ADMIN_CHAT_ID) console.warn('[hestia-bot] ADMIN_CHAT_ID kosong — bukti pembayaran belum bisa diteruskan ke admin.');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); }
  catch { return []; }
}
function saveOrders(o) { fs.writeFileSync(ORDERS_FILE, JSON.stringify(o, null, 2)); }

/* ---------- util ---------- */
const rupiah = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const tgl = (ts) => new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
async function gw(pathname, opts = {}) {
  const r = await fetch(GATEWAY_URL + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-bot-token': BOT_API_TOKEN, ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
// Daftar paket fallback bila gateway tidak bisa dihubungi
const FALLBACK_PLANS = [
  { id: 'basic-1m', name: 'BASIC', price: 10000, tokens: 1000000, durationDays: 7, maxModels: 10, maxKeys: 5, desc: '1M token • 7 hari • 10 model' },
  { id: 'member-3m', name: 'MEMBER', price: 25000, tokens: 3000000, durationDays: 14, maxModels: 20, maxKeys: 10, desc: '3M token • 14 hari • 20 model' },
  { id: 'vip-8m', name: 'VIP', price: 50000, tokens: 8000000, durationDays: 30, maxModels: 9999, maxKeys: 20, desc: '8M token • 30 hari • FULL model' },
  { id: 'sultan', name: 'SULTAN', price: 350000, tokens: 1500000, durationDays: 30, maxModels: 8, maxKeys: 50, sultan: true, pick: 0, desc: '1,5M token • 30 hari • semua model mahal aktif' },
  { id: 'sultan-plus', name: 'SULTAN+', price: 150000, tokens: 1000000, durationDays: 30, maxModels: 3, maxKeys: 50, sultan: true, pick: 3, pool: 'mahal', desc: '1M token • 30 hari • pilih 3 model mahal' },
  { id: 'sultan-plus2', name: 'SULTAN++', price: 100000, tokens: 1000000, durationDays: 30, maxModels: 5, maxKeys: 50, sultan: true, pick: 5, pool: 'mid', desc: '1M token • 30 hari • pilih 5 model menengah' },
];
let plansCache = FALLBACK_PLANS;
async function refreshPlans() {
  try {
    const r = await gw('/api/plans');
    if (r.plans && r.plans.length) plansCache = r.plans.filter((p) => p.id !== 'free-500k');
  } catch (e) { console.warn('[hestia-bot] gagal ambil /api/plans:', e.message); }
}
const paidPlans = () => plansCache;
const getPlan = (id) => paidPlans().find((p) => p.id === id);

/* ---------- bot ---------- */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.on('polling_error', (e) => console.warn('[hestia-bot] polling_error:', e.message));
process.on('unhandledRejection', (e) => console.warn('[hestia-bot] unhandled:', e && e.message));

const sessions = new Map(); // chatId -> { step, planId, picks, poolList, email, orderId }
const sess = (chatId) => {
  if (!sessions.has(chatId)) sessions.set(chatId, { step: 'idle' });
  return sessions.get(chatId);
};

const BTN = {
  menu: () => ({ reply_markup: { inline_keyboard: [
    [{ text: 'Beli Paket', callback_data: 'menu:buy' }, { text: 'Daftar Harga', callback_data: 'menu:price' }],
    [{ text: 'Bantuan', callback_data: 'menu:help' }],
  ] } }),
  back: () => ({ reply_markup: { inline_keyboard: [[{ text: 'Kembali', callback_data: 'menu:main' }]] } }),
};

function priceText() {
  const lines = paidPlans().map((p) =>
    p.name + ' — ' + rupiah(p.price) + '\n' + p.tokens.toLocaleString('id-ID') + ' token • ' +
    p.durationDays + ' hari • ' + p.maxKeys + ' key\n' + (p.desc || ''));
  return 'Daftar harga Hestia Gateway:\n\n' + lines.join('\n\n') +
    '\n\nPembayaran via DANA. Key dikirim otomatis setelah admin menyetujui bukti bayar.';
}

async function showBuyList(chatId, msgId) {
  await refreshPlans();
  const kb = paidPlans().map((p) => [{ text: p.name + ' — ' + rupiah(p.price), callback_data: 'buy:' + p.id }]);
  kb.push([{ text: 'Kembali', callback_data: 'menu:main' }]);
  const text = 'Pilih paket yang mau dibeli:';
  if (msgId) await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: kb } });
  else await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: kb } });
}

function planSummary(p) {
  return 'Paket: ' + p.name + '\nHarga: ' + rupiah(p.price) + '\nToken: ' +
    p.tokens.toLocaleString('id-ID') + '\nMasa aktif: ' + p.durationDays + ' hari\nMaks key: ' + p.maxKeys;
}

async function askEmail(chatId, msgId) {
  const s = sess(chatId);
  s.step = 'await_email';
  const text = 'Ketik Gmail kamu yang sudah terdaftar di Hestia Gateway:\n\nBelum daftar? Daftar dulu di ' + GATEWAY_URL;
  if (msgId) await bot.editMessageText(text, { chat_id: chatId, message_id: msgId });
  else await bot.sendMessage(chatId, text);
}

function pickerKeyboard(s) {
  const rows = s.poolList.map((m, i) => {
    const on = s.picks.includes(m.id);
    return [{ text: (on ? '[x] ' : '[ ] ') + m.alias, callback_data: 'pk:' + i }];
  });
  rows.push([{ text: 'Selesai pilih (' + s.picks.length + '/' + s.needPick + ')', callback_data: 'pk:done' }]);
  rows.push([{ text: 'Batal', callback_data: 'menu:buy' }]);
  return { inline_keyboard: rows };
}

async function startPicker(chatId, msgId, plan) {
  const s = sess(chatId);
  const r = await gw('/api/bot/pools');
  if (!r.ok) {
    await bot.sendMessage(chatId, 'Gagal mengambil daftar model: ' + (r.msg || 'gateway error') + '. Coba lagi nanti.');
    return;
  }
  const poolKey = plan.pool === 'mid' ? 'mid' : 'mahal';
  const list = (r.pools[poolKey] || []).filter((m) => m.active);
  if (list.length < plan.pick) {
    await bot.sendMessage(chatId, 'Maaf, model aktif untuk paket ' + plan.name + ' saat ini hanya ' + list.length +
      ' (butuh ' + plan.pick + '). Coba lagi nanti atau hubungi admin.');
    return;
  }
  s.step = 'picking';
  s.poolList = list;
  s.picks = [];
  s.needPick = plan.pick;
  const label = poolKey === 'mid' ? 'model menengah' : 'model mahal';
  const text = 'Paket ' + plan.name + ' — pilih TEPAT ' + plan.pick + ' ' + label + ':\n(Ketuk untuk centang/hapus centang)';
  if (msgId) await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: pickerKeyboard(s) });
  else await bot.sendMessage(chatId, text, { reply_markup: pickerKeyboard(s) });
}

async function sendPayment(chatId) {
  const s = sess(chatId);
  const p = getPlan(s.planId);
  if (!p) { await bot.sendMessage(chatId, 'Paket tidak valid. Ketik /start untuk mulai lagi.'); return; }
  s.step = 'await_proof';
  let modelLine = '';
  if (p.sultan && p.pick > 0) {
    const names = s.poolList.filter((m) => s.picks.includes(m.id)).map((m) => m.alias);
    modelLine = '\nModel pilihan: ' + names.join(', ');
  } else if (p.sultan) {
    modelLine = '\nModel: semua model mahal yang aktif (otomatis)';
  }
  const caption = 'Ringkasan pesanan\n\n' + planSummary(p) + '\nGmail: ' + s.email + modelLine +
    '\n\nTransfer TEPAT ' + rupiah(p.price) + ' ke DANA:\n' + DANA_NUMBER +
    '\n(atau scan QR di atas)\n\nLalu kirim FOTO bukti transfer ke sini.';
  const kb = { reply_markup: { inline_keyboard: [[{ text: 'Batalkan pesanan', callback_data: 'menu:buy' }]] } };
  if (fs.existsSync(DANA_QR)) await bot.sendPhoto(chatId, DANA_QR, { caption, ...kb });
  else await bot.sendMessage(chatId, caption + '\n\n(QR tidak tersedia, transfer ke nomor DANA di atas)', kb);
}

function orderText(o) {
  const p = getPlan(o.planId) || { name: o.planId, price: o.price };
  return 'Pesanan ' + o.id + '\nPaket: ' + p.name + ' — ' + rupiah(o.price) +
    '\nGmail: ' + o.email + '\nTelegram: ' + o.buyerName +
    (o.pickNames && o.pickNames.length ? '\nModel: ' + o.pickNames.join(', ') : '') +
    '\nWaktu: ' + tgl(o.ts);
}

/* ---------- /start ---------- */
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  console.log('[hestia-bot] /start dari chat_id=' + chatId + ' user=' + (msg.from.username || msg.from.first_name || '?'));
  sessions.delete(chatId);
  await refreshPlans();
  await bot.sendMessage(chatId,
    'Selamat datang di Hestia Gateway!\n\nBeli paket API key AI di sini. Pembayaran via DANA, key dikirim otomatis setelah admin menyetujui bukti bayar.',
    BTN.menu());
});

/* ---------- callback ---------- */
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;
  const data = q.data || '';
  const s = sess(chatId);
  try {
    if (data === 'menu:main') {
      sessions.delete(chatId);
      await bot.editMessageText('Mau apa?', { chat_id: chatId, message_id: msgId, ...BTN.menu() });
    } else if (data === 'menu:price') {
      await refreshPlans();
      await bot.editMessageText(priceText(), { chat_id: chatId, message_id: msgId, ...BTN.back() });
    } else if (data === 'menu:help') {
      await bot.editMessageText(
        'Bantuan\n\n1. Ketuk Beli Paket, pilih paket.\n2. Untuk SULTAN+/SULTAN++, pilih modelnya.\n3. Masukkan Gmail yang terdaftar di web Hestia Gateway.\n' +
        '4. Transfer via DANA sesuai nominal, kirim foto bukti.\n5. Admin verifikasi, key dikirim otomatis ke sini.\n\nWeb: ' + GATEWAY_URL,
        { chat_id: chatId, message_id: msgId, ...BTN.back() });
    } else if (data === 'menu:buy') {
      sessions.set(chatId, { step: 'idle' });
      await showBuyList(chatId, msgId);
    } else if (data.startsWith('buy:')) {
      const p = getPlan(data.slice(4));
      if (!p) { await bot.answerCallbackQuery(q.id, { text: 'Paket tidak dikenal.' }); return; }
      s.planId = p.id;
      if (p.sultan && p.pick > 0) { await startPicker(chatId, msgId, p); }
      else {
        const extra = p.sultan ? '\n\nSemua model mahal yang aktif dibuka otomatis.' : '';
        await bot.editMessageText(planSummary(p) + extra, {
          chat_id: chatId, message_id: msgId,
          reply_markup: { inline_keyboard: [
            [{ text: 'Lanjut', callback_data: 'go:email' }],
            [{ text: 'Kembali', callback_data: 'menu:buy' }],
          ] },
        });
      }
    } else if (data === 'go:email') {
      await askEmail(chatId, msgId);
    } else if (data === 'pk:done') {
      if (s.step !== 'picking') return;
      if (s.picks.length !== s.needPick) {
        await bot.answerCallbackQuery(q.id, { text: 'Pilih tepat ' + s.needPick + ' model (sekarang ' + s.picks.length + ').' });
        return;
      }
      await askEmail(chatId, null);
    } else if (data.startsWith('pk:')) {
      if (s.step !== 'picking' || !s.poolList) return;
      const i = parseInt(data.slice(3), 10);
      const m = s.poolList[i];
      if (!m) return;
      if (s.picks.includes(m.id)) s.picks = s.picks.filter((x) => x !== m.id);
      else {
        if (s.picks.length >= s.needPick) {
          await bot.answerCallbackQuery(q.id, { text: 'Maksimal ' + s.needPick + ' model.' });
          return;
        }
        s.picks.push(m.id);
      }
      const p = getPlan(s.planId);
      const label = (p && p.pool === 'mid' ? 'model menengah' : 'model mahal');
      await bot.editMessageText('Paket ' + (p ? p.name : '') + ' — pilih TEPAT ' + s.needPick + ' ' + label + ':',
        { chat_id: chatId, message_id: msgId, reply_markup: pickerKeyboard(s) });
      await bot.answerCallbackQuery(q.id);
    } else if (data.startsWith('ap:') || data.startsWith('rj:')) {
      // Hanya admin yang boleh menyetujui/menolak
      if (!ADMIN_CHAT_ID || String(q.from.id) !== String(ADMIN_CHAT_ID)) {
        await bot.answerCallbackQuery(q.id, { text: 'Hanya admin.' });
        return;
      }
      const approve = data.startsWith('ap:');
      const orderId = data.slice(3);
      const orders = loadOrders();
      const o = orders.find((x) => x.id === orderId);
      if (!o || o.status !== 'pending') {
        await bot.answerCallbackQuery(q.id, { text: 'Order tidak ditemukan / sudah diproses.' });
        return;
      }
      if (approve) {
        const p = getPlan(o.planId);
        const r = await gw('/api/bot/keys', {
          method: 'POST',
          body: JSON.stringify({ email: o.email, planId: o.planId, name: (p ? p.name : o.planId) + ' via Bot', modelPicks: o.picks }),
        });
        if (!r.ok) {
          await bot.answerCallbackQuery(q.id, { text: 'Gagal buat key: ' + (r.msg || 'error') });
          await bot.sendMessage(chatId, 'Gagal membuat key untuk ' + o.id + ': ' + (r.msg || 'error') + '. Buatkan manual via dashboard.');
          return;
        }
        o.status = 'approved'; saveOrders(orders);
        const lines = r.keys.map((k, i) =>
          (r.keys.length > 1 ? 'Key ' + (i + 1) + ' (' + k.providerName + '):\n' : '') +
          'Key: ' + k.key + '\nBase URL: ' + k.baseUrl +
          '\nToken: ' + k.tokenLimit.toLocaleString('id-ID') + ' • Aktif sampai ' + tgl(k.expiresAt) +
          '\nModel: ' + k.modelCount).join('\n\n');
        await bot.sendMessage(o.buyerChatId,
          'Pembayaran disetujui. Key kamu sudah aktif:\n\nPaket: ' + (r.keys[0] && r.keys[0].planName) +
          '\n\n' + lines +
          '\n\nSimpan baik-baik. Key ini juga bisa dilihat di halaman Key Saya pada web Hestia Gateway.\n\nCara pakai singkat:\nBase URL: ' + GATEWAY_URL + '/v1\nAPI Key: key di atas\nHeader: Authorization: Bearer <key>');
        await bot.editMessageCaption(orderText(o) + '\n\nStatus: DISETUJUI',
          { chat_id: chatId, message_id: msgId });
        await bot.answerCallbackQuery(q.id, { text: 'Disetujui, key terkirim ke pembeli.' });
      } else {
        o.status = 'rejected'; saveOrders(orders);
        await bot.sendMessage(o.buyerChatId,
          'Maaf, bukti pembayaran untuk pesanan ' + o.id + ' ditolak admin.\nPastikan nominal transfer pas dan bukti valid, lalu buat pesanan baru dengan /start.');
        await bot.editMessageCaption(orderText(o) + '\n\nStatus: DITOLAK',
          { chat_id: chatId, message_id: msgId });
        await bot.answerCallbackQuery(q.id, { text: 'Ditolak.' });
      }
    }
  } catch (e) {
    console.warn('[hestia-bot] callback error:', e.message);
    try { await bot.answerCallbackQuery(q.id, { text: 'Terjadi kesalahan, coba lagi.' }); } catch {}
  }
});

/* ---------- pesan teks: input email ---------- */
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const s = sess(chatId);
  if (s.step !== 'await_email') return;
  const email = msg.text.trim().toLowerCase();
  if (!/^[^@\s]+@gmail\.com$/.test(email)) {
    await bot.sendMessage(chatId, 'Itu bukan Gmail yang valid. Ketik lagi Gmail kamu (contoh: nama@gmail.com).');
    return;
  }
  const r = await gw('/api/bot/user?email=' + encodeURIComponent(email));
  if (!r.ok) { await bot.sendMessage(chatId, 'Gateway error: ' + (r.msg || 'coba lagi nanti.')); return; }
  if (!r.exists) {
    await bot.sendMessage(chatId, 'Email ' + email + ' belum terdaftar di Hestia Gateway.\nDaftar dulu di ' + GATEWAY_URL + ' lalu ketik lagi Gmail kamu di sini.');
    return;
  }
  if (r.suspended) {
    await bot.sendMessage(chatId, 'Akun ' + email + ' sedang di-suspend. Hubungi admin.');
    sessions.delete(chatId);
    return;
  }
  s.email = email;
  s.buyerName = (msg.from.username ? '@' + msg.from.username : msg.from.first_name || 'Tanpa Nama');
  await sendPayment(chatId);
});

/* ---------- foto bukti ---------- */
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const s = sess(chatId);
  if (s.step !== 'await_proof' || !s.email || !s.planId) {
    await bot.sendMessage(chatId, 'Kamu belum punya pesanan aktif. Ketik /start untuk mulai.');
    return;
  }
  const p = getPlan(s.planId);
  const photo = msg.photo[msg.photo.length - 1];
  const orders = loadOrders();
  const order = {
    id: 'TG-' + Date.now().toString(36).toUpperCase(),
    buyerChatId: chatId,
    buyerName: s.buyerName || (msg.from.username ? '@' + msg.from.username : msg.from.first_name || '?'),
    email: s.email, planId: s.planId, price: p ? p.price : 0,
    picks: s.picks || [],
    pickNames: (s.poolList || []).filter((m) => (s.picks || []).includes(m.id)).map((m) => m.alias),
    photoFileId: photo.file_id,
    status: 'pending', ts: Date.now(),
  };
  orders.unshift(order); saveOrders(orders);
  sessions.delete(chatId);

  if (!ADMIN_CHAT_ID) {
    console.warn('[hestia-bot] ADMIN_CHAT_ID kosong — order ' + order.id + ' tersimpan, menunggu admin terhubung.');
    await bot.sendMessage(chatId, 'Bukti diterima dan tersimpan. Admin belum terhubung ke bot — pesananmu diproses setelah admin terhubung. Terima kasih sudah menunggu.');
    return;
  }
  try {
    await bot.sendPhoto(ADMIN_CHAT_ID, photo.file_id, {
      caption: orderText(order),
      reply_markup: { inline_keyboard: [[
        { text: 'Setujui', callback_data: 'ap:' + order.id },
        { text: 'Tolak', callback_data: 'rj:' + order.id },
      ]] },
    });
    await bot.sendMessage(chatId, 'Bukti pembayaran diterima. Menunggu verifikasi admin — key dikirim otomatis setelah disetujui.');
  } catch (e) {
    console.warn('[hestia-bot] gagal teruskan ke admin:', e.message);
    await bot.sendMessage(chatId, 'Bukti tersimpan, tapi gagal diteruskan ke admin saat ini. Coba kirim ulang nanti atau hubungi admin.');
  }
});

refreshPlans().then(() => {
  console.log('[hestia-bot] jalan. Gateway: ' + GATEWAY_URL + ' | plans: ' + paidPlans().length);
});
