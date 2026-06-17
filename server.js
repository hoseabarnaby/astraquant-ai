
import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const GLOBAL_ENGINE_USER_ID = process.env.ASTRAQUANT_WORKSPACE_ID || "astraquant_main_live";
const GLOBAL_ENGINE_INTERVAL_MS = Number(process.env.ASTRAQUANT_ENGINE_INTERVAL_MS || 10000);
const GLOBAL_ENGINE_ENABLED = process.env.ASTRAQUANT_ENGINE_ENABLED !== "false";
const GLOBAL_ENGINE_OPEN_TRADES = process.env.ASTRAQUANT_ENGINE_OPEN_TRADES !== "false";
const SERVERLESS_ENGINE_INTERVAL_MS = Number(process.env.ASTRAQUANT_SERVERLESS_ENGINE_INTERVAL_MS || 60000);
const SCAN_ASSET_LIMIT = Math.max(6, Number(process.env.ASTRAQUANT_SCAN_ASSET_LIMIT || 14));
const SCAN_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.ASTRAQUANT_SCAN_CONCURRENCY || 4)));
const SCAN_STALE_MS = Math.max(30_000, Number(process.env.ASTRAQUANT_SCAN_STALE_MS || 90_000));
const SERVERLESS_PRICE_INTERVAL_MS = Number(process.env.ASTRAQUANT_SERVERLESS_PRICE_INTERVAL_MS || 15000);
let lastServerlessEngineTickAt = 0;
let lastServerlessPriceTickAt = 0;
const MIGRATE_FROM_WORKSPACES = (process.env.ASTRAQUANT_MIGRATE_FROM_WORKSPACES || "astraquant_global_engine_v39,astraquant_global_engine_v38,astraquant_global_engine_v37,astraquant_global_engine_v36,astraquant_global_engine_v35,astraquant_global_engine_v34,astraquant_global_engine_v33,astraquant_global_engine_v32,astraquant_global_engine_v31,astraquant_global_engine_v30,astraquant_global_engine_v29,astraquant_global_engine_v28,astraquant_global_engine_v27,astraquant_v25_safe_demo,astraquant_v21_live,public_workspace")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);
const GLOBAL_PRICE_TICK_MS = Number(process.env.ASTRAQUANT_PRICE_TICK_MS || 5000);
const PRICE_MODE = (process.env.ASTRAQUANT_PRICE_MODE || "coingecko").toLowerCase();
const XAU_SYMBOL = "GC=F";
const XAU_COIN = "XAUUSD";
const XAU_ENABLED = process.env.ASTRAQUANT_ENABLE_XAUUSD !== "false";
const DEFAULT_BLOCKLIST = "SAHARA";
const BLOCKED_COINS = new Set(
  `${DEFAULT_BLOCKLIST},${process.env.ASTRAQUANT_BLOCKLIST || ""}`
    .split(",")
    .map(x => x.trim().toUpperCase())
    .filter(Boolean)
);
// XAU is explicitly enabled by default in V51. This also overrides an old
// Vercel blocklist left behind by versions that temporarily hid Gold.
if (XAU_ENABLED) {
  BLOCKED_COINS.delete(XAU_COIN);
  BLOCKED_COINS.delete(XAU_SYMBOL);
}
const SUPABASE_READY = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = SUPABASE_READY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const MEMORY_STATE = new Map();
const loopRunning = new Set();
const priceLoopRunning = new Set();
const activeUsers = new Map();

let liveTickerCache = new Map();
let liveTickerUpdatedAt = null;
let liveTickerSource = "none";

const YAHOO_ALIASES = {
  WBTC: "BTC-USD", WETH: "ETH-USD", STETH: "ETH-USD", TON: "TON11419-USD",
  RENDER: "RENDER-USD", RNDR: "RNDR-USD", POL: "POL-USD", MATIC: "MATIC-USD"
};

const NARRATIVE_RULES = [
  { match: ["bitcoin", "btc"], tags: ["Bitcoin", "ETF", "digital gold", "market leader"], boost: 4 },
  { match: ["ethereum", "eth", "staked"], tags: ["Ethereum", "staking", "DeFi", "L2 ecosystem"], boost: 4 },
  { match: ["solana", "sol"], tags: ["Solana", "memecoin", "DePIN", "consumer apps"], boost: 5 },
  { match: ["near", "render", "fet", "tao", "ai", "artificial", "bittensor"], tags: ["AI narrative", "compute", "data economy"], boost: 6 },
  { match: ["chainlink", "link"], tags: ["oracle", "RWA", "data infrastructure"], boost: 5 },
  { match: ["doge", "shib", "pepe", "bonk", "floki", "meme"], tags: ["memecoin", "social momentum", "high volatility"], boost: 3 },
  { match: ["ondo", "pendle", "maker", "aave", "uniswap", "curve"], tags: ["DeFi", "RWA", "yield", "protocol revenue"], boost: 5 },
  { match: ["avax", "sui", "aptos", "sei", "inj", "arbitrum", "optimism"], tags: ["Layer-1/L2", "ecosystem growth", "high beta"], boost: 4 }
];

let dynamicUniverse = [];
let dynamicUniverseUpdatedAt = null;
let marketRowsCache = [];
let marketRowsUpdatedAt = null;

function nowIso() {
  return new Date().toISOString();
}

function requireAdminToken(req) {
  const token = process.env.ASTRAQUANT_ADMIN_TOKEN;
  if (!token) return false;
  return req.headers["x-astraquant-admin"] === token || req.query.admin_token === token;
}

function getUserId(req) {
  // V26: one global bot workspace for everyone. Visitors are viewers only.
  // 1000 users online still read the same bot state, not 1000 separate positions.
  return GLOBAL_ENGINE_USER_ID;
}

function emptyRuntime(userId) {
  return {
    userId,
    balance: 1000,
    equity: 1000,
    riskPerTrade: Math.min(0.05, Math.max(0.001, Number(process.env.ASTRAQUANT_MAX_RISK_PER_TRADE || 0.05))),
    positions: [],
    history: [],
    memory: {},
    equityCurve: [],
    ledgerAnchor: null,
    lastScan: [],
    skippedTrades: [],
    universe: dynamicUniverse,
    universeUpdatedAt: dynamicUniverseUpdatedAt,
    source: SUPABASE_READY ? "Online Memory + Smart Screener" : "Demo memory only: Supabase .env missing",
    lastSync: null,
    status: SUPABASE_READY ? "BOOTING" : "SUPABASE_NOT_CONNECTED",
    staleExitHours: intradayMaxHoldHours(),
    minReviewHours: intradayMinHoldHours(),
    signalFlipExit: true,
    storageMode: SUPABASE_READY ? "supabase_online" : "memory_demo",
    liveTickerSource,
    liveTickerUpdatedAt,
    autoEnabled: GLOBAL_ENGINE_OPEN_TRADES,
    safeMode: true,
    maxOpenPositions: Number(process.env.ASTRAQUANT_MAX_OPEN_POSITIONS || 2),
    maxMargin: Number(process.env.ASTRAQUANT_MAX_MARGIN || 0),
    positionAllocationMinPct: Number(process.env.ASTRAQUANT_POSITION_ALLOCATION_MIN_PCT || 0.10),
    positionAllocationMaxPct: Number(process.env.ASTRAQUANT_POSITION_ALLOCATION_MAX_PCT || 0.15),
    maxTotalExposurePct: Number(process.env.ASTRAQUANT_MAX_TOTAL_EXPOSURE_PCT || 0.45),
    minPositionMargin: Number(process.env.ASTRAQUANT_MIN_POSITION_MARGIN || 20),
    maxPriceRisk: Number(process.env.ASTRAQUANT_MAX_PRICE_RISK || 0.035),
    scanState: {
      inProgress: false,
      startedAt: null,
      finishedAt: null,
      durationMs: 0,
      processed: 0,
      total: 0,
      valid: 0,
      failed: 0,
      partial: false
    }
  };
}




function configuredInitialCapital() {
  const value = Number(process.env.ASTRAQUANT_INITIAL_CAPITAL || 1000);
  return Number.isFinite(value) && value >= 0 ? value : 1000;
}

const VERIFIED_SCREENSHOT_LEDGER = Object.freeze({
  source: "user_verified_trade_history_screenshots_2026-06-17",
  initialCapital: 1000,
  closedTradeCount: 53,
  realizedPnl: 29.1299,
  closedTradeEquity: 1029.1299
});

function canonicalHistory(runtime) {
  const seen = new Set();
  return [...(runtime.history || [])]
    .filter(trade => {
      const pnl = Number(trade?.pnl);
      const closed = new Date(trade?.closedAt || 0).getTime();
      if (!Number.isFinite(pnl) || !Number.isFinite(closed)) return false;
      const key = trade.positionId
        ? `pos:${trade.positionId}`
        : trade.id
          ? `id:${trade.id}`
          : `trade:${trade.coin}:${trade.side}:${trade.openedAt}:${trade.closedAt}:${trade.entry}:${trade.exit}:${pnl}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
}

function realizedPnlAllHistory(runtime) {
  return canonicalHistory(runtime).reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
}

function currentOpenPnl(runtime) {
  return (runtime.positions || []).reduce((sum, position) => sum + Number(position.unrealized || 0), 0);
}

function currentLockedMargin(runtime) {
  return (runtime.positions || []).reduce((sum, position) => sum + Number(position.margin || 0), 0);
}

function canonicalLedger(runtime) {
  const initialCapital = configuredInitialCapital();
  const trades = canonicalHistory(runtime);
  const realizedPnl = trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const lockedMargin = currentLockedMargin(runtime);
  const openPnl = currentOpenPnl(runtime);
  const expectedEquity = initialCapital + realizedPnl + openPnl;
  const expectedCashBalance = initialCapital + realizedPnl - lockedMargin;
  const referenceApplies = trades.length === VERIFIED_SCREENSHOT_LEDGER.closedTradeCount;
  const referenceDifference = referenceApplies
    ? realizedPnl - VERIFIED_SCREENSHOT_LEDGER.realizedPnl
    : null;

  return {
    initialCapital,
    realizedPnl,
    openPnl,
    lockedMargin,
    expectedCashBalance,
    expectedEquity,
    historyCount: (runtime.history || []).length,
    ledgerTradeCount: trades.length,
    openPositions: (runtime.positions || []).length,
    referenceSnapshot: VERIFIED_SCREENSHOT_LEDGER,
    referenceApplies,
    referenceDifference,
    formula: "equity = initial capital + unique closed-trade P/L + current open P/L"
  };
}

function parseLedgerAnchorRow() {
  // V61 ignores all legacy checkpoint rows. They were created while the old
  // accounting model was drifting and must never alter strict ledger equity.
  return null;
}

async function saveLedgerAnchor(runtime) {
  if (!supabase) return;
  const ledger = canonicalLedger(runtime);
  const payload = JSON.stringify({
    version: "v61-strict-ledger",
    initialCapital: ledger.initialCapital,
    formula: ledger.formula,
    updatedAt: nowIso()
  });
  const { error } = await supabase.from("ai_memory").upsert({
    user_id: runtime.userId,
    key: "__ledger_anchor__",
    coin: "EQUITY",
    side: "STRICT_LEDGER",
    trades: ledger.ledgerTradeCount,
    wins: 0,
    losses: 0,
    avg_pnl_pct: 0,
    weight_adjustment: 0,
    mistake_tags: [],
    notes: [payload],
    updated_at: nowIso()
  }, { onConflict: "user_id,key" });
  if (error) console.warn("save strict ledger metadata error:", error.message);
}

async function ensureLedgerAnchor(runtime) {
  runtime.ledgerAnchor = {
    equity: configuredInitialCapital(),
    openPnl: 0,
    positionOpenPnl: {},
    anchoredAt: canonicalHistory(runtime)[0]?.closedAt || nowIso(),
    version: "v61-strict-ledger",
    source: "configured_initial_capital"
  };
  await saveLedgerAnchor(runtime);
  return runtime.ledgerAnchor;
}

function rebuildCanonicalEquityCurve(runtime, reason = "strict_ledger_rebuild") {
  const initialCapital = configuredInitialCapital();
  const trades = canonicalHistory(runtime);
  const firstTradeTime = trades[0]?.closedAt
    ? new Date(new Date(trades[0].closedAt).getTime() - 1000).toISOString()
    : nowIso();
  const points = [{
    time: firstTradeTime,
    equity: initialCapital,
    balance: initialCapital,
    openPnl: 0,
    openPositions: 0,
    reason: "initial_capital"
  }];

  let realizedEquity = initialCapital;
  for (const trade of trades) {
    realizedEquity += Number(trade.pnl || 0);
    points.push({
      time: trade.closedAt,
      equity: realizedEquity,
      balance: realizedEquity,
      openPnl: 0,
      openPositions: 0,
      reason: trade.closeReason || "realized_trade"
    });
  }

  const ledger = canonicalLedger(runtime);
  points.push({
    time: nowIso(),
    equity: ledger.expectedEquity,
    balance: ledger.expectedCashBalance,
    openPnl: ledger.openPnl,
    openPositions: ledger.openPositions,
    reason
  });

  runtime.equityCurve = normalizeEquityCurve(points);
  runtime.equityCurveDirty = true;
  return runtime.equityCurve;
}

function reconcileLedger(runtime, reason = "strict_ledger_check", options = {}) {
  const ledger = canonicalLedger(runtime);
  const storedCashBalance = Number(runtime.balance || 0);
  const storedEquity = Number(runtime.equity || 0);
  const cashDifference = ledger.expectedCashBalance - storedCashBalance;
  const equityDifference = ledger.expectedEquity - storedEquity;
  const tolerance = Number(process.env.ASTRAQUANT_ACCOUNTING_TOLERANCE_USD || 0.01);
  const driftDetected = Math.abs(cashDifference) > tolerance || Math.abs(equityDifference) > tolerance;

  runtime.balance = ledger.expectedCashBalance;
  runtime.equity = ledger.expectedEquity;
  runtime.accountingRepair = driftDetected ? {
    repairedAt: nowIso(),
    reason,
    storedCashBalance,
    expectedCashBalance: ledger.expectedCashBalance,
    cashDifference,
    storedEquity,
    expectedEquity: ledger.expectedEquity,
    equityDifference
  } : runtime.accountingRepair || null;

  if ((driftDetected || options.forceCurve) && options.rebuildCurve !== false) {
    rebuildCanonicalEquityCurve(runtime, "strict_ledger_reconciliation");
  }

  runtime.accounting = buildAccountingBreakdown(runtime);
  return { ...ledger, storedCashBalance, storedEquity, cashDifference, equityDifference, driftDetected };
}

function buildAccountingBreakdown(runtime) {
  const ledger = canonicalLedger(runtime);
  return {
    cashBalance: Number(runtime.balance || ledger.expectedCashBalance),
    lockedMargin: ledger.lockedMargin,
    openPnl: ledger.openPnl,
    computedEquity: Number(runtime.equity || ledger.expectedEquity),
    initialCapital: ledger.initialCapital,
    realizedPnl: ledger.realizedPnl,
    expectedCashBalance: ledger.expectedCashBalance,
    expectedEquity: ledger.expectedEquity,
    cashDifference: ledger.expectedCashBalance - Number(runtime.balance || 0),
    equityDifference: ledger.expectedEquity - Number(runtime.equity || 0),
    openPositions: ledger.openPositions,
    historyCount: ledger.historyCount,
    ledgerTradeCount: ledger.ledgerTradeCount,
    referenceSnapshot: ledger.referenceSnapshot,
    referenceApplies: ledger.referenceApplies,
    referenceDifference: ledger.referenceDifference,
    formula: ledger.formula,
    repair: runtime.accountingRepair || null
  };
}

async function repairHistoricalDuplicateMargins(runtime) {
  if (!supabase) return { count: 0, refundedMargin: 0 };
  const { data, error } = await supabase
    .from("ai_positions")
    .select("id,margin,status,reason")
    .eq("user_id", runtime.userId)
    .eq("status", "DUPLICATE_FILTERED");
  if (error) {
    console.warn("duplicate margin repair lookup skipped:", error.message);
    return { count: 0, refundedMargin: 0 };
  }
  const rows = (data || []).filter(row => Number(row.margin || 0) > 0);
  const duplicateMargin = rows.reduce((sum, row) => sum + Number(row.margin || 0), 0);
  if (!rows.length || duplicateMargin <= 0) return { count: 0, refundedMargin: 0, duplicateMargin: 0 };
  for (const row of rows) {
    const { error: updateError } = await supabase
      .from("ai_positions")
      .update({
        status: "DUPLICATE_REFUNDED",
        closed_at: nowIso(),
        reason: `${row.reason || "Filtered duplicate open position"} • margin refunded`
      })
      .eq("user_id", runtime.userId)
      .eq("id", row.id)
      .eq("status", "DUPLICATE_FILTERED");
    if (updateError) console.warn("duplicate margin refund mark skipped:", updateError.message);
  }
  return { count: rows.length, refundedMargin: 0, duplicateMargin };
}

function deterministicPositionId(runtime, signal) {
  const lifecycle = signal?.firstSeenAt || signal?.priceAction?.lifecycleFirstSeenAt || signal?.updatedAt || nowIso();
  const parsed = new Date(lifecycle).getTime();
  const stamp = Number.isFinite(parsed) ? parsed : Date.now();
  const safeCoin = String(signal?.coin || "ASSET").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const safeSide = String(signal?.side || "WAIT").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  return `${runtime.userId}-${safeCoin}-${safeSide}-${stamp}`;
}

async function dedupeOpenPositions(runtime) {
  if (!Array.isArray(runtime.positions) || runtime.positions.length <= 1) {
    return { count: 0, refundedMargin: 0 };
  }
  const sorted = [...runtime.positions].sort((a, b) => new Date(b.openedAt || 0) - new Date(a.openedAt || 0));
  const seen = new Set();
  const keep = [];
  const duplicates = [];
  for (const p of sorted) {
    const key = `${p.coin}:${p.side}`;
    if (seen.has(key)) duplicates.push(p);
    else {
      seen.add(key);
      keep.push(p);
    }
  }
  runtime.positions = keep.sort((a, b) => new Date(b.openedAt || 0) - new Date(a.openedAt || 0));
  const duplicateMargin = duplicates.reduce((sum, p) => sum + Number(p.margin || 0), 0);
  if (supabase && duplicates.length) {
    for (const p of duplicates) {
      try {
        await supabase
          .from("ai_positions")
          .update({
            status: "DUPLICATE_REFUNDED",
            closed_at: nowIso(),
            reason: "Filtered duplicate open position • margin refunded"
          })
          .eq("user_id", runtime.userId)
          .eq("id", p.id);
      } catch (err) {
        console.warn("duplicate position cleanup skipped:", err.message);
      }
    }
  }
  return { count: duplicates.length, refundedMargin: 0, duplicateMargin };
}


function normalizeHistoryRows(rows) {
  const seen = new Set();
  const out = [];

  for (const row of rows || []) {
    const key = row.position_id
      ? `pos:${row.position_id}`
      : `${row.coin}:${row.side}:${row.opened_at}:${row.closed_at}:${row.entry}:${row.exit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}


async function countWorkspaceRows(workspaceId) {
  if (!supabase || !workspaceId) return { workspaceId, score: 0, positions: 0, history: 0, signals: 0 };

  const [pos, hist, sig] = await Promise.all([
    supabase.from("ai_positions").select("id", { count: "exact", head: true }).eq("user_id", workspaceId),
    supabase.from("ai_trade_history").select("id", { count: "exact", head: true }).eq("user_id", workspaceId),
    supabase.from("ai_signals").select("id", { count: "exact", head: true }).eq("user_id", workspaceId)
  ]);

  const positions = pos.count || 0;
  const history = hist.count || 0;
  const signals = sig.count || 0;

  return {
    workspaceId,
    positions,
    history,
    signals,
    score: positions * 10 + history * 5 + signals
  };
}

async function findBestOldWorkspace(targetUserId) {
  const candidates = [...new Set(MIGRATE_FROM_WORKSPACES.filter(id => id && id !== targetUserId))];
  const counts = [];

  for (const id of candidates) {
    try {
      counts.push(await countWorkspaceRows(id));
    } catch (err) {
      console.warn("workspace count skipped:", id, err.message);
    }
  }

  return counts.sort((a, b) => b.score - a.score)[0] || null;
}

async function copyRowsToWorkspace(table, fromUserId, toUserId, idField = "id", limit = 300) {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("user_id", fromUserId)
    .limit(limit);

  if (error) throw error;
  if (!data?.length) return 0;

  let copied = 0;
  for (const row of data) {
    const clone = { ...row, user_id: toUserId };
    const { error: upsertErr } = await supabase
      .from(table)
      .upsert(clone, { onConflict: idField });
    if (upsertErr) console.warn(`migration upsert ${table} skipped:`, upsertErr.message);
    else copied++;
  }
  return copied;
}

async function maybeMigrateWorkspaceData(targetUserId) {
  if (!supabase || process.env.ASTRAQUANT_DISABLE_MIGRATION === "true") return null;

  const current = await countWorkspaceRows(targetUserId);
  if (current.score > 0) return null;

  const best = await findBestOldWorkspace(targetUserId);
  if (!best || best.score <= 0) return null;

  console.log(`Migrating workspace data from ${best.workspaceId} to ${targetUserId}`);

  try {
    const { data: oldState } = await supabase
      .from("ai_bot_state")
      .select("*")
      .eq("user_id", best.workspaceId)
      .eq("id", "main")
      .maybeSingle();

    if (oldState) {
      await supabase.from("ai_bot_state").upsert({
        ...oldState,
        user_id: targetUserId,
        updated_at: nowIso()
      }, { onConflict: "user_id,id" });
    }
  } catch (err) {
    console.warn("state migration skipped:", err.message);
  }

  const result = {
    from: best.workspaceId,
    positions: 0,
    history: 0,
    signals: 0,
    memory: 0
  };

  try { result.positions = await copyRowsToWorkspace("ai_positions", best.workspaceId, targetUserId, "id", 200); } catch (err) { console.warn("position migration skipped:", err.message); }
  try { result.history = await copyRowsToWorkspace("ai_trade_history", best.workspaceId, targetUserId, "id", 250); } catch (err) { console.warn("history migration skipped:", err.message); }
  try { result.signals = await copyRowsToWorkspace("ai_signals", best.workspaceId, targetUserId, "id", 100); } catch (err) { console.warn("signal migration skipped:", err.message); }
  try { result.memory = await copyRowsToWorkspace("ai_memory", best.workspaceId, targetUserId, "key", 300); } catch (err) { console.warn("memory migration skipped:", err.message); }

  return result;
}


async function getRuntime(userId) {
  if (MEMORY_STATE.has(userId)) return MEMORY_STATE.get(userId);
  const runtime = emptyRuntime(userId);
  MEMORY_STATE.set(userId, runtime);

  if (!supabase) {
    await ensureLedgerAnchor(runtime);
    reconcileLedger(runtime, "memory_strict_ledger_init", { rebuildCurve: false });
    rebuildCanonicalEquityCurve(runtime, "memory_strict_ledger_curve");
    return runtime;
  }


  try {
    const migration = await maybeMigrateWorkspaceData(userId);
    if (migration) {
      runtime.migratedFrom = migration.from;
      runtime.migrationSummary = migration;
    }

    let { data: state, error: stateError } = await supabase
      .from("ai_bot_state")
      .select("*")
      .eq("user_id", userId)
      .eq("id", "main")
      .maybeSingle();
    if (stateError) throw stateError;

    if (!state) {
      const { data: inserted, error: insertError } = await supabase
        .from("ai_bot_state")
        .insert({ user_id: userId, id: "main", balance: 1000, equity: 1000, risk_per_trade: 0.015 })
        .select("*")
        .single();
      if (insertError) throw insertError;
      state = inserted;
    }

    const { data: positions, error: posErr } = await supabase
      .from("ai_positions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "OPEN")
      .order("opened_at", { ascending: false });
    if (posErr) throw posErr;

    const { data: history, error: histErr } = await supabase
      .from("ai_trade_history")
      .select("*")
      .eq("user_id", userId)
      .order("closed_at", { ascending: false })
      .limit(1000);
    if (histErr) throw histErr;

    const { data: memoryRows, error: memErr } = await supabase
      .from("ai_memory")
      .select("*")
      .eq("user_id", userId);
    if (memErr) throw memErr;

    const { data: signalRows, error: sigErr } = await supabase
      .from("ai_signals")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (sigErr) throw sigErr;

    runtime.balance = Number(state.balance ?? 1000);
    runtime.equity = Number(state.equity ?? state.balance ?? 1000);
    {
      const envRisk = Number(process.env.ASTRAQUANT_MAX_RISK_PER_TRADE);
      const storedRisk = Number(state.risk_per_trade ?? 0.05);
      runtime.riskPerTrade = Math.min(0.05, Math.max(0.001, Number.isFinite(envRisk) && envRisk > 0 ? envRisk : storedRisk));
    }
    runtime.positions = (positions || []).map(fromPositionRow).filter(p => !BLOCKED_COINS.has(String(p.coin || p.symbol || "").toUpperCase()));
    runtime.history = normalizeHistoryRows(history || []).map(fromHistoryRow);
    runtime.memory = {};

    for (const row of memoryRows || []) {
      if (row.key === "__ledger_anchor__") {
        runtime.ledgerAnchor = parseLedgerAnchorRow(row);
        continue;
      }
      if (row.key === "__equity_curve__") {
        runtime.equityCurve = parseEquityCurveFromMemoryRow(row);
        continue;
      }

      runtime.memory[row.key] = {
        trades: row.trades || 0,
        wins: row.wins || 0,
        losses: row.losses || 0,
        avgPnlPct: Number(row.avg_pnl_pct || 0),
        weightAdjustment: Number(row.weight_adjustment || 0),
        mistakeTags: row.mistake_tags || [],
        notes: row.notes || []
      };
    }

    await ensureLearningMemoryFromHistory(runtime);

    runtime.lastScan = normalizeLoadedSignals(signalRows || []).filter(s => !BLOCKED_COINS.has(String(s.coin || s.symbol || "").toUpperCase()));
    const historicalRepair = await repairHistoricalDuplicateMargins(runtime);
    const liveRepair = await dedupeOpenPositions(runtime);
    const repairedRows = Number(historicalRepair.count || 0) + Number(liveRepair.count || 0);
    await ensureLedgerAnchor(runtime, state);
    const ledgerAudit = reconcileLedger(runtime, repairedRows > 0 ? "dedupe_and_strict_ledger_reconciliation" : "strict_ledger_load_reconciliation", { rebuildCurve: false });
    // V61 always discards stored legacy equity points and rebuilds from $1,000 + unique trade P/L.
    rebuildCanonicalEquityCurve(runtime, "strict_ledger_curve_rebuild");
    await saveState(runtime);
    runtime.lastLoadedFromDb = nowIso();
    runtime.status = "READY";
  } catch (err) {
    runtime.status = `SUPABASE_ERROR: ${err.message}`;
    console.warn("Supabase load error:", err.message);
  }

  return runtime;
}

function fromPositionRow(row) {
  return {
    id: row.id,
    coin: row.coin,
    symbol: row.symbol,
    side: row.side,
    entry: Number(row.entry),
    sl: Number(row.sl),
    tp: Number(row.tp),
    qty: Number(row.qty),
    margin: Number(row.margin),
    score: Number(row.score),
    status: row.status,
    signalId: row.signal_id,
    maxHoldHours: Number(row.max_hold_hours || intradayMaxHoldHours()),
    reason: row.reason || "AI signal",
    last: Number(row.last || row.entry),
    unrealized: Number(row.unrealized || 0),
    pnlPct: Number(row.pnl_pct || 0),
    openedAt: row.opened_at,
    notional: Number(row.qty || 0) * Number(row.entry || 0),
    leverage: Number(row.margin || 0) > 0 ? (Number(row.qty || 0) * Number(row.entry || 0)) / Number(row.margin || 1) : 1
  };
}

function fromHistoryRow(row) {
  return {
    id: row.id,
    positionId: row.position_id,
    coin: row.coin,
    symbol: row.symbol,
    side: row.side,
    entry: Number(row.entry),
    exit: Number(row.exit),
    sl: Number(row.sl || 0),
    tp: Number(row.tp || 0),
    qty: Number(row.qty || 0),
    margin: Number(row.margin || 0),
    score: Number(row.score || 0),
    pnl: Number(row.pnl || 0),
    pnlPct: Number(row.pnl_pct || 0),
    closeReason: row.close_reason,
    mistakeTags: row.mistake_tags || [],
    lesson: row.lesson,
    openedAt: row.opened_at,
    closedAt: row.closed_at
  };
}


function buildMemoryFromHistory(history = []) {
  const memory = {};
  const sorted = [...(history || [])].sort((a, b) => new Date(a.closedAt || 0) - new Date(b.closedAt || 0));

  for (const trade of sorted) {
    if (!trade.coin || !trade.side) continue;

    const key = `${trade.coin}:${trade.side}`;
    const mem = memory[key] || {
      trades: 0,
      wins: 0,
      losses: 0,
      avgPnlPct: 0,
      weightAdjustment: 0,
      mistakeTags: [],
      notes: []
    };

    const pnlPct = Number(trade.pnlPct || 0);
    const mistakeTags = trade.mistakeTags?.length ? trade.mistakeTags : diagnoseMistake(trade, trade.closeReason || "");
    const lesson = trade.lesson || buildLesson(mistakeTags, pnlPct);

    mem.trades += 1;
    if (pnlPct >= 0) mem.wins += 1;
    else mem.losses += 1;

    mem.avgPnlPct = ((mem.avgPnlPct * (mem.trades - 1)) + pnlPct) / mem.trades;
    mem.weightAdjustment = pnlPct >= 0
      ? Math.min(10, mem.weightAdjustment + 1.2)
      : Math.max(-12, mem.weightAdjustment - 2.0);
    mem.mistakeTags = [...new Set([...(mistakeTags || []), ...(mem.mistakeTags || [])])].slice(0, 10);
    mem.notes = [lesson, ...(mem.notes || [])].filter(Boolean).slice(0, 8);

    memory[key] = mem;
  }

  return memory;
}

async function ensureLearningMemoryFromHistory(runtime) {
  if (!runtime.history?.length) return false;

  const rebuilt = buildMemoryFromHistory(runtime.history);
  const expectedKeys = Object.keys(rebuilt);
  const currentKeys = Object.keys(runtime.memory || {}).filter(k => k !== "__equity_curve__");

  const force = process.env.ASTRAQUANT_REBUILD_LEARNING_FROM_HISTORY === "true";
  const enabled = process.env.ASTRAQUANT_REBUILD_LEARNING_FROM_HISTORY !== "false";
  const missing = expectedKeys.filter(k => !runtime.memory?.[k]);

  if (!enabled) return false;
  if (!force && !missing.length && currentKeys.length >= expectedKeys.length) return false;

  runtime.memory = {
    ...(runtime.memory || {}),
    ...rebuilt
  };

  if (supabase) {
    for (const key of expectedKeys) {
      const [coin, side] = key.split(":");
      await saveMemory(runtime, key, coin, side, runtime.memory[key]);
    }
  }

  runtime.learningRebuilt = {
    keys: expectedKeys.length,
    trades: runtime.history.length,
    missingAdded: missing.length,
    force
  };

  console.log(`Learning memory rebuilt from history: ${expectedKeys.length} keys / ${runtime.history.length} trades`);
  return true;
}


function normalizeLoadedSignals(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row.coin || seen.has(row.coin)) continue;
    seen.add(row.coin);
    const normalized = {
      id: row.id,
      coin: row.coin,
      symbol: row.symbol,
      side: row.side,
      score: Number(row.score || 0),
      confidence: Number(row.confidence || 0),
      entry: row.entry == null ? null : Number(row.entry),
      sl: row.sl == null ? null : Number(row.sl),
      tp: row.tp == null ? null : Number(row.tp),
      price: row.price == null ? null : Number(row.price),
      timeframe: row.timeframe || intradayDurationLabel(),
      analysisTimeframe: "1H structure",
      minHoldHours: intradayMinHoldHours(),
      maxHoldHours: intradayMaxHoldHours(),
      validForMinutes: signalTtlMinutes(),
      firstSeenAt: row.price_action?.lifecycleFirstSeenAt || row.created_at || null,
      validUntil: row.price_action?.lifecycleValidUntil || (row.created_at ? new Date(new Date(row.created_at).getTime() + signalTtlMinutes() * 60_000).toISOString() : null),
      scannedAt: row.created_at || null,
      tradeStatus: row.price_action?.tradeStatus || null,
      executionReasons: row.price_action?.executionReasons || [],
      adaptiveWideStopApproved: Boolean(row.price_action?.adaptiveWideStopApproved),
      riskMode: row.price_action?.riskMode || "STANDARD",
      confluenceScore: Number(row.price_action?.confluenceScore || 0),
      confluenceMaxScore: Number(row.price_action?.confluenceMaxScore || 11),
      confluenceReasons: row.price_action?.confluenceReasons || [],
      source: row.source || "saved_db",
      technicalAnalysis: row.technical || [],
      fundamentalAnalysis: row.fundamental || [],
      why: row.why || [],
      chart: row.chart || [],
      updatedAt: row.created_at,
      savedFromDb: true,
      priceAction: row.price_action || {},
      fib: row.fib || {}
    };

    if (isValidBackendSignal(normalized)) out.push(normalized);
  }
  return out;
}


function normalizeEquityCurve(points = []) {
  const out = [];
  const seen = new Set();

  for (const p of points || []) {
    const time = p.time || p.t;
    const equity = Number(p.equity ?? p.value);
    const balance = Number(p.balance ?? 0);
    const openPnl = Number(p.openPnl ?? 0);
    if (!time || !Number.isFinite(equity)) continue;
    const key = `${time}:${equity.toFixed(8)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      time,
      equity,
      balance: Number.isFinite(balance) ? balance : 0,
      openPnl: Number.isFinite(openPnl) ? openPnl : 0,
      openPositions: Number(p.openPositions || 0),
      reason: p.reason || "tick"
    });
  }

  return out
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .slice(-Number(process.env.ASTRAQUANT_EQUITY_SNAPSHOT_LIMIT || 3000));
}

function parseEquityCurveFromMemoryRow(row) {
  try {
    const notes = row?.notes;
    const raw = Array.isArray(notes) ? notes[0] : notes;
    if (!raw) return [];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return normalizeEquityCurve(Array.isArray(parsed) ? parsed : parsed?.points || []);
  } catch {
    return [];
  }
}

function recordEquitySnapshot(runtime, reason = "tick", force = false) {
  const ledger = canonicalLedger(runtime);
  runtime.balance = ledger.expectedCashBalance;
  runtime.equity = ledger.expectedEquity;

  const now = Date.now();
  const last = runtime.equityCurve?.at?.(-1);
  const lastTime = last ? new Date(last.time).getTime() : 0;
  const minMs = Number(process.env.ASTRAQUANT_EQUITY_SNAPSHOT_MS || 60000);
  const equityChanged = !last || Math.abs(Number(last.equity || 0) - runtime.equity) >= Number(process.env.ASTRAQUANT_EQUITY_MIN_CHANGE || 0.0001);

  if (!force && last && now - lastTime < minMs && !equityChanged) return false;

  const openPnl = runtime.positions.reduce((sum, p) => sum + Number(p.unrealized || 0), 0);
  runtime.equityCurve = normalizeEquityCurve([
    ...(runtime.equityCurve || []),
    {
      time: nowIso(),
      equity: runtime.equity,
      balance: runtime.balance,
      openPnl,
      openPositions: runtime.positions.length,
      reason
    }
  ]);

  return true;
}

async function saveEquityCurve(runtime) {
  if (!supabase) return;
  const payload = JSON.stringify(runtime.equityCurve || []);
  const { error } = await supabase.from("ai_memory").upsert({
    user_id: runtime.userId,
    key: "__equity_curve__",
    coin: "EQUITY",
    side: "CURVE",
    trades: runtime.history?.length || 0,
    wins: 0,
    losses: 0,
    avg_pnl_pct: 0,
    weight_adjustment: 0,
    mistake_tags: [],
    notes: [payload],
    updated_at: nowIso()
  }, { onConflict: "user_id,key" });
  if (error) console.warn("saveEquityCurve error:", error.message);
}


async function saveState(runtime) {
  reconcileLedger(runtime, "save_state", { rebuildCurve: false });
  const recorded = recordEquitySnapshot(runtime, "state");
  if (!supabase) return;
  const { error } = await supabase.from("ai_bot_state").upsert({
    user_id: runtime.userId,
    id: "main",
    balance: runtime.balance,
    equity: runtime.equity,
    risk_per_trade: runtime.riskPerTrade,
    updated_at: nowIso()
  }, { onConflict: "user_id,id" });
  if (error) console.warn("saveState error:", error.message);
  if (recorded || runtime.equityCurveDirty) {
    await saveEquityCurve(runtime);
    runtime.equityCurveDirty = false;
  }
}

async function saveSignal(runtime, signal) {
  if (!supabase) return;

  // Keep only latest valid signal per coin in DB to avoid old valid/invalid cards flickering.
  await supabase
    .from("ai_signals")
    .delete()
    .eq("user_id", runtime.userId)
    .eq("coin", signal.coin);

  const { error } = await supabase.from("ai_signals").insert({
    user_id: runtime.userId,
    coin: signal.coin,
    symbol: signal.symbol,
    side: signal.side,
    score: signal.score,
    confidence: signal.confidence,
    entry: signal.entry,
    sl: signal.sl,
    tp: signal.tp,
    price: signal.price,
    timeframe: signal.timeframe,
    source: signal.source,
    technical: signal.technicalAnalysis,
    fundamental: signal.fundamentalAnalysis,
    why: signal.why,
    chart: signal.chart,
    price_action: signal.priceAction || {},
    fib: signal.fib || {}
  });
  if (error) console.warn("saveSignal error:", error.message);
}

async function saveOpenPosition(runtime, p) {
  if (!supabase) return;
  const { error } = await supabase.from("ai_positions").upsert({
    user_id: runtime.userId,
    id: p.id,
    coin: p.coin,
    symbol: p.symbol,
    side: p.side,
    entry: p.entry,
    sl: p.sl,
    tp: p.tp,
    qty: p.qty,
    margin: p.margin,
    score: p.score,
    status: "OPEN",
    signal_id: p.signalId,
    reason: p.reason,
    max_hold_hours: p.maxHoldHours,
    last: p.last,
    unrealized: p.unrealized || 0,
    pnl_pct: p.pnlPct || 0,
    opened_at: p.openedAt
  });
  if (error) console.warn("saveOpenPosition error:", error.message);
}

async function updateOpenPosition(runtime, p) {
  if (!supabase) return;
  const { error } = await supabase
    .from("ai_positions")
    .update({ last: p.last, unrealized: p.unrealized || 0, pnl_pct: p.pnlPct || 0 })
    .eq("user_id", runtime.userId)
    .eq("id", p.id);
  if (error) console.warn("updateOpenPosition error:", error.message);
}

async function closePositionDb(runtime, p, trade) {
  if (!supabase) return;

  const { error: posErr } = await supabase
    .from("ai_positions")
    .update({ status: "CLOSED", last: trade.exit, unrealized: trade.pnl, pnl_pct: trade.pnlPct, closed_at: trade.closedAt })
    .eq("user_id", runtime.userId)
    .eq("id", p.id);
  if (posErr) console.warn("close position update error:", posErr.message);

  const { error: histErr } = await supabase.from("ai_trade_history").insert({
    user_id: runtime.userId,
    position_id: p.id,
    coin: trade.coin,
    symbol: trade.symbol,
    side: trade.side,
    entry: trade.entry,
    exit: trade.exit,
    sl: trade.sl,
    tp: trade.tp,
    qty: trade.qty,
    margin: trade.margin,
    score: trade.score,
    pnl: trade.pnl,
    pnl_pct: trade.pnlPct,
    close_reason: trade.closeReason,
    mistake_tags: trade.mistakeTags,
    lesson: trade.lesson,
    opened_at: trade.openedAt,
    closed_at: trade.closedAt
  });
  if (histErr) console.warn("trade history insert error:", histErr.message);
}

async function saveMemory(runtime, key, coin, side, mem) {
  if (!supabase) return;
  const { error } = await supabase.from("ai_memory").upsert({
    user_id: runtime.userId,
    key,
    coin,
    side,
    trades: mem.trades,
    wins: mem.wins,
    losses: mem.losses,
    avg_pnl_pct: mem.avgPnlPct,
    weight_adjustment: mem.weightAdjustment,
    mistake_tags: mem.mistakeTags,
    notes: mem.notes,
    updated_at: nowIso()
  }, { onConflict: "user_id,key" });
  if (error) console.warn("saveMemory error:", error.message);
}

function isAbortLikeError(err) {
  const name = String(err?.name || "").toLowerCase();
  const code = String(err?.code || "").toLowerCase();
  const message = String(err?.message || err || "").toLowerCase();
  return name.includes("abort") || code === "abort_err" || message.includes("operation was aborted") || message.includes("request was aborted") || message.includes("aborted");
}

function friendlyExternalError(err) {
  if (isAbortLikeError(err)) return "External price request timed out";
  return String(err?.message || err || "External request failed");
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || process.env.ASTRAQUANT_EXTERNAL_FETCH_TIMEOUT_MS || 20000));
  const retries = Math.max(0, Math.min(3, Number(options.retries ?? process.env.ASTRAQUANT_EXTERNAL_FETCH_RETRIES ?? 1)));
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 AstraQuantAI", "Accept": "application/json,text/plain,*/*" }
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      const retryable = isAbortLikeError(err) || [429, 500, 502, 503, 504].some(code => String(err?.message || "").startsWith(String(code)));
      if (!retryable || attempt >= retries) break;
      await delay(500 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  const wrapped = new Error(friendlyExternalError(lastError));
  wrapped.cause = lastError;
  wrapped.code = isAbortLikeError(lastError) ? "EXTERNAL_TIMEOUT" : "EXTERNAL_FETCH_FAILED";
  throw wrapped;
}

function median(values = []) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function sanitizeYahooCandles(rows = [], options = {}) {
  const isGold = options.type === "gold" || options.symbol === XAU_SYMBOL;
  const maxGapPct = Number(process.env.ASTRAQUANT_XAU_MAX_CANDLE_GAP_PCT || 8) / 100;
  const normalized = rows
    .map(row => {
      const time = Number(row.time);
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      const volume = Number(row.volume || 0);
      if (![time, open, high, low, close].every(Number.isFinite)) return null;
      if ([open, high, low, close].some(value => value <= 0)) return null;
      return {
        time,
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: Number.isFinite(volume) && volume >= 0 ? volume : 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  const unique = [];
  const seen = new Set();
  for (const candle of normalized) {
    if (seen.has(candle.time)) continue;
    seen.add(candle.time);
    unique.push(candle);
  }

  if (!isGold) return unique;

  const clean = [];
  for (const candle of unique) {
    const recent = clean.slice(-12).map(item => item.close);
    const reference = median(recent) || candle.close;
    const prices = [candle.open, candle.high, candle.low, candle.close];
    const extreme = prices.some(value => Math.abs(value - reference) / reference > maxGapPct);
    if (extreme && clean.length >= 5) continue;

    const maxWickPct = Number(process.env.ASTRAQUANT_XAU_MAX_WICK_PCT || 5) / 100;
    const bodyReference = Math.max(1e-9, (candle.open + candle.close) / 2);
    if ((candle.high - candle.low) / bodyReference > maxWickPct && clean.length >= 5) continue;

    clean.push(candle);
  }

  return clean;
}

async function getYahooChart(symbol, interval = "1h", range = "1mo") {
  const encoded = encodeURIComponent(symbol);
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastError = null;
  for (const host of hosts) {
    try {
      return await fetchJson(`https://${host}/v8/finance/chart/${encoded}?interval=${interval}&range=${range}&includePrePost=false&events=div%2Csplits`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Yahoo chart unavailable");
}

async function getYahooLastPrice(symbol = XAU_SYMBOL) {
  const attempts = [
    { interval: "1m", range: "1d" },
    { interval: "5m", range: "5d" },
    { interval: "1h", range: "1mo" }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const json = await getYahooChart(symbol, attempt.interval, attempt.range);
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error("Yahoo quote empty");
      const closes = result.indicators?.quote?.[0]?.close || [];
      const candidates = [result.meta?.regularMarketPrice, ...closes.slice().reverse()];
      const price = candidates.map(Number).find(value => Number.isFinite(value) && value > 0);
      if (!price) throw new Error("Yahoo quote has no valid price");
      if (symbol === XAU_SYMBOL && (price < 300 || price > 10000)) {
        throw new Error(`Yahoo gold quote sanity failed: ${price}`);
      }
      return price;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Yahoo quote unavailable");
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function inferNarrative(coin) {
  const hay = `${coin.name || ""} ${coin.symbol || ""}`.toLowerCase();
  const tags = [];
  let boost = 0;
  for (const rule of NARRATIVE_RULES) {
    if (rule.match.some(m => hay.includes(m))) {
      tags.push(...rule.tags);
      boost += rule.boost || 0;
    }
  }
  if (!tags.length) tags.push("high volume", "market rotation", "technical setup");
  return { tags: [...new Set(tags)].slice(0, 7), boost };
}

function toYahooSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  return YAHOO_ALIASES[s] || `${s}-USD`;
}

async function getTrendingSet() {
  try {
    const data = await fetchJson("https://api.coingecko.com/api/v3/search/trending");
    const set = new Set();
    for (const item of data?.coins || []) {
      const sym = item?.item?.symbol?.toUpperCase();
      if (sym) set.add(sym);
    }
    return set;
  } catch {
    return new Set();
  }
}

async function getMarketRows(force = false) {
  const age = marketRowsUpdatedAt ? Date.now() - new Date(marketRowsUpdatedAt).getTime() : Infinity;
  if (!force && marketRowsCache.length && age < 10 * 60_000) return marketRowsCache;

  const url = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=120&page=1&sparkline=true&price_change_percentage=1h,24h,7d";
  const rows = await fetchJson(url);
  if (!Array.isArray(rows) || rows.length < 10) throw new Error("CoinGecko market list empty");

  marketRowsCache = rows;
  marketRowsUpdatedAt = nowIso();
  return rows;
}


let binanceTickerCache = new Map();
let binanceTickerUpdatedAt = null;

async function getBinanceTickerMap(force = false) {
  const age = binanceTickerUpdatedAt ? Date.now() - new Date(binanceTickerUpdatedAt).getTime() : Infinity;
  if (!force && binanceTickerCache.size && age < 30_000) return binanceTickerCache;

  const url = "https://api.binance.com/api/v3/ticker/24hr";
  const rows = await fetchJson(url);
  if (!Array.isArray(rows) || rows.length < 20) throw new Error("Binance ticker list empty");

  const map = new Map();
  const bannedSuffixes = ["UP", "DOWN", "BULL", "BEAR"];

  for (const row of rows) {
    const symbol = String(row.symbol || "").toUpperCase();
    if (!symbol.endsWith("USDT")) continue;
    const coin = symbol.slice(0, -4);
    if (!coin || bannedSuffixes.some(suffix => coin.endsWith(suffix))) continue;

    const price = Number(row.lastPrice);
    const quoteVolume = Number(row.quoteVolume || 0);
    const changePct = Number(row.priceChangePercent || 0);

    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(quoteVolume) || quoteVolume <= 0) continue;

    const old = map.get(coin);
    if (!old || quoteVolume > old.volumeUsd) {
      map.set(coin, {
        coin,
        symbol,
        price,
        volumeUsd: quoteVolume,
        changePct,
        source: "Binance spot ticker"
      });
    }
  }

  if (map.size < 20) throw new Error("Binance ticker map too small");
  binanceTickerCache = map;
  binanceTickerUpdatedAt = nowIso();
  return map;
}

function isExchangePriceAligned(coin, cgPrice, exchangePrice) {
  if (!Number.isFinite(cgPrice) || !Number.isFinite(exchangePrice) || cgPrice <= 0 || exchangePrice <= 0) return false;
  const gap = Math.abs(cgPrice - exchangePrice) / exchangePrice;
  return gap <= Number(process.env.ASTRAQUANT_MAX_EXCHANGE_PRICE_GAP || 0.08);
}

async function getBinanceCandles(asset, timeframe = "1h") {
  const symbol = asset.binanceSymbol || `${asset.coin}USDT`;
  const interval = timeframe === "1d" ? "1d" : "1h";
  const limit = timeframe === "1d" ? 180 : 180;
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows) || rows.length < 60) throw new Error(`Binance candles empty for ${symbol}`);

  return rows.map(k => ({
    time: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5])
  })).filter(c =>
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    c.close > 0
  );
}


async function getMarketUniverse(force = false) {
  const trending = await getTrendingSet();
  const rows = await getMarketRows(force);

  let exchangeMap = new Map();

  if (PRICE_MODE !== "coingecko") {
    try {
      exchangeMap = await getBinanceTickerMap(force);
    } catch (err) {
      console.warn("Binance ticker guard unavailable:", err.message);
    }
  }

  const requireExchange = PRICE_MODE === "binance" && process.env.ASTRAQUANT_REQUIRE_EXCHANGE_PRICE !== "false";
  const picked = [];
  const seen = new Set();

  for (const c of rows) {
    const symbol = String(c.symbol || "").toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    if (symbol.includes("USD") || symbol.length > 9) continue;
    if (BLOCKED_COINS.has(symbol)) continue;

    const exchange = exchangeMap.get(symbol);
    if (requireExchange && exchangeMap.size && !exchange) continue;

    const volume = Number(c.total_volume || 0);
    const rank = Number(c.market_cap_rank || 9999);
    const change24 = Number(c.price_change_percentage_24h || 0);
    const change7d = Number(c.price_change_percentage_7d_in_currency || 0);
    const change1h = Number(c.price_change_percentage_1h_in_currency || 0);
    const cgPrice = Number(c.current_price || 0);
    const exchangePrice = exchange?.price ? Number(exchange.price) : null;
    if (exchange && !isExchangePriceAligned(symbol, cgPrice, exchangePrice)) {
      console.warn(`Price mismatch blocked ${symbol}: CoinGecko=${cgPrice} Binance=${exchangePrice}`);
      continue;
    }
    const isTrending = trending.has(symbol);
    const liquid = volume >= 35_000_000;
    const ranked = rank <= 300;
    const momentum = Math.abs(change24) >= 2.5 || Math.abs(change7d) >= 7 || Math.abs(change1h) >= 1.25;
    const hasSparkline = Array.isArray(c.sparkline_in_7d?.price) && c.sparkline_in_7d.price.length >= 80;

    if (!ranked && !isTrending) continue;
    if (!liquid && !isTrending && !momentum) continue;
    if (!hasSparkline) continue;

    const narrative = inferNarrative({ name: c.name, symbol });
    const preScore =
      Math.min(25, Math.log10(Math.max(volume, 1)) * 2.2) +
      Math.max(0, 18 - rank / 18) +
      Math.min(20, Math.abs(change24) * 1.15) +
      Math.min(15, Math.abs(change7d) * 0.45) +
      (isTrending ? 12 : 0) +
      narrative.boost;

    picked.push({
      symbol: toYahooSymbol(symbol),
      coin: symbol,
      coingeckoId: c.id,
      type: "crypto",
      name: c.name || symbol,
      narrative: narrative.tags,
      marketCapRank: rank,
      volumeUsd: volume,
      change1h,
      change24,
      change7d,
      currentPrice: PRICE_MODE === "coingecko" ? cgPrice : (exchangePrice || cgPrice),
      binanceSymbol: exchange?.symbol || null,
      binancePrice: exchangePrice || null,
      priceSource: PRICE_MODE === "coingecko" ? "CoinGecko guarded" : (exchange ? "CoinGecko guarded" : "CoinGecko fallback"),
      isTrending,
      sparkline: c.sparkline_in_7d.price,
      preScore,
      sourceReason: [liquid ? "high_volume" : null, isTrending ? "trending" : null, momentum ? "momentum" : null, ranked ? "ranked" : null].filter(Boolean).join("+") || "ai_selected"
    });
    seen.add(symbol);
  }

  picked.sort((a, b) => b.preScore - a.preScore);
  const top = picked.slice(0, 30);
  if (XAU_ENABLED && !BLOCKED_COINS.has(XAU_COIN) && !BLOCKED_COINS.has(XAU_SYMBOL)) {
    let currentPrice = null;
    try {
      currentPrice = await getYahooLastPrice(XAU_SYMBOL);
    } catch (error) {
      console.warn("XAUUSD quote guard unavailable:", error.message);
    }
    top.push({
      symbol: XAU_SYMBOL,
      coin: XAU_COIN,
      type: "gold",
      name: "Gold / XAUUSD",
      narrative: ["gold", "safe haven", "macro", "real yield", "USD"],
      marketCapRank: 0,
      volumeUsd: 0,
      currentPrice,
      priceSource: "Yahoo Finance GC=F futures proxy",
      sourceReason: "macro_gold_filter",
      preScore: 16
    });
  }
  return top.length >= 8 ? top : picked.slice(0, 15);
}

async function getDynamicUniverse(force = false) {
  const age = dynamicUniverseUpdatedAt ? Date.now() - new Date(dynamicUniverseUpdatedAt).getTime() : Infinity;
  if (!force && dynamicUniverse.length && age < 10 * 60_000) return dynamicUniverse;
  dynamicUniverse = await getMarketUniverse(force);
  dynamicUniverseUpdatedAt = nowIso();
  return dynamicUniverse;
}

function candlesFromSparkline(asset) {
  const prices = (asset.sparkline || []).map(Number).filter(Number.isFinite);
  if (prices.length < 80) throw new Error("sparkline too short");
  const now = Date.now();
  const step = 3600_000;
  const candles = [];
  const volumeBase = Math.max(1, Number(asset.volumeUsd || 0) / prices.length);

  for (let i = 0; i < prices.length; i++) {
    const close = prices[i];
    const prev = i > 0 ? prices[i - 1] : close;
    const next = i + 1 < prices.length ? prices[i + 1] : close;
    const open = prev;
    const high = Math.max(open, close, next);
    const low = Math.min(open, close, next);
    const volume = volumeBase * (0.8 + (Math.sin(i / 7) + 1) * 0.25);
    candles.push({ time: now - (prices.length - i) * step, open, high, low, close, volume });
  }

  return candles;
}

function dailyFromHourly(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i += 24) {
    const chunk = candles.slice(i, i + 24);
    if (chunk.length < 4) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk.at(-1).close,
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0)
    });
  }
  // If only 7 daily candles, expand softly for EMA fallback.
  if (out.length < 60) {
    const expanded = [];
    for (let i = 0; i < 70; i++) {
      const src = out[Math.min(out.length - 1, Math.floor(i / Math.max(1, 70 / Math.max(out.length, 1))))] || candles[0];
      expanded.push({ ...src, time: Date.now() - (70 - i) * 86400_000 });
    }
    return expanded;
  }
  return out;
}

async function getYahooCandles(asset, interval = "1h", range = "1mo") {
  const json = await getYahooChart(asset.symbol, interval, range);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo empty");
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const raw = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    raw.push({
      time: Number(timestamps[index]) * 1000,
      open: quote.open?.[index],
      high: quote.high?.[index],
      low: quote.low?.[index],
      close: quote.close?.[index],
      volume: quote.volume?.[index]
    });
  }

  const candles = sanitizeYahooCandles(raw, asset);
  if (candles.length < 60) throw new Error(`Yahoo candles too short after guard: ${candles.length}`);

  if (asset.type === "gold") {
    const last = candles.at(-1)?.close;
    const quotePrice = Number(asset.currentPrice || result.meta?.regularMarketPrice || 0);
    if (Number.isFinite(last) && Number.isFinite(quotePrice) && quotePrice > 0) {
      const gap = Math.abs(last - quotePrice) / quotePrice;
      const maxGap = Number(process.env.ASTRAQUANT_XAU_MAX_QUOTE_GAP_PCT || 3) / 100;
      if (gap > maxGap) throw new Error(`XAU candle/quote mismatch ${(gap * 100).toFixed(2)}%`);
    }
  }

  return candles;
}

async function getCandles(asset, timeframe = "1h") {
  if (asset.type === "crypto") {
    if (PRICE_MODE === "coingecko") {
      const hourly = candlesFromSparkline(asset);
      return { candles: timeframe === "1d" ? dailyFromHourly(hourly) : hourly, source: "CoinGecko guarded sparkline" };
    }

    const requireExchangeCandles = process.env.ASTRAQUANT_REQUIRE_EXCHANGE_CANDLES !== "false";

    if (asset.binanceSymbol) {
      try {
        const candles = await getBinanceCandles(asset, timeframe);
        return { candles, source: "Binance spot klines" };
      } catch (err) {
        if (requireExchangeCandles) throw err;
        console.warn(`Binance candles fallback ${asset.coin}:`, err.message);
      }
    }

    const hourly = candlesFromSparkline(asset);
    return { candles: timeframe === "1d" ? dailyFromHourly(hourly) : hourly, source: "CoinGecko smart market sparkline" };
  }

  const interval = timeframe === "1d" ? "1d" : "1h";
  const range = timeframe === "1d" ? "1y" : "1mo";
  const candles = await getYahooCandles(asset, interval, range);
  return { candles, source: asset.type === "gold" ? "Yahoo Finance GC=F futures proxy (guarded)" : "Yahoo Finance guarded" };
}

function sma(values, period) {
  const out = Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function macd(values) {
  const e12 = ema(values, 12), e26 = ema(values, 26);
  const line = values.map((_, i) => e12[i] && e26[i] ? e12[i] - e26[i] : null);
  const signal = ema(line.map(v => Number.isFinite(v) ? v : 0), 9);
  const hist = line.map((v, i) => v == null || signal[i] == null ? null : v - signal[i]);
  return { line, signal, hist };
}

function stochastic(candles, period = 14) {
  const out = Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...slice.map(c => c.high));
    const low = Math.min(...slice.map(c => c.low));
    out[i] = high === low ? 50 : ((candles[i].close - low) / (high - low)) * 100;
  }
  return out;
}

function atr(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
  });
  return ema(tr, period);
}

function lastValid(arr, fallback = null) {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i];
  return fallback;
}

function supportResistance(candles, lookback = 90) {
  const recent = candles.slice(-Math.min(lookback, candles.length));
  const highs = recent.map(c => c.high), lows = recent.map(c => c.low), closes = recent.map(c => c.close);
  return { support: Math.min(...lows), resistance: Math.max(...highs), pivot: (Math.max(...highs) + Math.min(...lows) + closes.at(-1)) / 3 };
}

function fibonacci(candles, lookback = 90) {
  const recent = candles.slice(-Math.min(lookback, candles.length));
  const high = Math.max(...recent.map(c => c.high));
  const low = Math.min(...recent.map(c => c.low));
  const range = high - low;
  return { high, low, fib236: high - range * 0.236, fib382: high - range * 0.382, fib500: high - range * 0.5, fib618: high - range * 0.618, fib786: high - range * 0.786 };
}

function findPivots(candles, left = 3, right = 3) {
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, time: c.time, price: c.high });
    if (isLow) lows.push({ index: i, time: c.time, price: c.low });
  }
  return { highs, lows };
}

function lineValue(p1, p2, x) {
  if (!p1 || !p2 || p1.index === p2.index) return null;
  return p1.price + ((p2.price - p1.price) / (p2.index - p1.index)) * (x - p1.index);
}

function safeProjectedLine(p1, p2, lastIndex, price, atrValue) {
  const projected = lineValue(p1, p2, lastIndex);
  if (!Number.isFinite(projected) || projected <= 0) return null;
  const slope = Math.abs((p2.price - p1.price) / Math.max(1, p2.index - p1.index));
  const maxSlope = Math.max(price * 0.004, atrValue * 0.8);
  const maxDistance = Math.max(price * 0.08, atrValue * 8);
  if (slope > maxSlope) return null;
  if (Math.abs(projected - price) > maxDistance) return null;
  return projected;
}

function detectPriceAction(candles) {
  const window = candles.slice(-120);
  const offset = candles.length - window.length;
  const { highs, lows } = findPivots(window, 3, 3);
  const pivotHighs = highs.slice(-6).map(p => ({ ...p, index: p.index + offset }));
  const pivotLows = lows.slice(-6).map(p => ({ ...p, index: p.index + offset }));
  const lastIndex = candles.length - 1;
  const price = candles.at(-1).close;
  const atrVal = lastValid(atr(candles, 14), price * 0.02);
  const tolerancePct = (atrVal / price) * 100;

  const h1 = pivotHighs.at(-2), h2 = pivotHighs.at(-1), l1 = pivotLows.at(-2), l2 = pivotLows.at(-1);
  const upperNow = h1 && h2 ? safeProjectedLine(h1, h2, lastIndex, price, atrVal) : null;
  const lowerNow = l1 && l2 ? safeProjectedLine(l1, l2, lastIndex, price, atrVal) : null;

  let pattern = "Structure forming", bias = "NEUTRAL", scoreBonusLong = 0, scoreBonusShort = 0;
  const reasons = [];
  const descendingHighs = h1 && h2 && h2.price < h1.price;
  const ascendingLows = l1 && l2 && l2.price > l1.price;
  const risingHighs = h1 && h2 && h2.price > h1.price;
  const fallingLows = l1 && l2 && l2.price < l1.price;
  const nearLower = lowerNow ? Math.abs((price - lowerNow) / price) * 100 <= Math.max(0.35, tolerancePct * 0.7) : false;
  const nearUpper = upperNow ? Math.abs((upperNow - price) / price) * 100 <= Math.max(0.35, tolerancePct * 0.7) : false;
  const breakUpper = upperNow ? price > upperNow + atrVal * 0.15 : false;
  const breakLower = lowerNow ? price < lowerNow - atrVal * 0.15 : false;
  let strongPattern = false;

  if (descendingHighs && ascendingLows) {
    strongPattern = true;
    pattern = "Symmetrical Triangle / Compression";
    reasons.push("Compression: swing high makin rendah dan swing low makin tinggi.");
    if (breakUpper) { bias = "LONG"; scoreBonusLong += 14; reasons.push("Breakout upper trendline."); }
    else if (breakLower) { bias = "SHORT"; scoreBonusShort += 14; reasons.push("Breakdown lower trendline."); }
    else if (nearLower) { bias = "LONG"; scoreBonusLong += 8; reasons.push("Harga dekat lower trendline."); }
    else if (nearUpper) { bias = "SHORT"; scoreBonusShort += 8; reasons.push("Harga dekat upper trendline."); }
  } else if (descendingHighs && fallingLows) {
    strongPattern = true;
    pattern = "Descending Channel / Falling Wedge Watch";
    reasons.push("Swing high dan swing low turun.");
    if (breakUpper) { bias = "LONG"; scoreBonusLong += 16; reasons.push("Breakout dari struktur turun."); }
    else if (nearLower) { bias = "LONG"; scoreBonusLong += 7; reasons.push("Harga dekat trendline bawah."); }
    else { bias = "SHORT"; scoreBonusShort += 5; reasons.push("Struktur masih bearish."); }
  } else if (risingHighs && ascendingLows) {
    strongPattern = true;
    pattern = "Ascending Channel";
    reasons.push("Swing high dan swing low naik.");
    if (nearLower) { bias = "LONG"; scoreBonusLong += 9; reasons.push("Harga dekat trendline bawah."); }
    else if (breakLower) { bias = "SHORT"; scoreBonusShort += 12; reasons.push("Breakdown ascending channel."); }
    else { bias = "LONG"; scoreBonusLong += 5; reasons.push("Trend channel masih naik."); }
  } else if (risingHighs && fallingLows) {
    strongPattern = true;
    pattern = "Broadening / High Volatility";
    reasons.push("Swing melebar, volatilitas tinggi.");
    scoreBonusLong -= 3; scoreBonusShort -= 3;
  }

  const recent = candles.slice(-18);
  const prevLow = Math.min(...recent.slice(0, -1).map(c => c.low));
  const prevHigh = Math.max(...recent.slice(0, -1).map(c => c.high));
  const last = candles.at(-1);
  if (last.low < prevLow && last.close > prevLow) { strongPattern = true; pattern = "Liquidity Sweep Support"; bias = "LONG"; scoreBonusLong += 10; reasons.push("Liquidity sweep bawah."); }
  if (last.high > prevHigh && last.close < prevHigh) { strongPattern = true; pattern = "Liquidity Sweep Resistance"; bias = "SHORT"; scoreBonusShort += 10; reasons.push("Liquidity sweep atas."); }

  const recentHigh = pivotHighs.at(-1)?.price, recentLow = pivotLows.at(-1)?.price;
  if (recentHigh && price > recentHigh) { strongPattern = true; pattern = "Bullish Break of Structure"; bias = "LONG"; scoreBonusLong += 8; reasons.push("Break of structure bullish."); }
  if (recentLow && price < recentLow) { strongPattern = true; pattern = "Bearish Break of Structure"; bias = "SHORT"; scoreBonusShort += 8; reasons.push("Break of structure bearish."); }

  // V39 fallback label: jangan tampilkan "Structure forming" terus.
  // Kalau struktur klasik belum terbentuk, tetap beri label setup berbasis trend, range, momentum, dan posisi terhadap S/R.
  if (!strongPattern) {
    const closes = candles.map(c => c.close);
    const ema20v = lastValid(ema(closes, 20), price);
    const ema50v = lastValid(ema(closes, 50), ema20v);
    const rsi14v = lastValid(rsi(closes, 14), 50);
    const recentRange = candles.slice(-48);
    const rangeHigh = Math.max(...recentRange.map(c => c.high));
    const rangeLow = Math.min(...recentRange.map(c => c.low));
    const rangePos = (price - rangeLow) / Math.max(1e-9, rangeHigh - rangeLow);
    const last6 = closes.slice(-6);
    const momentum = last6.length >= 2 ? (last6.at(-1) - last6[0]) / last6[0] * 100 : 0;

    if (ema20v > ema50v && price >= ema20v && momentum > 0) {
      pattern = "Bullish Momentum Continuation";
      bias = "LONG";
      scoreBonusLong += 4;
      reasons.push("Fallback: EMA20 di atas EMA50 dan momentum pendek naik.");
    } else if (ema20v < ema50v && price <= ema20v && momentum < 0) {
      pattern = "Bearish Momentum Continuation";
      bias = "SHORT";
      scoreBonusShort += 4;
      reasons.push("Fallback: EMA20 di bawah EMA50 dan momentum pendek turun.");
    } else if (rangePos <= 0.28) {
      pattern = "Range Support Retest";
      bias = "LONG";
      scoreBonusLong += 3;
      reasons.push("Fallback: harga berada di area bawah range 48 candle.");
    } else if (rangePos >= 0.72) {
      pattern = "Range Resistance Retest";
      bias = "SHORT";
      scoreBonusShort += 3;
      reasons.push("Fallback: harga berada di area atas range 48 candle.");
    } else if (rsi14v > 58 && momentum > 0) {
      pattern = "Bullish Momentum Build-Up";
      bias = "LONG";
      scoreBonusLong += 3;
      reasons.push("Fallback: RSI dan momentum pendek condong bullish.");
    } else if (rsi14v < 42 && momentum < 0) {
      pattern = "Bearish Momentum Build-Up";
      bias = "SHORT";
      scoreBonusShort += 3;
      reasons.push("Fallback: RSI dan momentum pendek condong bearish.");
    } else {
      pattern = "Range Balance / Wait Breakout";
      bias = "NEUTRAL";
      reasons.push("Fallback: harga masih di tengah range, tunggu breakout/pullback.");
    }
  }

  return {
    pattern,
    bias,
    scoreBonusLong,
    scoreBonusShort,
    reasons,
    upperLine: h1 && h2 && Number.isFinite(upperNow) ? { p1: h1, p2: h2, now: upperNow } : null,
    lowerLine: l1 && l2 && Number.isFinite(lowerNow) ? { p1: l1, p2: l2, now: lowerNow } : null,
    pivots: { highs: pivotHighs.slice(-5), lows: pivotLows.slice(-5) }
  };
}


function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function classifyMarket(ema20, ema50, ema200, price, rsi14, atrPct) {
  if (price > ema200 && ema20 > ema50 && rsi14 > 50) return "Bullish Trend";
  if (price < ema200 && ema20 < ema50 && rsi14 < 50) return "Bearish Trend";
  if (atrPct > 4.5) return "High Volatility";
  return "Sideways / Wait Confirmation";
}

function estimateTimeframe(score, atrPct, regime) {
  if (score < 60) return "WAIT";
  return intradayDurationLabel();
}

function learningAdjustment(runtime, asset, side) {
  const mem = runtime.memory[`${asset.coin}:${side}`];
  if (!mem || mem.trades < 2) return 0;
  return Math.max(-12, Math.min(12, Number(mem.weightAdjustment || 0)));
}

function buildFundamental(asset, changePct, regime) {
  const out = [];
  if (asset.type === "gold") out.push("Gold/XAUUSD dipakai sebagai pembanding macro.");
  else {
    out.push(`AI memasukkan ${asset.coin} ke universe karena: ${asset.sourceReason || "dynamic_screening"}.`);
    if (asset.volumeUsd) out.push(`Volume market sekitar $${Number(asset.volumeUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}.`);
    if (asset.marketCapRank) out.push(`Market cap rank sekitar #${asset.marketCapRank}.`);
    if (asset.isTrending) out.push(`${asset.coin} muncul di trending market.`);
    out.push(`${asset.coin} narrative: ${(asset.narrative || ["market rotation"]).join(", ")}.`);
  }
  if (changePct > 4) out.push(`Momentum kuat (${changePct.toFixed(2)}%), tetap dicek terhadap resistance.`);
  else if (changePct < -4) out.push(`Momentum lemah (${changePct.toFixed(2)}%), short menarik jika struktur bearish.`);
  else out.push(`Momentum netral (${changePct.toFixed(2)}%), struktur harga lebih dominan.`);
  out.push(`Market regime: ${regime}.`);
  return out;
}


function feePct() {
  return Number(process.env.ASTRAQUANT_EST_ROUNDTRIP_FEE_PCT || 0.25);
}

function positionAllocationMinPct() {
  const legacy = Number(process.env.ASTRAQUANT_POSITION_ALLOCATION_PCT);
  const fallback = Number.isFinite(legacy) && legacy > 0 && legacy <= 0.20 ? legacy : 0.10;
  return Math.min(0.15, Math.max(0.05, Number(process.env.ASTRAQUANT_POSITION_ALLOCATION_MIN_PCT || fallback)));
}

function positionAllocationMaxPct() {
  const minPct = positionAllocationMinPct();
  return Math.min(0.25, Math.max(minPct, Number(process.env.ASTRAQUANT_POSITION_ALLOCATION_MAX_PCT || 0.15)));
}

function dynamicPositionAllocationPct(order) {
  const minPct = positionAllocationMinPct();
  const maxPct = positionAllocationMaxPct();
  const score = Math.max(0, Math.min(100, Number(order?.score || 0)));
  const confidence = Math.max(0, Math.min(100, Number(order?.confidence || 0)));
  const quality = Math.max(0, Math.min(1, (((score * 0.6) + (confidence * 0.4)) - 80) / 20));
  return minPct + (maxPct - minPct) * quality;
}

function maxTotalExposurePct() {
  return Math.min(0.75, Math.max(0.20, Number(process.env.ASTRAQUANT_MAX_TOTAL_EXPOSURE_PCT || 0.45)));
}

function minPositionMargin() {
  return Math.max(5, Number(process.env.ASTRAQUANT_MIN_POSITION_MARGIN || 20));
}

function paperMaxLeverage() {
  return Math.min(3, Math.max(1, Number(process.env.ASTRAQUANT_PAPER_MAX_LEVERAGE || 2)));
}

function maxTotalNotionalPct() {
  return Math.min(1.5, Math.max(0.3, Number(process.env.ASTRAQUANT_MAX_TOTAL_NOTIONAL_PCT || 1.0)));
}

function estimatedRoundTripFeeUsd(notional) {
  return Math.max(0, Number(notional || 0)) * feePct() / 100;
}

function positionNotional(position) {
  const qty = Number(position?.qty || 0);
  const entry = Number(position?.entry || 0);
  if (Number.isFinite(qty) && qty > 0 && Number.isFinite(entry) && entry > 0) return qty * entry;
  return Math.max(0, Number(position?.margin || 0));
}

function baseRiskPerTrade() {
  return Math.min(0.03, Math.max(0.005, Number(process.env.ASTRAQUANT_BASE_RISK_PER_TRADE || 0.02)));
}

function eliteRiskPerTrade() {
  return Math.min(0.04, Math.max(baseRiskPerTrade(), Number(process.env.ASTRAQUANT_ELITE_RISK_PER_TRADE || 0.03)));
}

function dynamicRiskPerTrade(runtime, order) {
  const hardCap = Math.min(0.05, Math.max(0.01, Number(runtime?.riskPerTrade || process.env.ASTRAQUANT_MAX_RISK_PER_TRADE || 0.05)));
  const score = Number(order?.score || 0);
  const confidence = Number(order?.confidence || 0);
  const confluence = Number(order?.confluenceScore || order?.priceAction?.confluenceScore || 0);
  const entry = Number(order?.entry || 0);
  const sl = Number(order?.sl || 0);
  const tp = Number(order?.tp || 0);
  const risk = entry > 0 ? Math.abs(entry - sl) : 0;
  const reward = entry > 0 ? Math.abs(tp - entry) : 0;
  const rr = risk > 0 ? reward / risk : 0;

  let target = baseRiskPerTrade();
  if (score >= 94 && confidence >= 90 && confluence >= 7 && rr >= 1.7) target = eliteRiskPerTrade();
  if (score >= 97 && confidence >= 94 && confluence >= 9 && rr >= 2.0) target = Math.min(hardCap, 0.035);
  return Math.min(hardCap, target);
}

function calculatePositionPlan(runtime, order) {
  const equity = Number(runtime.balance || 0) + (runtime.positions || []).reduce(
    (sum, p) => sum + Number(p.margin || 0) + Number(p.unrealized || 0),
    0
  );
  const usedMargin = (runtime.positions || []).reduce((sum, p) => sum + Number(p.margin || 0), 0);
  const usedNotional = (runtime.positions || []).reduce((sum, p) => sum + positionNotional(p), 0);
  const stopDistancePct = Math.abs(Number(order.entry) - Number(order.sl)) / Number(order.entry);
  if (!Number.isFinite(stopDistancePct) || stopDistancePct <= 0 || !Number.isFinite(equity) || equity <= 0) {
    return { margin: 0, notional: 0, qty: 0, leverage: 1, equity, stopDistancePct, targetAllocationPct: 0, riskBudgetUsd: 0, plannedLossUsd: 0, plannedLossPctOfEquity: 0, estimatedFee: 0 };
  }

  const targetAllocationPct = dynamicPositionAllocationPct(order);
  const configuredRisk = dynamicRiskPerTrade(runtime, order);
  const riskBudgetUsd = Math.max(0, equity * configuredRisk);
  const feeRate = Math.max(0, feePct() / 100);
  const effectiveLossPct = stopDistancePct + feeRate;
  const riskBasedNotional = riskBudgetUsd / Math.max(effectiveLossPct, 0.000001);

  const allocationCap = equity * targetAllocationPct;
  const marginExposureRemaining = Math.max(0, equity * maxTotalExposurePct() - usedMargin);
  const configuredMaxMargin = Number(runtime.maxMargin || process.env.ASTRAQUANT_MAX_MARGIN || 0);
  const hardMaxMargin = Number.isFinite(configuredMaxMargin) && configuredMaxMargin > 0 ? configuredMaxMargin : Infinity;
  const cashAvailable = Math.max(0, Number(runtime.balance || 0));

  let rawMargin = Math.min(allocationCap, marginExposureRemaining, hardMaxMargin, cashAvailable);
  let margin = Math.max(0, Math.floor(rawMargin * 100) / 100);

  const notionalExposureRemaining = Math.max(0, equity * maxTotalNotionalPct() - usedNotional);
  const leverageCapNotional = margin * paperMaxLeverage();
  let notional = Math.max(0, Math.min(riskBasedNotional, leverageCapNotional, notionalExposureRemaining));
  notional = Math.floor(notional * 100) / 100;

  if (notional < margin) margin = Math.max(0, Math.floor(notional * 100) / 100);
  const leverage = margin > 0 ? notional / margin : 0;
  const estimatedFee = estimatedRoundTripFeeUsd(notional);
  const plannedLossUsd = notional * stopDistancePct + estimatedFee;

  return {
    margin,
    notional,
    qty: Number(order.entry) > 0 ? notional / Number(order.entry) : 0,
    leverage,
    equity,
    stopDistancePct,
    targetAllocationPct,
    riskBudgetUsd,
    configuredRiskPct: configuredRisk,
    plannedLossUsd,
    plannedLossPctOfEquity: equity > 0 ? plannedLossUsd / equity * 100 : 0,
    estimatedFee
  };
}

function calculatePositionMargin(runtime, order) {
  return calculatePositionPlan(runtime, order).margin;
}

// V50 intraday profile. These use new environment names so older Vercel
// settings do not silently restore the old multi-day behavior.
function intradayMinHoldHours() {
  return Math.max(1, Number(process.env.ASTRAQUANT_INTRADAY_MIN_HOLD_HOURS || 4));
}

function intradayMaxHoldHours() {
  return Math.max(intradayMinHoldHours(), Number(process.env.ASTRAQUANT_INTRADAY_MAX_HOLD_HOURS || 6));
}

function signalTtlMinutes() {
  return Math.max(15, Number(process.env.ASTRAQUANT_INTRADAY_SIGNAL_TTL_MINUTES || 60));
}

function signalRearmMinutes() {
  return Math.max(5, Number(process.env.ASTRAQUANT_SIGNAL_REARM_MINUTES || 30));
}

function signalSameSetupTolerancePct() {
  return Math.max(0.005, Number(process.env.ASTRAQUANT_SIGNAL_SAME_SETUP_TOLERANCE_PCT || 0.025));
}

function normalizePatternName(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/\s+/g, " ");
}

function relativeGap(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return Infinity;
  return Math.abs(left - right) / Math.max(left, right);
}

function signalLifecycleFingerprint(signal) {
  return [
    String(signal?.coin || "").toUpperCase(),
    String(signal?.side || "WAIT").toUpperCase(),
    normalizePatternName(signal?.priceAction?.pattern),
    String(signal?.marketRegime || "").toUpperCase()
  ].join("|");
}

function sameSignalSetup(previous, current) {
  if (!previous || !current) return false;
  if (String(previous.coin || "").toUpperCase() !== String(current.coin || "").toUpperCase()) return false;
  if (String(previous.side || "").toUpperCase() !== String(current.side || "").toUpperCase()) return false;
  if (normalizePatternName(previous.priceAction?.pattern) !== normalizePatternName(current.priceAction?.pattern)) return false;
  const tolerance = signalSameSetupTolerancePct();
  return relativeGap(previous.entry, current.entry) <= tolerance &&
    relativeGap(previous.sl, current.sl) <= Math.max(0.08, tolerance * 3) &&
    relativeGap(previous.tp, current.tp) <= Math.max(0.08, tolerance * 3);
}

function applySignalLifecycle(signal, previous) {
  const now = Date.now();
  const sameSetup = sameSignalSetup(previous, signal);
  const previousFirstSeen = previous?.firstSeenAt || previous?.priceAction?.lifecycleFirstSeenAt || previous?.updatedAt || previous?.createdAt || null;
  const firstSeenAt = sameSetup && previousFirstSeen ? new Date(previousFirstSeen).toISOString() : new Date(now).toISOString();
  const previousValidUntil = previous?.validUntil || previous?.priceAction?.lifecycleValidUntil || null;
  const validUntil = sameSetup && previousValidUntil
    ? new Date(previousValidUntil).toISOString()
    : new Date(new Date(firstSeenAt).getTime() + signalTtlMinutes() * 60_000).toISOString();

  signal.firstSeenAt = firstSeenAt;
  signal.validUntil = validUntil;
  signal.validForMinutes = signalTtlMinutes();
  signal.scannedAt = new Date(now).toISOString();
  signal.updatedAt = signal.scannedAt;
  signal.priceAction = {
    ...(signal.priceAction || {}),
    lifecycleFirstSeenAt: firstSeenAt,
    lifecycleValidUntil: validUntil,
    lifecycleFingerprint: signalLifecycleFingerprint(signal)
  };
  return signal;
}

async function loadSignalLifecycleMap(runtime) {
  const map = new Map();
  for (const signal of runtime?.lastScan || []) {
    if (signal?.coin && !map.has(signal.coin)) map.set(signal.coin, signal);
  }
  if (!supabase) return map;

  const { data: rows, error } = await supabase
    .from("ai_signals")
    .select("id,coin,symbol,side,entry,sl,tp,score,confidence,created_at,price_action")
    .eq("user_id", runtime.userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    console.warn("loadSignalLifecycleMap error:", error.message);
    return map;
  }

  for (const row of rows || []) {
    if (!row.coin || map.has(row.coin)) continue;
    map.set(row.coin, {
      id: row.id,
      coin: row.coin,
      symbol: row.symbol,
      side: row.side,
      entry: Number(row.entry || 0),
      sl: Number(row.sl || 0),
      tp: Number(row.tp || 0),
      score: Number(row.score || 0),
      confidence: Number(row.confidence || 0),
      firstSeenAt: row.price_action?.lifecycleFirstSeenAt || row.created_at,
      validUntil: row.price_action?.lifecycleValidUntil || (row.created_at ? new Date(new Date(row.created_at).getTime() + signalTtlMinutes() * 60_000).toISOString() : null),
      updatedAt: row.created_at,
      marketRegime: row.price_action?.marketRegime || "",
      priceAction: row.price_action || {}
    });
  }
  return map;
}

function assetCooldownHours() {
  return Math.max(0, Number(process.env.ASTRAQUANT_INTRADAY_ASSET_COOLDOWN_HOURS || 2));
}

function intradayMinTradeScore() {
  return Number(process.env.ASTRAQUANT_INTRADAY_MIN_TRADE_SCORE || 88);
}

function intradayMinTradeConfidence() {
  return Number(process.env.ASTRAQUANT_INTRADAY_MIN_TRADE_CONFIDENCE || 84);
}

function intradayMaxTradeRisk() {
  return Number(process.env.ASTRAQUANT_INTRADAY_MAX_TRADE_RISK || 0.035);
}

function intradayMinTradeRr() {
  return Number(process.env.ASTRAQUANT_INTRADAY_MIN_TRADE_RR || 1.6);
}

function intradayMinNetProfitPct() {
  return Number(process.env.ASTRAQUANT_INTRADAY_MIN_NET_PROFIT_PCT || 1.0);
}


function adaptiveWideStopEnabled() {
  return process.env.ASTRAQUANT_ADAPTIVE_WIDE_STOP_ENABLED !== "false";
}

function adaptiveWideStopMaxRisk() {
  return Math.min(0.30, Math.max(intradayMaxTradeRisk(), Number(process.env.ASTRAQUANT_ADAPTIVE_WIDE_STOP_MAX_RISK || 0.25)));
}

function adaptiveWideStopMinScore() {
  return Math.max(intradayMinTradeScore(), Number(process.env.ASTRAQUANT_ADAPTIVE_WIDE_STOP_MIN_SCORE || 88));
}

function adaptiveWideStopMinConfidence() {
  return Math.max(intradayMinTradeConfidence(), Number(process.env.ASTRAQUANT_ADAPTIVE_WIDE_STOP_MIN_CONFIDENCE || 84));
}

function adaptiveWideStopMinConfluence() {
  return Math.max(5, Number(process.env.ASTRAQUANT_ADAPTIVE_WIDE_STOP_MIN_CONFLUENCE || 7));
}

function adaptiveWideStopMinRr() {
  return Math.max(1.25, Number(process.env.ASTRAQUANT_ADAPTIVE_WIDE_STOP_MIN_RR || 1.6));
}

function adaptiveMinVolumeRatio() {
  return Math.max(0.7, Number(process.env.ASTRAQUANT_ADAPTIVE_MIN_VOLUME_RATIO || 1.15));
}

function adaptiveHardMinVolumeRatio() {
  return Math.max(0.5, Number(process.env.ASTRAQUANT_ADAPTIVE_HARD_MIN_VOLUME_RATIO || 0.80));
}

function adaptiveConfluence(s, stats) {
  const side = String(s?.side || "");
  const entry = Number(s?.entry || s?.price || 0);
  const support = Number(s?.support || 0);
  const resistance = Number(s?.resistance || 0);
  const indicators = s?.indicators || {};
  const fib = s?.fib || {};
  const pa = s?.priceAction || {};
  const reasons = [];
  let score = 0;

  const volumeRatio = Number(indicators.volumeRatio || 0);
  const ema20 = Number(indicators.ema20 || 0);
  const ema50 = Number(indicators.ema50 || 0);
  const ema200 = Number(indicators.ema200 || 0);
  const dailyEma20 = Number(indicators.dailyEma20 || 0);
  const dailyEma50 = Number(indicators.dailyEma50 || 0);
  const macdLine = Number(indicators.macdLine || 0);
  const macdSignal = Number(indicators.macdSignal || 0);
  const macdHist = Number(indicators.macdHist || 0);
  const rsi14 = Number(indicators.rsi14 || 50);
  const atrPct = Math.max(0.2, Number(s?.atrPct || 0));

  if (Number(s?.score || 0) >= adaptiveWideStopMinScore()) {
    score += 1;
    reasons.push(`score tinggi ${Math.round(Number(s.score || 0))}`);
  }
  if (Number(s?.confidence || 0) >= adaptiveWideStopMinConfidence()) {
    score += 1;
    reasons.push(`confidence kuat ${Math.round(Number(s.confidence || 0))}`);
  }
  if (volumeRatio >= adaptiveMinVolumeRatio()) {
    score += 1;
    reasons.push(`volume ${volumeRatio.toFixed(2)}x`);
  }
  if (volumeRatio >= 1.25) {
    score += 1;
    reasons.push("volume ekspansif");
  }

  const trend1h = side === "LONG"
    ? ema20 > ema50 && entry >= ema200
    : ema20 < ema50 && entry <= ema200;
  if (trend1h) {
    score += 1;
    reasons.push("trend 1H searah");
  }

  const dailyTrend = side === "LONG" ? dailyEma20 >= dailyEma50 : dailyEma20 <= dailyEma50;
  if (dailyTrend) {
    score += 1;
    reasons.push("trend harian mendukung");
  }

  const momentum = side === "LONG"
    ? macdLine >= macdSignal && macdHist >= 0 && rsi14 >= 38 && rsi14 <= 72
    : macdLine <= macdSignal && macdHist <= 0 && rsi14 >= 28 && rsi14 <= 62;
  if (momentum) {
    score += 1;
    reasons.push("momentum searah");
  }
  if (String(pa.bias || "").toUpperCase() === side) {
    score += 1;
    reasons.push("price action searah");
  }

  const zoneTolerance = Math.max(0.025, atrPct / 100 * 1.6);
  const fibValues = [fib.fib382, fib.fib500, fib.fib618].map(Number).filter(v => Number.isFinite(v) && v > 0);
  const nearFib = fibValues.some(level => Math.abs(entry - level) / entry <= zoneTolerance);
  if (nearFib) {
    score += 1;
    reasons.push("dekat zona Fibonacci");
  }

  const structuralLevel = side === "LONG" ? support : resistance;
  const structureDistance = Number.isFinite(structuralLevel) && structuralLevel > 0
    ? Math.abs(entry - structuralLevel) / entry
    : Infinity;
  const nearStructure = structureDistance <= Math.min(adaptiveWideStopMaxRisk(), Math.max(0.04, atrPct / 100 * 2.2));
  if (nearStructure) {
    score += 2;
    reasons.push(side === "LONG" ? "support struktural terkonfirmasi" : "resistance struktural terkonfirmasi");
  }

  const sl = Number(s?.sl || 0);
  const structuralStop = side === "LONG"
    ? Number.isFinite(sl) && sl < entry && ((support > 0 && support > sl * 0.97 && support < entry) || fibValues.some(level => level > sl * 0.97 && level < entry))
    : Number.isFinite(sl) && sl > entry && ((resistance > 0 && resistance < sl * 1.03 && resistance > entry) || fibValues.some(level => level < sl * 1.03 && level > entry));

  return {
    score,
    maxScore: 11,
    reasons,
    volumeRatio,
    nearStructure,
    nearFib,
    structuralStop,
    trend1h,
    dailyTrend,
    momentum,
    hardBlock: volumeRatio > 0 && volumeRatio < adaptiveHardMinVolumeRatio(),
    riskPct: Number(stats?.riskPct || 0)
  };
}

function intradayDurationLabel() {
  return `${intradayMinHoldHours()}-${intradayMaxHoldHours()} jam`;
}

function signalAgeMinutes(signal) {
  const timestamp = signal?.firstSeenAt || signal?.priceAction?.lifecycleFirstSeenAt || signal?.createdAt || signal?.created_at || signal?.updatedAt;
  if (!timestamp) return 0;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, (Date.now() - time) / 60_000);
}

function isSignalFresh(signal) {
  const validUntil = signal?.validUntil || signal?.priceAction?.lifecycleValidUntil;
  if (validUntil) {
    const end = new Date(validUntil).getTime();
    if (Number.isFinite(end)) return Date.now() <= end;
  }
  return signalAgeMinutes(signal) <= Number(signal?.validForMinutes || signalTtlMinutes());
}

function cooldownRemainingHours(runtime, coin) {
  const lastTrade = (runtime?.history || [])
    .filter(item => item.coin === coin && item.closedAt)
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))[0];
  if (!lastTrade) return 0;
  const closedAt = new Date(lastTrade.closedAt).getTime();
  if (!Number.isFinite(closedAt)) return 0;
  return Math.max(0, assetCooldownHours() - ((Date.now() - closedAt) / 36e5));
}

function minSignalTargetPct() {
  return Number(process.env.ASTRAQUANT_MIN_SIGNAL_TP_PCT || 1.8);
}

function minTradeTargetPct() {
  return Number(process.env.ASTRAQUANT_MIN_TRADE_TP_PCT || 1.8);
}

function minNetTradeProfitPct() {
  return Number(process.env.ASTRAQUANT_MIN_NET_TRADE_PROFIT_PCT || 1.2);
}

function targetRr() {
  return Number(process.env.ASTRAQUANT_TARGET_RR || 1.5);
}

function applyFeeAwareTarget(side, entry, sl, rawTp) {
  entry = Number(entry);
  sl = Number(sl);
  rawTp = Number(rawTp);
  if (![entry, sl].every(Number.isFinite) || entry <= 0) return { tp: rawTp, rewardPct: 0, netRewardPct: 0, feePct: feePct(), adjusted: false };

  const riskPct = Math.abs(entry - sl) / entry * 100;
  const rawRewardPct = Number.isFinite(rawTp) ? Math.abs(rawTp - entry) / entry * 100 : 0;

  const minimumGrossPct = Math.max(
    minSignalTargetPct(),
    feePct() + minNetTradeProfitPct(),
    riskPct * targetRr()
  );

  const rewardPct = Math.max(rawRewardPct, minimumGrossPct);
  const adjusted = rewardPct > rawRewardPct + 0.000001;

  let tp = rawTp;
  if (side === "LONG") tp = entry * (1 + rewardPct / 100);
  if (side === "SHORT") tp = entry * (1 - rewardPct / 100);

  return {
    tp,
    rewardPct,
    netRewardPct: rewardPct - feePct(),
    feePct: feePct(),
    adjusted
  };
}


function buildSignal(runtime, asset, candles1h, candlesDaily, source) {
  const closes = candles1h.map(c => c.close);
  const volumes = candles1h.map(c => c.volume || 0);
  const price = closes.at(-1);

  if (PRICE_MODE !== "coingecko" && asset.binancePrice && Number.isFinite(asset.binancePrice)) {
    const gap = Math.abs(price - asset.binancePrice) / asset.binancePrice;
    if (gap > Number(process.env.ASTRAQUANT_MAX_EXCHANGE_PRICE_GAP || 0.08)) {
      throw new Error(`${asset.coin} candle/live price mismatch ${(gap * 100).toFixed(2)}%`);
    }
  }

  if (PRICE_MODE === "coingecko" && asset.currentPrice && Number.isFinite(asset.currentPrice)) {
    const gap = Math.abs(price - asset.currentPrice) / asset.currentPrice;
    if (gap > Number(process.env.ASTRAQUANT_MAX_COINGECKO_SPARKLINE_GAP || 0.12)) {
      throw new Error(`${asset.coin} CoinGecko sparkline/current mismatch ${(gap * 100).toFixed(2)}%`);
    }
  }

  const smallCoinSymbols = new Set(["PEPE", "SHIB", "BONK", "FLOKI"]);
  if (smallCoinSymbols.has(asset.coin) && price > 0.1) throw new Error(`${asset.coin} price sanity failed: ${price}`);

  const prev24 = closes[Math.max(0, closes.length - 25)];
  const changePct = ((price - prev24) / prev24) * 100;
  const ema20 = lastValid(ema(closes, 20), price);
  const ema50 = lastValid(ema(closes, 50), price);
  const ema200 = lastValid(ema(closes, Math.min(120, closes.length - 1)), ema50);
  const rsi14 = lastValid(rsi(closes, 14), 50);
  const m = macd(closes);
  const macdLine = lastValid(m.line, 0);
  const macdSignal = lastValid(m.signal, 0);
  const macdHist = lastValid(m.hist, 0);
  const stochArr = stochastic(candles1h, 14);
  const stochK = lastValid(stochArr, 50);
  const stochPrev = lastValid(stochArr.slice(0, -1), 50);
  const atr14 = lastValid(atr(candles1h, 14), price * 0.02);
  const atrPct = (atr14 / price) * 100;
  const volumeAvg = lastValid(sma(volumes, 20), volumes.at(-1) || 1);
  const volumeRatio = volumeAvg > 0 ? (volumes.at(-1) || volumeAvg) / volumeAvg : 1;

  const dailyClose = candlesDaily.map(c => c.close);
  const dailyEma20 = lastValid(ema(dailyClose, Math.min(20, dailyClose.length - 1)), price);
  const dailyEma50 = lastValid(ema(dailyClose, Math.min(50, dailyClose.length - 1)), dailyEma20);
  const dailyRsi = lastValid(rsi(dailyClose, Math.min(14, dailyClose.length - 1)), 50);

  const sr = supportResistance(candles1h, Math.min(90, candles1h.length));
  const fib = fibonacci(candles1h, Math.min(90, candles1h.length));
  const priceAction = detectPriceAction(candles1h);
  const distSupport = Math.abs((price - sr.support) / price) * 100;
  const distResistance = Math.abs((sr.resistance - price) / price) * 100;
  const regime = classifyMarket(ema20, ema50, ema200, price, rsi14, atrPct);

  let longScore = 50 + priceAction.scoreBonusLong;
  let shortScore = 50 + priceAction.scoreBonusShort;
  const why = [];
  const penalty = [];

  if (priceAction.reasons.length) why.push(...priceAction.reasons.slice(0, 5));
  if (ema20 > ema50) { longScore += 11; why.push("EMA20 > EMA50, momentum pendek bullish."); }
  else { shortScore += 11; why.push("EMA20 < EMA50, momentum pendek bearish."); }
  if (price > ema200) { longScore += 8; why.push("Harga di atas trend EMA utama."); }
  else { shortScore += 8; why.push("Harga di bawah trend EMA utama."); }
  if (dailyEma20 > dailyEma50) { longScore += 7; why.push("Daily trend mendukung bullish bias."); }
  else { shortScore += 7; why.push("Daily trend mendukung bearish bias."); }

  if (rsi14 >= 45 && rsi14 <= 62) { longScore += 8; why.push(`RSI ${rsi14.toFixed(1)} sehat.`); }
  else if (rsi14 > 70) { shortScore += 8; penalty.push(`RSI ${rsi14.toFixed(1)} overbought.`); }
  else if (rsi14 < 35) { longScore += 6; why.push(`RSI ${rsi14.toFixed(1)} oversold.`); }

  if (macdLine > macdSignal && macdHist > 0) { longScore += 10; why.push("MACD bullish."); }
  else if (macdLine < macdSignal && macdHist < 0) { shortScore += 10; why.push("MACD bearish."); }

  if (stochK > 82) { shortScore += 5; penalty.push(`Stochastic ${stochK.toFixed(1)} overbought.`); }
  else if (stochK < 22) { longScore += 5; why.push(`Stochastic ${stochK.toFixed(1)} oversold.`); }
  if (stochPrev < 20 && stochK > stochPrev && priceAction.bias === "LONG") { longScore += 8; why.push("Stochastic cross naik dari oversold."); }
  if (stochPrev > 80 && stochK < stochPrev && priceAction.bias === "SHORT") { shortScore += 8; why.push("Stochastic cross turun dari overbought."); }

  if (volumeRatio > 1.18 && changePct > 0) { longScore += 5; why.push(`Volume ${volumeRatio.toFixed(2)}x dan harga menguat.`); }
  else if (volumeRatio > 1.18 && changePct < 0) { shortScore += 5; why.push(`Volume ${volumeRatio.toFixed(2)}x dan harga melemah.`); }

  if (distSupport < distResistance) { longScore += 3; why.push("Harga lebih dekat support."); }
  else { shortScore += 3; why.push("Harga lebih dekat resistance."); }

  const preBoost = Math.min(8, Math.max(0, (asset.preScore || 0) / 12));
  longScore += preBoost;
  shortScore += preBoost * 0.75;

  if (distResistance < atrPct * 0.8 && longScore > shortScore) { longScore -= 8; penalty.push("Long dikurangi karena terlalu dekat resistance."); }
  if (distSupport < atrPct * 0.8 && shortScore > longScore) { shortScore -= 8; penalty.push("Short dikurangi karena terlalu dekat support."); }

  longScore += learningAdjustment(runtime, asset, "LONG");
  shortScore += learningAdjustment(runtime, asset, "SHORT");

  const chosen = longScore >= shortScore ? "LONG" : "SHORT";
  const score = Math.round(Math.max(0, Math.min(99, Math.max(longScore, shortScore))));
  const side = score >= 60 ? chosen : "WAIT";

  let entry = null, sl = null, tp = null, entryPlan = "WAIT";
  if (side === "LONG") {
    const pullbackLevel = priceAction.lowerLine?.now || sr.support || fib.fib618;
    const nearPullback = pullbackLevel && Math.abs((price - pullbackLevel) / price) * 100 < atrPct * 1.2;
    entry = nearPullback ? price : Math.max(price - atr14 * 0.35, sr.support);
    entryPlan = nearPullback ? "entry dekat support/trendline" : "pullback entry";
    sl = Math.min(entry - atr14 * 0.95, sr.support * 0.996, (priceAction.lowerLine?.now || entry) - atr14 * 0.65);
    tp = entry + (entry - sl) * 1.35;
  } else if (side === "SHORT") {
    const pullbackLevel = priceAction.upperLine?.now || sr.resistance || fib.fib382;
    const nearPullback = pullbackLevel && Math.abs((pullbackLevel - price) / price) * 100 < atrPct * 1.2;
    entry = nearPullback ? price : Math.min(price + atr14 * 0.35, sr.resistance);
    entryPlan = nearPullback ? "entry dekat resistance/trendline" : "pullback entry";
    sl = Math.max(entry + atr14 * 0.95, sr.resistance * 1.004, (priceAction.upperLine?.now || entry) + atr14 * 0.65);
    tp = entry - (sl - entry) * 1.35;
  }

  if (asset.type === "gold" && ["LONG", "SHORT"].includes(side)) {
    if (!Number.isFinite(price) || price < 300 || price > 10000) {
      throw new Error(`XAUUSD price sanity failed: ${price}`);
    }

    const quotePrice = Number(asset.currentPrice || price);
    const quoteGap = Math.abs(price - quotePrice) / quotePrice;
    const maxQuoteGap = Number(process.env.ASTRAQUANT_XAU_MAX_QUOTE_GAP_PCT || 3) / 100;
    if (Number.isFinite(quotePrice) && quotePrice > 0 && quoteGap > maxQuoteGap) {
      throw new Error(`XAUUSD current/candle mismatch ${(quoteGap * 100).toFixed(2)}%`);
    }

    const maxRiskPct = Number(process.env.ASTRAQUANT_XAU_MAX_LEVEL_RISK_PCT || 3.5) / 100;
    const minimumRisk = Math.max(atr14 * 0.85, entry * 0.0035);
    const maximumRisk = Math.max(minimumRisk, entry * maxRiskPct);

    if (side === "LONG") {
      const rawRisk = Math.max(minimumRisk, Math.min(maximumRisk, entry - Number(sl || entry - minimumRisk)));
      sl = entry - rawRisk;
      tp = entry + rawRisk * Math.max(1.5, targetRr());
    } else {
      const rawRisk = Math.max(minimumRisk, Math.min(maximumRisk, Number(sl || entry + minimumRisk) - entry));
      sl = entry + rawRisk;
      tp = entry - rawRisk * Math.max(1.5, targetRr());
    }

    why.push(`XAU guard aktif: level dibatasi maksimal ${(maxRiskPct * 100).toFixed(1)}% dari entry dan diselaraskan dengan ATR.`);
  }

  const targetInfo = ["LONG", "SHORT"].includes(side)
    ? applyFeeAwareTarget(side, entry, sl, tp)
    : { tp, rewardPct: 0, netRewardPct: 0, feePct: feePct(), adjusted: false };
  tp = targetInfo.tp;

  if (targetInfo.adjusted) {
    why.push(`TP diperlebar agar net profit masuk akal setelah estimasi fee ${targetInfo.feePct.toFixed(2)}%.`);
  }

  const confidence = Math.round(score * (1 - Math.min(0.22, atrPct / 100)));
  const technicalAnalysis = [
    `Harga terakhir ${fmt(price)}; perubahan sekitar ${changePct.toFixed(2)}%.`,
    `Structure: ${priceAction.pattern}; bias: ${priceAction.bias}.`,
    `Entry plan: ${entryPlan}.`,
    `Intraday profile: signal berlaku ${signalTtlMinutes()} menit, target durasi ${intradayDurationLabel()}, evaluasi aktif mulai jam ke-${intradayMinHoldHours()}.`,
    `Fee-aware target: gross TP ${targetInfo.rewardPct.toFixed(2)}%, estimasi net ${targetInfo.netRewardPct.toFixed(2)}% setelah fee ${targetInfo.feePct.toFixed(2)}%.`,
    `Support ${fmt(sr.support)}, pivot ${fmt(sr.pivot)}, resistance ${fmt(sr.resistance)}.`,
    `Fibonacci: 0.382=${fmt(fib.fib382)}, 0.5=${fmt(fib.fib500)}, 0.618=${fmt(fib.fib618)}.`,
    `EMA20=${fmt(ema20)}, EMA50=${fmt(ema50)}, EMA trend=${fmt(ema200)}.`,
    `RSI=${rsi14.toFixed(1)}, MACD=${macdLine.toFixed(4)}, signal=${macdSignal.toFixed(4)}, hist=${macdHist.toFixed(4)}.`,
    `Stochastic=${stochK.toFixed(1)}, ATR=${atrPct.toFixed(2)}%, volume ratio=${volumeRatio.toFixed(2)}x.`,
    `Daily proxy: EMA20=${fmt(dailyEma20)}, EMA50=${fmt(dailyEma50)}, RSI=${dailyRsi.toFixed(1)}.`,
    ...penalty.map(p => `Risk filter: ${p}`)
  ];

  return {
    id: `${runtime.userId}-${asset.coin}-${Date.now()}`,
    symbol: asset.symbol,
    coin: asset.coin,
    source,
    side,
    score,
    confidence,
    marketRegime: regime,
    timeframe: estimateTimeframe(score, atrPct, regime),
    analysisTimeframe: "1H structure",
    minHoldHours: intradayMinHoldHours(),
    maxHoldHours: intradayMaxHoldHours(),
    validForMinutes: signalTtlMinutes(),
    validUntil: new Date(Date.now() + signalTtlMinutes() * 60_000).toISOString(),
    price,
    changePct,
    feePct: targetInfo.feePct,
    rewardPct: targetInfo.rewardPct,
    netRewardPct: targetInfo.netRewardPct,
    targetAdjusted: targetInfo.adjusted,
    entry,
    sl,
    tp,
    support: sr.support,
    resistance: sr.resistance,
    pivot: sr.pivot,
    fib,
    priceAction,
    atrPct,
    updatedAt: nowIso(),
    chart: candles1h.slice(-95).map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })),
    indicators: { ema20, ema50, ema200, rsi14, macdLine, macdSignal, macdHist, stochK, atr14, volumeRatio, dailyEma20, dailyEma50, dailyRsi },
    why: [...why, ...penalty].slice(0, 12),
    technicalAnalysis,
    fundamentalAnalysis: buildFundamental(asset, changePct, regime)
  };
}


function getSignalRiskStats(s) {
  const entry = Number(s.entry);
  const sl = Number(s.sl);
  const tp = Number(s.tp);
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp) || entry <= 0) {
    return { valid: false, riskPct: Infinity, rewardPct: 0, netRewardPct: -feePct(), rr: 0, feePct: feePct() };
  }

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const riskPct = risk / entry;
  const rewardPct = reward / entry * 100;
  const rr = risk > 0 ? reward / risk : 0;
  const estimatedFeePct = Number(s.feePct ?? feePct());
  const netRewardPct = rewardPct - estimatedFeePct;

  return {
    valid: risk > 0 && reward > 0 && Number.isFinite(riskPct) && Number.isFinite(rr),
    riskPct,
    rewardPct,
    netRewardPct,
    feePct: estimatedFeePct,
    rr
  };
}

function isXauSignalSane(signal) {
  if (String(signal?.coin || "").toUpperCase() !== XAU_COIN) return true;
  const price = Number(signal.price || signal.entry);
  const entry = Number(signal.entry);
  const sl = Number(signal.sl);
  const tp = Number(signal.tp);
  if (![price, entry, sl, tp].every(Number.isFinite)) return false;
  if (price < 300 || price > 10000) return false;
  if (Math.abs(entry - price) / price > 0.05) return false;
  if (Math.abs(sl - entry) / entry > 0.06) return false;
  if (Math.abs(tp - entry) / entry > 0.12) return false;
  if (signal.side === "LONG" && !(sl < entry && tp > entry)) return false;
  if (signal.side === "SHORT" && !(sl > entry && tp < entry)) return false;
  return true;
}

function isDisplaySignal(s) {
  if (!s || !["LONG", "SHORT"].includes(s.side)) return false;
  if (BLOCKED_COINS.has(String(s.coin || "").toUpperCase())) return false;
  if (!isXauSignalSane(s)) return false;
  if (!isSignalFresh(s)) return false;

  const stats = getSignalRiskStats(s);
  return Boolean(
    stats.valid &&
    Number(s.score || 0) >= Number(process.env.ASTRAQUANT_MIN_DISPLAY_SCORE || 58) &&
    Number(s.confidence || 0) >= Number(process.env.ASTRAQUANT_MIN_DISPLAY_CONFIDENCE || 40) &&
    stats.riskPct <= Number(process.env.ASTRAQUANT_MAX_DISPLAY_RISK || 0.28) &&
    stats.rewardPct >= Number(process.env.ASTRAQUANT_MIN_DISPLAY_TP_PCT || 0.8) &&
    stats.netRewardPct >= Number(process.env.ASTRAQUANT_MIN_DISPLAY_NET_PROFIT_PCT || 0.35) &&
    stats.rr >= Number(process.env.ASTRAQUANT_MIN_DISPLAY_RR || 0.75)
  );
}

function isTradableBackendSignal(s) {
  if (!isDisplaySignal(s)) return false;
  const stats = getSignalRiskStats(s);
  return Boolean(
    Number(s.score || 0) >= intradayMinTradeScore() &&
    Number(s.confidence || 0) >= intradayMinTradeConfidence() &&
    stats.riskPct <= intradayMaxTradeRisk() &&
    stats.rewardPct >= minTradeTargetPct() &&
    stats.netRewardPct >= Math.max(minNetTradeProfitPct(), intradayMinNetProfitPct()) &&
    stats.rr >= intradayMinTradeRr()
  );
}

// Backward-compatible name used in older parts of the code.
// In V30 this means "allowed to display", not "allowed to open trade".
function isValidBackendSignal(s) {
  return isDisplaySignal(s);
}

function invalidSignalReason(s) {
  if (!s) return "empty signal";
  if (BLOCKED_COINS.has(String(s.coin || "").toUpperCase())) return "coin masuk blocklist";
  if (!isXauSignalSane(s)) return "XAUUSD gagal sanity guard harga/level";
  if (!["LONG", "SHORT"].includes(s.side)) return "bias belum LONG/SHORT";
  if (!isSignalFresh(s)) return `signal kedaluwarsa (${signalAgeMinutes(s).toFixed(0)} menit)`;
  const stats = getSignalRiskStats(s);
  if (!stats.valid) return "entry/SL/TP tidak valid";
  if (Number(s.score || 0) < Number(process.env.ASTRAQUANT_MIN_DISPLAY_SCORE || 58)) return `score ${s.score} belum lolos display`;
  if (Number(s.confidence || 0) < Number(process.env.ASTRAQUANT_MIN_DISPLAY_CONFIDENCE || 40)) return `confidence ${s.confidence} belum lolos display`;
  if (stats.riskPct > Number(process.env.ASTRAQUANT_MAX_DISPLAY_RISK || 0.28)) return `risk ${(stats.riskPct * 100).toFixed(2)}% terlalu lebar`;
  if (stats.rewardPct < Number(process.env.ASTRAQUANT_MIN_DISPLAY_TP_PCT || 0.8)) return `TP gross ${stats.rewardPct.toFixed(2)}% terlalu kecil`;
  if (stats.netRewardPct < Number(process.env.ASTRAQUANT_MIN_DISPLAY_NET_PROFIT_PCT || 0.35)) return `net profit ${stats.netRewardPct.toFixed(2)}% kurang setelah fee`;
  if (stats.rr < Number(process.env.ASTRAQUANT_MIN_DISPLAY_RR || 0.75)) return `RR ${stats.rr.toFixed(2)} kurang`;
  return "tidak valid";
}

function normalizedSetupText(signal) {
  return [
    signal?.priceAction?.pattern,
    signal?.marketRegime,
    signal?.structure,
    ...(signal?.why || []),
    ...(signal?.technicalAnalysis || [])
  ].filter(Boolean).join(" ").toLowerCase();
}

function selectiveRecoveryGuard(signal, confluence, stats) {
  const reasons = [];
  const text = normalizedSetupText(signal);
  const ambiguous = ["wait", "no clear", "balance", "sideways", "unclear", "range watch"].some(word => text.includes(word));
  const confirmedBreakout = ["breakout retest", "retest confirmed", "support reclaim", "resistance rejection", "liquidity sweep reclaim"].some(word => text.includes(word));

  if (ambiguous && !confirmedBreakout) reasons.push("struktur masih menunggu konfirmasi breakout/retest");
  if (!confluence.trend1h) reasons.push("trend 1H belum searah");
  if (!confluence.momentum) reasons.push("momentum belum searah");
  if (confluence.volumeRatio > 0 && confluence.volumeRatio < adaptiveMinVolumeRatio()) {
    reasons.push(`volume ${confluence.volumeRatio.toFixed(2)}x < ${adaptiveMinVolumeRatio().toFixed(2)}x`);
  }
  if (!confluence.nearStructure && !confluence.nearFib && stats.riskPct > intradayMaxTradeRisk()) {
    reasons.push("wide stop tidak dekat support/resistance/Fibonacci");
  }
  return reasons;
}

function evaluateSignalReadiness(runtime, s) {
  const reasons = [];
  const stats = getSignalRiskStats(s);
  const minTradeScore = intradayMinTradeScore();
  const minTradeConfidence = intradayMinTradeConfidence();
  const maxTradeRisk = intradayMaxTradeRisk();
  const minTradeRr = intradayMinTradeRr();
  const minTradeTp = minTradeTargetPct();
  const minNetProfit = Math.max(minNetTradeProfitPct(), intradayMinNetProfitPct());
  const cooldownHours = cooldownRemainingHours(runtime, s.coin);
  const confluence = adaptiveConfluence(s, stats);
  const selectiveReasons = selectiveRecoveryGuard(s, confluence, stats);
  const wideStop = stats.valid && stats.riskPct > maxTradeRisk;
  const adaptiveWideStopApproved = Boolean(
    adaptiveWideStopEnabled() &&
    wideStop &&
    stats.riskPct <= adaptiveWideStopMaxRisk() &&
    Number(s.score || 0) >= adaptiveWideStopMinScore() &&
    Number(s.confidence || 0) >= adaptiveWideStopMinConfidence() &&
    stats.rr >= adaptiveWideStopMinRr() &&
    confluence.score >= adaptiveWideStopMinConfluence() &&
    confluence.structuralStop &&
    !confluence.hardBlock
  );

  if (!isSignalFresh(s)) reasons.push(`signal kedaluwarsa setelah ${signalTtlMinutes()} menit`);
  if (cooldownHours > 0) reasons.push(`cooldown aset ${cooldownHours.toFixed(1)} jam lagi`);
  if (Number(s.score || 0) < minTradeScore) reasons.push(`score ${s.score} < ${minTradeScore}`);
  if (Number(s.confidence || 0) < minTradeConfidence) reasons.push(`confidence ${s.confidence} < ${minTradeConfidence}`);
  if (!stats.valid || !Number.isFinite(stats.riskPct) || stats.riskPct <= 0) reasons.push("risk distance tidak valid");

  if (stats.valid && wideStop && !adaptiveWideStopApproved) {
    if (stats.riskPct > adaptiveWideStopMaxRisk()) {
      reasons.push(`SL ${(stats.riskPct * 100).toFixed(2)}% melewati hard cap ${(adaptiveWideStopMaxRisk() * 100).toFixed(0)}%`);
    } else {
      reasons.push(`SL lebar butuh konfluensi ${adaptiveWideStopMinConfluence()} poin; saat ini ${confluence.score}`);
      if (!confluence.structuralStop) reasons.push("SL belum terlindungi support/resistance/Fibonacci yang jelas");
      if (confluence.hardBlock) reasons.push(`volume terlalu lemah ${confluence.volumeRatio.toFixed(2)}x`);
      if (stats.rr < adaptiveWideStopMinRr()) reasons.push(`RR wide-stop ${stats.rr.toFixed(2)}R < ${adaptiveWideStopMinRr().toFixed(2)}R`);
    }
  }

  if (stats.rewardPct < minTradeTp) reasons.push(`TP gross ${stats.rewardPct.toFixed(2)}% < ${minTradeTp}%`);
  if (stats.netRewardPct < minNetProfit) reasons.push(`net profit ${stats.netRewardPct.toFixed(2)}% < ${minNetProfit}% setelah fee`);
  const requiredRr = adaptiveWideStopApproved ? adaptiveWideStopMinRr() : minTradeRr;
  if (stats.rr < requiredRr) reasons.push(`risk/reward ${stats.rr.toFixed(2)}R < ${requiredRr.toFixed(2)}R`);
  reasons.push(...selectiveReasons);

  return {
    pass: reasons.length === 0,
    status: !isSignalFresh(s) ? "EXPIRED" : reasons.length === 0 ? "TRADE_READY" : "WATCHLIST",
    reasons,
    stats,
    cooldownHours,
    adaptiveWideStopApproved,
    riskMode: adaptiveWideStopApproved ? "ADAPTIVE_WIDE_STOP" : "STANDARD",
    confluence
  };
}

async function cleanupInvalidSignals(runtime, validSignals = []) {
  if (!supabase) return;

  const validCoins = new Set(validSignals.map(s => s.coin));
  const ttlMs = signalTtlMinutes() * 60_000;
  const now = Date.now();

  const { data: rows, error } = await supabase
    .from("ai_signals")
    .select("id,coin,created_at,score,confidence,side,entry,sl,tp,price_action")
    .eq("user_id", runtime.userId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    console.warn("cleanupInvalidSignals select error:", error.message);
    return;
  }

  const latestPerCoin = new Set();
  const deleteIds = [];

  for (const row of rows || []) {
    const lifecycleFirstSeenAt = row.price_action?.lifecycleFirstSeenAt || row.created_at;
    const lifecycleValidUntil = row.price_action?.lifecycleValidUntil || (lifecycleFirstSeenAt ? new Date(new Date(lifecycleFirstSeenAt).getTime() + ttlMs).toISOString() : null);
    const created = new Date(lifecycleFirstSeenAt || 0).getTime();
    const validEnd = new Date(lifecycleValidUntil || 0).getTime();
    const rearmEnd = Number.isFinite(validEnd) ? validEnd + signalRearmMinutes() * 60_000 : 0;
    const lifecycleLockActive = Boolean(row.price_action?.lifecycleFingerprint) && Number.isFinite(rearmEnd) && now <= rearmEnd;
    const tooOld = Number.isFinite(created) && now - created > ttlMs;

    const pseudo = {
      coin: row.coin,
      side: row.side,
      score: Number(row.score || 0),
      confidence: Number(row.confidence || 0),
      entry: Number(row.entry || 0),
      sl: Number(row.sl || 0),
      tp: Number(row.tp || 0),
      firstSeenAt: lifecycleFirstSeenAt,
      validUntil: lifecycleValidUntil,
      updatedAt: row.created_at,
      validForMinutes: signalTtlMinutes(),
      priceAction: row.price_action || {}
    };

    const duplicateOld = latestPerCoin.has(row.coin);
    latestPerCoin.add(row.coin);

    const invalidAndUnlocked = !isValidBackendSignal(pseudo) && !lifecycleLockActive;
    const missingAndUnlocked = !validCoins.has(row.coin) && !lifecycleLockActive;
    const expiredAndUnlocked = tooOld && !lifecycleLockActive;
    if (duplicateOld || missingAndUnlocked || expiredAndUnlocked || invalidAndUnlocked) {
      deleteIds.push(row.id);
    }
  }

  for (const id of deleteIds.slice(0, 250)) {
    const { error: delErr } = await supabase
      .from("ai_signals")
      .delete()
      .eq("user_id", runtime.userId)
      .eq("id", id);

    if (delErr) console.warn("cleanupInvalidSignals delete error:", delErr.message);
  }
}


function scanStateIsFresh(runtime) {
  const started = new Date(runtime?.scanState?.startedAt || 0).getTime();
  return Boolean(runtime?.scanState?.inProgress) && Number.isFinite(started) && Date.now() - started < SCAN_STALE_MS;
}

function normalizeScanLifecycle(runtime) {
  if (!runtime) return;
  if (runtime.scanState?.inProgress && !scanStateIsFresh(runtime)) {
    runtime.scanState = {
      ...(runtime.scanState || {}),
      inProgress: false,
      finishedAt: nowIso(),
      partial: true,
      staleRecovered: true
    };
    runtime.lastWarning = runtime.lastWarning || "Scan sebelumnya terputus; data terakhir tetap digunakan.";
    runtime.status = runtime.lastScan?.length ? "BACKEND_READY" : "DATA_DELAYED";
  }
  if (runtime.status === "BACKEND_SCANNING" && !scanStateIsFresh(runtime)) {
    runtime.status = runtime.lastScan?.length ? "BACKEND_READY" : "DATA_DELAYED";
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const source = Array.from(items || []);
  const results = new Array(source.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, source.length || 1) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= source.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(source[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function selectScanUniverse(universe, runtime) {
  const selected = [];
  const seen = new Set();
  const priorityCoins = new Set((runtime?.positions || []).map(position => String(position.coin || "").toUpperCase()));
  for (const asset of universe || []) {
    const coin = String(asset.coin || "").toUpperCase();
    if (!coin || seen.has(coin)) continue;
    if (priorityCoins.has(coin)) { selected.push(asset); seen.add(coin); }
  }
  for (const asset of universe || []) {
    const coin = String(asset.coin || "").toUpperCase();
    if (!coin || seen.has(coin)) continue;
    if (selected.length >= SCAN_ASSET_LIMIT) break;
    selected.push(asset);
    seen.add(coin);
  }
  return selected;
}

async function scanMarket(runtime) {
  normalizeScanLifecycle(runtime);
  if (scanStateIsFresh(runtime)) return runtime.lastScan || [];

  const previousStatus = runtime.status;
  const previousSignals = Array.isArray(runtime.lastScan) ? [...runtime.lastScan] : [];
  const startedAt = nowIso();
  const startedMs = Date.now();
  let selectedUniverse = [];
  let valid = [];
  let skipped = [];

  runtime.scanState = {
    inProgress: true,
    startedAt,
    finishedAt: null,
    durationMs: 0,
    processed: 0,
    total: 0,
    valid: 0,
    failed: 0,
    partial: false
  };
  // Only show SCANNING on a cold boot. Existing cached signals stay usable while refresh runs.
  runtime.status = previousSignals.length ? "GLOBAL_ENGINE_ACTIVE" : "BACKEND_SCANNING";

  try {
    const universe = await getDynamicUniverse();
    runtime.universe = universe;
    runtime.universeUpdatedAt = dynamicUniverseUpdatedAt;
    selectedUniverse = selectScanUniverse(universe, runtime);
    runtime.scanState.total = selectedUniverse.length;

    const lifecycleMap = await loadSignalLifecycleMap(runtime);
    const results = await mapWithConcurrency(selectedUniverse, SCAN_CONCURRENCY, async asset => {
      const [one, daily] = await Promise.all([
        getCandles(asset, "1h"),
        getCandles(asset, "1d")
      ]);
      const signal = applySignalLifecycle(
        buildSignal(runtime, asset, one.candles, daily.candles, one.source),
        lifecycleMap.get(asset.coin)
      );
      const readiness = evaluateSignalReadiness(runtime, signal);
      signal.tradeStatus = readiness.status;
      signal.executionReasons = readiness.reasons;
      signal.adaptiveWideStopApproved = readiness.adaptiveWideStopApproved;
      signal.riskMode = readiness.riskMode;
      signal.confluenceScore = readiness.confluence.score;
      signal.confluenceMaxScore = readiness.confluence.maxScore;
      signal.confluenceReasons = readiness.confluence.reasons;
      signal.priceAction = {
        ...(signal.priceAction || {}),
        tradeStatus: readiness.status,
        executionReasons: readiness.reasons,
        marketRegime: signal.marketRegime,
        adaptiveWideStopApproved: readiness.adaptiveWideStopApproved,
        riskMode: readiness.riskMode,
        confluenceScore: readiness.confluence.score,
        confluenceMaxScore: readiness.confluence.maxScore,
        confluenceReasons: readiness.confluence.reasons
      };
      return signal;
    });

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const asset = selectedUniverse[index];
      runtime.scanState.processed += 1;
      if (result?.status === "fulfilled") {
        const signal = result.value;
        if (isValidBackendSignal(signal)) {
          valid.push(signal);
        } else {
          skipped.push({
            coin: signal.coin || asset?.coin,
            side: signal.side || "SKIP",
            score: signal.score || 0,
            confidence: signal.confidence || 0,
            reason: invalidSignalReason(signal),
            checkedAt: nowIso()
          });
        }
      } else {
        runtime.scanState.failed += 1;
        const message = friendlyExternalError(result?.reason);
        skipped.push({
          coin: asset?.coin || "UNKNOWN",
          side: "SKIP",
          score: 0,
          confidence: 0,
          reason: `Data market tertunda: ${message}`,
          checkedAt: nowIso()
        });
      }
    }

    valid.sort((a, b) => (b.score || 0) - (a.score || 0));
    const nextSignals = valid.slice(0, Number(process.env.ASTRAQUANT_SIGNAL_DISPLAY_LIMIT || 20));
    // Never erase usable cached signals just because one external provider had a bad cycle.
    if (nextSignals.length) {
      runtime.lastScan = nextSignals;
      for (const signal of nextSignals) await saveSignal(runtime, signal);
      await cleanupInvalidSignals(runtime, runtime.lastScan);
    } else {
      const now = Date.now();
      runtime.lastScan = previousSignals.filter(signal => {
        const validUntil = new Date(signal.validUntil || signal.priceAction?.lifecycleValidUntil || 0).getTime();
        return !Number.isFinite(validUntil) || validUntil <= 0 || validUntil > now;
      });
    }

    runtime.skippedTrades = skipped.slice(0, 20);
    runtime.lastSync = nowIso();
    runtime.scanState.valid = valid.length;
    runtime.scanState.partial = runtime.scanState.failed > 0;
    runtime.status = runtime.scanState.partial
      ? (runtime.lastScan.length ? "BACKEND_READY_PARTIAL" : "DATA_DELAYED")
      : "BACKEND_READY";
    return runtime.lastScan;
  } catch (err) {
    runtime.lastWarning = friendlyExternalError(err);
    runtime.scanState.partial = true;
    runtime.status = previousSignals.length ? "BACKEND_READY_PARTIAL" : "DATA_DELAYED";
    runtime.lastScan = previousSignals;
    throw err;
  } finally {
    runtime.scanState.inProgress = false;
    runtime.scanState.finishedAt = nowIso();
    runtime.scanState.durationMs = Date.now() - startedMs;
    runtime.scanState.total = selectedUniverse.length || runtime.scanState.total || 0;
    runtime.scanState.valid = valid.length;
    runtime.scanState.failed = runtime.scanState.failed || 0;
    if (runtime.status === "BACKEND_SCANNING") {
      runtime.status = runtime.lastScan?.length ? "BACKEND_READY" : "DATA_DELAYED";
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isFreshPosition(p, minutes = 10) {
  const t = new Date(p.openedAt || 0).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < minutes * 60_000;
}

function hasPriceMismatch(p, livePrice) {
  const entry = Number(p.entry);
  if (!Number.isFinite(entry) || !Number.isFinite(livePrice) || entry <= 0 || livePrice <= 0) return false;
  const gap = Math.abs(livePrice - entry) / entry;
  const plannedRisk = Math.abs(entry - Number(p.sl || entry)) / entry;
  return isFreshPosition(p, 15) && gap > Math.max(0.18, plannedRisk * 5);
}

function safeOrderFromSignal(s) {
  const liveEntry = Number(s.price || s.entry);
  if (!Number.isFinite(liveEntry) || liveEntry <= 0) return null;

  const rawBase = Number(s.entry || liveEntry);
  const rawRiskPct = Math.abs(rawBase - Number(s.sl || rawBase)) / rawBase;
  const rawRewardPct = Math.abs(Number(s.tp || rawBase) - rawBase) / rawBase;
  if (!Number.isFinite(rawRiskPct) || rawRiskPct <= 0) return null;

  const adaptiveApproved = Boolean(s.adaptiveWideStopApproved || s.priceAction?.adaptiveWideStopApproved);
  const maxRisk = adaptiveApproved
    ? adaptiveWideStopMaxRisk()
    : Number(process.env.ASTRAQUANT_MAX_PRICE_RISK || intradayMaxTradeRisk());
  const riskPct = clamp(rawRiskPct, 0.006, maxRisk);
  const rr = adaptiveApproved ? adaptiveWideStopMinRr() : Number(process.env.ASTRAQUANT_RR || targetRr());
  const minTarget = Math.max(rawRewardPct, minTradeTargetPct() / 100, (feePct() + minNetTradeProfitPct()) / 100, riskPct * rr);

  if (s.side === "LONG") {
    return {
      entry: liveEntry,
      sl: liveEntry * (1 - riskPct),
      tp: liveEntry * (1 + minTarget),
      riskMode: adaptiveApproved ? "ADAPTIVE_WIDE_STOP" : "STANDARD",
      confluenceScore: Number(s.confluenceScore || s.priceAction?.confluenceScore || 0)
    };
  }

  if (s.side === "SHORT") {
    return {
      entry: liveEntry,
      sl: liveEntry * (1 + riskPct),
      tp: liveEntry * (1 - minTarget),
      riskMode: adaptiveApproved ? "ADAPTIVE_WIDE_STOP" : "STANDARD",
      confluenceScore: Number(s.confluenceScore || s.priceAction?.confluenceScore || 0)
    };
  }

  return null;
}

function unrealized(p, last) {
  const dir = p.side === "LONG" ? 1 : -1;
  const grossPnl = (last - p.entry) * dir * p.qty;
  return grossPnl - estimatedRoundTripFeeUsd(positionNotional(p));
}

function hoursSince(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / 36e5;
}

function findCurrentSignalForPosition(signals, p) {
  return (signals || []).find(s => s.coin === p.coin) || null;
}

function shouldClose(runtime, p, signal, last) {
  const ageHours = hoursSince(p.openedAt);
  const minReviewHours = Number(p.minHoldHours || runtime.minReviewHours || intradayMinHoldHours());
  const maxHoldHours = Math.min(
    Number(p.maxHoldHours || runtime.staleExitHours || intradayMaxHoldHours()),
    intradayMaxHoldHours()
  );
  const pnlPctOnPrice = p.side === "LONG" ? ((last - p.entry) / p.entry) * 100 : ((p.entry - last) / p.entry) * 100;
  const livePnl = unrealized(p, last);
  const pnlPctOnMargin = Number(p.margin || 0) > 0 ? livePnl / Number(p.margin) * 100 : 0;

  // TP and SL are handled before this function. A strong invalidation or signal flip
  // may still exit early, while discretionary profit/risk exits wait until hour 4.
  if (pnlPctOnMargin <= -4.0) {
    return { close: true, reason: "EMERGENCY RISK CUT", lesson: "Kerugian margin mencapai batas darurat 4%; posisi ditutup tanpa menunggu 4 jam." };
  }

  if (signal && !isValidBackendSignal(signal)) {
    return { close: true, reason: "SIGNAL INVALID EXIT", lesson: "Exit lebih awal karena setup intraday tidak lagi valid." };
  }

  if (signal && ["LONG", "SHORT"].includes(signal.side) && signal.side !== p.side && signal.score >= 78) {
    return { close: true, reason: "SIGNAL FLIP EXIT", lesson: `Exit karena signal berubah dari ${p.side} ke ${signal.side} score ${signal.score}.` };
  }

  if (ageHours >= maxHoldHours) {
    return { close: true, reason: "TIME EXIT 6H", lesson: `Posisi ditutup saat batas maksimum ${maxHoldHours} jam tercapai.` };
  }

  if (ageHours >= minReviewHours && pnlPctOnPrice >= 0.45) {
    return { close: true, reason: "PROFIT LOCK", lesson: `Profit dikunci setelah evaluasi jam ke-${minReviewHours}.` };
  }
  if (ageHours >= minReviewHours && pnlPctOnPrice <= -0.45) {
    return { close: true, reason: "RISK CUT", lesson: `Risiko dipotong setelah evaluasi jam ke-${minReviewHours}.` };
  }
  return { close: false };
}

function diagnoseMistake(p, closeReason) {
  const tags = [];
  if (closeReason === "SL HIT") tags.push("stop_loss");
  if (closeReason === "RISK CUT") tags.push("risk_cut");
  if (p.score < 72) tags.push("low_score_entry");
  if (Math.abs(p.entry - p.sl) / p.entry * 100 > 8) tags.push("wide_stop");
  if (!tags.length) tags.push(closeReason.includes("TP") || closeReason.includes("PROFIT") ? "good_execution" : "neutral_exit");
  return tags;
}

function buildLesson(tags, pnlPct) {
  if (pnlPct >= 0) return "Setup menang; bobot struktur/indikator ini boleh dipertahankan.";
  if (tags.includes("low_score_entry")) return "Score entry terlalu rendah; tunggu konfirmasi tambahan.";
  if (tags.includes("wide_stop")) return "Stop terlalu lebar; tunggu entry lebih dekat level.";
  return "Trade loss; bobot arah yang sama akan dikurangi.";
}

async function updateMemoryFromTrade(runtime, trade) {
  const key = `${trade.coin}:${trade.side}`;
  const mem = runtime.memory[key] || { trades: 0, wins: 0, losses: 0, avgPnlPct: 0, weightAdjustment: 0, mistakeTags: [], notes: [] };
  mem.trades += 1;
  if (trade.pnlPct >= 0) mem.wins += 1; else mem.losses += 1;
  mem.avgPnlPct = ((mem.avgPnlPct * (mem.trades - 1)) + trade.pnlPct) / mem.trades;
  mem.weightAdjustment = trade.pnlPct >= 0 ? Math.min(10, mem.weightAdjustment + 1.2) : Math.max(-12, mem.weightAdjustment - 2.0);
  mem.mistakeTags = [...new Set([...(trade.mistakeTags || []), ...(mem.mistakeTags || [])])].slice(0, 10);
  mem.notes = [trade.lesson, ...(mem.notes || [])].slice(0, 8);
  runtime.memory[key] = mem;
  await saveMemory(runtime, key, trade.coin, trade.side, mem);
}

async function enforceExpiredPositions(runtime) {
  const hardMaxHours = intradayMaxHoldHours();
  const stillOpen = [];
  let closedCount = 0;

  for (const p of runtime.positions || []) {
    const ageHours = hoursSince(p.openedAt);
    const configuredMax = Math.min(Number(p.maxHoldHours || hardMaxHours), hardMaxHours);
    if (ageHours < configuredMax) {
      stillOpen.push(p);
      continue;
    }

    const exit = Number.isFinite(Number(p.last)) && Number(p.last) > 0
      ? Number(p.last)
      : Number(p.entry);
    const pnl = unrealized(p, exit);
    const pnlPct = p.margin ? (pnl / p.margin) * 100 : 0;
    const closeReason = `TIME EXIT ${hardMaxHours}H`;
    const mistakeTags = diagnoseMistake(p, closeReason);
    const lesson = `Posisi otomatis ditutup saat batas maksimum ${hardMaxHours} jam tercapai.`;
    const trade = {
      positionId: p.id,
      coin: p.coin,
      symbol: p.symbol,
      side: p.side,
      entry: p.entry,
      exit,
      sl: p.sl,
      tp: p.tp,
      qty: p.qty,
      margin: p.margin,
      score: p.score,
      pnl,
      pnlPct,
      closeReason,
      mistakeTags,
      lesson,
      openedAt: p.openedAt,
      closedAt: nowIso()
    };

    runtime.balance += Number(p.margin || 0) + pnl;
    runtime.history = [trade, ...(runtime.history || [])].slice(0, 250);
    await closePositionDb(runtime, p, trade);
    await updateMemoryFromTrade(runtime, trade);
    closedCount += 1;
  }

  if (closedCount) {
    runtime.positions = stillOpen;
    await dedupeOpenPositions(runtime);
    reconcileLedger(runtime, "expired_position_close", { rebuildCurve: false });
  }

  return closedCount;
}

async function autoTradingStep(runtime) {
  // Backend handles open, close, TP, SL, and invalid-signal exits without waiting for viewers.
  await refreshOpenPositionsLive(runtime);
  const signals = await scanMarket(runtime);
  const priceByCoin = Object.fromEntries(signals.map(s => [s.coin, s.price]));

  const stillOpen = [];
  for (const p of runtime.positions) {
    // V52: a position must still be evaluated even when its coin is no longer
    // present in the newest signal scan. refreshOpenPositionsLive() updates p.last,
    // so use that as the fallback instead of skipping the position forever.
    const scannedPrice = Number(priceByCoin[p.coin]);
    const refreshedPrice = Number(p.last);
    const last = Number.isFinite(scannedPrice) && scannedPrice > 0
      ? scannedPrice
      : (Number.isFinite(refreshedPrice) && refreshedPrice > 0 ? refreshedPrice : Number(p.entry));

    p.last = last;
    p.unrealized = unrealized(p, last);
    p.pnlPct = p.margin ? (p.unrealized / p.margin) * 100 : 0;

    const hitTp = p.side === "LONG" ? last >= p.tp : last <= p.tp;
    const hitSl = p.side === "LONG" ? last <= p.sl : last >= p.sl;
    const liveSignal = findCurrentSignalForPosition(signals, p);
    const aiClose = shouldClose(runtime, p, liveSignal, last);

    if (hitTp || hitSl || aiClose.close) {
      const exit = hitTp ? p.tp : hitSl ? p.sl : last;
      const pnl = unrealized(p, exit);
      const pnlPct = p.margin ? (pnl / p.margin) * 100 : 0;
      const closeReason = hitTp ? "TP HIT" : hitSl ? "SL HIT" : aiClose.reason;
      const mistakeTags = diagnoseMistake(p, closeReason);
      const lesson = aiClose.lesson || buildLesson(mistakeTags, pnlPct);
      const trade = { positionId: p.id, coin: p.coin, symbol: p.symbol, side: p.side, entry: p.entry, exit, sl: p.sl, tp: p.tp, qty: p.qty, margin: p.margin, score: p.score, pnl, pnlPct, closeReason, mistakeTags, lesson, openedAt: p.openedAt, closedAt: nowIso() };

      runtime.balance += p.margin + pnl;
      runtime.history = [trade, ...runtime.history].slice(0, 250);
      await closePositionDb(runtime, p, trade);
      await updateMemoryFromTrade(runtime, trade);
    } else {
      stillOpen.push(p);
      await updateOpenPosition(runtime, p);
    }
  }

  runtime.positions = stillOpen;
  await dedupeOpenPositions(runtime);

  const openCoins = new Set(runtime.positions.map(p => p.coin));
  const slot = Math.max(0, (runtime.maxOpenPositions || 1) - runtime.positions.length);
  const rejected = [];
  const tradable = signals
    .filter(s => ["LONG", "SHORT"].includes(s.side))
    .filter(s => !openCoins.has(s.coin))
    .filter(s => s.entry && s.sl && s.tp)
    .sort((a, b) => ((b.score || 0) * 0.7 + (b.confidence || 0) * 0.3) - ((a.score || 0) * 0.7 + (a.confidence || 0) * 0.3));

  const candidates = [];
  for (const s of tradable) {
    const evaluation = evaluateSignalReadiness(runtime, s);
    const reasons = [...evaluation.reasons];
    const isTopFive = tradable.indexOf(s) < 5;
    let pass = evaluation.pass;

    if (!isTopFive && pass) {
      const stricterScore = intradayMinTradeScore() + 3;
      const stricterConfidence = intradayMinTradeConfidence() + 3;
      const stricterRisk = Math.max(0.006, intradayMaxTradeRisk() - 0.005);
      const stricterRr = intradayMinTradeRr() + 0.10;
      if (Number(s.score || 0) < stricterScore) reasons.push(`prioritas bawah butuh score ${stricterScore}`);
      if (Number(s.confidence || 0) < stricterConfidence) reasons.push(`prioritas bawah butuh confidence ${stricterConfidence}`);
      if (!evaluation.adaptiveWideStopApproved && evaluation.stats.riskPct > stricterRisk) reasons.push(`prioritas bawah butuh SL <= ${(stricterRisk * 100).toFixed(1)}%`);
      const priorityRr = evaluation.adaptiveWideStopApproved ? adaptiveWideStopMinRr() : stricterRr;
      if (evaluation.stats.rr < priorityRr) reasons.push(`prioritas bawah butuh RR ${priorityRr.toFixed(2)}R`);
      pass = reasons.length === 0;
    }

    s.tradeStatus = pass ? "TRADE_READY" : (isSignalFresh(s) ? "WATCHLIST" : "EXPIRED");
    s.executionReasons = reasons;
    if (s.priceAction) {
      s.priceAction.tradeStatus = s.tradeStatus;
      s.priceAction.executionReasons = reasons;
    }

    if (pass && candidates.length < slot) candidates.push(s);
    else rejected.push({ coin: s.coin, side: s.side, score: s.score, confidence: s.confidence, reason: reasons.length ? reasons.join(", ") : "slot posisi penuh / kalah prioritas", checkedAt: nowIso() });
  }

  runtime.skippedTrades = rejected.slice(0, 20);

  for (const s of candidates) {
    if (!runtime.autoEnabled && process.env.ASTRAQUANT_AUTO_START !== "true") continue;
    if (runtime.positions.some(p => p.coin === s.coin)) continue;

    const order = safeOrderFromSignal(s);
    if (!order) continue;

    const positionPlan = calculatePositionPlan(runtime, { ...order, score: s.score, confidence: s.confidence });
    const margin = positionPlan.margin;
    if (margin < minPositionMargin()) {
      rejected.push({
        coin: s.coin,
        side: s.side,
        score: s.score,
        confidence: s.confidence,
        reason: `size $${margin.toFixed(2)} di bawah minimum $${minPositionMargin().toFixed(2)} / exposure penuh`,
        checkedAt: nowIso()
      });
      continue;
    }

    const p = {
      id: deterministicPositionId(runtime, s),
      coin: s.coin,
      symbol: s.symbol,
      side: s.side,
      entry: order.entry,
      sl: order.sl,
      tp: order.tp,
      qty: positionPlan.qty,
      margin,
      notional: positionPlan.notional,
      leverage: positionPlan.leverage,
      allocatedPct: positionPlan.targetAllocationPct * 100,
      plannedLossUsd: positionPlan.plannedLossUsd,
      plannedLossPctOfEquity: positionPlan.plannedLossPctOfEquity,
      riskMode: order.riskMode || s.riskMode || "STANDARD",
      confluenceScore: Number(order.confluenceScore || s.confluenceScore || 0),
      riskBudgetUsd: positionPlan.riskBudgetUsd,
      estimatedFee: positionPlan.estimatedFee,
      score: s.score,
      status: "OPEN",
      reason: s.why?.[0] || "AI signal",
      signalId: s.id,
      minHoldHours: s.minHoldHours || intradayMinHoldHours(),
      maxHoldHours: s.maxHoldHours || intradayMaxHoldHours(),
      openedAt: nowIso(),
      last: order.entry,
      unrealized: 0,
      pnlPct: 0
    };
    runtime.balance -= margin;
    runtime.positions.push(p);
    await saveOpenPosition(runtime, p);
  }

  await refreshOpenPositionsLive(runtime);

  reconcileLedger(runtime, "auto_trading_step", { rebuildCurve: false });
  runtime.status = "AUTO_TRADING";
  await saveState(runtime);
  return runtime;
}


async function getLiveTickerMap(force = false) {
  const age = liveTickerUpdatedAt ? Date.now() - new Date(liveTickerUpdatedAt).getTime() : Infinity;
  if (!force && liveTickerCache.size && age < 5_000) return liveTickerCache;

  if (PRICE_MODE !== "coingecko") {
    try {
      const binance = await getBinanceTickerMap(force);
      const map = new Map();

      for (const [coin, row] of binance.entries()) {
        map.set(coin, {
          price: row.price,
          changePct: row.changePct,
          volumeUsd: row.volumeUsd,
          source: "Binance spot ticker"
        });
      }

      if (map.size > 20) {
        liveTickerCache = map;
        liveTickerUpdatedAt = nowIso();
        liveTickerSource = "Binance spot ticker";
        return liveTickerCache;
      }
    } catch (err) {
      console.warn("Binance live ticker failed:", err.message);
    }
  }

  try {
    const rows = await getMarketRows(true);
    const map = new Map();

    for (const c of rows || []) {
      const coin = String(c.symbol || "").toUpperCase();
      if (BLOCKED_COINS.has(coin)) continue;

      const price = Number(c.current_price);
      const changePct = Number(c.price_change_percentage_24h || 0);
      const volumeUsd = Number(c.total_volume || 0);

      if (coin && Number.isFinite(price) && price > 0) {
        map.set(coin, {
          price,
          changePct,
          volumeUsd,
          source: "CoinGecko guarded market"
        });
      }
    }

    if (map.size > 10) {
      liveTickerCache = map;
      liveTickerUpdatedAt = nowIso();
      liveTickerSource = "CoinGecko guarded market";
      return liveTickerCache;
    }
  } catch (err) {
    console.warn("CoinGecko live ticker failed:", err.message);
  }

  return liveTickerCache;
}


let simplePriceCache = new Map();
let simplePriceUpdatedAt = null;

async function getCoinbaseSpotPrice(coin) {
  const url = `https://api.coinbase.com/v2/prices/${encodeURIComponent(coin)}-USD/spot`;
  const data = await fetchJson(url);
  const price = Number(data?.data?.amount);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    price,
    changePct: 0,
    volumeUsd: 0,
    source: "Coinbase spot"
  };
}

async function getCoinGeckoSimpleTickerMapForCoins(coins = []) {
  const wanted = [...new Set((coins || []).map(c => String(c || "").toUpperCase()).filter(Boolean))];
  if (!wanted.length) return new Map();

  const age = simplePriceUpdatedAt ? Date.now() - new Date(simplePriceUpdatedAt).getTime() : Infinity;
  const cachedHasAll = wanted.every(c => simplePriceCache.has(c));
  if (cachedHasAll && age < Number(process.env.ASTRAQUANT_SIMPLE_PRICE_CACHE_MS || 4500)) {
    return simplePriceCache;
  }

  const map = new Map(simplePriceCache);

  try {
    const rows = await getMarketRows(true);
    const idByCoin = new Map();
    for (const c of rows || []) {
      const coin = String(c.symbol || "").toUpperCase();
      if (wanted.includes(coin) && c.id) idByCoin.set(coin, c.id);
    }

    const ids = [...new Set([...idByCoin.values()])];
    if (ids.length) {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd&include_24hr_change=true`;
      const data = await fetchJson(url);

      for (const [coin, id] of idByCoin.entries()) {
        const row = data?.[id];
        const price = Number(row?.usd);
        const changePct = Number(row?.usd_24h_change || 0);
        if (Number.isFinite(price) && price > 0) {
          map.set(coin, {
            price,
            changePct,
            volumeUsd: 0,
            source: "CoinGecko simple price"
          });
        }
      }
    }
  } catch (err) {
    console.warn("CoinGecko simple price failed:", err.message);
  }

  for (const coin of wanted) {
    try {
      const cb = await getCoinbaseSpotPrice(coin);
      if (!cb) continue;

      const current = map.get(coin);
      if (!current?.price) {
        map.set(coin, cb);
        continue;
      }

      const gap = Math.abs(current.price - cb.price) / cb.price;
      if (gap <= Number(process.env.ASTRAQUANT_MAX_SECONDARY_PRICE_GAP || 0.08)) {
        map.set(coin, {
          ...cb,
          source: "Coinbase spot / CoinGecko aligned"
        });
      }
    } catch {
      // unsupported pair or blocked network, ignore
    }
  }

  simplePriceCache = map;
  simplePriceUpdatedAt = nowIso();
  return simplePriceCache;
}

async function getLivePriceForPosition(p, tickerMap) {
  if (p.coin === "XAUUSD" || p.symbol === "GC=F") {
    try {
      return { price: await getYahooLastPrice(XAU_SYMBOL), source: "Yahoo Finance GC=F guarded quote" };
    } catch {
      return null;
    }
  }

  const direct = tickerMap.get(p.coin);
  if (direct?.price) return { price: direct.price, source: direct.source };

  const alias = {
    RENDER: "RNDR",
    RNDR: "RENDER",
    POL: "MATIC",
    MATIC: "POL"
  }[p.coin];

  if (alias && tickerMap.get(alias)?.price) {
    const a = tickerMap.get(alias);
    return { price: a.price, source: a.source + " alias" };
  }

  return null;
}

async function refreshOpenPositionsLive(runtime) {
  if (!runtime.positions?.length) {
    runtime.liveTickerSource = liveTickerSource;
    runtime.liveTickerUpdatedAt = liveTickerUpdatedAt;
    return false;
  }

  const tickerMap = PRICE_MODE === "coingecko"
    ? await getCoinGeckoSimpleTickerMapForCoins(runtime.positions.map(p => p.coin))
    : await getLiveTickerMap(true);
  let changed = false;
  const stillOpen = [];

  for (const p of runtime.positions) {
    const live = await getLivePriceForPosition(p, tickerMap);
    if (!live || !Number.isFinite(live.price) || live.price <= 0) {
      stillOpen.push(p);
      continue;
    }

    const oldLast = Number(p.last || p.entry);
    p.last = live.price;
    p.unrealized = unrealized(p, live.price);
    p.pnlPct = p.margin ? (p.unrealized / p.margin) * 100 : 0;
    p.liveTickerSource = live.source;
    p.liveUpdatedAt = nowIso();

    const hitTp = p.side === "LONG" ? live.price >= p.tp : live.price <= p.tp;
    const hitSl = p.side === "LONG" ? live.price <= p.sl : live.price >= p.sl;
    const mismatch = hasPriceMismatch(p, live.price);

    if (mismatch) {
      p.status = "PRICE_MISMATCH_FILTERED";
      runtime.balance += p.margin;
      if (supabase) {
        await supabase
          .from("ai_positions")
          .update({
            status: "PRICE_MISMATCH_FILTERED",
            last: live.price,
            unrealized: 0,
            pnl_pct: 0,
            closed_at: nowIso(),
            reason: "Filtered: entry and live price mismatch"
          })
          .eq("user_id", runtime.userId)
          .eq("id", p.id);
      }
      changed = true;
      continue;
    }

    if (hitTp || hitSl) {
      const exit = hitTp ? p.tp : p.sl;
      const pnl = unrealized(p, exit);
      const pnlPct = p.margin ? (pnl / p.margin) * 100 : 0;
      const closeReason = hitTp ? "TP HIT" : "SL HIT";
      const mistakeTags = diagnoseMistake(p, closeReason);
      const lesson = buildLesson(mistakeTags, pnlPct);
      const trade = {
        positionId: p.id,
        coin: p.coin,
        symbol: p.symbol,
        side: p.side,
        entry: p.entry,
        exit,
        sl: p.sl,
        tp: p.tp,
        qty: p.qty,
        margin: p.margin,
        score: p.score,
        pnl,
        pnlPct,
        closeReason,
        mistakeTags,
        lesson,
        openedAt: p.openedAt,
        closedAt: nowIso()
      };

      runtime.balance += p.margin + pnl;
      runtime.history = [trade, ...runtime.history].slice(0, 250);
      await closePositionDb(runtime, p, trade);
      await updateMemoryFromTrade(runtime, trade);
      changed = true;
      continue;
    }

    if (Math.abs(oldLast - p.last) > 0) changed = true;
    stillOpen.push(p);
    await updateOpenPosition(runtime, p);
  }

  runtime.positions = stillOpen;
  runtime.liveTickerSource = PRICE_MODE === "coingecko" ? "CoinGecko simple/live position price" : liveTickerSource;
  runtime.liveTickerUpdatedAt = PRICE_MODE === "coingecko" ? simplePriceUpdatedAt : liveTickerUpdatedAt;
  reconcileLedger(runtime, "auto_trading_step", { rebuildCurve: false });

  if (changed) await saveState(runtime);
  return changed;
}


async function globalPriceTick() {
  const userId = GLOBAL_ENGINE_USER_ID;
  if (!GLOBAL_ENGINE_ENABLED) return;
  if (priceLoopRunning.has(userId)) return;

  priceLoopRunning.add(userId);
  try {
    const runtime = await getRuntime(userId);
    await refreshOpenPositionsLive(runtime);
    runtime.status = runtime.positions?.length ? "LIVE_PRICE_TICK" : runtime.status;
    await saveState(runtime);
  } catch (err) {
    const runtime = MEMORY_STATE.get(userId);
    if (runtime) {
      runtime.lastWarning = friendlyExternalError(err);
      runtime.status = isAbortLikeError(err) || err?.code === "EXTERNAL_TIMEOUT" ? "PRICE_DELAYED" : "PRICE_RETRYING";
    }
    console.warn("Global price tick warning:", userId, friendlyExternalError(err));
  } finally {
    priceLoopRunning.delete(userId);
  }
}

async function globalEngineTick() {
  const userId = GLOBAL_ENGINE_USER_ID;
  if (!GLOBAL_ENGINE_ENABLED) return;
  if (loopRunning.has(userId)) return;

  loopRunning.add(userId);
  try {
    const runtime = await getRuntime(userId);

    // Always keep open positions updated and enforce TP/SL even when no one is watching.
    await refreshOpenPositionsLive(runtime);

    if (GLOBAL_ENGINE_OPEN_TRADES) {
      runtime.autoEnabled = true;
      await autoTradingStep(runtime);
      runtime.status = "GLOBAL_ENGINE_ACTIVE";
    } else {
      runtime.autoEnabled = false;
      await scanMarket(runtime);
      runtime.status = "GLOBAL_ENGINE_OBSERVE";
      await saveState(runtime);
    }
  } catch (err) {
    const runtime = MEMORY_STATE.get(userId);
    if (runtime) {
      runtime.lastWarning = friendlyExternalError(err);
      runtime.status = isAbortLikeError(err) || err?.code === "EXTERNAL_TIMEOUT" ? "BACKEND_RETRYING" : "BACKEND_DEGRADED";
      try { await saveState(runtime); } catch {}
    }
    console.warn("Global engine warning:", userId, friendlyExternalError(err));
  } finally {
    loopRunning.delete(userId);
  }
}

async function backgroundLoopForUser(userId) {
  // Backward-compatible wrapper. User traffic no longer creates separate bot loops.
  return globalEngineTick();
}

async function maybeServerlessTick(reason = "request") {
  if (!process.env.VERCEL && process.env.ASTRAQUANT_FORCE_SERVERLESS_TICK !== "true") return;
  if (process.env.ASTRAQUANT_VERCEL_TICK_ON_REQUEST === "false") return;

  const now = Date.now();
  const tasks = [];

  if (now - lastServerlessPriceTickAt > SERVERLESS_PRICE_INTERVAL_MS) {
    lastServerlessPriceTickAt = now;
    tasks.push(globalPriceTick());
  }

  if (now - lastServerlessEngineTickAt > SERVERLESS_ENGINE_INTERVAL_MS) {
    lastServerlessEngineTickAt = now;
    tasks.push(globalEngineTick());
  }

  if (!tasks.length) return;

  try {
    await Promise.allSettled(tasks);
  } catch (err) {
    console.warn("Serverless tick skipped:", reason, err.message);
  }
}

app.get("/api/state", async (req, res) => {
  try {
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    normalizeScanLifecycle(runtime);
    let livePriceRefreshed = false;
    let warning = null;

    try {
      await refreshOpenPositionsLive(runtime);
      livePriceRefreshed = true;
    } catch (err) {
      warning = friendlyExternalError(err);
      runtime.lastWarning = warning;
      runtime.status = isAbortLikeError(err) || err?.code === "EXTERNAL_TIMEOUT" ? "PRICE_DELAYED" : "BACKEND_DEGRADED";
      console.warn("State live-price refresh warning:", warning);
    }

    try {
      const expiredClosed = await enforceExpiredPositions(runtime);
      if (expiredClosed) await saveState(runtime);
    } catch (err) {
      warning = warning || friendlyExternalError(err);
      runtime.lastWarning = warning;
      console.warn("State expiry enforcement warning:", warning);
    }

    if (process.env.VERCEL && process.env.ASTRAQUANT_VERCEL_TICK_ON_REQUEST !== "false") {
      const now = Date.now();
      if (now - lastServerlessEngineTickAt > SERVERLESS_ENGINE_INTERVAL_MS) {
        lastServerlessEngineTickAt = now;
        // Fire once per interval, but scanMarket no longer persists a stale SCANNING state.
        globalEngineTick().catch(err => console.warn("Serverless background engine warning:", friendlyExternalError(err)));
      }
    }

    runtime.accounting = buildAccountingBreakdown(runtime);

    res.json({
      ok: true,
      data: runtime,
      meta: {
        livePriceRefreshed,
        liveTickerSource: runtime.liveTickerSource || liveTickerSource,
        liveTickerUpdatedAt: runtime.liveTickerUpdatedAt || liveTickerUpdatedAt,
        serverless: !!process.env.VERCEL,
        warning
      }
    });
  } catch (err) {
    const cached = MEMORY_STATE.get(GLOBAL_ENGINE_USER_ID);
    if (cached) {
      cached.lastWarning = friendlyExternalError(err);
      cached.status = isAbortLikeError(err) || err?.code === "EXTERNAL_TIMEOUT" ? "BACKEND_RETRYING" : "BACKEND_DEGRADED";
      return res.json({ ok: true, data: cached, meta: { cached: true, warning: cached.lastWarning } });
    }
    res.status(503).json({ ok: false, error: friendlyExternalError(err) });
  }
});

app.get("/api/scan-health", async (req, res) => {
  try {
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    normalizeScanLifecycle(runtime);
    res.json({
      ok: true,
      data: {
        status: runtime.status,
        scanState: runtime.scanState,
        cachedSignals: runtime.lastScan?.length || 0,
        universeSize: runtime.universe?.length || 0,
        scanAssetLimit: SCAN_ASSET_LIMIT,
        scanConcurrency: SCAN_CONCURRENCY,
        lastSync: runtime.lastSync,
        lastWarning: runtime.lastWarning || null
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: friendlyExternalError(err) });
  }
});

app.get("/api/scan", async (req, res) => {
  try {
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    const data = await scanMarket(runtime);
    await saveState(runtime);
    res.json({ ok: true, data, bot: runtime });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/auto-step", async (req, res) => {
  try {
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    res.json({ ok: true, data: await autoTradingStep(runtime) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/start-ai", async (req, res) => {
  if (!requireAdminToken(req)) return res.status(403).json({ ok: false, error: "Admin only" });
  try {
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    runtime.autoEnabled = true;
    runtime.status = "PAPER_AI_ACTIVE";
    await saveState(runtime);
    res.json({ ok: true, data: runtime });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/pause-ai", async (req, res) => {
  if (!requireAdminToken(req)) return res.status(403).json({ ok: false, error: "Admin only" });
  try {
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    runtime.autoEnabled = false;
    runtime.status = "OBSERVE_ONLY";
    await saveState(runtime);
    res.json({ ok: true, data: runtime });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/close-position", async (req, res) => {
  res.status(403).json({ ok: false, error: "Manual close disabled. AstraQuant exits positions autonomously." });
});

app.post("/api/reset", async (req, res) => {
  res.status(403).json({ ok: false, error: "Reset disabled. Online learning data is persistent." });
});

app.post("/api/new-workspace", async (req, res) => {
  try {
    const userId = getUserId(req);
    MEMORY_STATE.delete(userId);

    if (supabase) {
      await supabase.from("ai_bot_state").upsert({
        user_id: userId,
        id: "main",
        balance: 1000,
        equity: 1000,
        risk_per_trade: 0.015,
        updated_at: nowIso()
      }, { onConflict: "user_id,id" });
    }

    const runtime = await getRuntime(userId);
    res.json({ ok: true, data: runtime });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/rebuild-learning", async (req, res) => {
  try {
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    runtime.learningRebuilt = null;
    process.env.ASTRAQUANT_REBUILD_LEARNING_FROM_HISTORY = "true";
    await ensureLearningMemoryFromHistory(runtime);
    res.json({ ok: true, data: { memory: runtime.memory, learningRebuilt: runtime.learningRebuilt } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/workspace-info", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!supabase) return res.json({ ok: true, data: { userId, supabase: false } });

    const [signals, positions, history, memory] = await Promise.all([
      supabase.from("ai_signals").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("ai_positions").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("ai_trade_history").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("ai_memory").select("key", { count: "exact", head: true }).eq("user_id", userId)
    ]);

    res.json({
      ok: true,
      data: {
        userId,
        signals: signals.count || 0,
        positions: positions.count || 0,
        history: history.count || 0,
        memory: memory.count || 0
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/live-tickers", async (req, res) => {
  try {
    const map = await getLiveTickerMap(true);
    const sample = [...map.entries()].slice(0, 30).map(([coin, v]) => ({ coin, ...v }));
    res.json({ ok: true, data: { source: liveTickerSource, updatedAt: liveTickerUpdatedAt, count: map.size, sample } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/cron-tick", async (req, res) => {
  try {
    const secret = process.env.ASTRAQUANT_CRON_SECRET;
    if (secret && req.query.secret !== secret && req.headers["x-cron-secret"] !== secret) {
      return res.status(403).json({ ok: false, error: "Invalid cron secret" });
    }

    await globalPriceTick();
    await globalEngineTick();
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    res.json({ ok: true, data: { status: runtime.status, equity: runtime.equity, positions: runtime.positions.length, history: runtime.history.length, workspace: GLOBAL_ENGINE_USER_ID } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/xau-health", async (req, res) => {
  try {
    const asset = { symbol: XAU_SYMBOL, coin: XAU_COIN, type: "gold", currentPrice: null };
    const price = await getYahooLastPrice(XAU_SYMBOL);
    asset.currentPrice = price;
    const candles = await getYahooCandles(asset, "1h", "1mo");
    const last = candles.at(-1);
    res.json({
      ok: true,
      data: {
        enabled: XAU_ENABLED,
        blocked: BLOCKED_COINS.has(XAU_COIN) || BLOCKED_COINS.has(XAU_SYMBOL),
        coin: XAU_COIN,
        symbol: XAU_SYMBOL,
        instrument: "Gold Futures proxy for XAUUSD",
        source: "Yahoo Finance guarded chart",
        price,
        candleCount: candles.length,
        lastCandle: last,
        range: {
          low: Math.min(...candles.map(candle => candle.low)),
          high: Math.max(...candles.map(candle => candle.high))
        }
      }
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message,
      data: {
        enabled: XAU_ENABLED,
        blocked: BLOCKED_COINS.has(XAU_COIN) || BLOCKED_COINS.has(XAU_SYMBOL),
        coin: XAU_COIN,
        symbol: XAU_SYMBOL
      }
    });
  }
});

app.get("/api/accounting-health", async (req, res) => {
  try {
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    await refreshOpenPositionsLive(runtime);
    const audit = reconcileLedger(runtime, "accounting_health", { rebuildCurve: false });
    res.json({
      ok: true,
      workspace: runtime.userId,
      accounting: runtime.accounting,
      audit,
      positions: (runtime.positions || []).map(p => ({
        id: p.id,
        coin: p.coin,
        side: p.side,
        margin: Number(p.margin || 0),
        notional: positionNotional(p),
        leverage: Number(p.leverage || 1),
        unrealized: Number(p.unrealized || 0)
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


app.get("/api/ledger-audit", async (req, res) => {
  try {
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    await refreshOpenPositionsLive(runtime);
    const audit = reconcileLedger(runtime, "manual_ledger_audit", { rebuildCurve: false });
    res.json({
      ok: true,
      workspace: runtime.userId,
      audit,
      formula: "expected equity = $1,000 initial capital + all unique realized P/L + current open P/L",
      verifiedScreenshotReference: VERIFIED_SCREENSHOT_LEDGER,
      recentTrades: (runtime.history || []).slice(0, 20).map(trade => ({
        coin: trade.coin,
        side: trade.side,
        pnl: Number(trade.pnl || 0),
        closedAt: trade.closedAt
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    supabase: SUPABASE_READY,
    storage: SUPABASE_READY ? "supabase_online" : "memory_demo",
    xauEnabled: XAU_ENABLED,
    xauBlocked: BLOCKED_COINS.has(XAU_COIN) || BLOCKED_COINS.has(XAU_SYMBOL)
  });
});

// V61: strict $1,000 ledger rebuild, low-leverage selective engine, and XAU guard self-tests.
export { sanitizeYahooCandles, safeProjectedLine, isXauSignalSane, canonicalLedger, canonicalHistory, rebuildCanonicalEquityCurve };
export default app;

if (!process.env.VERCEL) {
  // Normal local/server mode: one global backend engine.
  setInterval(() => {
    globalEngineTick();
  }, GLOBAL_ENGINE_INTERVAL_MS);

  setTimeout(() => {
    globalEngineTick();
  }, 3000);

  setInterval(() => {
    globalPriceTick();
  }, GLOBAL_PRICE_TICK_MS);

  setTimeout(() => {
    globalPriceTick();
  }, 1500);

  app.listen(PORT, () => {
    console.log(`AstraQuant AI V63 running: http://localhost:${PORT}`);
    console.log(`Storage: ${SUPABASE_READY ? "Supabase Online DB" : "Supabase not connected, memory demo only"}`);
    console.log(`Global Engine: ${GLOBAL_ENGINE_ENABLED ? "ON" : "OFF"} | Workspace: ${GLOBAL_ENGINE_USER_ID}`);
    console.log(`Price Tick: every ${GLOBAL_PRICE_TICK_MS}ms`);
  });
}
