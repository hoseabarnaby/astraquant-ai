
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
const SERVERLESS_PRICE_INTERVAL_MS = Number(process.env.ASTRAQUANT_SERVERLESS_PRICE_INTERVAL_MS || 15000);
let lastServerlessEngineTickAt = 0;
let lastServerlessPriceTickAt = 0;
const MIGRATE_FROM_WORKSPACES = (process.env.ASTRAQUANT_MIGRATE_FROM_WORKSPACES || "astraquant_global_engine_v39,astraquant_global_engine_v38,astraquant_global_engine_v37,astraquant_global_engine_v36,astraquant_global_engine_v35,astraquant_global_engine_v34,astraquant_global_engine_v33,astraquant_global_engine_v32,astraquant_global_engine_v31,astraquant_global_engine_v30,astraquant_global_engine_v29,astraquant_global_engine_v28,astraquant_global_engine_v27,astraquant_v25_safe_demo,astraquant_v21_live,public_workspace")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);
const GLOBAL_PRICE_TICK_MS = Number(process.env.ASTRAQUANT_PRICE_TICK_MS || 5000);
const PRICE_MODE = (process.env.ASTRAQUANT_PRICE_MODE || "coingecko").toLowerCase();
const DEFAULT_BLOCKLIST = "SAHARA,XAUUSD,GC=F";
const BLOCKED_COINS = new Set(
  `${DEFAULT_BLOCKLIST},${process.env.ASTRAQUANT_BLOCKLIST || ""}`
    .split(",")
    .map(x => x.trim().toUpperCase())
    .filter(Boolean)
);
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
    riskPerTrade: Number(process.env.ASTRAQUANT_MAX_RISK_PER_TRADE || 0.015),
    positions: [],
    history: [],
    memory: {},
    equityCurve: [],
    lastScan: [],
    skippedTrades: [],
    universe: dynamicUniverse,
    universeUpdatedAt: dynamicUniverseUpdatedAt,
    source: SUPABASE_READY ? "Online Memory + Smart Screener" : "Demo memory only: Supabase .env missing",
    lastSync: null,
    status: SUPABASE_READY ? "BOOTING" : "SUPABASE_NOT_CONNECTED",
    staleExitHours: 6,
    signalFlipExit: true,
    storageMode: SUPABASE_READY ? "supabase_online" : "memory_demo",
    liveTickerSource,
    liveTickerUpdatedAt,
    autoEnabled: GLOBAL_ENGINE_OPEN_TRADES,
    safeMode: true,
    maxOpenPositions: Number(process.env.ASTRAQUANT_MAX_OPEN_POSITIONS || 3),
    maxMargin: Number(process.env.ASTRAQUANT_MAX_MARGIN || 10),
    maxPriceRisk: Number(process.env.ASTRAQUANT_MAX_PRICE_RISK || 0.035)
  };
}



async function dedupeOpenPositions(runtime) {
  if (!Array.isArray(runtime.positions) || runtime.positions.length <= 1) return;

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

  if (supabase && duplicates.length) {
    for (const p of duplicates) {
      try {
        await supabase
          .from("ai_positions")
          .update({
            status: "DUPLICATE_FILTERED",
            closed_at: nowIso(),
            reason: "Filtered duplicate open position"
          })
          .eq("user_id", runtime.userId)
          .eq("id", p.id);
      } catch (err) {
        console.warn("duplicate position cleanup skipped:", err.message);
      }
    }
  }
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

  if (!supabase) return runtime;


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
      .limit(100);
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
    runtime.riskPerTrade = Math.min(Number(state.risk_per_trade ?? 0.015), Number(process.env.ASTRAQUANT_MAX_RISK_PER_TRADE || 0.015));
    runtime.positions = (positions || []).map(fromPositionRow).filter(p => !BLOCKED_COINS.has(String(p.coin || p.symbol || "").toUpperCase()));
    runtime.history = normalizeHistoryRows(history || []).map(fromHistoryRow);
    runtime.memory = {};

    for (const row of memoryRows || []) {
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
    await dedupeOpenPositions(runtime);
    runtime.equity = runtime.balance + runtime.positions.reduce((sum, p) => sum + p.margin + (p.unrealized || 0), 0);
    if (!runtime.equityCurve.length) recordEquitySnapshot(runtime, "load", true);
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
    maxHoldHours: Number(row.max_hold_hours || 6),
    reason: row.reason || "AI signal",
    last: Number(row.last || row.entry),
    unrealized: Number(row.unrealized || 0),
    pnlPct: Number(row.pnl_pct || 0),
    openedAt: row.opened_at
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
      timeframe: row.timeframe,
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
  runtime.equity = runtime.balance + runtime.positions.reduce((sum, p) => sum + p.margin + (p.unrealized || 0), 0);

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
  if (recorded) await saveEquityCurve(runtime);
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

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 AstraQuantAI", "Accept": "application/json,text/plain,*/*" }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
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
  if (process.env.ASTRAQUANT_ENABLE_XAUUSD === "true" && !BLOCKED_COINS.has("XAUUSD")) {
    top.push({ symbol: "GC=F", coin: "XAUUSD", type: "gold", name: "Gold Futures", narrative: ["gold", "safe haven", "macro"], marketCapRank: 0, volumeUsd: 0, sourceReason: "macro_filter", preScore: 10 });
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?interval=${interval}&range=${range}`;
  const json = await fetchJson(url);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo empty");
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const open = Number(q.open?.[i]);
    const high = Number(q.high?.[i]);
    const low = Number(q.low?.[i]);
    const close = Number(q.close?.[i]);
    const volume = Number(q.volume?.[i] || 0);
    if ([open, high, low, close].every(Number.isFinite)) candles.push({ time: ts[i] * 1000, open, high, low, close, volume });
  }
  if (candles.length < 60) throw new Error("Yahoo candles too short");
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
  return { candles, source: "Yahoo Finance" };
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
  const upperNow = h1 && h2 ? lineValue(h1, h2, lastIndex) : null;
  const lowerNow = l1 && l2 ? lineValue(l1, l2, lastIndex) : null;

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

  return { pattern, bias, scoreBonusLong, scoreBonusShort, reasons, upperLine: h1 && h2 ? { p1: h1, p2: h2, now: upperNow } : null, lowerLine: l1 && l2 ? { p1: l1, p2: l2, now: lowerNow } : null, pivots: { highs: pivotHighs.slice(-5), lows: pivotLows.slice(-5) } };
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
  if (score >= 86 && regime.includes("Trend")) return "6-18 jam";
  if (score >= 78) return "12 jam - 2 hari";
  if (score >= 68) return "1-3 hari";
  return "WAIT";
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
    maxHoldHours: score >= 80 ? 6 : 4,
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

function isDisplaySignal(s) {
  if (!s || !["LONG", "SHORT"].includes(s.side)) return false;
  if (BLOCKED_COINS.has(String(s.coin || "").toUpperCase())) return false;

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
    Number(s.score || 0) >= Number(process.env.ASTRAQUANT_MIN_TRADE_SCORE || 78) &&
    Number(s.confidence || 0) >= Number(process.env.ASTRAQUANT_MIN_TRADE_CONFIDENCE || 65) &&
    stats.riskPct <= Number(process.env.ASTRAQUANT_MAX_TRADE_RISK || 0.12) &&
    stats.rewardPct >= minTradeTargetPct() &&
    stats.netRewardPct >= minNetTradeProfitPct() &&
    stats.rr >= Number(process.env.ASTRAQUANT_MIN_TRADE_RR || 1.10)
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
  if (!["LONG", "SHORT"].includes(s.side)) return "bias belum LONG/SHORT";
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

async function cleanupInvalidSignals(runtime, validSignals = []) {
  if (!supabase) return;

  const validCoins = new Set(validSignals.map(s => s.coin));
  const ttlMs = Number(process.env.ASTRAQUANT_SIGNAL_TTL_MINUTES || 45) * 60_000;
  const now = Date.now();

  const { data: rows, error } = await supabase
    .from("ai_signals")
    .select("id,coin,created_at,score,confidence,side,entry,sl,tp")
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
    const created = new Date(row.created_at || 0).getTime();
    const tooOld = Number.isFinite(created) && now - created > ttlMs;

    const pseudo = {
      coin: row.coin,
      side: row.side,
      score: Number(row.score || 0),
      confidence: Number(row.confidence || 0),
      entry: Number(row.entry || 0),
      sl: Number(row.sl || 0),
      tp: Number(row.tp || 0)
    };

    const duplicateOld = latestPerCoin.has(row.coin);
    latestPerCoin.add(row.coin);

    if (!validCoins.has(row.coin) || tooOld || duplicateOld || !isValidBackendSignal(pseudo)) {
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


async function scanMarket(runtime) {
  runtime.status = "BACKEND_SCANNING";
  const universe = await getDynamicUniverse();
  runtime.universe = universe;
  runtime.universeUpdatedAt = dynamicUniverseUpdatedAt;

  const valid = [];
  const skipped = [];

  for (const asset of universe) {
    try {
      const one = await getCandles(asset, "1h");
      const daily = await getCandles(asset, "1d");
      const signal = buildSignal(runtime, asset, one.candles, daily.candles, one.source);

      if (isValidBackendSignal(signal)) {
        valid.push(signal);
        await saveSignal(runtime, signal);
      } else {
        skipped.push({
          coin: signal.coin || asset.coin,
          side: signal.side || "SKIP",
          score: signal.score || 0,
          confidence: signal.confidence || 0,
          reason: invalidSignalReason(signal),
          checkedAt: nowIso()
        });
      }
    } catch (err) {
      skipped.push({
        coin: asset.coin,
        side: "SKIP",
        score: 0,
        confidence: 0,
        reason: `Chart invalid / unsupported: ${err.message}`,
        checkedAt: nowIso()
      });
    }
  }

  valid.sort((a, b) => (b.score || 0) - (a.score || 0));
  runtime.lastScan = valid.slice(0, Number(process.env.ASTRAQUANT_SIGNAL_DISPLAY_LIMIT || 20));
  runtime.skippedTrades = skipped.slice(0, 20);
  runtime.lastSync = nowIso();
  runtime.status = "BACKEND_READY";

  await cleanupInvalidSignals(runtime, runtime.lastScan);
  return runtime.lastScan;
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
  if (!Number.isFinite(rawRiskPct) || rawRiskPct <= 0) return null;

  const riskPct = clamp(rawRiskPct, 0.006, Number(process.env.ASTRAQUANT_MAX_PRICE_RISK || 0.035));
  const rr = Number(process.env.ASTRAQUANT_RR || targetRr());
  const minTarget = Math.max(minTradeTargetPct() / 100, (feePct() + minNetTradeProfitPct()) / 100, riskPct * rr);

  if (s.side === "LONG") {
    return {
      entry: liveEntry,
      sl: liveEntry * (1 - riskPct),
      tp: liveEntry * (1 + minTarget)
    };
  }

  if (s.side === "SHORT") {
    return {
      entry: liveEntry,
      sl: liveEntry * (1 + riskPct),
      tp: liveEntry * (1 - minTarget)
    };
  }

  return null;
}

function unrealized(p, last) {
  const dir = p.side === "LONG" ? 1 : -1;
  return (last - p.entry) * dir * p.qty;
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
  const pnlPctOnPrice = p.side === "LONG" ? ((last - p.entry) / p.entry) * 100 : ((p.entry - last) / p.entry) * 100;

  if (signal && !isValidBackendSignal(signal)) {
    return { close: true, reason: "SIGNAL INVALID EXIT", lesson: "Exit karena setup tidak lagi valid di scan backend terbaru." };
  }

  if (signal && ["LONG", "SHORT"].includes(signal.side) && signal.side !== p.side && signal.score >= 70) {
    return { close: true, reason: "SIGNAL FLIP EXIT", lesson: `Exit karena signal berubah dari ${p.side} ke ${signal.side} score ${signal.score}.` };
  }
  if (ageHours >= (p.maxHoldHours || runtime.staleExitHours) && Math.abs(pnlPctOnPrice) < 1.0) {
    return { close: true, reason: "TIME EXIT", lesson: `Exit karena posisi terlalu lama sideways.` };
  }
  if (ageHours >= 2 && pnlPctOnPrice >= 0.45) return { close: true, reason: "PROFIT LOCK", lesson: "Profit dikunci sebelum TP penuh." };
  if (ageHours >= 3 && pnlPctOnPrice <= -0.45) return { close: true, reason: "RISK CUT", lesson: "Cut loss karena posisi melemah dan belum pulih." };
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

async function autoTradingStep(runtime) {
  // Backend handles open, close, TP, SL, and invalid-signal exits without waiting for viewers.
  await refreshOpenPositionsLive(runtime);
  const signals = await scanMarket(runtime);
  const priceByCoin = Object.fromEntries(signals.map(s => [s.coin, s.price]));

  const stillOpen = [];
  for (const p of runtime.positions) {
    const last = priceByCoin[p.coin];
    if (!Number.isFinite(last)) {
      stillOpen.push(p);
      continue;
    }

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
    const riskPct = Math.abs(s.entry - s.sl) / s.entry;
    const rr = s.side === "LONG" ? Math.abs((s.tp - s.entry) / (s.entry - s.sl)) : Math.abs((s.entry - s.tp) / (s.sl - s.entry));
    const reasons = [];
    const minTradeScore = Number(process.env.ASTRAQUANT_MIN_TRADE_SCORE || 78);
    const minTradeConfidence = Number(process.env.ASTRAQUANT_MIN_TRADE_CONFIDENCE || 65);
    const maxTradeRisk = Number(process.env.ASTRAQUANT_MAX_TRADE_RISK || 0.12);
    const minTradeRr = Number(process.env.ASTRAQUANT_MIN_TRADE_RR || 1.10);
    const minTradeTp = minTradeTargetPct();
    const minNetProfit = minNetTradeProfitPct();

    if (s.score < minTradeScore) reasons.push(`score ${s.score} < ${minTradeScore}`);
    if (s.confidence < minTradeConfidence) reasons.push(`confidence ${s.confidence} < ${minTradeConfidence}`);
    if (!Number.isFinite(riskPct) || riskPct <= 0) reasons.push("risk distance tidak valid");
    if (riskPct > maxTradeRisk) reasons.push(`SL terlalu jauh ${(riskPct * 100).toFixed(2)}% > ${(maxTradeRisk * 100).toFixed(0)}%`);
    const stats = getSignalRiskStats(s);
    if (stats.rewardPct < minTradeTp) reasons.push(`TP gross ${stats.rewardPct.toFixed(2)}% < ${minTradeTp}%`);
    if (stats.netRewardPct < minNetProfit) reasons.push(`net profit ${stats.netRewardPct.toFixed(2)}% < ${minNetProfit}% setelah fee`);
    if (Number.isFinite(rr) && rr < minTradeRr) reasons.push(`risk/reward terlalu kecil ${rr.toFixed(2)}R`);

    const isTopFive = tradable.indexOf(s) < 5;
    const pass = isTopFive
      ? (s.score >= minTradeScore && s.confidence >= minTradeConfidence && riskPct <= maxTradeRisk && stats.rewardPct >= minTradeTp && stats.netRewardPct >= minNetProfit && rr >= minTradeRr)
      : (s.score >= minTradeScore + 4 && s.confidence >= minTradeConfidence + 5 && riskPct <= Math.max(0.01, maxTradeRisk - 0.02) && stats.rewardPct >= minTradeTp && stats.netRewardPct >= minNetProfit && rr >= minTradeRr + 0.10);

    if (pass && candidates.length < slot) candidates.push(s);
    else rejected.push({ coin: s.coin, side: s.side, score: s.score, confidence: s.confidence, reason: reasons.length ? reasons.join(", ") : "slot posisi penuh / kalah prioritas", checkedAt: nowIso() });
  }

  runtime.skippedTrades = rejected.slice(0, 20);

  for (const s of candidates) {
    if (!runtime.autoEnabled && process.env.ASTRAQUANT_AUTO_START !== "true") continue;
    if (runtime.positions.some(p => p.coin === s.coin)) continue;

    const order = safeOrderFromSignal(s);
    if (!order) continue;

    const margin = Math.min(runtime.balance * runtime.riskPerTrade, runtime.maxMargin || 15);
    if (margin < 5) continue;

    const p = {
      id: `${runtime.userId}-${Date.now()}-${s.coin}-${Math.floor(Math.random() * 10000)}`,
      coin: s.coin,
      symbol: s.symbol,
      side: s.side,
      entry: order.entry,
      sl: order.sl,
      tp: order.tp,
      qty: margin / order.entry,
      margin,
      score: s.score,
      status: "OPEN",
      reason: s.why?.[0] || "AI signal",
      signalId: s.id,
      maxHoldHours: s.maxHoldHours || runtime.staleExitHours,
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

  runtime.equity = runtime.balance + runtime.positions.reduce((sum, p) => sum + p.margin + (p.unrealized || 0), 0);
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
      return { price: await getYahooLastPrice("GC=F"), source: "Yahoo 1m quote" };
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
  runtime.equity = runtime.balance + runtime.positions.reduce((sum, p) => sum + p.margin + (p.unrealized || 0), 0);

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
    if (runtime) runtime.status = `PRICE_ERROR: ${err.message}`;
    console.warn("Global price tick error:", userId, err.message);
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
    if (runtime) runtime.status = `ERROR: ${err.message}`;
    console.warn("Global engine error:", userId, err.message);
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
    // V44: Vercel is serverless, so there is no always-on price loop.
    // Refresh open position prices on every dashboard poll so Paper tab stays close to CoinGecko.
    const runtime = await getRuntime(GLOBAL_ENGINE_USER_ID);
    await refreshOpenPositionsLive(runtime);

    // Scan/open engine can be expensive on serverless, so keep it on a softer interval only.
    if (process.env.VERCEL && process.env.ASTRAQUANT_VERCEL_TICK_ON_REQUEST !== "false") {
      const now = Date.now();
      if (now - lastServerlessEngineTickAt > SERVERLESS_ENGINE_INTERVAL_MS) {
        lastServerlessEngineTickAt = now;
        globalEngineTick().catch(err => console.warn("Serverless background engine skipped:", err.message));
      }
    }

    res.json({
      ok: true,
      data: runtime,
      meta: {
        livePriceRefreshed: true,
        liveTickerSource: runtime.liveTickerSource || liveTickerSource,
        liveTickerUpdatedAt: runtime.liveTickerUpdatedAt || liveTickerUpdatedAt,
        serverless: !!process.env.VERCEL
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, supabase: SUPABASE_READY, storage: SUPABASE_READY ? "supabase_online" : "memory_demo" });
});

// V44: ESM-compatible export for Vercel serverless.
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
    console.log(`AstraQuant AI V46 running: http://localhost:${PORT}`);
    console.log(`Storage: ${SUPABASE_READY ? "Supabase Online DB" : "Supabase not connected, memory demo only"}`);
    console.log(`Global Engine: ${GLOBAL_ENGINE_ENABLED ? "ON" : "OFF"} | Workspace: ${GLOBAL_ENGINE_USER_ID}`);
    console.log(`Price Tick: every ${GLOBAL_PRICE_TICK_MS}ms`);
  });
}
