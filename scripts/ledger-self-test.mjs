import assert from "node:assert/strict";

process.env.VERCEL = "1";
process.env.ASTRAQUANT_INITIAL_CAPITAL = "1000";
const { canonicalLedger, rebuildCanonicalEquityCurve } = await import("../server.js");

const pnlValues = [
  36.18,-12.23,-6.22,1.12,-3.55,-2.41,
  24.32,-0.2968,-0.4521,-2.95,-0.2101,-5.43,
  -2.52,1.80,-0.4958,-0.5058,-0.6909,4.16,
  -4.03,-0.4902,0.1421,-0.1897,-0.0618,0.0937,
  0.1694,0.1588,-0.0139,-0.0225,0.0737,0.1182,
  0.1951,0.5250,0.1436,-0.0997,-0.3500,-0.2012,
  -1.48,-0.2895,-0.1821,-4.72,0.1785,0.0996,
  -0.1713,0.2597,2.87,1.13,0.1929,0.1740,
  0.1990,4.03,0.1635,0.5054,0.3911
];

const start = Date.parse("2026-06-08T15:24:00Z");
const runtime = {
  history: pnlValues.map((pnl, index) => ({
    id: `trade-${index}`,
    positionId: `position-${index}`,
    coin: `C${index}`,
    side: "LONG",
    pnl,
    closedAt: new Date(start + index * 60_000).toISOString()
  })),
  positions: [],
  equityCurve: [],
  balance: 0,
  equity: 0
};

const ledger = canonicalLedger(runtime);
assert.equal(ledger.ledgerTradeCount, 53);
assert.ok(Math.abs(ledger.realizedPnl - 29.1299) < 1e-9);
assert.ok(Math.abs(ledger.expectedEquity - 1029.1299) < 1e-9);
assert.ok(Math.abs(ledger.expectedCashBalance - 1029.1299) < 1e-9);

runtime.positions.push({ id: "open-1", margin: 150, unrealized: -5.25 });
const liveLedger = canonicalLedger(runtime);
assert.ok(Math.abs(liveLedger.expectedEquity - 1023.8799) < 1e-9);
assert.ok(Math.abs(liveLedger.expectedCashBalance - 879.1299) < 1e-9);

rebuildCanonicalEquityCurve(runtime, "test");
assert.ok(Math.abs(runtime.equityCurve[0].equity - 1000) < 1e-9);
assert.ok(Math.abs(runtime.equityCurve.at(-1).equity - 1023.8799) < 1e-9);

console.log("Ledger self-test passed: 53 trades = +$29.1299, closed equity = $1029.1299");
