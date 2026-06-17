# AstraQuant AI V61 — Strict Ledger Rebuild

V61 removes the legacy checkpoint system and calculates all finance data from one formula:

```text
Equity = $1,000 initial capital + unique realized P/L + current floating P/L
Cash balance = $1,000 + unique realized P/L - locked margin
```

The 53 trades supplied in the screenshots total **+$29.1299**, so closed-trade equity is **$1,029.1299** before any current floating P/L.

## Important ENV

```env
ASTRAQUANT_INITIAL_CAPITAL=1000
```

Remove old checkpoint variables because V61 ignores them:

```env
ASTRAQUANT_LEDGER_ANCHOR_EQUITY
ASTRAQUANT_LEDGER_ANCHOR_VERSION
ASTRAQUANT_LEDGER_ANCHOR_AT
```

## Audit

Open `/api/ledger-audit` to compare trade count, realized P/L, floating P/L, locked margin, cash balance, and equity.


## V62 Abort Resilience Fix
- External CoinGecko/Yahoo requests retry once and use a longer configurable timeout.
- A temporary AbortError no longer marks the whole backend as fatal.
- `/api/state` returns cached Supabase/runtime data when a live-price refresh times out.
- UI shows BACKEND RETRYING or DATA DELAYED instead of raw `This operation was aborted`.


## V63 Scan Lifecycle Fix
- Scan market dibatasi ke aset prioritas agar tidak berjalan berlarut-larut.
- Analisis candle 1H dan 1D dijalankan paralel dengan concurrency terbatas.
- Status BACKEND_SCANNING selalu ditutup melalui finally dan status stale dipulihkan otomatis.
- Sinyal cache tidak dihapus ketika provider harga sedang timeout.
- Endpoint diagnosis baru: `/api/scan-health`.
- ENV opsional: `ASTRAQUANT_SCAN_ASSET_LIMIT=14`, `ASTRAQUANT_SCAN_CONCURRENCY=4`, `ASTRAQUANT_SCAN_STALE_MS=90000`.
