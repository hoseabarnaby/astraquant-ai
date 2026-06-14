const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

let state = null;
let currentSignals = [];
let visibleSignals = [];
let equityRange = "1D";
let equityMode = "step";
let paperRange = "1D";
let historyRange = "1M";
let resizeTimer = null;

const AQ_USER_ID = "public_workspace";
const UI_HIDDEN_ASSETS = new Set(["XAUUSD", "GC=F", "SAHARA"]);

function isHiddenAsset(row) {
  const coin = String(row?.coin || "").toUpperCase();
  const symbol = String(row?.symbol || "").toUpperCase();
  return UI_HIDDEN_ASSETS.has(coin) || UI_HIDDEN_ASSETS.has(symbol);
}

function sanitizeState(next) {
  if (!next || typeof next !== "object") return next;
  return {
    ...next,
    lastScan: (next.lastScan || []).filter(item => !isHiddenAsset(item)),
    positions: (next.positions || []).filter(item => !isHiddenAsset(item)),
    universe: (next.universe || []).filter(item => !isHiddenAsset(item)),
    history: (next.history || []).filter(item => !isHiddenAsset(item))
  };
}

function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  if (Math.abs(number) >= 1000) {
    return "$" + number.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  if (Math.abs(number) >= 1) {
    return "$" + number.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  }
  return "$" + number.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 8 });
}

function pnlMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  const prefix = number > 0 ? "+" : "";
  if (Math.abs(number) >= 1000) return prefix + money(number);
  if (Math.abs(number) >= 1) return `${prefix}$${number.toFixed(2)}`;
  if (Math.abs(number) >= .01) return `${prefix}$${number.toFixed(4)}`;
  return `${prefix}$${number.toFixed(6)}`;
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  const digits = Math.abs(number) < .01 && number !== 0 ? 4 : 2;
  return `${number > 0 ? "+" : ""}${number.toFixed(digits)}%`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function cls(side) {
  if (side === "LONG") return "long";
  if (side === "SHORT") return "short";
  return "wait";
}

function time(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
}

function shortTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short" }) + " • " +
    date.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

function chartPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (Math.abs(number) >= 100) return number.toFixed(2);
  if (Math.abs(number) >= 1) return number.toFixed(4);
  if (Math.abs(number) >= .01) return number.toFixed(5);
  return number.toFixed(7);
}

function coinSymbol(coin) {
  const code = String(coin || "").toUpperCase();
  if (code.startsWith("BTC")) return "₿";
  if (code.startsWith("ETH")) return "◆";
  if (code.startsWith("SOL")) return "≋";
  if (code.startsWith("XRP")) return "×";
  return code.slice(0, 2) || "•";
}

function coinClass(coin) {
  const code = String(coin || "").toUpperCase();
  if (code.startsWith("BTC")) return "coin-btc";
  if (code.startsWith("ETH")) return "coin-eth";
  if (code.startsWith("SOL")) return "coin-sol";
  if (code.startsWith("XRP")) return "coin-xrp";
  return "coin-default";
}

function coinAvatar(coin) {
  return `<span class="coin-avatar ${coinClass(coin)}">${esc(coinSymbol(coin))}</span>`;
}

function badge(side) {
  return `<span class="badge ${cls(side)}">${esc(side || "WAIT")}</span>`;
}

function signalStats(signal) {
  const entry = Number(signal?.entry);
  const tp = Number(signal?.tp);
  const sl = Number(signal?.sl);
  const fee = Number(signal?.feePct ?? .25);
  if (![entry, tp, sl].every(Number.isFinite) || entry <= 0) {
    return { rr: "-", gross: "-", net: "-", fee: `${fee.toFixed(2)}%` };
  }
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk ? reward / risk : 0;
  const gross = reward / entry * 100;
  const net = gross - fee;
  return {
    rr: risk ? `${rr.toFixed(2)}R` : "-",
    gross: `${gross.toFixed(2)}%`,
    net: `${net.toFixed(2)}%`,
    fee: `${fee.toFixed(2)}%`
  };
}

function performanceSummary() {
  const history = state?.history || [];
  const positions = state?.positions || [];
  const signals = state?.lastScan || [];
  const wins = history.filter(item => Number(item.pnl || 0) >= 0).length;
  const netPnl = history.reduce((total, item) => total + Number(item.pnl || 0), 0);
  const avgPnlPct = history.length
    ? history.reduce((total, item) => total + Number(item.pnlPct || 0), 0) / history.length
    : 0;
  const winRate = history.length ? wins / history.length * 100 : 0;
  const best = [...history].sort((a, b) => Number(b.pnl || 0) - Number(a.pnl || 0))[0];
  const worst = [...history].sort((a, b) => Number(a.pnl || 0) - Number(b.pnl || 0))[0];
  return {
    historyCount: history.length,
    positionsCount: positions.length,
    signalsCount: signals.length,
    wins,
    losses: Math.max(0, history.length - wins),
    netPnl,
    avgPnlPct,
    winRate,
    best,
    worst,
    winRateText: history.length ? `${winRate.toFixed(0)}%` : "-",
    statusText: history.length
      ? `Win rate ${winRate.toFixed(0)}% • Avg ${avgPnlPct.toFixed(2)}% • ${history.length} closed trade`
      : `Signals ${signals.length} • Open ${positions.length} • learning aktif setelah closed trade`
  };
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}), "X-AQ-User-Id": AQ_USER_ID };
  const response = await fetch(path, { ...options, headers });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "API error");
  return data;
}

function resetPageScroll() {
  // Prevent the browser from preserving the old vertical position when switching pages.
  const scrollTargets = [
    document.scrollingElement,
    document.documentElement,
    document.body,
    $(".workspace"),
    $(".main-content")
  ].filter(Boolean);

  scrollTargets.forEach(target => {
    try {
      target.scrollTop = 0;
      target.scrollLeft = 0;
    } catch (_) {}
  });

  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function setPage(page) {
  $$(".page").forEach(section => section.classList.toggle("active", section.id === page));
  $$(".navlink, .bottom-nav-btn").forEach(button => button.classList.toggle("active", button.dataset.page === page));

  // Update the URL without triggering native anchor scrolling to #home/#trading/etc.
  if (location.hash !== `#${page}`) {
    history.replaceState(null, "", `#${page}`);
  }

  resetPageScroll();
  requestAnimationFrame(() => {
    resetPageScroll();
    drawPageCharts();
    requestAnimationFrame(resetPageScroll);
  });

  // Safari/mobile browsers may restore the previous scroll a moment later.
  setTimeout(resetPageScroll, 60);
  setTimeout(resetPageScroll, 180);
}

function setGauge(element, score) {
  if (!element) return;
  const value = Math.max(0, Math.min(100, Number(score || 0)));
  element.style.setProperty("--score", value);
  element.dataset.label = Number.isFinite(Number(score)) ? String(Math.round(value)) : "-";
}

function roundRect(ctx, x, y, width, height, radius = 8) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function canvasSetup(canvas, minWidth = 320, minHeight = 180) {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(minWidth, rect.width || minWidth);
  const height = Math.max(minHeight, rect.height || minHeight);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawEmptyChart(canvas, message = "Data chart belum tersedia") {
  const setup = canvasSetup(canvas);
  if (!setup) return;
  const { ctx, width, height } = setup;
  ctx.fillStyle = "#f6fafc";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#7a8aa2";
  ctx.font = "12px Inter, system-ui";
  ctx.textAlign = "center";
  ctx.fillText(message, width / 2, height / 2);
  ctx.textAlign = "left";
}

function drawCandleChart(canvas, rows, options = {}) {
  if (!canvas) return;
  const data = (rows || []).map(item => ({
    o: Number(item.o ?? item.open ?? item.c ?? item.close),
    h: Number(item.h ?? item.high ?? item.c ?? item.close),
    l: Number(item.l ?? item.low ?? item.c ?? item.close),
    c: Number(item.c ?? item.close)
  })).filter(item => [item.o, item.h, item.l, item.c].every(Number.isFinite));

  if (data.length < 3) {
    drawEmptyChart(canvas, "Chart sedang diperbarui...");
    return;
  }

  const setup = canvasSetup(canvas, 320, 170);
  if (!setup) return;
  const { ctx, width, height } = setup;
  const signal = options.signal || null;
  const levels = signal ? [
    { label: "ENTRY", value: Number(signal.entry), color: "#168fbd" },
    { label: "TP", value: Number(signal.tp), color: "#0ca66f" },
    { label: "SL", value: Number(signal.sl), color: "#e9415e" }
  ].filter(item => Number.isFinite(item.value) && item.value > 0) : [];

  const padding = { left: 46, right: levels.length ? Math.min(128, Math.max(94, width * .25)) : 18, top: 18, bottom: 28 };
  const highs = data.map(item => item.h);
  const lows = data.map(item => item.l);
  const levelValues = levels.map(item => item.value);
  const rawMax = Math.max(...highs, ...levelValues);
  const rawMin = Math.min(...lows, ...levelValues);
  const rawRange = rawMax - rawMin || Math.max(1, rawMax * .02);
  const max = rawMax + rawRange * .1;
  const min = rawMin - rawRange * .1;
  const range = max - min || 1;
  const plotWidth = Math.max(70, width - padding.left - padding.right);
  const plotHeight = Math.max(80, height - padding.top - padding.bottom);
  const y = value => padding.top + (max - value) / range * plotHeight;
  const step = plotWidth / data.length;
  const candleWidth = Math.max(2, Math.min(8, step * .58));

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#fbfeff");
  gradient.addColorStop(1, "#edf7fa");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(102,128,154,.16)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#7a8ba3";
  ctx.font = "10px Inter, system-ui";
  for (let index = 0; index < 5; index += 1) {
    const yy = padding.top + index / 4 * plotHeight;
    ctx.beginPath();
    ctx.moveTo(padding.left, yy);
    ctx.lineTo(width - padding.right, yy);
    ctx.stroke();
    const value = max - index / 4 * range;
    ctx.fillText(chartPrice(value), 4, yy + 3);
  }

  data.forEach((item, index) => {
    const x = padding.left + index * step + step / 2;
    const up = item.c >= item.o;
    const color = up ? "#14a976" : "#e94c68";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y(item.h));
    ctx.lineTo(x, y(item.l));
    ctx.stroke();

    const top = Math.min(y(item.o), y(item.c));
    const bodyHeight = Math.max(2, Math.abs(y(item.o) - y(item.c)));
    ctx.fillStyle = up ? "rgba(20,169,118,.72)" : "rgba(233,76,104,.72)";
    roundRect(ctx, x - candleWidth / 2, top, candleWidth, bodyHeight, 2);
    ctx.fill();
  });

  levels.forEach((level, index) => {
    const yy = y(level.value);
    ctx.strokeStyle = level.color;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(padding.left, yy);
    ctx.lineTo(width - padding.right + 4, yy);
    ctx.stroke();
    ctx.setLineDash([]);

    const labelWidth = Math.min(112, padding.right - 12);
    const labelHeight = 22;
    const labelX = width - labelWidth - 8;
    const labelY = Math.max(4, Math.min(height - labelHeight - 4, yy - labelHeight / 2 + index * 2));
    ctx.fillStyle = "rgba(255,255,255,.96)";
    roundRect(ctx, labelX, labelY, labelWidth, labelHeight, 9);
    ctx.fill();
    ctx.strokeStyle = level.color;
    ctx.stroke();
    ctx.fillStyle = level.color;
    ctx.font = "bold 9px Inter, system-ui";
    ctx.fillText(level.label, labelX + 7, labelY + 14);
    ctx.fillStyle = "#263a57";
    ctx.font = "9px Inter, system-ui";
    ctx.fillText(chartPrice(level.value), labelX + 42, labelY + 14);
  });
}

function rangeMilliseconds(range) {
  if (range === "1W") return 7 * 24 * 60 * 60 * 1000;
  if (range === "1M") return 30 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function formatChartTime(value, range) {
  const date = new Date(value);
  if (range === "1D") return date.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  if (range === "1W") return date.toLocaleDateString("id-ID", { weekday: "short", day: "2-digit" });
  return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
}

function normalizeEquityPoints(points) {
  if (!Array.isArray(points) || points.length < 3) return points || [];
  const cleaned = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = cleaned[cleaned.length - 1];
    const current = points[index];
    const next = points[index + 1];
    const prevValue = Number(prev?.value);
    const currentValue = Number(current?.value);
    const nextValue = Number(next?.value);
    if (![prevValue, currentValue, nextValue].every(Number.isFinite)) {
      cleaned.push(current);
      continue;
    }
    const baseline = (prevValue + nextValue) / 2;
    const spikeDistance = Math.abs(currentValue - baseline);
    const neighborDistance = Math.abs(nextValue - prevValue);
    const tolerance = Math.max(2, Math.abs(baseline) * 0.0035);
    const transientSpike = spikeDistance > tolerance * 2 && neighborDistance < tolerance * 1.2;
    if (transientSpike) continue;
    cleaned.push(current);
  }
  cleaned.push(points[points.length - 1]);
  return cleaned;
}

function buildEquitySeries(range = "1D") {
  const defaultStart = 1000;
  const cutoff = Date.now() - rangeMilliseconds(range);
  const curve = (state?.equityCurve || [])
    .map(point => ({
      time: point.time,
      value: Number(point.equity),
      balance: Number(point.balance || 0),
      openPnl: Number(point.openPnl || 0),
      reason: point.reason || "tick"
    }))
    .filter(point => point.time && Number.isFinite(point.value))
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  let points = curve.filter(point => new Date(point.time).getTime() >= cutoff);
  if (curve.length && points.length < 2) {
    const before = [...curve].reverse().find(point => new Date(point.time).getTime() < cutoff);
    if (before) points = [before, ...points];
  }

  const currentEquity = Number(state?.equity || defaultStart);
  const last = points.at(-1);
  if (!last || Math.abs(last.value - currentEquity) > .000001) {
    points.push({
      time: new Date().toISOString(),
      value: currentEquity,
      balance: Number(state?.balance || 0),
      openPnl: (state?.positions || []).reduce((sum, position) => sum + Number(position.unrealized || 0), 0),
      reason: "live"
    });
  }

  if (points.length < 2) {
    const history = [...(state?.history || [])]
      .filter(item => item.closedAt && new Date(item.closedAt).getTime() >= cutoff)
      .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
    let equity = defaultStart;
    points = [{ time: new Date(Date.now() - rangeMilliseconds(range)).toISOString(), value: equity, reason: "start" }];
    history.forEach(item => {
      equity += Number(item.pnl || 0);
      points.push({ time: item.closedAt, value: equity, reason: item.closeReason || "exit" });
    });
    points.push({ time: new Date().toISOString(), value: currentEquity, reason: "live" });
  }

  return normalizeEquityPoints(points);
}

function buildRealizedSeries(range = "1M") {
  const cutoff = Date.now() - rangeMilliseconds(range);
  const history = [...(state?.history || [])]
    .filter(item => item.closedAt)
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  const base = 1000;
  let running = base;
  const all = [{ time: new Date(Date.now() - rangeMilliseconds(range)).toISOString(), value: base, reason: "start" }];
  history.forEach(item => {
    running += Number(item.pnl || 0);
    all.push({ time: item.closedAt, value: running, reason: item.closeReason || "exit" });
  });
  let points = all.filter(point => new Date(point.time).getTime() >= cutoff);
  if (points.length < 2) points = all.slice(-Math.max(2, all.length));
  return points;
}

function drawLineChart(canvas, points, options = {}) {
  if (!canvas) return;
  const data = (points || []).filter(point => Number.isFinite(Number(point.value)));
  if (data.length < 2) {
    drawEmptyChart(canvas, "Equity belum memiliki cukup data");
    return;
  }

  const setup = canvasSetup(canvas, 320, 190);
  if (!setup) return;
  const { ctx, width, height } = setup;
  const padding = { left: width < 480 ? 44 : 54, right: 18, top: 18, bottom: 32 };
  const values = data.map(point => Number(point.value));
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const span = Math.max(1, maxValue - minValue);
  const pad = Math.max(span * .16, Math.abs(maxValue) * .004, 1);
  const low = minValue - pad;
  const high = maxValue + pad;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = index => padding.left + index / Math.max(1, data.length - 1) * plotWidth;
  const y = value => padding.top + (high - value) / Math.max(.0001, high - low) * plotHeight;
  const start = values[0];
  const end = values.at(-1);
  const up = end >= start;
  const lineColor = up ? "#0ca66f" : "#e9415e";

  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, "#fbfeff");
  background.addColorStop(1, "#edf7fa");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(101,126,151,.17)";
  ctx.fillStyle = "#71829b";
  ctx.font = "10px Inter, system-ui";
  for (let index = 0; index <= 4; index += 1) {
    const yy = padding.top + index / 4 * plotHeight;
    ctx.beginPath();
    ctx.moveTo(padding.left, yy);
    ctx.lineTo(width - padding.right, yy);
    ctx.stroke();
    const value = high - index / 4 * (high - low);
    ctx.fillText("$" + value.toFixed(0), 4, yy + 3);
  }

  const fill = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  fill.addColorStop(0, up ? "rgba(14,165,166,.26)" : "rgba(233,65,94,.20)");
  fill.addColorStop(1, "rgba(14,165,166,0)");
  ctx.beginPath();
  ctx.moveTo(x(0), y(values[0]));
  data.forEach((point, index) => {
    if (options.step && index > 0) {
      ctx.lineTo(x(index), y(values[index - 1]));
    }
    ctx.lineTo(x(index), y(point.value));
  });
  ctx.lineTo(x(data.length - 1), height - padding.bottom);
  ctx.lineTo(x(0), height - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x(0), y(values[0]));
  data.forEach((point, index) => {
    if (index === 0) return;
    if (options.step) ctx.lineTo(x(index), y(values[index - 1]));
    ctx.lineTo(x(index), y(point.value));
  });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  const lastX = x(data.length - 1);
  const lastY = y(end);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.stroke();

  const labels = Math.min(5, data.length);
  ctx.fillStyle = "#74859c";
  ctx.font = "9px Inter, system-ui";
  for (let index = 0; index < labels; index += 1) {
    const dataIndex = labels === 1 ? 0 : Math.round(index / (labels - 1) * (data.length - 1));
    const labelX = x(dataIndex);
    ctx.textAlign = index === 0 ? "left" : index === labels - 1 ? "right" : "center";
    ctx.fillText(formatChartTime(data[dataIndex].time, options.range || "1D"), labelX, height - 10);
  }
  ctx.textAlign = "left";
}

function buildEquityCandles(range = equityRange) {
  const series = buildEquitySeries(range);
  const groups = [];
  const map = new Map();
  series.forEach(point => {
    const date = new Date(point.time);
    const key = range === "1D"
      ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`
      : range === "1W"
        ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
        : `${date.getFullYear()}-${date.getMonth()}-${Math.floor((date.getDate() - 1) / 3)}`;
    let group = map.get(key);
    if (!group) {
      group = { time: point.time, open: point.value, high: point.value, low: point.value, close: point.value };
      map.set(key, group);
      groups.push(group);
    } else {
      group.high = Math.max(group.high, point.value);
      group.low = Math.min(group.low, point.value);
      group.close = point.value;
    }
  });
  return groups;
}

function drawEquityModalChart() {
  const canvas = $("#equityChart");
  if (!canvas) return;
  if (equityMode === "step") {
    drawLineChart(canvas, buildEquitySeries(equityRange), { range: equityRange, step: true });
    updateEquitySummary(buildEquitySeries(equityRange), "Step line");
    return;
  }

  const candles = buildEquityCandles(equityRange);
  if (candles.length < 1) {
    drawEmptyChart(canvas, "Data candle equity belum tersedia");
    return;
  }
  const setup = canvasSetup(canvas, 600, 300);
  if (!setup) return;
  const { ctx, width, height } = setup;
  const padding = { left: 56, right: 18, top: 18, bottom: 34 };
  const values = candles.flatMap(candle => [candle.high, candle.low]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const span = Math.max(1, maxValue - minValue);
  const low = minValue - span * .15;
  const high = maxValue + span * .15;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const y = value => padding.top + (high - value) / (high - low) * plotHeight;
  const step = plotWidth / candles.length;
  const bodyWidth = Math.max(7, Math.min(24, step * .55));

  ctx.fillStyle = "#f7fbfd";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(101,126,151,.17)";
  ctx.fillStyle = "#71829b";
  ctx.font = "10px Inter, system-ui";
  for (let index = 0; index <= 4; index += 1) {
    const yy = padding.top + index / 4 * plotHeight;
    ctx.beginPath();
    ctx.moveTo(padding.left, yy);
    ctx.lineTo(width - padding.right, yy);
    ctx.stroke();
    const value = high - index / 4 * (high - low);
    ctx.fillText("$" + value.toFixed(0), 4, yy + 3);
  }

  candles.forEach((candle, index) => {
    const xx = padding.left + step * index + step / 2;
    const up = candle.close >= candle.open;
    const color = up ? "#0ca66f" : "#e9415e";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xx, y(candle.high));
    ctx.lineTo(xx, y(candle.low));
    ctx.stroke();
    const top = Math.min(y(candle.open), y(candle.close));
    const bodyHeight = Math.max(2, Math.abs(y(candle.open) - y(candle.close)));
    ctx.fillStyle = up ? "rgba(12,166,111,.34)" : "rgba(233,65,94,.28)";
    roundRect(ctx, xx - bodyWidth / 2, top, bodyWidth, bodyHeight, 4);
    ctx.fill();
    ctx.stroke();
  });

  updateEquitySummary(candles.map(candle => ({ value: candle.close })), "Candlestick");
}

function updateEquitySummary(points, modeLabel) {
  const box = $("#equitySummary");
  if (!box || !points.length) return;
  const values = points.map(point => Number(point.value)).filter(Number.isFinite);
  const start = values[0];
  const current = values.at(-1);
  const pnl = current - start;
  const change = start ? pnl / start * 100 : 0;
  box.innerHTML = `
    <div><span>Range</span><b>${esc(equityRange)}</b></div>
    <div><span>Mode</span><b>${esc(modeLabel)}</b></div>
    <div><span>Start</span><b>${money(start)}</b></div>
    <div><span>Current</span><b>${money(current)}</b></div>
    <div><span>High</span><b class="green">${money(Math.max(...values))}</b></div>
    <div><span>Low</span><b class="${Math.min(...values) < start ? "red" : ""}">${money(Math.min(...values))}</b></div>
    <div><span>Total P/L</span><b class="${pnl >= 0 ? "green" : "red"}">${pnlMoney(pnl)} (${pct(change)})</b></div>
    <div><span>Points</span><b>${values.length}</b></div>`;
}

function levelStrip(signal) {
  const stats = signalStats(signal);
  return `
    <div class="level-strip">
      <div><span>Entry</span><b>${money(signal.entry)}</b></div>
      <div><span>TP</span><b class="green">${money(signal.tp)}</b></div>
      <div><span>SL</span><b class="red">${money(signal.sl)}</b></div>
      <div><span>R/R</span><b>${stats.rr}</b></div>
      <div><span>Est. Fee</span><b>${stats.fee}</b></div>
      <div><span>Est. Net</span><b class="${Number(stats.net.replace("%", "")) >= 0 ? "green" : "red"}">${stats.net}</b></div>
    </div>`;
}

function sortedSignals() {
  const side = $("#filterSide")?.value || "ALL";
  const sortBy = $("#sortBy")?.value || "score";
  const query = String($("#globalSearch")?.value || "").trim().toUpperCase();
  let rows = [...currentSignals].filter(signal => side === "ALL" || signal.side === side);
  if (query) {
    rows = rows.filter(signal => [signal.coin, signal.side, signal.priceAction?.pattern, signal.marketRegime]
      .some(value => String(value || "").toUpperCase().includes(query)));
  }
  rows.sort((a, b) => {
    if (sortBy === "change") return Math.abs(Number(b.changePct || 0)) - Math.abs(Number(a.changePct || 0));
    if (sortBy === "confidence") return Number(b.confidence || 0) - Number(a.confidence || 0);
    return Number(b.score || 0) - Number(a.score || 0);
  });
  return rows;
}

function renderAll() {
  if (!state) return;
  currentSignals = state.lastScan || [];
  const performance = performanceSummary();
  const status = String(state.status || "AI ACTIVE").replaceAll("_", " ");

  $("#botStatus").textContent = status;
  $("#sidebarEngineStatus").textContent = status;
  $("#lastUpdatedText").textContent = `Update ${new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`;
  $("#balance").textContent = money(state.balance);
  $("#equity").textContent = money(state.equity);
  $("#openCount").textContent = state.positions?.length || 0;
  $("#tradeCount").textContent = state.history?.length || 0;
  $("#actionWinRate").textContent = performance.winRateText;
  $("#dbSource").textContent = performance.statusText;

  $("#paperBalance").textContent = money(state.balance);
  $("#paperEquity").textContent = money(state.equity);
  $("#paperOpenCount").textContent = state.positions?.length || 0;
  $("#paperWinRate").textContent = performance.winRateText;
  $("#paperPositionCountPill").textContent = `${state.positions?.length || 0} posisi`;

  $("#historyClosed").textContent = performance.historyCount;
  $("#historyPnl").textContent = pnlMoney(performance.netPnl);
  $("#historyPnl").className = performance.netPnl >= 0 ? "green" : "red";
  $("#historyWinRate").textContent = performance.winRateText;
  $("#historyAvgReturn").textContent = performance.historyCount ? pct(performance.avgPnlPct) : "-";

  renderHome();
  renderSignals();
  renderPositions();
  renderPaperClosed();
  renderSkipped();
  renderHistory();
  renderMemory();
  renderUniverse();
  drawPageCharts();
}

function renderHome() {
  const best = [...currentSignals].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
  if (best) {
    $("#bestSignal").textContent = `${best.coin} ${best.side}`;
    $("#primeSubtext").textContent = `${best.timeframe || "-"} • ${best.marketRegime || "market setup"} • ${time(best.updatedAt)}`;
    setGauge($("#heroScore"), best.score);
    $("#heroSide").textContent = best.side || "-";
    $("#heroPattern").textContent = best.priceAction?.pattern || "-";
    $("#openCountHero").textContent = state.positions?.length || 0;
    $("#heroRR").textContent = signalStats(best).rr;
    $("#primeInsight").innerHTML = `<span class="insight-icon">✦</span><p>${esc((best.why || best.technicalAnalysis || ["AI sedang membaca struktur pasar."])[0])}</p>`;
    drawCandleChart($("#heroChart"), best.chart || [], { signal: best });
  } else {
    $("#bestSignal").textContent = "Scanning market...";
    $("#primeSubtext").textContent = "AI sedang memilih setup terbaik.";
    setGauge($("#heroScore"), 0);
    drawEmptyChart($("#heroChart"), "Menunggu data signal...");
  }

  const equityPoints = buildEquitySeries("1D");
  const first = Number(equityPoints[0]?.value || 1000);
  const current = Number(equityPoints.at(-1)?.value || state.equity || first);
  const pnl = current - first;
  const floating = (state.positions || []).reduce((sum, position) => sum + Number(position.unrealized || 0), 0);
  $("#homeEquityValue").textContent = money(current);
  $("#homeEquityPnl").textContent = `${pnlMoney(pnl)} • ${pct(first ? pnl / first * 100 : 0)}`;
  $("#homeEquityPnl").className = pnl >= 0 ? "green" : "red";
  $("#homeEquityStart").textContent = money(first);
  $("#homeFloatingPnl").textContent = pnlMoney(floating);
  $("#homeFloatingPnl").className = floating >= 0 ? "green" : "red";

  const homePositions = $("#homePositions");
  const positions = (state.positions || []).slice(0, 4);
  homePositions.innerHTML = positions.length ? positions.map(position => `
    <div class="stack-row">
      <div class="row-title">
        ${coinAvatar(position.coin)}
        <div><strong>${esc(position.coin)}</strong> ${badge(position.side)}<span class="row-sub">Entry ${money(position.entry)} • ${esc(position.liveTickerSource || "live")}</span></div>
      </div>
      <div class="row-value"><span>Last</span><b>${money(position.last)}</b></div>
      <div class="row-value"><span>P/L</span><b class="${Number(position.unrealized || 0) >= 0 ? "green" : "red"}">${pnlMoney(position.unrealized)}</b></div>
    </div>`).join("") : `<p class="muted">Belum ada posisi terbuka.</p>`;

  const homeHistory = $("#homeHistory");
  const history = (state.history || []).slice(0, 4);
  homeHistory.innerHTML = history.length ? history.map(item => `
    <div class="stack-row">
      <div class="row-title">
        ${coinAvatar(item.coin)}
        <div><strong>${esc(item.coin)}</strong> ${badge(item.side)}<span class="row-sub">${shortTime(item.closedAt)} • ${esc(item.closeReason || "EXIT")}</span></div>
      </div>
      <div class="row-value"><span>Exit</span><b>${money(item.exit)}</b></div>
      <div class="row-value"><span>P/L</span><b class="${Number(item.pnl || 0) >= 0 ? "green" : "red"}">${pnlMoney(item.pnl)}</b></div>
    </div>`).join("") : `<p class="muted">Belum ada closed trade.</p>`;

  const memoryRows = Object.entries(state.memory || {}).slice(0, 4);
  $("#learningSnapshot").innerHTML = memoryRows.length ? memoryRows.map(([key, memory]) => {
    const weight = Math.max(0, Math.min(100, 50 + Number(memory.weightAdjustment || 0) * 10));
    return `<div class="learning-mini"><div><strong>${esc(key)}</strong><small>${memory.trades || 0} trades • ${memory.wins || 0} win • ${memory.losses || 0} loss</small></div><div class="weight-bar"><i style="width:${weight}%"></i></div></div>`;
  }).join("") : `<p class="muted">Memory mulai terisi setelah closed trade.</p>`;
}

function renderUniverse() {
  const box = $("#universeBox");
  if (!box) return;
  const universe = state.universe || [];
  box.innerHTML = `
    <div class="universe-meta">
      <span>${universe.length} aset dipantau</span>
      <span>${currentSignals.length} signal aktif</span>
      <span>${state.positions?.length || 0} posisi terbuka</span>
    </div>
    <div class="universe-list">
      ${universe.slice(0, 18).map(asset => `<span class="universe-pill">${coinAvatar(asset.coin)}<b>${esc(asset.coin)}</b></span>`).join("") || `<span class="muted">Universe sedang dimuat...</span>`}
    </div>`;
}

function renderSignals() {
  const box = $("#signalGrid");
  if (!box) return;
  visibleSignals = sortedSignals();
  if (!visibleSignals.length) {
    box.innerHTML = `<article class="surface-card"><p class="muted">AI sedang memproses market universe dan chart terbaru...</p></article>`;
    return;
  }

  box.innerHTML = visibleSignals.slice(0, 12).map((signal, index) => {
    const stats = signalStats(signal);
    const score = Number(signal.score || 0);
    const reason = esc((signal.why || signal.technicalAnalysis || ["AI sedang membaca struktur pasar terbaru."])[0]);
    return `<article class="signal-card uniform" data-signal-index="${index}">
      <div class="signal-top">
        <div>
          <div class="coin-title">${coinAvatar(signal.coin)}<span>${esc(signal.coin)}</span>${badge(signal.side)}</div>
          <p class="signal-meta-line">${esc(signal.timeframe || "-")} • ${esc(signal.marketRegime || "Market setup")} • ${shortTime(signal.updatedAt)}</p>
        </div>
        <div class="signal-score" style="--score:${Math.max(0, Math.min(100, score))}"><span>${Math.round(score)}</span></div>
      </div>
      <canvas class="signal-chart" data-signal-chart="${index}"></canvas>
      <div class="signal-stat-grid compact-grid">
        <div class="signal-stat"><span>Price</span><b>${money(signal.price)}</b></div>
        <div class="signal-stat"><span>Change</span><b class="${Number(signal.changePct || 0) >= 0 ? "green" : "red"}">${pct(signal.changePct)}</b></div>
        <div class="signal-stat"><span>Confidence</span><b>${signal.confidence ?? "-"}</b></div>
        <div class="signal-stat"><span>Structure</span><b>${esc(signal.priceAction?.pattern || "-")}</b></div>
      </div>
      ${levelStrip(signal)}
      <p class="signal-reason">${reason}</p>
      ${signal.warning ? `<p class="warn">${esc(signal.warning)}</p>` : ""}
    </article>`;
  }).join("");

  visibleSignals.slice(0, 12).forEach((signal, index) => {
    drawCandleChart(document.querySelector(`[data-signal-chart="${index}"]`), signal.chart || [], { signal });
  });
}

function renderPositions() {
  const box = $("#positionsBox");
  if (!box) return;
  const rows = state.positions || [];
  if (!rows.length) {
    box.innerHTML = `<p class="muted">Belum ada posisi terbuka. AI akan membuka posisi ketika setup memenuhi filter entry.</p>`;
    return;
  }
  box.innerHTML = rows.map(position => {
    const score = Math.max(0, Math.min(100, Number(position.score || 0)));
    return `<div class="position-row">
      <div class="position-coin">${coinAvatar(position.coin)}<div><strong>${esc(position.coin)}</strong><small>${badge(position.side)} • ${shortTime(position.openedAt)}</small></div></div>
      <div class="data-cell"><span>Entry</span><b>${money(position.entry)}</b></div>
      <div class="data-cell"><span>Last</span><b>${money(position.last)}</b></div>
      <div class="data-cell"><span>SL / TP</span><b><span class="red">${money(position.sl)}</span> / <span class="green">${money(position.tp)}</span></b></div>
      <div class="position-pnl"><span>P/L</span><b class="${Number(position.unrealized || 0) >= 0 ? "green" : "red"}">${pnlMoney(position.unrealized)}</b><span>${pct(position.pnlPct)}</span></div>
      <div class="small-score" style="--score:${score}"><b>${Math.round(score)}</b></div>
    </div>`;
  }).join("");
}

function renderPaperClosed() {
  const box = $("#paperClosedBox");
  if (!box) return;
  const rows = (state.history || []).slice(0, 6);
  box.innerHTML = rows.length ? rows.map(item => `
    <div class="closed-row compact-closed-row">
      <div class="row-title">${coinAvatar(item.coin)}<div><strong>${esc(item.coin)}</strong><span class="row-sub">${badge(item.side)} • ${shortTime(item.closedAt)}</span><span class="row-sub trade-route">${money(item.entry)} → ${money(item.exit)}</span></div></div>
      <div class="result"><span>P/L</span><b class="${Number(item.pnl || 0) >= 0 ? "green" : "red"}">${pnlMoney(item.pnl)}</b><span class="row-sub">${pct(item.pnlPct)}</span></div>
    </div>`).join("") : `<p class="muted">Belum ada closed trade.</p>`;
}

function renderSkipped() {
  const box = $("#skippedBox");
  if (!box) return;
  const rows = state.skippedTrades || [];
  box.innerHTML = rows.length ? rows.slice(0, 8).map(item => `
    <div class="skip-item">
      <div><strong>${esc(item.coin)} ${badge(item.side)}</strong><p>${esc(item.reason || "Setup tidak memenuhi filter.")}</p></div>
      <div class="skip-score"><span>Score</span><b>${item.score ?? "-"}</b></div>
    </div>`).join("") : `<p class="muted">Belum ada setup yang difilter pada sesi ini.</p>`;
}

function renderHistory() {
  const rows = state.history || [];
  const performance = performanceSummary();
  const box = $("#historyBox");
  if (!box) return;

  box.innerHTML = rows.length ? rows.map(item => `
    <div class="history-row">
      <div class="row-title">${coinAvatar(item.coin)}<div><strong>${esc(item.coin)}</strong><span class="row-sub">${badge(item.side)} • ${shortTime(item.closedAt)}</span></div></div>
      <div class="data-cell"><span>Entry</span><b>${money(item.entry)}</b></div>
      <div class="data-cell"><span>Exit</span><b>${money(item.exit)}</b></div>
      <div class="data-cell"><span>P/L</span><b class="${Number(item.pnl || 0) >= 0 ? "green" : "red"}">${pnlMoney(item.pnl)}<br>${pct(item.pnlPct)}</b></div>
      <div class="history-lesson"><span>${esc(item.closeReason || "EXIT")}</span><p>${esc(item.lesson || "Belum ada lesson tambahan.")}</p></div>
    </div>`).join("") : `<p class="muted">Belum ada trade selesai. Jurnal akan muncul setelah posisi ditutup.</p>`;

  $("#historySummaryBox").innerHTML = `
    <div class="summary-stat"><span>Best Trade</span><b class="green">${performance.best ? `${esc(performance.best.coin)} ${pnlMoney(performance.best.pnl)}` : "-"}</b></div>
    <div class="summary-stat"><span>Worst Trade</span><b class="${Number(performance.worst?.pnl || 0) >= 0 ? "green" : "red"}">${performance.worst ? `${esc(performance.worst.coin)} ${pnlMoney(performance.worst.pnl)}` : "-"}</b></div>
    <div class="summary-stat"><span>Wins / Losses</span><b>${performance.wins} / ${performance.losses}</b></div>
    <div class="summary-stat"><span>Average Return</span><b class="${performance.avgPnlPct >= 0 ? "green" : "red"}">${pct(performance.avgPnlPct)}</b></div>`;

  const losses = rows.filter(item => Number(item.pnl || 0) < 0).slice(0, 3);
  const wins = rows.filter(item => Number(item.pnl || 0) >= 0).slice(0, 3);
  $("#historyLessons").innerHTML = `
    <article class="lesson-card danger"><h3>Kesalahan yang Perlu Dihindari</h3><ul>${losses.length ? losses.map(item => `<li>${esc(item.lesson || `${item.coin}: evaluasi ${item.closeReason || "loss"}.`)}</li>`).join("") : `<li>Belum ada loss yang cukup untuk dianalisis.</li>`}</ul></article>
    <article class="lesson-card success"><h3>Pola yang Perlu Dipertahankan</h3><ul>${wins.length ? wins.map(item => `<li>${esc(item.lesson || `${item.coin}: pertahankan disiplin setup.`)}</li>`).join("") : `<li>Closed trade profitable belum tersedia.</li>`}</ul></article>`;
}

function renderMemory() {
  const entries = Object.entries(state.memory || {});
  const box = $("#memoryGrid");
  if (!box) return;
  const wins = entries.reduce((sum, [, memory]) => sum + Number(memory.wins || 0), 0);
  const avgWeight = entries.length
    ? entries.reduce((sum, [, memory]) => sum + Number(memory.weightAdjustment || 0), 0) / entries.length
    : 0;
  $("#memoryNodeCount").textContent = entries.length;
  $("#memoryWins").textContent = wins;
  $("#memoryAvgWeight").textContent = avgWeight.toFixed(1);

  if (!entries.length) {
    box.innerHTML = `<article class="surface-card"><p class="muted">Memory masih kosong. Sistem mulai belajar setelah trade selesai.</p></article>`;
  } else {
    box.innerHTML = entries.map(([key, memory]) => {
      const [coin, side = "WAIT"] = key.split(":");
      const score = Math.max(0, Math.min(100, 50 + Number(memory.weightAdjustment || 0) * 10));
      const tags = memory.mistakeTags || [];
      return `<article class="memory-card">
        <div class="memory-card-head">
          <div class="memory-card-title">${coinAvatar(coin)}<div><h3>${esc(key)}</h3>${badge(side)}</div></div>
          <div class="small-score" style="--score:${score}"><b>${Math.round(score)}</b></div>
        </div>
        <div class="memory-tags">${tags.length ? tags.map(tag => `<span class="memory-tag">${esc(tag)}</span>`).join("") : `<span class="memory-tag">belum ada tag risiko</span>`}</div>
        <div class="memory-stats">
          <div><span>Trades</span><b>${memory.trades || 0}</b></div>
          <div><span>Win</span><b class="green">${memory.wins || 0}</b></div>
          <div><span>Loss</span><b class="red">${memory.losses || 0}</b></div>
          <div><span>Avg P/L</span><b class="${Number(memory.avgPnlPct || 0) >= 0 ? "green" : "red"}">${pct(memory.avgPnlPct)}</b></div>
          <div><span>Weight</span><b class="${Number(memory.weightAdjustment || 0) >= 0 ? "green" : "red"}">${Number(memory.weightAdjustment || 0).toFixed(1)}</b></div>
        </div>
        <p class="memory-note">${esc((memory.notes || ["AI belum menambahkan insight khusus."])[0])}</p>
      </article>`;
    }).join("");
  }

  const tagCounts = new Map();
  entries.forEach(([, memory]) => (memory.mistakeTags || []).forEach(tag => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)));
  const commonTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("#commonMistakesBox").innerHTML = commonTags.length
    ? commonTags.map(([tag, count]) => `<div class="bullet-item"><span>${esc(tag)} muncul pada ${count} memory node.</span></div>`).join("")
    : `<div class="bullet-item"><span>Belum ada kesalahan berulang yang cukup untuk dirangkum.</span></div>`;

  const adjustments = [
    "Tunggu konfirmasi struktur dan volume sebelum entry.",
    "Sesuaikan lebar stop loss dengan volatilitas aset.",
    "Prioritaskan setup dengan bobot dan win rate lebih tinggi.",
    "Kurangi entry pada arah yang memiliki loss berulang."
  ];
  $("#nextAdjustmentsBox").innerHTML = adjustments.map(text => `<div class="bullet-item"><span>${esc(text)}</span></div>`).join("");
}

function drawPageCharts() {
  if (!state) return;
  const activePage = $(".page.active")?.id;
  if (activePage === "home") {
    const best = [...currentSignals].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
    if (best) drawCandleChart($("#heroChart"), best.chart || [], { signal: best });
    drawLineChart($("#homeEquityChart"), buildEquitySeries("1D"), { range: "1D" });
  }
  if (activePage === "signals") {
    visibleSignals.slice(0, 12).forEach((signal, index) => {
      drawCandleChart(document.querySelector(`[data-signal-chart="${index}"]`), signal.chart || [], { signal });
    });
  }
  if (activePage === "trading") {
    const points = buildEquitySeries(paperRange);
    drawLineChart($("#paperEquityChart"), points, { range: paperRange });
    const start = Number(points[0]?.value || 1000);
    const current = Number(points.at(-1)?.value || start);
    const pnl = current - start;
    $("#paperEquityValue").textContent = money(current);
    $("#paperEquityChange").textContent = `${pnlMoney(pnl)} • ${pct(start ? pnl / start * 100 : 0)}`;
    $("#paperEquityChange").className = pnl >= 0 ? "green" : "red";
  }
  if (activePage === "history") {
    const points = buildEquitySeries(historyRange);
    drawLineChart($("#historyEquityChart"), points, { range: historyRange });
    const start = Number(points[0]?.value || 1000);
    const current = Number(points.at(-1)?.value || start);
    const pnl = current - start;
    $("#historyCurveValue").textContent = money(current);
    $("#historyCurveChange").textContent = `${pnlMoney(pnl)} • ${pct(start ? pnl / start * 100 : 0)}`;
    $("#historyCurveChange").className = pnl >= 0 ? "green" : "red";
  }
}

function openSignal(index) {
  const signal = visibleSignals[index];
  if (!signal) return;
  $("#modalTitle").textContent = `${signal.coin} ${signal.side} • Score ${signal.score}`;
  $("#modalSub").textContent = `${signal.marketRegime || "Market setup"} • ${signal.timeframe || "-"} • updated ${time(signal.updatedAt)}`;
  $("#modalBody").innerHTML = `
    <div class="detail-grid">
      <div class="detail-mini"><span>Entry</span><b>${money(signal.entry)}</b></div>
      <div class="detail-mini"><span>Take Profit</span><b class="green">${money(signal.tp)}</b></div>
      <div class="detail-mini"><span>Stop Loss</span><b class="red">${money(signal.sl)}</b></div>
      <div class="detail-mini"><span>R/R</span><b>${signalStats(signal).rr}</b></div>
      <div class="detail-mini"><span>Support</span><b>${money(signal.support)}</b></div>
      <div class="detail-mini"><span>Pivot</span><b>${money(signal.pivot)}</b></div>
      <div class="detail-mini"><span>Resistance</span><b>${money(signal.resistance)}</b></div>
      <div class="detail-mini"><span>Confidence</span><b>${signal.confidence ?? "-"}</b></div>
    </div>
    <div class="detail-section"><h3>Structure Chart + Entry / TP / SL</h3>${levelStrip(signal)}<canvas id="modalChart" class="modal-chart"></canvas></div>
    <div class="detail-section"><h3>Technical Analysis</h3><ul>${(signal.technicalAnalysis || signal.why || ["Belum ada analisis teknikal tambahan."]).map(item => `<li>${esc(item)}</li>`).join("")}</ul></div>
    <div class="detail-section"><h3>Market Narrative</h3><ul>${(signal.fundamentalAnalysis || ["Belum ada narrative tambahan."]).map(item => `<li>${esc(item)}</li>`).join("")}</ul></div>
    <div class="detail-section"><h3>Structure Detail</h3><ul><li>Pattern: ${esc(signal.priceAction?.pattern || "-")}</li><li>Bias: ${esc(signal.priceAction?.bias || signal.side || "-")}</li><li>Timeframe: ${esc(signal.timeframe || "-")}</li><li>Market regime: ${esc(signal.marketRegime || "-")}</li></ul></div>`;
  $("#detailModal").showModal();
  requestAnimationFrame(() => drawCandleChart($("#modalChart"), signal.chart || [], { signal }));
}

function openEquityModal() {
  equityRange = "1D";
  equityMode = "step";
  $$(".equity-range-btn").forEach(button => button.classList.toggle("active", button.dataset.equityRange === equityRange));
  $$(".equity-mode-btn").forEach(button => button.classList.toggle("active", button.dataset.equityMode === equityMode));
  $("#equityModal").classList.remove("hidden");
  $("#equityModal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  requestAnimationFrame(drawEquityModalChart);
}

function closeEquityModal() {
  $("#equityModal").classList.add("hidden");
  $("#equityModal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

async function poll() {
  try {
    const result = await api("/api/state");
    state = sanitizeState(result.data);
    renderAll();
  } catch (error) {
    console.error(error);
    $("#botStatus").textContent = "ERROR";
    $("#sidebarEngineStatus").textContent = "Connection error";
    $("#lastUpdatedText").textContent = error.message;
  }
}

document.addEventListener("click", event => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) setPage(pageButton.dataset.page);

  const signalCard = event.target.closest("[data-signal-index]");
  if (signalCard) openSignal(Number(signalCard.dataset.signalIndex));

  if (event.target.closest("[data-close-modal='equity']")) closeEquityModal();

  const equityRangeButton = event.target.closest("[data-equity-range]");
  if (equityRangeButton) {
    equityRange = equityRangeButton.dataset.equityRange;
    $$(".equity-range-btn").forEach(button => button.classList.toggle("active", button.dataset.equityRange === equityRange));
    drawEquityModalChart();
  }

  const equityModeButton = event.target.closest("[data-equity-mode]");
  if (equityModeButton) {
    equityMode = equityModeButton.dataset.equityMode;
    $$(".equity-mode-btn").forEach(button => button.classList.toggle("active", button.dataset.equityMode === equityMode));
    drawEquityModalChart();
  }

  const paperRangeButton = event.target.closest("[data-paper-range]");
  if (paperRangeButton) {
    paperRange = paperRangeButton.dataset.paperRange;
    $$("[data-paper-range]").forEach(button => button.classList.toggle("active", button.dataset.paperRange === paperRange));
    drawPageCharts();
  }

  const historyRangeButton = event.target.closest("[data-history-range]");
  if (historyRangeButton) {
    historyRange = historyRangeButton.dataset.historyRange;
    $$("[data-history-range]").forEach(button => button.classList.toggle("active", button.dataset.historyRange === historyRange));
    drawPageCharts();
  }
});

$("#filterSide")?.addEventListener("change", renderSignals);
$("#sortBy")?.addEventListener("change", renderSignals);
$("#globalSearch")?.addEventListener("input", () => {
  if ($("#signals").classList.contains("active")) renderSignals();
});
$("#closeModal")?.addEventListener("click", () => $("#detailModal").close());
$("#equityCard")?.addEventListener("click", openEquityModal);
$("#equityCard")?.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") openEquityModal();
});
$("#openEquityFromPreview")?.addEventListener("click", openEquityModal);

window.addEventListener("hashchange", () => {
  const page = location.hash.replace("#", "");
  if (["home", "signals", "trading", "history", "memory"].includes(page)) {
    setPage(page);
  }
});

window.addEventListener("pageshow", () => {
  setTimeout(resetPageScroll, 0);
});

window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawPageCharts, 120);
});

const initialPage = location.hash.replace("#", "") || "home";
setPage(["home", "signals", "trading", "history", "memory"].includes(initialPage) ? initialPage : "home");
poll();
setInterval(poll, 10000);
