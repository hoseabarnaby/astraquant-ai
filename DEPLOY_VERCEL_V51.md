# Deploy AstraQuant AI V51 to GitHub and Vercel

## Test lokal

```powershell
cd C:\Users\ASUS\Downloads\astraquant_ai_v51_xau_gold_fix
npm install
npm run check
npm start
```

Buka:

- `http://localhost:3000`
- `http://localhost:3000/api/health`
- `http://localhost:3000/api/xau-health` untuk memeriksa quote dan candle Gold.

## Upload ke GitHub

```powershell
git init
git add .
git commit -m "fix xau gold chart and signal v51"
git branch -M main
git remote add origin https://github.com/hoseabarnaby/astraquant-ai.git
git push -u origin main --force
```

Jika origin sudah ada:

```powershell
git remote set-url origin https://github.com/hoseabarnaby/astraquant-ai.git
git push -u origin main --force
```

## Environment Variables Vercel

Pastikan variabel berikut ada:

```text
ASTRAQUANT_ENABLE_XAUUSD=true
ASTRAQUANT_BLOCKLIST=SAHARA
ASTRAQUANT_XAU_MAX_CANDLE_GAP_PCT=8
ASTRAQUANT_XAU_MAX_WICK_PCT=5
ASTRAQUANT_XAU_MAX_QUOTE_GAP_PCT=3
ASTRAQUANT_XAU_MAX_LEVEL_RISK_PCT=3.5
```

V51 menghapus XAUUSD dan GC=F dari blocklist secara otomatis jika `ASTRAQUANT_ENABLE_XAUUSD` tidak disetel ke `false`, sehingga setting blocklist lama tidak lagi menyembunyikan Gold.
