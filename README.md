# Hestia Bot

Bot Telegram untuk pembelian paket Hestia Gateway.

Alur: pembeli pilih paket di bot -> bayar via DANA -> kirim foto bukti ->
bot teruskan ke admin -> admin ketuk Setujui -> bot buatkan key via gateway
dan kirim ke pembeli otomatis.

## Env yang dibutuhkan

- `BOT_TOKEN` — token dari @BotFather (diisi pemilik via Railway Variables)
- `GATEWAY_URL` — URL gateway (default: https://hestia-gateway-production.up.railway.app)
- `BOT_API_TOKEN` — harus SAMA dengan env BOT_API_TOKEN di service gateway
- `ADMIN_CHAT_ID` — chat ID Telegram admin (diisi setelah admin mengetuk START di bot; lihat log `[hestia-bot] /start dari chat_id=...`)

## Jalankan lokal

npm install
cp .env.example .env   # lalu isi
npm start
