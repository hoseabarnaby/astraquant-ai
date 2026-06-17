import assert from "node:assert/strict";

process.env.VERCEL = "1";
const { sanitizeYahooCandles, safeProjectedLine, isXauSignalSane } = await import("../server.js");

const base = 2300;
const raw = Array.from({ length: 80 }, (_, index) => {
  const close = base + index * 0.35 + Math.sin(index / 4) * 2;
  return {
    time: 1_700_000_000_000 + index * 3_600_000,
    open: close - 0.8,
    high: close + 2.2,
    low: close - 2.4,
    close,
    volume: 100 + index
  };
});
raw[45] = { ...raw[45], open: 7000, high: 7600, low: 6900, close: 7200 };

const cleaned = sanitizeYahooCandles(raw, { type: "gold", symbol: "GC=F" });
assert.ok(cleaned.length >= 70, "Gold guard should preserve normal candles");
assert.ok(Math.max(...cleaned.map(c => c.high)) < 3000, "Gold guard should remove the extreme candle");

const rejectedProjection = safeProjectedLine(
  { index: 10, price: 2300 },
  { index: 11, price: 3000 },
  80,
  2325,
  18
);
assert.equal(rejectedProjection, null, "Extreme projected trendline must be rejected");

assert.equal(isXauSignalSane({
  coin: "XAUUSD", side: "LONG", price: 2325, entry: 2324, sl: 2288, tp: 2382
}), true);
assert.equal(isXauSignalSane({
  coin: "XAUUSD", side: "LONG", price: 2325, entry: 2324, sl: 700, tp: 8000
}), false);

console.log("XAU self-test passed");
