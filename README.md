# AstraQuant AI V44 — Live Price Sync

# AstraQuant AI V42 — Vercel Trial

Versi ini dibuat khusus supaya bisa dicoba di Vercel.

Penting:
- Vercel bukan server long-running seperti Render/Fly/VPS.
- `setInterval` backend 24 jam tidak dipakai di Vercel.
- Engine akan ditrigger saat `/api/state` dipanggil dan bisa juga dipanggil manual lewat `/api/cron-tick`.
- Cocok untuk coba online tanpa kartu, demo UI, dan test link publik.
- Tidak cocok untuk AI paper engine 24 jam beneran.

## Deploy Vercel

- Framework Preset: Other
- Build Command: kosong / None
- Output Directory: kosong
- Install Command: npm install

Vercel akan memakai `vercel.json`.

## ENV wajib

```env
SUPABASE_URL=https://project-kamu.supabase.co
SUPABASE_SERVICE_ROLE_KEY=service_role_key_kamu
ASTRAQUANT_WORKSPACE_ID=astraquant_main_live
ASTRAQUANT_REBUILD_LEARNING_FROM_HISTORY=true
ASTRAQUANT_ENGINE_ENABLED=true
ASTRAQUANT_ENGINE_OPEN_TRADES=true
ASTRAQUANT_PRICE_MODE=coingecko
ASTRAQUANT_BLOCKLIST=SAHARA
ASTRAQUANT_VERCEL_TICK_ON_REQUEST=true
ASTRAQUANT_SERVERLESS_ENGINE_INTERVAL_MS=60000
ASTRAQUANT_SERVERLESS_PRICE_INTERVAL_MS=15000
```

## Local run

```powershell
cd C:\Users\ASUS\Downloads\astraquant_ai_v42_vercel_trial
npm install
npm run check
npm start
```


## V42.1 hotfix

- Fixed Vercel serverless entry to use ESM `export default app`.
- Local test still runs with `npm start`.
- Vercel mode does not run a 24h background loop, it triggers ticks by request/cron endpoint.

## V43 fixes

- Clean website title: `AstraQuant AI`.
- Mobile filters no longer get squeezed/truncated.
- Extra bottom spacing so the mobile nav does not cover card text.
- XAUUSD/GC=F is blocked by default to avoid broken gold chart scaling on the crypto paper dashboard.
- Chart trendlines are clipped/skipped if old extrapolated lines fly outside the visible price scale.

## V44 fixes

- `/api/state` refreshes open position prices before returning dashboard data.
- Paper tab price should stay closer to live CoinGecko spot prices on Vercel serverless.
- Adds clearer live price source/time metadata for positions.
- Adds extra bottom spacing on mobile.


## V45
- Equity modal upgraded with step-line mode and optional candle mode.
- Flat/no-trade periods render as a thin horizontal line instead of a thick band.
- Summary now shows start/current/high/low and change.


## V48 scroll and heading fix
- Every navigation tab now opens from the top of the page.
- Native hash anchor scrolling is disabled to prevent headings from hiding behind the sticky top bar.
- Home headline changed to “AstraQuant AI Trading Dashboard”.


## V49 mobile/overflow fix
- Mobile Signals is forced to one card per row.
- Paper Trading cards no longer overflow or clip on desktop/tablet.
- Recent Closed Trades uses a compact responsive layout.
