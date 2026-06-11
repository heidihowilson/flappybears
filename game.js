"use strict";

/* ============================================================
   Flappy Bears — flap a bear through real crypto candlesticks.
   Candle direction (green/red) and the gap's vertical path come
   from live CoinGecko OHLC data for the selected coin.
   ============================================================ */

const COLORS = {
  bg: "#232320",
  bgDarker: "#1e1e1b",
  surface: "#2d2d29",
  text: "#efeee0",
  muted: "#b4b3aa",
  grid: "#efeee012",
  up: "#127f31",
  upBright: "#1f9e44",
  down: "#b72c2c",
  downBright: "#cf4a4a",
  gold: "#fda301",
  blue: "#6496c5",
};

const COIN_NAMES = { bitcoin: "BTC", ethereum: "ETH", solana: "SOL" };

// ---------- Canvas ----------
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const startScreen = $("start-screen");
const overScreen = $("over-screen");
const hud = $("hud");
const scoreEl = $("score");
const priceChip = $("price-chip");
const bestLine = $("best-line");
const dataNote = $("data-note");
const muteBtn = $("mute-btn");

// ---------- Audio (tiny WebAudio blips) ----------
let audioCtx = null;
let muted = localStorage.getItem("fb-muted") === "1";

function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}

function blip(freqStart, freqEnd, dur, type, gain) {
  if (muted || !audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqStart, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur);
}

const sfx = {
  flap: () => blip(380, 620, 0.09, "square", 0.04),
  score: () => { blip(660, 660, 0.06, "sine", 0.05); setTimeout(() => blip(880, 880, 0.08, "sine", 0.05), 70); },
  death: () => blip(320, 60, 0.45, "sawtooth", 0.07),
};

function renderMute() { muteBtn.textContent = muted ? "🔇" : "🔊"; }
muteBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  muted = !muted;
  localStorage.setItem("fb-muted", muted ? "1" : "0");
  renderMute();
});
renderMute();

// ---------- Market data ----------
let selectedCoin = "bitcoin";
let candleData = null; // [{t,o,h,l,c,up}] — the last 24h, 30-min candles
let dataLo = 0, dataHi = 1; // global low/high of the 24h window
let usingLiveData = false;
const dataCache = {};

function syntheticCandles() {
  const out = [];
  let price = 80000;
  const now = Date.now();
  for (let i = 0; i < 48; i++) {
    const drift = (Math.random() - 0.485) * price * 0.012;
    const o = price;
    const c = Math.max(100, price + drift);
    const h = Math.max(o, c) * (1 + Math.random() * 0.004);
    const l = Math.min(o, c) * (1 - Math.random() * 0.004);
    out.push({ t: now - (48 - i) * 30 * 60 * 1000, o, h, l, c, up: c >= o });
    price = c;
  }
  return out;
}

function setCandles(candles, live) {
  candleData = candles;
  usingLiveData = live;
  dataLo = Math.min(...candles.map((k) => k.l));
  dataHi = Math.max(...candles.map((k) => k.h));
}

async function loadCandles(coin) {
  const cached = dataCache[coin];
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
    setCandles(cached.candles, cached.live);
    return;
  }
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coin}/ohlc?vs_currency=usd&days=1`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length < 20) throw new Error("bad data");
    const candles = rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c, up: c >= o }));
    setCandles(candles, true);
    dataCache[coin] = { at: Date.now(), candles, live: true };
  } catch {
    setCandles(syntheticCandles(), false);
    dataCache[coin] = { at: Date.now(), candles: candleData, live: false };
  }
  dataNote.textContent = usingLiveData
    ? `The real ${COIN_NAMES[coin]}/USD chart, last 24h · range ` +
      `${fmtPrice(dataLo)} – ${fmtPrice(dataHi)} · ${candleData.length} candles`
    : "Candles: simulated (market data unavailable)";
}

// ---------- Game state ----------
const STATE = { MENU: 0, PLAYING: 1, DYING: 2, OVER: 3 };
let state = STATE.MENU;

let bear, obstacles, score, best, speed, dist, candleIdx, deathPrice, shake, won, wrongSide;
best = parseInt(localStorage.getItem("fb-best") || "0", 10);
bestLine.textContent = `Best: ${best}`;

const BEAR_R = 17;          // collision radius
const GRAVITY = 1750;
const FLAP_VY = -540;
const MAX_VY = 850;
const CANDLE_W = 44;
const SPACING = 230;
const BASE_SPEED = 165;
const PAD_TOP = 56;         // y of the day's high
const PAD_BOT = 72;         // room between the day's low and the floor

function reset() {
  bear = { x: Math.min(W * 0.28, 240), y: H * 0.45, vy: 0, rot: 0, wingT: 0 };
  obstacles = [];
  score = 0;
  speed = BASE_SPEED;
  dist = 0;
  shake = 0;
  deathPrice = null;
  won = false;
  wrongSide = false;
  // The level IS the last 24 hours, ridden chronologically from candle 0
  candleIdx = 0;
  scoreEl.textContent = `0 / ${candleData.length}`;
  priceChip.textContent = `${COIN_NAMES[selectedCoin]} —`;
  // Pre-spawn obstacles off the right edge
  let x = W + 200;
  while (x < W + 200 + SPACING * 4) {
    spawnObstacle(x);
    x += SPACING;
  }
}

// Map a price to a screen y. The playfield IS the day's chart: the day's
// high sits near the ceiling, the day's low near the floor.
function priceToY(p) {
  const span = dataHi - dataLo || 1;
  const usable = H - floorH() - PAD_TOP - PAD_BOT;
  return PAD_TOP + (1 - (p - dataLo) / span) * usable;
}

// Each obstacle is ONE real candle at its true chart position.
// Rule: fly OVER green (bullish) candles, UNDER red (bearish) ones.
function spawnObstacle(x) {
  if (candleIdx >= candleData.length) return; // end of the day's chart
  const k = candleData[candleIdx];
  let top = priceToY(Math.max(k.o, k.c));
  let bot = priceToY(Math.min(k.o, k.c));
  if (bot - top < 12) { // doji — give the body a minimum height
    const m = (top + bot) / 2;
    top = m - 6;
    bot = m + 6;
  }
  obstacles.push({
    x,
    top,
    bot,
    wickTop: priceToY(k.h),
    wickBot: priceToY(k.l),
    up: k.up,
    price: k.c,
    time: k.t,
    isLast: candleIdx === candleData.length - 1,
    passed: false,
  });
  candleIdx++;
}

// ---------- Input ----------
function flap() {
  if (state === STATE.MENU || state === STATE.OVER) return;
  if (state === STATE.PLAYING) {
    bear.vy = FLAP_VY;
    bear.wingT = 1;
    sfx.flap();
  }
}

canvas.addEventListener("pointerdown", (e) => { e.preventDefault(); ensureAudio(); flap(); });
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" || e.code === "ArrowUp") {
    e.preventDefault();
    ensureAudio();
    if (state === STATE.MENU) startGame();
    else if (state === STATE.OVER && overScreen.hidden === false) restart();
    else flap();
  }
});

// ---------- Screens ----------
document.querySelectorAll(".coin-pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".coin-pill").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedCoin = btn.dataset.coin;
    loadCandles(selectedCoin);
  });
});

async function startGame() {
  ensureAudio();
  if (!candleData) await loadCandles(selectedCoin);
  reset();
  const fmtDay = (t) =>
    new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const d0 = fmtDay(candleData[0].t);
  const d1 = fmtDay(candleData[candleData.length - 1].t);
  $("date-chip").textContent =
    `${COIN_NAMES[selectedCoin]}/USD · ${d0 === d1 ? d0 : `${d0} – ${d1}`}, ` +
    `${new Date(candleData[candleData.length - 1].t).getFullYear()}`;
  startScreen.hidden = true;
  overScreen.hidden = true;
  hud.hidden = false;
  state = STATE.PLAYING;
}

function restart() {
  startGame();
}

function toMenu() {
  state = STATE.MENU;
  overScreen.hidden = true;
  hud.hidden = true;
  startScreen.hidden = false;
  bestLine.textContent = `Best: ${best}`;
}

$("play-btn").addEventListener("click", startGame);
$("retry-btn").addEventListener("click", restart);
$("menu-btn").addEventListener("click", toMenu);

function fmtPrice(p) {
  return p >= 1000
    ? "$" + Math.round(p).toLocaleString("en-US")
    : "$" + p.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtTime(t) {
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function win() {
  won = true;
  if (score > best) {
    best = score;
    localStorage.setItem("fb-best", String(best));
  }
  state = STATE.OVER;
  sfx.score();
  const lastK = candleData[candleData.length - 1];
  $("over-title").textContent = "SURVIVED";
  $("over-title").classList.remove("rekt");
  $("over-title").classList.add("survived");
  $("rekt-line").textContent =
    `You rode 24 hours of ${COIN_NAMES[selectedCoin]} — closed at ${fmtPrice(lastK.c)}`;
  $("final-score").textContent = score;
  $("final-best").textContent = best;
  overScreen.hidden = false;
  hud.hidden = true;
}

function die() {
  state = STATE.DYING;
  shake = 14;
  sfx.death();
  // Price of the nearest obstacle = where you got liquidated
  const near = obstacles.find((o) => o.x + CANDLE_W > bear.x - 80) || obstacles[0];
  deathPrice = near ? near.price : null;
  if (score > best) {
    best = score;
    localStorage.setItem("fb-best", String(best));
  }
  setTimeout(showGameOver, 900);
}

function showGameOver() {
  state = STATE.OVER;
  $("over-title").textContent = "REKT";
  $("over-title").classList.remove("survived");
  $("over-title").classList.add("rekt");
  $("final-score").textContent = score;
  $("final-best").textContent = best;
  $("rekt-line").textContent = !deathPrice
    ? "Liquidated"
    : wrongSide
      ? `Wrong side of the candle — ${COIN_NAMES[selectedCoin]} at ${fmtPrice(deathPrice)}`
      : `Liquidated ${COIN_NAMES[selectedCoin]} at ${fmtPrice(deathPrice)}`;
  overScreen.hidden = false;
  hud.hidden = true;
}

// ---------- Update ----------
function update(dt) {
  if (state === STATE.PLAYING) {
    speed = BASE_SPEED + Math.min(70, score * 1.8);
    dist += speed * dt;

    bear.vy = Math.min(MAX_VY, bear.vy + GRAVITY * dt);
    bear.y += bear.vy * dt;
    bear.rot = Math.max(-0.45, Math.min(1.25, bear.vy / 700));
    bear.wingT = Math.max(0, bear.wingT - dt * 4);

    for (const o of obstacles) o.x -= speed * dt;

    // Recycle and spawn (the chart is finite — no wrap-around)
    if (obstacles.length && obstacles[0].x + CANDLE_W < -20) obstacles.shift();
    const last = obstacles[obstacles.length - 1];
    if (!last || last.x < W + 100) spawnObstacle((last ? last.x : W) + SPACING);

    // Scoring + collision. Passing on the wrong side (under a green,
    // over a red) is a death, same as hitting the body.
    for (const o of obstacles) {
      if (!o.passed && o.x + CANDLE_W < bear.x - BEAR_R) {
        o.passed = true;
        const okSide = o.up ? bear.y < o.top : bear.y > o.bot;
        if (!okSide) { wrongSide = true; die(); break; }
        score++;
        scoreEl.textContent = `${score} / ${candleData.length}`;
        priceChip.textContent = `${COIN_NAMES[selectedCoin]} ${fmtPrice(o.price)} · ${fmtTime(o.time)}`;
        sfx.score();
        if (o.isLast) { win(); break; }
      }
      if (collides(o)) { die(); break; }
    }

    // Floor / ceiling
    if (bear.y + BEAR_R > H - floorH() || bear.y - BEAR_R < -40) die();
  } else if (state === STATE.DYING) {
    // Bear tumbles down
    bear.vy = Math.min(MAX_VY, bear.vy + GRAVITY * dt);
    bear.y += bear.vy * dt;
    bear.rot = Math.min(Math.PI / 2, bear.rot + dt * 4);
    if (bear.y + BEAR_R > H - floorH()) {
      bear.y = H - floorH() - BEAR_R;
      bear.vy = 0;
    }
  }
  if (shake > 0) shake = Math.max(0, shake - dt * 30);
}

function collides(o) {
  // Circle vs the candle body (wicks are decorative — no collision)
  const cx = Math.max(o.x, Math.min(bear.x, o.x + CANDLE_W));
  const cy = Math.max(o.top, Math.min(bear.y, o.bot));
  const dx = bear.x - cx, dy = bear.y - cy;
  return dx * dx + dy * dy < (BEAR_R - 2) * (BEAR_R - 2);
}

function floorH() { return Math.max(46, H * 0.07); }

// ---------- Render ----------
function render() {
  ctx.save();
  if (shake > 0.5) {
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  }

  // Background
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, COLORS.bgDarker);
  grad.addColorStop(1, COLORS.bg);
  ctx.fillStyle = grad;
  ctx.fillRect(-20, -20, W + 40, H + 40);

  if (state === STATE.MENU) {
    drawGrid();
  } else {
    drawPriceAxis();
    for (const o of obstacles || []) drawCandle(o);
    drawFloor();
    drawTimeLabels();
  }
  if (state === STATE.MENU) drawFloor();
  if (bear) drawBear();

  ctx.restore();
}

function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

function fmtAxisPrice(p) {
  return p.toLocaleString("en-US", { maximumFractionDigits: p < 1000 ? 1 : 0 });
}

function drawPriceAxis() {
  if (!candleData) return;
  const step = niceStep((dataHi - dataLo) / 5);
  ctx.font = "11px 'IBM Plex Mono', monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  for (let p = Math.ceil(dataLo / step) * step; p <= dataHi; p += step) {
    const y = priceToY(p);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillStyle = "#b4b3aab3";
    ctx.fillText(fmtAxisPrice(p), W - 8, y - 3);
  }
}

function drawTimeLabels() {
  const y = H - floorH();
  ctx.font = "11px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const o of obstacles || []) {
    if (new Date(o.time).getMinutes() !== 0) continue; // hourly ticks only
    const cx = o.x + CANDLE_W / 2;
    if (cx < -60 || cx > W + 60) continue;
    ctx.strokeStyle = "#efeee018";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, y + 6);
    ctx.stroke();
    ctx.fillStyle = "#b4b3aab3";
    ctx.fillText(
      new Date(o.time).toLocaleTimeString("en-US", { hour: "numeric" }),
      cx, y + 10
    );
  }
}

function drawGrid() {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  const rows = 6;
  for (let i = 1; i < rows; i++) {
    const y = (H / rows) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  // Vertical gridlines scroll with the world
  const colW = 140;
  const off = -(dist || 0) % colW;
  for (let x = off; x < W; x += colW) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
}

function drawCandle(o) {
  const body = o.up ? COLORS.up : COLORS.down;
  const edge = o.up ? COLORS.upBright : COLORS.downBright;
  const cx = o.x + CANDLE_W / 2;

  // Wick: true high -> low (decorative, no collision)
  ctx.strokeStyle = edge;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, o.wickTop);
  ctx.lineTo(cx, o.wickBot);
  ctx.stroke();

  // Body: open -> close at its real chart position
  ctx.fillStyle = body;
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(o.x, o.top, CANDLE_W, o.bot - o.top, 4);
  else ctx.rect(o.x, o.top, CANDLE_W, o.bot - o.top);
  ctx.fill();
  ctx.stroke();
  // Inner sheen line for depth
  ctx.strokeStyle = "#efeee022";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(o.x + 5, o.top + 6);
  ctx.lineTo(o.x + 5, o.bot - 6);
  ctx.stroke();

  // Over/under marker on every candle you haven't cleared yet
  if (!o.passed) {
    ctx.font = "600 11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#efeee0cc";
    if (o.up) {
      ctx.textBaseline = "bottom";
      ctx.fillText("▲ OVER", cx, Math.min(o.wickTop, o.top) - 8);
    } else {
      ctx.textBaseline = "top";
      ctx.fillText("▼ UNDER", cx, Math.max(o.wickBot, o.bot) + 8);
    }
  }
}

function drawFloor() {
  const fh = floorH();
  const y = H - fh;
  ctx.fillStyle = COLORS.bgDarker;
  ctx.fillRect(-20, y, W + 40, fh + 20);
  ctx.strokeStyle = "#efeee033";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(W, y);
  ctx.stroke();
  // Axis ticks, scrolling
  ctx.strokeStyle = "#efeee026";
  ctx.lineWidth = 1;
  const tickW = 70;
  const off = -(dist || 0) % tickW;
  for (let x = off; x < W; x += tickW) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 7);
    ctx.stroke();
  }
}

function drawBear() {
  const { x, y, rot, wingT } = bear;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);

  const FUR = "#9c6b3c";
  const FUR_DARK = "#7a5230";
  const SNOUT = "#d9b98c";
  const INK = "#1e1e1b";

  // Ears
  ctx.fillStyle = FUR;
  ctx.strokeStyle = FUR_DARK;
  ctx.lineWidth = 2;
  for (const ex of [-9, 8]) {
    ctx.beginPath();
    ctx.arc(ex, -14, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = SNOUT;
  for (const ex of [-9, 8]) {
    ctx.beginPath();
    ctx.arc(ex, -14, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Body
  ctx.fillStyle = FUR;
  ctx.strokeStyle = FUR_DARK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Wing (tiny, flaps)
  const wingAngle = -0.5 - wingT * 1.1;
  ctx.save();
  ctx.translate(-7, 2);
  ctx.rotate(wingAngle);
  ctx.fillStyle = "#efeee0";
  ctx.strokeStyle = "#b4b3aa";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(-6, 0, 9, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Snout
  ctx.fillStyle = SNOUT;
  ctx.beginPath();
  ctx.ellipse(7, 4, 7.5, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  // Nose
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(10, 2.5, 2.4, 0, Math.PI * 2);
  ctx.fill();
  // Mouth
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(8, 6, 3, 0.25, Math.PI * 0.75);
  ctx.stroke();

  // Eye
  if (state === STATE.DYING || state === STATE.OVER) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(0.5, -7.5); ctx.lineTo(5.5, -2.5);
    ctx.moveTo(5.5, -7.5); ctx.lineTo(0.5, -2.5);
    ctx.stroke();
  } else {
    ctx.fillStyle = "#efeee0";
    ctx.beginPath();
    ctx.arc(3, -5, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(4.2, -5, 2.1, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ---------- Menu idle scene ----------
let idleT = 0;
function renderMenuScene(dt) {
  idleT += dt;
  dist = idleT * 40;
  bear = bear || { x: Math.min(W * 0.28, 240), y: H * 0.45, vy: 0, rot: 0, wingT: 0 };
  bear.x = Math.min(W * 0.28, 240);
  bear.y = H * 0.45 + Math.sin(idleT * 2.2) * 12;
  bear.rot = Math.sin(idleT * 2.2 + 1) * 0.12;
  bear.wingT = (Math.sin(idleT * 6) + 1) / 2;
  obstacles = [];
  render();
}

// ---------- Main loop ----------
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - lastT) / 1000);
  lastT = now;
  if (state === STATE.MENU) {
    renderMenuScene(dt);
  } else {
    update(dt);
    render();
  }
  requestAnimationFrame(frame);
}

document.addEventListener("visibilitychange", () => { lastT = performance.now(); });

// Preload data for default coin, then go
loadCandles(selectedCoin);
requestAnimationFrame(frame);

// Demo mode for testing: #autoplay starts a run with a perfect-ish autopilot
if (location.hash === "#autoplay") {
  loadCandles(selectedCoin).then(() => {
    startGame();
    setInterval(() => {
      if (state !== STATE.PLAYING) return;
      const next = obstacles.find((o) => o.x + CANDLE_W > bear.x - BEAR_R);
      const target = next
        ? next.up
          ? next.top - 55
          : Math.min(next.bot + 45, H - floorH() - 30)
        : H * 0.5;
      if (bear.y > target && bear.vy > -100) flap();
    }, 50);
  });
}
