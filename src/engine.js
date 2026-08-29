/* ============================================================================
 * ZODIAC ASCENSION — Game Engine
 * Stage 1: Architecture, engine and foundations.
 *
 * Logical modules (single bundle, clear boundaries):
 *   Config · Utils · EventBus · RNG · SlotMath · WinEvaluator · CascadeEngine
 *   MultiplierEngine · BonusEngine · GameState · GameStateMachine · SpinEngine
 *   ReelEngine · AnimationEngine · ParticleEngine · AmbientFX
 *   ConstellationEngine · Renderer · SoundManager · UIManager
 *   SettingsManager · AutoSpinManager · StorageService · LeaderboardService
 *   PerformanceManager · DebugTools · GameEngine
 *
 * Pipeline contract (math is fully decoupled from presentation):
 *   RNG -> Spin Result (full cascade chain precomputed) -> GameState
 *       -> Win Evaluation -> Animation. Never the reverse.
 * ========================================================================== */

import { gsap } from "gsap";

/* ========================================================================== *
 * MODULE: Config
 * ========================================================================== */
const CONFIG = {
  VERSION: "0.1.0",
  STAGE: "stage1-engine",
  GRID: { reels: 5, rows: 3 },
  START_BALANCE: 100,
  BETS: [1, 2, 5, 10, 20, 50],
  MIN_BET: 1,
  WAYS_DIV: 2.5, // units -> credits divisor for 243-ways paytable
  FREE_SPINS: { 3: 8, 4: 12, 5: 20 },
  SCATTER_PAY: { 3: 2, 4: 5, 5: 25 }, // x bet, added on trigger
  MULT_LADDER: [1, 2, 3, 5, 8, 10], // base-mode cascade step multipliers
  FS_MULT_START: 2, // free-spin persistent multiplier seed
  FS_MULT_CAP: 20,
  ASCENSION_CHARGES: 12,
  ASCENSION_MULT: 5,
  ASCENSION_PER_SCATTER: 3,
  MAX_CASCADE_STEPS: 12,
  BIG_WIN_TIERS: [
    { name: "COSMIC WIN", mult: 50 },
    { name: "MEGA WIN", mult: 25 },
    { name: "BIG WIN", mult: 10 },
  ],
  DEBUG_MODE: false, // when true + DEBUG_SEED, RNG is reproducible
  DEBUG_SEED: null,
  // Supabase (frontend-safe values only — never a service-role key).
  // Provide at runtime via window.ZODIAC_SUPABASE = { url, anonKey, edgeFunction? }
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  SUPABASE_EDGE_FUNCTION: "", // optional: validated server-side writes
  SUPABASE_TABLE: "leaderboard",
  STORAGE_PREFIX: "zodiacAscension.v1.",
  LEADERBOARD_SIZE: 50,
};

/* ========================================================================== *
 * MODULE: Utils
 * ========================================================================== */
const Utils = {
  clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
  lerp(a, b, t) { return a + (b - a) * t; },
  pick(arr, rnd) { return arr[Math.floor(rnd() * arr.length)]; },
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); },
  tween(target, vars) {
    return new Promise((resolve) => {
      gsap.to(target, { ...vars, onComplete: () => resolve(target), overwrite: "auto" });
    });
  },
  killTweens(target) { gsap.killTweensOf(target); },
  uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  },
  hexToRgb(hex) {
    const h = hex.replace("#", "");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  },
  rgba(hex, a) {
    const { r, g, b } = Utils.hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  },
  fmt(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); },
};

/* ========================================================================== *
 * MODULE: EventBus
 * ========================================================================== */
const EventBus = (() => {
  const listeners = new Map();
  return {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt).delete(fn);
    },
    off(evt, fn) { listeners.get(evt)?.delete(fn); },
    emit(evt, payload) {
      const set = listeners.get(evt);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (e) { console.error(`[EventBus] handler error on ${evt}`, e); }
      }
    },
    clear() { listeners.clear(); },
  };
})();

/* Canonical game events (contract for later stages). */
const EVENTS = {
  GAME_READY: "GAME_READY", SPIN_STARTED: "SPIN_STARTED", REEL_STOPPED: "REEL_STOPPED",
  SPIN_RESOLVED: "SPIN_RESOLVED", WIN_FOUND: "WIN_FOUND", CASCADE_STARTED: "CASCADE_STARTED",
  CASCADE_FINISHED: "CASCADE_FINISHED", MULTIPLIER_TRIGGERED: "MULTIPLIER_TRIGGERED",
  BONUS_STARTED: "BONUS_STARTED", BONUS_FINISHED: "BONUS_FINISHED", BALANCE_CHANGED: "BALANCE_CHANGED",
  BIG_WIN: "BIG_WIN", AUTO_SPIN_STARTED: "AUTO_SPIN_STARTED", AUTO_SPIN_STOPPED: "AUTO_SPIN_STOPPED",
  EXIT_REQUESTED: "EXIT_REQUESTED", LEADERBOARD_QUALIFIED: "LEADERBOARD_QUALIFIED",
  LEADERBOARD_SUBMITTED: "LEADERBOARD_SUBMITTED", ERROR: "ERROR", STATE_CHANGED: "STATE_CHANGED",
  ASCENSION_TRIGGERED: "ASCENSION_TRIGGERED",
};

/* ========================================================================== *
 * MODULE: RNG
 * crypto-backed by default. In DEBUG_MODE with a DEBUG_SEED, a seeded
 * mulberry32 stream makes results reproducible. Game results NEVER use
 * Math.random().
 * ========================================================================== */
const RNG = (() => {
  let seeded = null;
  let activeSeed = null;
  let draws = 0;
  const buf = new Uint32Array(1);

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function cryptoFloat() {
    crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  }
  return {
    configure({ debugMode = false, seed = null } = {}) {
      if (debugMode && seed != null) {
        activeSeed = seed >>> 0;
        seeded = mulberry32(activeSeed);
      } else {
        seeded = null;
        activeSeed = null;
      }
      draws = 0;
    },
    isSeeded() { return seeded != null; },
    float() { draws++; return seeded ? seeded() : cryptoFloat(); },
    int(n) { return Math.floor(this.float() * n); },
    pickWeighted(entries) {
      // entries: [{ id, weight }]
      let total = 0;
      for (const e of entries) total += e.weight;
      let r = this.float() * total;
      for (const e of entries) { r -= e.weight; if (r < 0) return e.id; }
      return entries[entries.length - 1].id;
    },
    info() {
      return {
        source: seeded ? "seeded-mulberry32" : "crypto.getRandomValues",
        seed: activeSeed,
        draws,
      };
    },
  };
})();

/* ========================================================================== *
 * MODULE: Symbols — procedural SVG glyph registry (no binary assets)
 * Glyph space: 24x24, stroke-based. Drawn on canvas AND reused as inline SVG.
 * ========================================================================== */
const Glyphs = {
  aries: [
    { d: "M12 21 V10" },
    { d: "M12 10 C12 4.5 6.5 3 5.5 6.5 C4.8 9.2 7.5 10.8 9.6 9.4" },
    { d: "M12 10 C12 4.5 17.5 3 18.5 6.5 C19.2 9.2 16.5 10.8 14.4 9.4" },
  ],
  taurus: [
    { cx: 12, cy: 14.6, r: 4.5 },
    { d: "M5.5 4 C5.5 8 8.5 10.1 12 10.1 C15.5 10.1 18.5 8 18.5 4" },
  ],
  gemini: [
    { d: "M5.5 4.5 C8.5 6.6 15.5 6.6 18.5 4.5" },
    { d: "M5.5 19.5 C8.5 17.4 15.5 17.4 18.5 19.5" },
    { d: "M9.2 6 V18" }, { d: "M14.8 6 V18" },
  ],
  cancer: [
    { cx: 8, cy: 9.2, r: 2.6 }, { cx: 16, cy: 14.8, r: 2.6 },
    { d: "M4.5 8.2 C8.5 4.2 15 4.8 19.2 9.5" },
    { d: "M19.5 15.8 C15.5 19.8 9 19.2 4.8 14.5" },
  ],
  leo: [
    { cx: 7, cy: 15.6, r: 2.4 },
    { d: "M9.4 15.6 C13.5 15.6 15.2 13.6 14.6 10.6 C14 7.8 10.4 7.4 9.6 9.9 C8.9 12.1 11.6 13.3 14.4 12.9 C17.2 12.5 18.6 14.6 18 16.8 C17.5 18.7 15.2 19 14.6 17.4" },
  ],
  virgo: [
    { d: "M4 13 C4 9.5 6.8 9.5 6.8 12 V15.5" },
    { d: "M6.8 12 C6.8 9.5 9.6 9.5 9.6 12 V15.5" },
    { d: "M9.6 12 C9.6 9.5 12.4 9.5 12.4 12 V16.5" },
    { d: "M12.4 13.5 C14.8 10.8 18.2 12.2 17 14.6 C16 16.6 12.6 16.3 12.4 16.3" },
    { d: "M15.6 15.6 L19 19" },
  ],
  libra: [
    { d: "M4.5 18.5 H19.5" },
    { d: "M4.5 15.2 H7.6" }, { d: "M16.4 15.2 H19.5" },
    { d: "M7.6 15.2 C7.6 10.8 9.6 8.6 12 8.6 C14.4 8.6 16.4 10.8 16.4 15.2" },
  ],
  scorpio: [
    { d: "M4 13 C4 9.5 6.8 9.5 6.8 12 V15.5" },
    { d: "M6.8 12 C6.8 9.5 9.6 9.5 9.6 12 V15.5" },
    { d: "M9.6 12 C9.6 9.5 12.4 9.5 12.4 12 V16.5 C12.4 19 14.6 19.8 16.6 18.9 L18.6 17.8" },
    { d: "M16.6 15.2 L18.8 17.6 L15.9 18.4" },
  ],
  sagittarius: [
    { d: "M4.5 19.5 L19 5" },
    { d: "M12.8 5 H19 V11.2" },
    { d: "M7.8 11.8 L12.2 16.2" },
  ],
  capricorn: [
    { d: "M4 9.5 C4 6.5 6.6 6.3 7.2 8.8 C7.9 11.6 7.6 14 9 15.6" },
    { d: "M10.6 12.4 C11.4 10.6 13.6 10.2 14.9 11.4 C16.4 12.7 16 14.9 14.2 15.3 C12.6 15.7 11.6 14.2 12.5 13" },
    { d: "M14.2 15.3 C17.8 14.6 19.8 16.8 18.2 18.9 C16.6 21 13.9 19.7 14.9 17.8 C15.5 16.6 17.2 16.7 17.4 17.9" },
  ],
  aquarius: [
    { d: "M4.5 9.5 L8 6.2 L11.5 9.5 L15 6.2 L18.5 9.5" },
    { d: "M4.5 16 L8 12.7 L11.5 16 L15 12.7 L18.5 16" },
  ],
  pisces: [
    { d: "M7.5 4 C10.8 8.5 10.8 15.5 7.5 20" },
    { d: "M16.5 4 C13.2 8.5 13.2 15.5 16.5 20" },
    { d: "M4 12 H20" },
  ],
  wild: [
    { cx: 12, cy: 12, r: 3.6 },
    { d: "M12 3.4 V6.1" }, { d: "M12 17.9 V20.6" },
    { d: "M3.4 12 H6.1" }, { d: "M17.9 12 H20.6" },
    { d: "M5.9 5.9 L7.8 7.8" }, { d: "M16.2 16.2 L18.1 18.1" },
    { d: "M18.1 5.9 L16.2 7.8" }, { d: "M7.8 16.2 L5.9 18.1" },
  ],
  scatter: [
    { d: "M14.8 4.2 A8.1 8.1 0 1 0 14.8 19.8 A9.8 9.8 0 0 1 14.8 4.2 Z", fill: true },
    { d: "M18.4 3.6 L19 5.2 L20.6 5.8 L19 6.4 L18.4 8 L17.8 6.4 L16.2 5.8 L17.8 5.2 Z", fill: true },
  ],
};

const TIER_COLORS = {
  fire: "#ff8a4a", earth: "#7dffa8", air: "#6fe3ff", water: "#7aa8ff",
  wild: "#ffd98a", scatter: "#ff7ad9",
};

const SYMBOLS = [
  // Low tier
  { id: "aries", name: "Aries", tier: "low", element: "fire", weight: 10, pay: { 3: 0.4, 4: 1.5, 5: 5 } },
  { id: "taurus", name: "Taurus", tier: "low", element: "earth", weight: 10, pay: { 3: 0.4, 4: 1.5, 5: 5 } },
  { id: "gemini", name: "Gemini", tier: "low", element: "air", weight: 10, pay: { 3: 0.4, 4: 1.5, 5: 5 } },
  { id: "cancer", name: "Cancer", tier: "low", element: "water", weight: 10, pay: { 3: 0.4, 4: 1.5, 5: 5 } },
  { id: "libra", name: "Libra", tier: "low", element: "air", weight: 11, pay: { 3: 0.4, 4: 1.5, 5: 5 } },
  // Mid tier
  { id: "virgo", name: "Virgo", tier: "mid", element: "earth", weight: 7, pay: { 3: 0.6, 4: 2.2, 5: 8 } },
  { id: "sagittarius", name: "Sagittarius", tier: "mid", element: "fire", weight: 7, pay: { 3: 0.6, 4: 2.2, 5: 8 } },
  { id: "aquarius", name: "Aquarius", tier: "mid", element: "air", weight: 7, pay: { 3: 0.6, 4: 2.2, 5: 8 } },
  { id: "pisces", name: "Pisces", tier: "mid", element: "water", weight: 7, pay: { 3: 0.6, 4: 2.2, 5: 8 } },
  // High tier
  { id: "leo", name: "Leo", tier: "high", element: "fire", weight: 5, pay: { 3: 1, 4: 4, 5: 15 } },
  { id: "scorpio", name: "Scorpio", tier: "high", element: "water", weight: 5, pay: { 3: 1, 4: 4, 5: 15 } },
  { id: "capricorn", name: "Capricorn", tier: "high", element: "earth", weight: 5, pay: { 3: 1, 4: 4, 5: 15 } },
  // Specials
  { id: "wild", name: "Solar Wild", tier: "special", element: "wild", weight: 2, pay: { 3: 2, 4: 8, 5: 40 } },
  { id: "scatter", name: "Lunar Scatter", tier: "special", element: "scatter", weight: 3, pay: null },
];
const SYMBOL_BY_ID = Object.fromEntries(SYMBOLS.map((s) => [s.id, s]));
const PAYABLE = SYMBOLS.filter((s) => s.pay); // wild included, scatter excluded

/* Simplified constellation maps (normalized 0..1) per zodiac symbol. */
const CONSTELLATIONS = {
  aries: { pts: [[0.15, 0.6], [0.38, 0.42], [0.62, 0.35], [0.88, 0.45]], lines: [[0, 1], [1, 2], [2, 3]] },
  taurus: { pts: [[0.1, 0.22], [0.35, 0.48], [0.55, 0.62], [0.8, 0.86], [0.76, 0.28], [0.5, 0.4]], lines: [[0, 1], [1, 2], [2, 3], [2, 5], [5, 4]] },
  gemini: { pts: [[0.25, 0.08], [0.28, 0.38], [0.3, 0.68], [0.35, 0.94], [0.7, 0.1], [0.66, 0.4], [0.62, 0.7], [0.55, 0.94]], lines: [[0, 1], [1, 2], [2, 3], [4, 5], [5, 6], [6, 7], [1, 5]] },
  cancer: { pts: [[0.2, 0.3], [0.45, 0.5], [0.78, 0.24], [0.72, 0.76]], lines: [[0, 1], [1, 2], [1, 3]] },
  leo: { pts: [[0.14, 0.8], [0.2, 0.5], [0.34, 0.24], [0.58, 0.16], [0.8, 0.34], [0.86, 0.64], [0.64, 0.72]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]] },
  virgo: { pts: [[0.1, 0.28], [0.3, 0.34], [0.5, 0.28], [0.7, 0.34], [0.86, 0.55], [0.6, 0.6], [0.34, 0.66]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5], [5, 6], [1, 6]] },
  libra: { pts: [[0.2, 0.38], [0.5, 0.18], [0.8, 0.38], [0.5, 0.58], [0.3, 0.82], [0.7, 0.82]], lines: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [3, 5]] },
  scorpio: { pts: [[0.08, 0.3], [0.24, 0.36], [0.4, 0.46], [0.55, 0.56], [0.7, 0.7], [0.85, 0.62], [0.92, 0.4]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]] },
  sagittarius: { pts: [[0.2, 0.72], [0.4, 0.5], [0.6, 0.44], [0.82, 0.28], [0.66, 0.7], [0.44, 0.76]], lines: [[0, 1], [1, 2], [2, 3], [1, 4], [4, 5], [5, 0]] },
  capricorn: { pts: [[0.14, 0.4], [0.4, 0.24], [0.66, 0.34], [0.86, 0.6], [0.6, 0.76], [0.3, 0.7]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]] },
  aquarius: { pts: [[0.1, 0.34], [0.3, 0.24], [0.45, 0.4], [0.6, 0.28], [0.75, 0.44], [0.9, 0.34], [0.55, 0.72]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [2, 6]] },
  pisces: { pts: [[0.15, 0.24], [0.26, 0.5], [0.15, 0.76], [0.5, 0.5], [0.85, 0.24], [0.74, 0.5], [0.85, 0.76]], lines: [[0, 1], [1, 2], [1, 3], [3, 5], [4, 5], [5, 6]] },
};

/* Glyph rendering shared by canvas + DOM SVG. */
function drawGlyph(ctx, glyphId, x, y, size, color, glow = 0) {
  const parts = Glyphs[glyphId];
  if (!parts) return;
  const s = size / 24;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(s, s);
  ctx.lineWidth = 1.9;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (glow > 0) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
  for (const p of parts) {
    if (p.d) {
      const path = new Path2D(p.d);
      if (p.fill) ctx.fill(path); else ctx.stroke(path);
    } else {
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}
function glyphSVG(glyphId, sizePx, color) {
  const parts = Glyphs[glyphId] || [];
  const inner = parts.map((p) =>
    p.d
      ? `<path d="${p.d}" ${p.fill ? `fill="${color}" stroke="none"` : `fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"`}/>`
      : `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="none" stroke="${color}" stroke-width="1.9"/>`
  ).join("");
  return `<svg viewBox="0 0 24 24" width="${sizePx}" height="${sizePx}">${inner}</svg>`;
}

/* ========================================================================== *
 * MODULE: StorageService
 * ========================================================================== */
const StorageService = (() => {
  const P = CONFIG.STORAGE_PREFIX;
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(P + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(P + key, JSON.stringify(value)); return true; }
    catch { return false; }
  }
  function remove(key) { try { localStorage.removeItem(P + key); } catch { /* noop */ } }
  return { read, write, remove, readRaw: read, writeRaw: write };
})();

/* ========================================================================== *
 * MODULE: SettingsManager
 * ========================================================================== */
const SettingsManager = (() => {
  const DEFAULTS = {
    masterVol: 0.8, sfxVol: 0.9, musicVol: 0.5, muted: false,
    quality: "AUTO", turbo: false, quick: false,
    reducedMotion: false, showFps: false, betIndex: 1, playerName: "",
  };
  let data = { ...DEFAULTS };
  function load() {
    const saved = StorageService.read("settings", null);
    if (saved && typeof saved === "object") data = { ...DEFAULTS, ...saved };
    return data;
  }
  function persist() { StorageService.write("settings", data); }
  return {
    load,
    get: (k) => data[k],
    all: () => ({ ...data }),
    set(k, v) {
      data[k] = v;
      persist();
      EventBus.emit("SETTINGS_CHANGED", { key: k, value: v });
    },
    reset() { data = { ...DEFAULTS }; persist(); },
  };
})();

/* ========================================================================== *
 * MODULE: GameState
 * ========================================================================== */
const GameState = (() => {
  function freshSession() {
    return {
      sessionId: Utils.uuid(),
      balance: CONFIG.START_BALANCE,
      sessionScore: 0,
      currentBet: CONFIG.BETS[SettingsManager.get("betIndex")] || CONFIG.BETS[0],
      lastWin: 0,
      totalWins: 0,
      biggestWin: 0,
      highestMultiplier: 1,
      cascadeCount: 0,
      zodiacAscensionCount: 0,
      spinsPlayed: 0,
      ascensionCharge: 0,
      ascensionArmed: false,
      startedAt: Date.now(),
    };
  }
  let data = freshSession();
  return {
    reset() { data = freshSession(); return data; },
    get data() { return data; },
    addBalance(delta) {
      data.balance = Math.max(0, Math.round((data.balance + delta) * 100) / 100);
      EventBus.emit(EVENTS.BALANCE_CHANGED, { balance: data.balance, delta });
      return data.balance;
    },
  };
})();

/* ========================================================================== *
 * MODULE: GameStateMachine — strict transition table, no invalid jumps.
 * ========================================================================== */
const FSM = (() => {
  const TRANSITIONS = {
    BOOT: ["IDLE"],
    IDLE: ["SPINNING", "AUTO_SPIN", "PAUSED", "EXIT_CONFIRMATION", "GAME_OVER", "NAME_ENTRY", "BONUS"],
    SPINNING: ["EVALUATING"],
    EVALUATING: ["WINNING", "CASCADING", "BONUS", "IDLE", "AUTO_SPIN", "GAME_OVER"],
    WINNING: ["CASCADING", "EVALUATING", "IDLE", "AUTO_SPIN", "BONUS", "GAME_OVER"],
    CASCADING: ["EVALUATING", "WINNING", "IDLE", "AUTO_SPIN"],
    BONUS: ["SPINNING", "IDLE", "AUTO_SPIN", "GAME_OVER"],
    AUTO_SPIN: ["SPINNING", "IDLE", "PAUSED", "EXIT_CONFIRMATION", "GAME_OVER"],
    PAUSED: ["IDLE", "AUTO_SPIN", "EXIT_CONFIRMATION"],
    EXIT_CONFIRMATION: ["IDLE", "AUTO_SPIN", "GAME_OVER", "NAME_ENTRY"],
    NAME_ENTRY: ["SUBMITTING_SCORE", "GAME_OVER", "IDLE"],
    SUBMITTING_SCORE: ["GAME_OVER", "IDLE"],
    GAME_OVER: ["IDLE", "NAME_ENTRY", "SUBMITTING_SCORE", "EXIT_CONFIRMATION"],
  };
  let state = "BOOT";
  const history = [];
  return {
    get state() { return state; },
    can(next) { return (TRANSITIONS[state] || []).includes(next); },
    set(next, reason = "") {
      if (state === next) return true; // no-op (guards double-execution, e.g. SPINNING->SPINNING)
      if (!this.can(next)) {
        console.warn(`[FSM] invalid transition ${state} -> ${next} (${reason})`);
        EventBus.emit(EVENTS.ERROR, { type: "FSM_INVALID_TRANSITION", from: state, to: next });
        return false;
      }
      const prev = state;
      state = next;
      history.push({ from: prev, to: next, at: Date.now() });
      if (history.length > 60) history.shift();
      EventBus.emit(EVENTS.STATE_CHANGED, { from: prev, to: next });
      return true;
    },
    historySnapshot() { return history.slice(-10).map((h) => `${h.from}>${h.to}`).join(" | "); },
  };
})();

/* ========================================================================== *
 * MODULE: SlotMath + WinEvaluator + CascadeEngine
 * Pure, deterministic once the RNG stream is fixed. The ENTIRE cascade chain
 * is precomputed before any animation runs.
 * ========================================================================== */
const SlotMath = (() => {
  let debugForce = null; // dev-only: { type:'scatter'|'symbol', symbol?, count? }

  function generateGrid() {
    const { reels, rows } = CONFIG.GRID;
    const grid = [];
    for (let c = 0; c < reels; c++) {
      const col = [];
      for (let r = 0; r < rows; r++) col.push(RNG.pickWeighted(SYMBOLS));
      grid.push(col);
    }
    if (debugForce) {
      const f = debugForce; debugForce = null;
      if (f.type === "scatter") {
        const n = Utils.clamp(f.count || 3, 3, 5);
        const cells = [];
        for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) cells.push([c, r]);
        for (let i = cells.length - 1; i > 0; i--) { const j = RNG.int(i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
        for (let i = 0; i < n; i++) grid[cells[i][0]][cells[i][1]] = "scatter";
      } else if (f.type === "symbol") {
        for (let c = 0; c < 3; c++) grid[c][RNG.int(3)] = f.symbol || "leo";
      }
    }
    return grid;
  }

  /* 243-ways evaluation: matching symbols (wild substitutes) on adjacent
     reels from the left, any row. Wild-only combos pay separately. */
  function evaluateGrid(grid, bet) {
    const wins = [];
    const winCells = new Map(); // key "c,r" -> true
    let totalUnits = 0;

    const countFor = (matchFn) => {
      const perReel = [];
      for (let c = 0; c < grid.length; c++) {
        const cells = [];
        for (let r = 0; r < grid[c].length; r++) if (matchFn(grid[c][r])) cells.push([c, r]);
        if (cells.length === 0) break;
        perReel.push(cells);
      }
      return perReel;
    };

    for (const sym of PAYABLE) {
      const isWildRun = sym.id === "wild";
      const perReel = countFor(isWildRun ? (s) => s === "wild" : (s) => s === sym.id || s === "wild");
      const n = perReel.length;
      if (n >= 3 && sym.pay[n]) {
        let ways = 1;
        for (const cells of perReel) ways *= cells.length;
        const units = sym.pay[n] * ways;
        totalUnits += units;
        for (const cells of perReel) for (const [c, r] of cells) winCells.set(`${c},${r}`, true);
        wins.push({ symbol: sym.id, reels: n, ways, units });
      }
    }

    let scatterCount = 0;
    const scatterCells = [];
    for (let c = 0; c < grid.length; c++)
      for (let r = 0; r < grid[c].length; r++)
        if (grid[c][r] === "scatter") { scatterCount++; scatterCells.push([c, r]); }

    const totalBase = totalUnits > 0 ? Math.max(1, Math.round((totalUnits * bet) / CONFIG.WAYS_DIV)) : 0;
    return { wins, totalUnits, totalBase, winCells: [...winCells.keys()], scatterCount, scatterCells };
  }

  function collapseGrid(grid, winCellKeys) {
    const remove = new Set(winCellKeys);
    const { rows } = CONFIG.GRID;
    const newGrid = [];
    const moves = []; // {col, symbol, fromRow|null, toRow, fall}
    for (let c = 0; c < grid.length; c++) {
      const kept = [];
      for (let r = rows - 1; r >= 0; r--) if (!remove.has(`${c},${r}`)) kept.push({ sym: grid[c][r], fromRow: r });
      kept.reverse(); // top..bottom order of survivors
      const col = new Array(rows).fill(null);
      const missing = rows - kept.length;
      // survivors fall to the bottom
      kept.forEach((k, i) => {
        const toRow = missing + i;
        col[toRow] = k.sym;
        moves.push({ col: c, symbol: k.sym, fromRow: k.fromRow, toRow, fall: toRow - k.fromRow, spawned: false });
      });
      // new symbols spawn from above
      for (let i = 0; i < missing; i++) {
        const sym = RNG.pickWeighted(SYMBOLS);
        col[i] = sym;
        moves.push({ col: c, symbol: sym, fromRow: null, toRow: i, fall: missing, spawned: true });
      }
      newGrid.push(col);
    }
    return { grid: newGrid, moves };
  }

  /* Precomputes the full outcome of one spin: every cascade step, its
     multiplier and amount — before any animation. */
  function generateOutcome(bet, ctx = {}) {
    const source = RNG.info();
    const steps = [];
    let grid = generateGrid();
    let scatter = null;
    let fsMult = ctx.freeSpin ? (ctx.fsMult || CONFIG.FS_MULT_START) : 1;
    const ascensionUsed = !!ctx.ascensionArmed;
    const globalMult = ascensionUsed ? CONFIG.ASCENSION_MULT : 1;

    for (let i = 0; i < CONFIG.MAX_CASCADE_STEPS; i++) {
      const ev = evaluateGrid(grid, bet);
      if (i === 0 && ev.scatterCount >= 3) {
        const n = Math.min(5, ev.scatterCount);
        scatter = {
          count: ev.scatterCount,
          spins: CONFIG.FREE_SPINS[n],
          pay: Math.round(bet * CONFIG.SCATTER_PAY[n]),
          cells: ev.scatterCells,
        };
      }
      const hasWin = ev.totalBase > 0;
      const stepMult = ctx.freeSpin ? fsMult : CONFIG.MULT_LADDER[Math.min(i, CONFIG.MULT_LADDER.length - 1)];
      const mult = stepMult * globalMult;
      const step = {
        grid, eval: ev, mult,
        amount: hasWin ? ev.totalBase * mult : 0,
        collapse: null,
      };
      steps.push(step);
      if (!hasWin) break;
      if (i === CONFIG.MAX_CASCADE_STEPS - 1) break;
      const collapsed = collapseGrid(grid, ev.winCells);
      step.collapse = collapsed;
      grid = collapsed.grid;
      if (ctx.freeSpin) fsMult = Math.min(CONFIG.FS_MULT_CAP, fsMult + 1);
    }

    const cascadeWins = steps.reduce((a, s) => a + (s.amount > 0 ? 1 : 0), 0);
    const totalWin = steps.reduce((a, s) => a + s.amount, 0) + (scatter ? scatter.pay : 0);
    return { steps, scatter, totalWin, ascensionUsed, fsMultEnd: fsMult, cascadeWins, source, bet };
  }

  return {
    generateGrid, evaluateGrid, collapseGrid, generateOutcome,
    setDebugForce(f) { debugForce = f; },
  };
})();

/* Thin aliases for architectural clarity (delegating to SlotMath). */
const WinEvaluator = { evaluate: (grid, bet) => SlotMath.evaluateGrid(grid, bet) };
const CascadeEngine = { collapse: (grid, keys) => SlotMath.collapseGrid(grid, keys) };

/* ========================================================================== *
 * MODULE: MultiplierEngine
 * ========================================================================== */
const MultiplierEngine = {
  baseLadder: CONFIG.MULT_LADDER,
  forStep(index, ctx = {}) {
    if (ctx.freeSpin) return ctx.fsMult || CONFIG.FS_MULT_START;
    return this.baseLadder[Math.min(index, this.baseLadder.length - 1)];
  },
};

/* ========================================================================== *
 * MODULE: BonusEngine (free spins)
 * ========================================================================== */
const BonusEngine = (() => {
  const state = { active: false, remaining: 0, total: 0, mult: CONFIG.FS_MULT_START, totalWon: 0 };
  return {
    state,
    isActive: () => state.active,
    async start(scatter) {
      state.active = true;
      state.remaining = scatter.spins;
      state.total = scatter.spins;
      state.mult = CONFIG.FS_MULT_START;
      state.totalWon = 0;
      FSM.set("BONUS", "bonus start");
      EventBus.emit(EVENTS.BONUS_STARTED, { spins: scatter.spins, scatterPay: scatter.pay });
      SoundManager.play("bonus");
      await UIManager.showBonusGrant(scatter);
      while (state.remaining > 0) {
        if (!state.active) break; // external stop (exit)
        state.remaining--;
        UIManager.updateStatus();
        const res = await SpinEngine.spin({ free: true });
        if (res && res.totalWin > 0) state.totalWon += res.totalWin;
        state.mult = res && res.fsMultEnd ? Math.max(state.mult, res.fsMultEnd) : state.mult;
        UIManager.updateStatus();
        if (state.remaining > 0) await Utils.wait(SpinEngine.spinGap());
      }
      state.active = false;
      const won = state.totalWon;
      EventBus.emit(EVENTS.BONUS_FINISHED, { totalWon: won });
      SoundManager.play("bonusEnd");
      await UIManager.showBonusSummary(won);
      SpinEngine.afterSpin();
      return won;
    },
    abort() { state.active = false; state.remaining = 0; },
    reset() { state.active = false; state.remaining = 0; state.total = 0; state.mult = CONFIG.FS_MULT_START; state.totalWon = 0; },
  };
})();

/* ========================================================================== *
 * MODULE: ReelEngine — per-column view model consumed by the Renderer.
 * ========================================================================== */
const ReelEngine = (() => {
  const { reels, rows } = CONFIG.GRID;
  const view = [];
  for (let c = 0; c < reels; c++) {
    view.push({
      mode: "idle", // idle | spin
      spinSpeed: 0, // cells per second
      spinOffset: 0,
      spinSymbols: [],
      cells: [], // {sym, row, off, scale, alpha, glow}
    });
  }
  function initStrips() {
    for (const col of view) {
      col.spinSymbols = [];
      for (let i = 0; i < 24; i++) col.spinSymbols.push(RNG.pickWeighted(SYMBOLS));
    }
  }
  function setGrid(grid) {
    for (let c = 0; c < reels; c++) {
      view[c].mode = "idle";
      view[c].spinSpeed = 0;
      view[c].cells = grid[c].map((sym, r) => ({ sym, row: r, off: 0, scale: 1, alpha: 1, glow: 0 }));
    }
  }
  function cellAt(c, r) { return view[c].cells[r]; }
  function integrate(dt) {
    for (const col of view) {
      if (col.mode === "spin") col.spinOffset = (col.spinOffset + col.spinSpeed * dt) % 24;
    }
  }
  return { view, initStrips, setGrid, cellAt, integrate, rows, reels };
})();

/* ========================================================================== *
 * MODULE: ParticleEngine — pooled particles.
 * ========================================================================== */
const ParticleEngine = (() => {
  const pool = [];
  let cap = 320;
  function spawn(p) {
    if (pool.length >= cap) pool.shift();
    pool.push(p);
  }
  return {
    get list() { return pool; },
    setCap(n) { cap = n; while (pool.length > cap) pool.shift(); },
    clear() { pool.length = 0; },
    burst(x, y, color, n = 14, opts = {}) {
      for (let i = 0; i < n; i++) {
        const a = RNG.float() * Math.PI * 2;
        const sp = (opts.speed || 120) * (0.35 + RNG.float());
        spawn({
          type: opts.type || "spark", x, y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (opts.lift || 40),
          life: 0, maxLife: (opts.life || 0.7) * (0.6 + RNG.float() * 0.8),
          size: (opts.size || 3) * (0.6 + RNG.float()),
          color, rot: RNG.float() * Math.PI * 2, vr: (RNG.float() - 0.5) * 8,
          grav: opts.grav != null ? opts.grav : 260,
        });
      }
    },
    shards(x, y, color, n = 10) {
      this.burst(x, y, color, n, { type: "shard", speed: 170, life: 0.8, size: 4, grav: 420 });
    },
    stardust(x, y, color, n = 8) {
      this.burst(x, y, color, n, { type: "dust", speed: 40, life: 1.4, size: 2.2, grav: -18 });
    },
    coinFlight(x0, y0, x1, y1, color, n = 8) {
      for (let i = 0; i < n; i++) {
        const t = i / n;
        spawn({
          type: "coin", x: x0 + (RNG.float() - 0.5) * 26, y: y0 + (RNG.float() - 0.5) * 18,
          tx: x1, ty: y1, life: -t * 0.28, maxLife: 0.62, size: 3.4, color,
          vx: 0, vy: 0, grav: 0, rot: 0, vr: 0,
        });
      }
    },
    update(dt) {
      for (let i = pool.length - 1; i >= 0; i--) {
        const p = pool[i];
        p.life += dt;
        if (p.life >= p.maxLife) { pool.splice(i, 1); continue; }
        if (p.type === "coin") {
          if (p.life < 0) continue;
          const t = Utils.clamp(p.life / p.maxLife, 0, 1);
          const e = 1 - Math.pow(1 - t, 3);
          p.x = Utils.lerp(p.x, p.tx, e * 0.22 + 0.05);
          p.y = Utils.lerp(p.y, p.ty, e * 0.22 + 0.05);
        } else {
          p.vy += (p.grav || 0) * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.rot += (p.vr || 0) * dt;
        }
      }
    },
    draw(ctx) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const p of this.list) {
        if (p.life < 0) continue;
        const t = p.life / p.maxLife;
        const a = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
        ctx.globalAlpha = Utils.clamp(a, 0, 1) * 0.9;
        if (p.type === "shard") {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          ctx.restore();
        } else if (p.type === "coin") {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.beginPath();
          ctx.arc(p.x - p.size * 0.25, p.y - p.size * 0.25, p.size * 0.35, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (p.type === "dust" ? 1 + t : 1 - t * 0.5), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    },
  };
})();

/* ========================================================================== *
 * MODULE: AmbientFX — parallax starfield, nebula, planets, meteors.
 * ========================================================================== */
const AmbientFX = (() => {
  const layers = [[], [], []];
  const meteors = [];
  let nebula = null;
  let W = 0, H = 0;
  let meteorTimer = 3;
  let t = 0;
  const pointer = { x: 0.5, y: 0.5 };
  const QUALITY = { starScale: 1, meteors: true, nebula: true };

  function build(w, h) {
    W = w; H = h;
    const density = [0.00011, 0.00007, 0.00004];
    const sizes = [0.9, 1.4, 2.1];
    for (let l = 0; l < 3; l++) {
      layers[l] = [];
      const n = Math.round(w * h * density[l] * QUALITY.starScale);
      for (let i = 0; i < n; i++) {
        layers[l].push({
          x: RNG.float() * w, y: RNG.float() * h, r: sizes[l] * (0.6 + RNG.float() * 0.8),
          tw: 0.5 + RNG.float() * 2.2, ph: RNG.float() * Math.PI * 2,
          hue: RNG.float() < 0.16 ? "#ffe9ad" : RNG.float() < 0.4 ? "#9fd8ff" : "#e8ecff",
        });
      }
    }
    renderNebula();
  }
  function renderNebula() {
    nebula = document.createElement("canvas");
    nebula.width = Math.max(2, Math.round(W / 2));
    nebula.height = Math.max(2, Math.round(H / 2));
    const c = nebula.getContext("2d");
    const blobs = [
      { x: 0.28, y: 0.3, r: 0.55, color: "rgba(28,44,110,0.5)" },
      { x: 0.75, y: 0.22, r: 0.42, color: "rgba(13,79,94,0.36)" },
      { x: 0.62, y: 0.8, r: 0.5, color: "rgba(64,26,84,0.34)" },
      { x: 0.15, y: 0.85, r: 0.4, color: "rgba(94,43,22,0.2)" },
    ];
    for (const b of blobs) {
      const g = c.createRadialGradient(b.x * nebula.width, b.y * nebula.height, 0, b.x * nebula.width, b.y * nebula.height, b.r * nebula.width);
      g.addColorStop(0, b.color);
      g.addColorStop(1, "rgba(4,6,26,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, nebula.width, nebula.height);
    }
  }
  function setPointer(nx, ny) { pointer.x = nx; pointer.y = ny; }
  function update(dt, paused) {
    if (paused) return;
    t += dt;
    if (QUALITY.meteors) {
      meteorTimer -= dt;
      if (meteorTimer <= 0) {
        meteorTimer = 4 + RNG.float() * 7;
        const fromLeft = RNG.float() < 0.5;
        meteors.push({
          x: fromLeft ? -40 : W * (0.4 + RNG.float() * 0.7),
          y: -30,
          vx: (fromLeft ? 1 : -1) * (260 + RNG.float() * 220),
          vy: 300 + RNG.float() * 200,
          life: 0, maxLife: 1.15,
        });
      }
    }
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      m.life += dt;
      m.x += m.vx * dt; m.y += m.vy * dt;
      if (m.life > m.maxLife || m.y > H + 60) meteors.splice(i, 1);
    }
  }
  function draw(ctx) {
    // nebula
    if (nebula && QUALITY.nebula) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.drawImage(nebula, 0, 0, W, H);
      ctx.restore();
    }
    // stars (3 parallax layers + twinkle)
    const px = (pointer.x - 0.5), py = (pointer.y - 0.5);
    const depths = [5, 11, 20];
    for (let l = 0; l < 3; l++) {
      const drift = t * (1.2 + l * 1.4);
      for (const s of layers[l]) {
        const x = (((s.x - px * depths[l] - drift) % W) + W) % W;
        const y = (((s.y - py * depths[l] * 0.5 + drift * 0.35) % H) + H) % H;
        const tw = 0.55 + 0.45 * Math.sin(t * s.tw + s.ph);
        ctx.globalAlpha = (0.28 + l * 0.2) * tw;
        ctx.fillStyle = s.hue;
        ctx.beginPath();
        ctx.arc(x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // planets
    drawPlanet(ctx, W * 0.12, H * 0.78 + Math.sin(t * 0.4) * 5, Math.min(W, H) * 0.11);
    drawMoon(ctx, W * 0.88, H * 0.16 + Math.sin(t * 0.3 + 2) * 4, Math.min(W, H) * 0.035);

    // meteors
    for (const m of meteors) {
      const a = 1 - m.life / m.maxLife;
      const len = 90;
      const nx = m.x - (m.vx / Math.hypot(m.vx, m.vy)) * len;
      const ny = m.y - (m.vy / Math.hypot(m.vx, m.vy)) * len;
      const g = ctx.createLinearGradient(m.x, m.y, nx, ny);
      g.addColorStop(0, `rgba(255,240,200,${0.85 * a})`);
      g.addColorStop(0.35, `rgba(111,227,255,${0.4 * a})`);
      g.addColorStop(1, "rgba(111,227,255,0)");
      ctx.strokeStyle = g;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
    }
  }
  function drawPlanet(ctx, x, y, r) {
    ctx.save();
    const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, "#3d5aa8");
    g.addColorStop(0.55, "#1c2c66");
    g.addColorStop(1, "#0a102f");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    // bands
    ctx.strokeStyle = "rgba(111,227,255,0.14)";
    ctx.lineWidth = r * 0.09;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.ellipse(x, y + i * r * 0.28, r * Math.sqrt(Math.max(0.05, 1 - (i * 0.28) ** 2)), r * 0.16, -0.18, 0.3, Math.PI - 0.3);
      ctx.stroke();
    }
    // ring
    ctx.strokeStyle = "rgba(242,200,109,0.32)";
    ctx.lineWidth = r * 0.07;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.65, r * 0.42, -0.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  function drawMoon(ctx, x, y, r) {
    ctx.save();
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, "#f4e7c8");
    g.addColorStop(0.7, "#b9a878");
    g.addColorStop(1, "#5c5138");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(60,50,30,0.35)";
    ctx.beginPath(); ctx.arc(x + r * 0.25, y - r * 0.15, r * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x - r * 0.2, y + r * 0.3, r * 0.14, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  return { build, update, draw, setPointer, QUALITY, get t() { return t; } };
})();

/* ========================================================================== *
 * MODULE: ConstellationEngine — ambient + win-triggered constellation art.
 * ========================================================================== */
const ConstellationEngine = (() => {
  const flashes = []; // {id, alpha, x, y, size}
  const ambient = [];
  let W = 0, H = 0;
  function build(w, h) {
    W = w; H = h;
    ambient.length = 0;
    const keys = Object.keys(CONSTELLATIONS);
    const n = 3;
    for (let i = 0; i < n; i++) {
      ambient.push({
        id: keys[(i * 4 + 1) % keys.length],
        x: w * (0.12 + 0.33 * i) + (RNG.float() - 0.5) * 60,
        y: h * (0.16 + (i % 2) * 0.5) + (RNG.float() - 0.5) * 40,
        size: Math.min(w, h) * (0.16 + RNG.float() * 0.08),
        ph: RNG.float() * Math.PI * 2,
      });
    }
  }
  function flash(id, x, y, size) {
    if (!CONSTELLATIONS[id]) return;
    flashes.push({ id, x, y, size, alpha: 0, phase: 0 });
    const f = flashes[flashes.length - 1];
    Utils.tween(f, { alpha: 1, duration: 0.25, ease: "power2.out" }).then(() =>
      Utils.tween(f, { alpha: 0, duration: 1.4, delay: 0.9, ease: "power1.inOut" })
    );
  }
  function drawMap(ctx, id, x, y, size, alpha, color) {
    const map = CONSTELLATIONS[id];
    if (!map || alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [a, b] of map.lines) {
      ctx.moveTo(x + map.pts[a][0] * size, y + map.pts[a][1] * size);
      ctx.lineTo(x + map.pts[b][0] * size, y + map.pts[b][1] * size);
    }
    ctx.stroke();
    for (const [px, py] of map.pts) {
      const sx = x + px * size, sy = y + py * size;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(sx, sy, 2.1, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = alpha * 0.35;
      ctx.beginPath(); ctx.arc(sx, sy, 4.6, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = alpha;
    }
    ctx.restore();
  }
  function draw(ctx, t) {
    for (const a of ambient) {
      const tw = 0.06 + 0.04 * Math.sin(t * 0.6 + a.ph);
      drawMap(ctx, a.id, a.x, a.y, a.size, tw, "#8fa7ff");
    }
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      drawMap(ctx, f.id, f.x, f.y, f.size, f.alpha * 0.95, "#ffe9ad");
      if (f.alpha <= 0.01 && f.phase > 0.3) flashes.splice(i, 1);
      f.phase += 0.016;
    }
  }
  return { build, flash, draw };
})();

/* ========================================================================== *
 * MODULE: Renderer — canvas compositing of all layers.
 * ========================================================================== */
const Renderer = (() => {
  let canvas, ctx;
  let W = 0, H = 0, dpr = 1;
  const layout = { ox: 0, oy: 0, cell: 80, gridW: 0, gridH: 0, frameX: 0, frameY: 0, frameW: 0, frameH: 0 };
  let shake = 0;
  const qual = { glow: true, blur: true };

  function init(c) {
    canvas = c;
    ctx = c.getContext("2d");
  }
  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    W = Math.max(320, rect.width);
    H = Math.max(320, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, PerformanceManager.get().dprCap);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    computeLayout();
    AmbientFX.build(W, H);
    ConstellationEngine.build(W, H);
  }
  function computeLayout() {
    const narrow = W < 760;
    const topPad = narrow ? 58 : 70;
    const bottomPad = narrow ? 170 : 158;
    const availH = H - topPad - bottomPad;
    const railPad = W >= 900 && !narrow ? 46 : 8;
    let cell = Math.min(availH / 3.35, (W - railPad * 2 - 24) / 5.5);
    cell = Utils.clamp(cell, 46, 168);
    layout.cell = cell;
    layout.gridW = cell * 5;
    layout.gridH = cell * 3;
    layout.ox = (W - layout.gridW) / 2 - (W >= 900 ? 14 : 0);
    layout.oy = topPad + Math.max(0, (availH - layout.gridH * 1.12) / 2);
    layout.frameX = layout.ox - cell * 0.22;
    layout.frameY = layout.oy - cell * 0.22;
    layout.frameW = layout.gridW + cell * 0.44;
    layout.frameH = layout.gridH * 1.12 + cell * 0.44;
  }
  function cellCenter(c, r) {
    return { x: layout.ox + c * layout.cell + layout.cell / 2, y: layout.oy + layout.cell * 0.06 + r * layout.cell + layout.cell / 2 };
  }
  function addShake(v) { shake = Math.min(10, shake + v); }
  function frameGeometry() { return { ...layout }; }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawChip(x, y, size, sym) {
    const def = SYMBOL_BY_ID[sym];
    const base = TIER_COLORS[def.element];
    const pad = size * 0.07;
    const s = size - pad * 2;
    roundRect(x + pad, y + pad, s, s, s * 0.18);
    const g = ctx.createRadialGradient(x + size / 2, y + size * 0.36, s * 0.1, x + size / 2, y + size / 2, s * 0.75);
    g.addColorStop(0, Utils.rgba(base, 0.30));
    g.addColorStop(0.6, "rgba(13,19,52,0.92)");
    g.addColorStop(1, "rgba(7,10,32,0.96)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = Utils.rgba(base, 0.4);
    ctx.lineWidth = Math.max(1, size * 0.014);
    ctx.stroke();
  }

  function drawReels(t) {
    const { cell } = layout;
    // frame backdrop
    ctx.save();
    roundRect(layout.frameX, layout.frameY, layout.frameW, layout.frameH, cell * 0.16);
    const bg = ctx.createLinearGradient(0, layout.frameY, 0, layout.frameY + layout.frameH);
    bg.addColorStop(0, "rgba(14,20,56,0.92)");
    bg.addColorStop(0.5, "rgba(8,12,38,0.94)");
    bg.addColorStop(1, "rgba(12,17,48,0.92)");
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = "rgba(242,200,109,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = "rgba(242,200,109,0.14)";
    ctx.lineWidth = 1;
    roundRect(layout.frameX - 5, layout.frameY - 5, layout.frameW + 10, layout.frameH + 10, cell * 0.19);
    ctx.stroke();
    // corner stars
    ctx.fillStyle = "rgba(255,233,173,0.9)";
    for (const [cx, cy] of [
      [layout.frameX, layout.frameY],
      [layout.frameX + layout.frameW, layout.frameY],
      [layout.frameX, layout.frameY + layout.frameH],
      [layout.frameX + layout.frameW, layout.frameY + layout.frameH],
    ]) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      const s = 5;
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.restore();
    }
    ctx.restore();

    // columns
    for (let c = 0; c < ReelEngine.reels; c++) {
      const col = ReelEngine.view[c];
      const x0 = layout.ox + c * cell;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 1, layout.oy - cell * 0.1, cell - 2, layout.gridH + cell * 0.2);
      ctx.clip();

      if (col.mode === "spin") {
        // scrolling strip with motion smear
        const n = col.spinSymbols.length;
        const speedBlur = qual.blur ? Utils.clamp(col.spinSpeed / 20, 0, 1) : 0;
        for (let k = -1; k < 4; k++) {
          const idx = ((Math.floor(col.spinOffset) + k) % n + n) % n;
          const frac = col.spinOffset - Math.floor(col.spinOffset);
          const y = layout.oy + (k - frac) * cell;
          const sym = col.spinSymbols[idx];
          ctx.globalAlpha = 1;
          drawChip(x0, y, cell, sym);
          const gsize = cell * 0.52;
          const color = TIER_COLORS[SYMBOL_BY_ID[sym].element];
          if (speedBlur > 0.25) {
            ctx.globalAlpha = 0.35;
            drawGlyph(ctx, sym, x0 + cell / 2, y + cell / 2 - cell * 0.16 * speedBlur, gsize, color, 0);
            drawGlyph(ctx, sym, x0 + cell / 2, y + cell / 2 + cell * 0.16 * speedBlur, gsize, color, 0);
          }
          ctx.globalAlpha = 0.95;
          drawGlyph(ctx, sym, x0 + cell / 2, y + cell / 2, gsize, color, qual.glow ? 6 : 0);
        }
        ctx.globalAlpha = 1;
        // vertical speed streaks
        ctx.fillStyle = `rgba(111,227,255,${0.05 * speedBlur})`;
        ctx.fillRect(x0 + cell * 0.2, layout.oy, cell * 0.06, layout.gridH);
        ctx.fillRect(x0 + cell * 0.7, layout.oy, cell * 0.05, layout.gridH);
      } else {
        // idle / landed cells
        const bob = col.cells.length ? Math.sin(t * 1.1 + c * 1.3) * 1.6 : 0;
        for (const cl of col.cells) {
          if (!cl) continue;
          const x = x0;
          const y = layout.oy + cl.row * cell + cl.off + bob * 0.25;
          ctx.save();
          ctx.globalAlpha = cl.alpha;
          const cx = x + cell / 2, cy = y + cell / 2;
          ctx.translate(cx, cy);
          ctx.scale(cl.scale, cl.scale);
          ctx.translate(-cx, -cy);
          drawChip(x, y, cell, cl.sym);
          const def = SYMBOL_BY_ID[cl.sym];
          const color = TIER_COLORS[def.element];
          const glow = qual.glow ? 6 + cl.glow * 22 : 0;
          drawGlyph(ctx, cl.sym, cx, cy, cell * 0.52, color, glow);
          if (cl.glow > 0.02) {
            ctx.strokeStyle = Utils.rgba("#ffe9ad", 0.75 * cl.glow);
            ctx.lineWidth = 2.4;
            roundRect(x + cell * 0.09, y + cell * 0.09, cell * 0.82, cell * 0.82, cell * 0.14);
            ctx.stroke();
            ctx.strokeStyle = Utils.rgba(color, 0.5 * cl.glow);
            ctx.lineWidth = 1.2;
            roundRect(x + cell * 0.045, y + cell * 0.045, cell * 0.91, cell * 0.91, cell * 0.16);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
      ctx.restore();

      // column separator
      if (c > 0) {
        ctx.strokeStyle = "rgba(242,200,109,0.1)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, layout.oy + 4);
        ctx.lineTo(x0, layout.oy + layout.gridH - 4);
        ctx.stroke();
      }
    }

    // top/bottom inner shading
    const sh = ctx.createLinearGradient(0, layout.oy, 0, layout.oy + cell * 0.5);
    sh.addColorStop(0, "rgba(4,6,26,0.65)");
    sh.addColorStop(1, "rgba(4,6,26,0)");
    ctx.fillStyle = sh;
    ctx.fillRect(layout.ox, layout.oy, layout.gridW, cell * 0.5);
    const sh2 = ctx.createLinearGradient(0, layout.oy + layout.gridH - cell * 0.5, 0, layout.oy + layout.gridH);
    sh2.addColorStop(0, "rgba(4,6,26,0)");
    sh2.addColorStop(1, "rgba(4,6,26,0.65)");
    ctx.fillStyle = sh2;
    ctx.fillRect(layout.ox, layout.oy + layout.gridH - cell * 0.5, layout.gridW, cell * 0.5);
  }

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // base
    const base = ctx.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, "#05071d");
    base.addColorStop(0.5, "#04061a");
    base.addColorStop(1, "#070a24");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    if (shake > 0.1) {
      ctx.translate((RNG.float() - 0.5) * shake, (RNG.float() - 0.5) * shake);
      shake *= 0.86;
    }
    AmbientFX.draw(ctx);
    ConstellationEngine.draw(ctx, t);
    drawReels(t);
    ParticleEngine.draw(ctx);
    ctx.restore();

    // vignette
    const v = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.35, W / 2, H * 0.5, Math.max(W, H) * 0.78);
    v.addColorStop(0, "rgba(4,6,26,0)");
    v.addColorStop(1, "rgba(2,3,14,0.6)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  return {
    init, resize, draw, cellCenter, addShake, frameGeometry,
    get W() { return W; }, get H() { return H; },
    setQuality(q) { qual.glow = q.glow; qual.blur = q.blur; },
  };
})();

/* ========================================================================== *
 * MODULE: PerformanceManager
 * ========================================================================== */
const PerformanceManager = (() => {
  const PRESETS = {
    HIGH: { particleCap: 420, starScale: 1, dprCap: 2, glow: true, blur: true, meteors: true, nebula: true },
    MEDIUM: { particleCap: 230, starScale: 0.7, dprCap: 1.5, glow: true, blur: true, meteors: true, nebula: true },
    LOW: { particleCap: 110, starScale: 0.45, dprCap: 1, glow: false, blur: false, meteors: false, nebula: true },
  };
  let current = { name: "AUTO", ...PRESETS.HIGH };
  let fps = 60, acc = 0, frames = 0, autoTimer = 0;
  let autoFloor = "LOW";

  function detectBaseline() {
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    const mobile = /Mobi|Android/i.test(navigator.userAgent);
    if (mobile || cores <= 3 || mem <= 3) return "MEDIUM";
    return "HIGH";
  }
  function apply(name) {
    if (name === "AUTO") {
      current = { name, ...PRESETS[detectBaseline()] };
    } else if (PRESETS[name]) {
      current = { name, ...PRESETS[name] };
      autoFloor = name;
    }
    ParticleEngine.setCap(current.particleCap);
    AmbientFX.QUALITY.starScale = current.starScale;
    AmbientFX.QUALITY.meteors = current.meteors;
    AmbientFX.QUALITY.nebula = current.nebula;
    Renderer.setQuality(current);
    if (GameEngine.ready) Renderer.resize();
    return current;
  }
  return {
    apply,
    get: () => current,
    tick(dt) {
      frames++; acc += dt;
      if (acc >= 0.5) { fps = Math.round(frames / acc); frames = 0; acc = 0; }
      if (current.name === "AUTO") {
        autoTimer += dt;
        if (autoTimer > 2.5) {
          autoTimer = 0;
          if (fps < 42 && current.particleCap > PRESETS.LOW.particleCap) {
            const order = ["HIGH", "MEDIUM", "LOW"];
            const idx = order.findIndex((k) => PRESETS[k].particleCap === current.particleCap);
            const next = order[Math.min(2, idx + 1)];
            current = { name: "AUTO", ...PRESETS[next] };
            ParticleEngine.setCap(current.particleCap);
            AmbientFX.QUALITY.starScale = current.starScale;
            AmbientFX.QUALITY.meteors = current.meteors;
          }
        }
      }
    },
    fps: () => fps,
    presetNames: () => ["AUTO", "HIGH", "MEDIUM", "LOW"],
  };
})();

/* ========================================================================== *
 * MODULE: SoundManager — 100% procedural WebAudio (no binary assets).
 * ========================================================================== */
const SoundManager = (() => {
  let ctx = null, master = null, sfx = null, music = null;
  let ambientNodes = null;
  let lastCoin = 0;

  function ensure() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume(); return ctx; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      sfx = ctx.createGain();
      music = ctx.createGain();
      sfx.connect(master); music.connect(master); master.connect(ctx.destination);
      applyVolumes();
    } catch (e) { console.warn("[Sound] WebAudio unavailable", e); }
    return ctx;
  }
  function applyVolumes() {
    if (!ctx) return;
    const s = SettingsManager.all();
    master.gain.value = s.muted ? 0 : s.masterVol;
    sfx.gain.value = s.sfxVol;
    music.gain.value = s.musicVol * 0.5;
  }
  function tone(freq, dur, { type = "sine", gain = 0.2, slide = null, delayT = 0 } = {}) {
    if (!ensure()) return;
    const t0 = ctx.currentTime + delayT;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(sfx);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function noise(dur, { gain = 0.14, from = 800, to = 2400, delayT = 0 } = {}) {
    if (!ensure()) return;
    const t0 = ctx.currentTime + delayT;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(from, t0);
    f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    f.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(sfx);
    src.start(t0);
  }
  function arpeggio(freqs, step = 0.09, opts = {}) {
    freqs.forEach((f, i) => tone(f, 0.22, { ...opts, delayT: i * step }));
  }

  const LIB = {
    ui: () => tone(760, 0.07, { type: "square", gain: 0.06 }),
    denied: () => tone(140, 0.16, { type: "square", gain: 0.09, slide: 90 }),
    spinStart: () => { noise(0.5, { gain: 0.1, from: 300, to: 1900 }); tone(180, 0.3, { type: "triangle", gain: 0.08, slide: 420 }); },
    reelStop: (i = 0) => { tone(120 - i * 8, 0.11, { type: "sine", gain: 0.22, slide: 55 }); noise(0.06, { gain: 0.05, from: 2200, to: 900 }); },
    win: (size = 1) => {
      if (size >= 3) arpeggio([523, 659, 784, 1046, 1318], 0.08, { type: "triangle", gain: 0.14 });
      else if (size === 2) arpeggio([523, 659, 784], 0.09, { type: "triangle", gain: 0.12 });
      else arpeggio([659, 784], 0.1, { type: "triangle", gain: 0.1 });
    },
    cascade: () => tone(880, 0.3, { type: "sawtooth", gain: 0.05, slide: 260 }),
    multiplier: () => tone(300, 0.24, { type: "triangle", gain: 0.12, slide: 980 }),
    scatter: () => { arpeggio([440, 554, 659, 880], 0.07, { type: "sine", gain: 0.14 }); noise(0.5, { gain: 0.06, from: 1200, to: 4000 }); },
    bonus: () => arpeggio([392, 523, 659, 784, 1046, 1318, 1568], 0.1, { type: "triangle", gain: 0.13 }),
    bonusEnd: () => arpeggio([784, 659, 523], 0.1, { type: "triangle", gain: 0.1 }),
    bigWin: () => { arpeggio([523, 659, 784, 1046, 784, 1046, 1318, 1568], 0.11, { type: "triangle", gain: 0.14 }); noise(1.1, { gain: 0.05, from: 800, to: 5000 }); },
    coin: () => { const now = performance.now(); if (now - lastCoin < 45) return; lastCoin = now; tone(1500 + Math.random() * 300, 0.07, { type: "square", gain: 0.035 }); },
    ascension: () => { tone(200, 0.9, { type: "sawtooth", gain: 0.06, slide: 1600 }); arpeggio([523, 784, 1046, 1568], 0.09, { delayT: 0.5, type: "sine", gain: 0.1 }); },
    gameOver: () => arpeggio([392, 330, 262, 196], 0.16, { type: "triangle", gain: 0.11 }),
    submit: () => arpeggio([659, 880, 1175], 0.08, { type: "sine", gain: 0.1 }),
  };

  function startAmbient() {
    if (!ensure() || ambientNodes) return;
    const g = ctx.createGain(); g.gain.value = 0.16;
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 320;
    const o1 = ctx.createOscillator(); o1.type = "sine"; o1.frequency.value = 55;
    const o2 = ctx.createOscillator(); o2.type = "triangle"; o2.frequency.value = 110.4;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 120;
    lfo.connect(lfoG); lfoG.connect(f.frequency);
    const shimmer = ctx.createOscillator(); shimmer.type = "sine"; shimmer.frequency.value = 1760;
    const shG = ctx.createGain(); shG.gain.value = 0.012;
    const vib = ctx.createOscillator(); vib.frequency.value = 5.2;
    const vibG = ctx.createGain(); vibG.gain.value = 0.008;
    vib.connect(vibG); vibG.connect(shG.gain);
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(music);
    shimmer.connect(shG); shG.connect(music);
    o1.start(); o2.start(); lfo.start(); shimmer.start(); vib.start();
    ambientNodes = { o1, o2, lfo, shimmer, vib, g };
  }
  function stopAmbient() {
    if (!ambientNodes) return;
    try {
      ambientNodes.o1.stop(); ambientNodes.o2.stop(); ambientNodes.lfo.stop();
      ambientNodes.shimmer.stop(); ambientNodes.vib.stop();
    } catch { /* noop */ }
    ambientNodes = null;
  }

  return {
    ensure,
    play(name, arg) { if (LIB[name]) LIB[name](arg); },
    applyVolumes, startAmbient, stopAmbient,
    unlock() { ensure(); if (SettingsManager.get("musicVol") > 0 && !SettingsManager.get("muted")) startAmbient(); },
  };
})();

/* ========================================================================== *
 * MODULE: LeaderboardService — Supabase-ready, offline-first.
 * Reads Top 50, submits scores with an idempotency key. Never deletes.
 * ========================================================================== */
const LeaderboardService = (() => {
  let client = null;
  let mode = "local"; // 'online' | 'local'
  let cacheRows = null;

  function seedLocalBoard() {
    const saved = StorageService.read("board.local", null);
    if (saved && Array.isArray(saved) && saved.length) return saved;
    const bases = ["ASTRAEA", "ORION", "VEGA", "LYRA", "RIGEL", "SIRIUS", "ATLAS", "NOVA", "CASTOR", "POLLUX", "THUBAN", "MIRA", "ALTAIR", "DENEB", "SPICA", "REGULUS"];
    const suffix = ["", " VII", "-X", " PRIME", " II", " ZERO", "-9", " ARC"];
    let s = 42;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const rows = [];
    let score = 5200;
    for (let i = 0; i < CONFIG.LEADERBOARD_SIZE; i++) {
      score = Math.max(120, Math.round(score * (0.86 + rnd() * 0.1)));
      rows.push({
        id: `seed-${i}`,
        player_name: bases[i % bases.length] + suffix[Math.floor(rnd() * suffix.length)],
        score,
        created_at: new Date(Date.now() - rnd() * 30 * 864e5).toISOString(),
        game_version: CONFIG.VERSION,
      });
    }
    rows.sort((a, b) => b.score - a.score);
    StorageService.write("board.local", rows);
    return rows;
  }
  function localBoard() {
    const rows = StorageService.read("board.local", null) || seedLocalBoard();
    rows.sort((a, b) => b.score - a.score);
    return rows.slice(0, CONFIG.LEADERBOARD_SIZE);
  }
  function saveLocalBoard(rows) { StorageService.write("board.local", rows); }
  function submittedIds() { return StorageService.read("board.submitted", []); }

  async function init() {
    const rt = (window.ZODIAC_SUPABASE) || {};
    const url = CONFIG.SUPABASE_URL || rt.url || "";
    const key = CONFIG.SUPABASE_ANON_KEY || rt.anonKey || "";
    if (url && key) {
      try {
        const { createClient } = await import("@supabase/supabase-js");
        client = createClient(url, key);
        mode = "online";
      } catch (e) {
        console.warn("[Leaderboard] supabase init failed, falling back to local board", e);
        client = null; mode = "local";
      }
    } else {
      mode = "local";
      seedLocalBoard();
    }
    cacheRows = localBoard();
    return mode;
  }

  async function fetchTop50() {
    if (mode === "online" && client) {
      try {
        const { data, error } = await client
          .from(CONFIG.SUPABASE_TABLE)
          .select("id, player_name, score, created_at, game_version")
          .order("score", { ascending: false })
          .limit(CONFIG.LEADERBOARD_SIZE);
        if (error) throw error;
        if (data && data.length) {
          cacheRows = data;
          StorageService.write("board.cache", data); // offline cache
          return { rows: data, source: "online" };
        }
      } catch (e) {
        console.warn("[Leaderboard] fetch failed, using cache", e);
      }
      const cached = StorageService.read("board.cache", null);
      if (cached && cached.length) return { rows: cached, source: "cache" };
    }
    return { rows: localBoard(), source: mode === "online" ? "cache" : "local" };
  }

  function qualifies(score) {
    if (!score || score <= 0) return false;
    const rows = cacheRows || localBoard();
    if (rows.length < CONFIG.LEADERBOARD_SIZE) return true;
    return score > rows[rows.length - 1].score;
  }
  function rankOf(score) {
    const rows = cacheRows || localBoard();
    for (let i = 0; i < rows.length; i++) if (score > rows[i].score) return i + 1;
    return Math.min(rows.length + 1, CONFIG.LEADERBOARD_SIZE);
  }

  async function submitScore({ playerName, score, submissionId }) {
    const ids = submittedIds();
    if (ids.includes(submissionId)) return { ok: false, reason: "duplicate", rank: rankOf(score) };
    const entry = {
      player_name: String(playerName || "ANON").slice(0, 16).toUpperCase(),
      score: Math.max(0, Math.round(score)),
      game_version: CONFIG.VERSION,
    };
    let onlineOk = false;
    if (mode === "online" && client) {
      try {
        if (CONFIG.SUPABASE_EDGE_FUNCTION) {
          const res = await fetch(CONFIG.SUPABASE_EDGE_FUNCTION, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: CONFIG.SUPABASE_ANON_KEY },
            body: JSON.stringify({ ...entry, submission_id: submissionId }),
          });
          onlineOk = res.ok;
        } else {
          const { error } = await client.from(CONFIG.SUPABASE_TABLE).insert(entry);
          onlineOk = !error;
        }
      } catch (e) { console.warn("[Leaderboard] submit failed, queued locally", e); }
    }
    // local merge always happens so the board reacts instantly (offline-first)
    const rows = localBoard();
    rows.push({ id: `local-${submissionId}`, ...entry, created_at: new Date().toISOString() });
    rows.sort((a, b) => b.score - a.score);
    saveLocalBoard(rows.slice(0, CONFIG.LEADERBOARD_SIZE));
    cacheRows = rows.slice(0, CONFIG.LEADERBOARD_SIZE);
    ids.push(submissionId);
    StorageService.write("board.submitted", ids.slice(-200));
    if (mode === "online" && !onlineOk) {
      const q = StorageService.read("board.pending", []);
      q.push({ ...entry, submission_id: submissionId, at: Date.now() });
      StorageService.write("board.pending", q.slice(-50));
    }
    EventBus.emit(EVENTS.LEADERBOARD_SUBMITTED, { ok: true, online: onlineOk, rank: rankOf(score) });
    return { ok: true, online: onlineOk, rank: rankOf(score) };
  }

  return { init, fetchTop50, submitScore, qualifies, rankOf, getMode: () => mode };
})();

/* ========================================================================== *
 * MODULE: UIManager — HUD, overlays, banners (DOM layer above the canvas).
 * ========================================================================== */
const UIManager = (() => {
  let root = null;
  const el = {};
  let gameStarted = false;
  let ascensionNodes = [];
  let autoPopOpen = false;

  const STAR_SVG = `<svg viewBox="0 0 24 24"><path d="M12 2 L14.4 9.6 L22 12 L14.4 14.4 L12 22 L9.6 14.4 L2 12 L9.6 9.6 Z" fill="currentColor"/></svg>`;

  function logoSVG() {
    return `<svg width="34" height="34" viewBox="0 0 34 34">
      <circle cx="17" cy="17" r="15" fill="none" stroke="#f2c86d" stroke-width="1.4" opacity="0.7"/>
      <circle cx="17" cy="17" r="10.5" fill="none" stroke="#6fe3ff" stroke-width="0.8" opacity="0.55"/>
      <path d="M17 5 L19.2 13.4 L27.5 17 L19.2 20.6 L17 29 L14.8 20.6 L6.5 17 L14.8 13.4 Z" fill="#ffe9ad"/>
      <circle cx="27" cy="8" r="1.6" fill="#6fe3ff"/><circle cx="7" cy="25" r="1.3" fill="#ff7ad9"/>
    </svg>`;
  }
  function zodiacRingSVG() {
    const ids = ["aries", "taurus", "gemini", "cancer", "leo", "virgo", "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces"];
    let inner = `<circle cx="90" cy="90" r="86" fill="none" stroke="rgba(242,200,109,0.35)" stroke-width="1"/>`;
    inner += `<circle cx="90" cy="90" r="62" fill="none" stroke="rgba(111,227,255,0.25)" stroke-width="0.8" stroke-dasharray="3 6"/>`;
    ids.forEach((id, i) => {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const x = 90 + Math.cos(a) * 74, y = 90 + Math.sin(a) * 74;
      const c = TIER_COLORS[SYMBOL_BY_ID[id].element];
      inner += `<g transform="translate(${x - 9},${y - 9}) scale(0.75)">${Glyphs[id].map((p) => p.d ? `<path d="${p.d}" ${p.fill ? `fill="${c}"` : `fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"`}/>` : `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="none" stroke="${c}" stroke-width="2"/>`).join("")}</g>`;
      inner += `<circle cx="${90 + Math.cos(a) * 86}" cy="${90 + Math.sin(a) * 86}" r="1.6" fill="#ffe9ad"/>`;
    });
    inner += `<path d="M90 66 L95 85 L114 90 L95 95 L90 114 L85 95 L66 90 L85 85 Z" fill="#ffe9ad" opacity="0.9"/>`;
    return `<svg class="za-menu-zodiac" width="180" height="180" viewBox="0 0 180 180">${inner}</svg>`;
  }

  function build(container) {
    root = container;
    container.classList.add("za-root");
    container.innerHTML = `
      <canvas id="za-stage"></canvas>

      <div class="za-hud-top">
        <div class="za-logo">
          ${logoSVG()}
          <div>
            <div class="za-logo-name">ZODIAC ASCENSION</div>
            <span class="za-logo-sub">COSMIC SLOT ENGINE</span>
          </div>
        </div>
        <div class="za-chips">
          <div class="za-chip is-gold"><div class="za-chip-label">Balance</div><div class="za-chip-value" id="za-balance">100</div></div>
          <div class="za-chip is-astral"><div class="za-chip-label">Score</div><div class="za-chip-value" id="za-score">0</div></div>
          <div class="za-chip is-mint"><div class="za-chip-label">Last Win</div><div class="za-chip-value" id="za-lastwin">0</div></div>
        </div>
        <div class="za-topbtns">
          <button class="za-iconbtn" id="za-sound" title="Sonido">${iconSound()}</button>
          <button class="za-iconbtn" id="za-boardbtn" title="Ranking">${iconTrophy()}</button>
          <button class="za-iconbtn" id="za-pausebtn" title="Pausa / Menú">${iconPause()}</button>
        </div>
      </div>

      <div class="za-ascension" id="za-ascension">
        <span class="za-asc-title">Ascension</span>
        <div id="za-asc-nodes" style="display:flex;flex-direction:column;gap:7px;align-items:center;"></div>
        <span class="za-asc-count" id="za-asc-count">0/12</span>
      </div>

      <div class="za-console" id="za-console">
        <div class="za-statusline" id="za-status"></div>
        <div class="za-cons-left">
          <div class="za-bet">
            <span class="za-bet-label">Bet</span>
            <button class="za-betbtn" id="za-bet-down">−</button>
            <span class="za-bet-value" id="za-bet">2</span>
            <button class="za-betbtn" id="za-bet-up">+</button>
          </div>
          <button class="za-btn is-small" id="za-paytable">Paytable</button>
          <button class="za-btn is-small is-ghost" id="za-exit">Exit</button>
        </div>
        <div class="za-spinwrap" id="za-spinwrap">
          <svg class="za-spin-ring" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="47" fill="none" stroke="rgba(242,200,109,0.25)" stroke-width="2" stroke-dasharray="4 9"/>
            <circle cx="50" cy="50" r="47" fill="none" stroke="#ffe9ad" stroke-width="2.4" stroke-dasharray="60 236" stroke-linecap="round"/>
          </svg>
          <button class="za-spinbtn" id="za-spin">SPIN</button>
        </div>
        <div class="za-cons-right">
          <div style="position:relative;">
            <button class="za-btn is-small" id="za-auto">Auto</button>
            <div class="za-auto-pop" id="za-autopop">
              <button class="za-btn is-small" data-auto="10">10 Spins</button>
              <button class="za-btn is-small" data-auto="25">25 Spins</button>
              <button class="za-btn is-small" data-auto="50">50 Spins</button>
              <button class="za-btn is-small" data-auto="inf">Until Stop</button>
              <button class="za-btn is-small is-danger" data-auto="stop" style="display:none;">Stop Auto</button>
            </div>
          </div>
          <button class="za-btn is-small" id="za-turbo">Turbo</button>
          <button class="za-btn is-small" id="za-quick">Quick</button>
          <button class="za-iconbtn" id="za-settings" title="Ajustes">${iconGear()}</button>
        </div>
      </div>

      <div class="za-multibadge" id="za-multibadge">x2</div>
      <div class="za-banner" id="za-banner">
        <div class="za-banner-rays"></div>
        <div class="za-banner-title" id="za-banner-title">BIG WIN</div>
        <div class="za-banner-amount" id="za-banner-amount">0</div>
      </div>

      <div class="za-overlay" id="za-ov-boot">
        <div class="za-boot">
          <div class="za-boot-title">ZODIAC ASCENSION</div>
          <div class="za-boot-bar"><i id="za-boot-fill"></i></div>
          <div class="za-boot-lines" id="za-boot-lines">INITIALIZING RNG CORE…</div>
        </div>
      </div>

      <div class="za-overlay" id="za-ov-menu">
        <div class="za-panel" style="text-align:center;">
          <div class="za-menu-hero">
            ${zodiacRingSVG()}
            <h1 class="za-menu-title">ZODIAC<br/>ASCENSION</h1>
            <p class="za-menu-tag">Alinea los doce signos. Encadena cascadas estelares. Asciende al Top 50 cósmico.</p>
          </div>
          <div class="za-menu-btns">
            <button class="za-btn is-primary" id="za-play">Enter the Zodiac</button>
            <button class="za-btn" id="za-menu-board">Rankings · Top 50</button>
            <button class="za-btn" id="za-menu-paytable">Paytable</button>
            <button class="za-btn" id="za-menu-settings">Settings</button>
          </div>
          <div class="za-version">v${CONFIG.VERSION} · ${CONFIG.STAGE}</div>
        </div>
      </div>

      <div class="za-overlay" id="za-ov-pause">
        <div class="za-panel" style="max-width:420px;">
          <div class="za-panel-kicker">System</div>
          <h2 class="za-panel-title">Paused</h2>
          <hr/>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <button class="za-btn is-primary" id="za-resume">Resume</button>
            <button class="za-btn" id="za-pause-settings">Settings</button>
            <button class="za-btn" id="za-pause-board">Rankings</button>
            <button class="za-btn is-danger" id="za-pause-exit">End Session</button>
          </div>
        </div>
      </div>

      <div class="za-overlay" id="za-ov-settings">
        <div class="za-panel">
          <div class="za-panel-kicker">Configuration</div>
          <h2 class="za-panel-title">Settings</h2>
          <hr/>
          <div class="za-setrow">
            <div><div class="za-setname">Graphics Quality</div><div class="za-setdesc">Never affects odds or math — visuals only.</div></div>
            <div class="za-seg" id="za-quality-seg"></div>
          </div>
          <div class="za-setrow">
            <div><div class="za-setname">Master Volume</div></div>
            <input type="range" class="za-range" id="za-vol-master" min="0" max="100"/>
          </div>
          <div class="za-setrow">
            <div><div class="za-setname">SFX Volume</div></div>
            <input type="range" class="za-range" id="za-vol-sfx" min="0" max="100"/>
          </div>
          <div class="za-setrow">
            <div><div class="za-setname">Ambience Volume</div></div>
            <input type="range" class="za-range" id="za-vol-music" min="0" max="100"/>
          </div>
          <div class="za-setrow">
            <div><div class="za-setname">Turbo Spin</div><div class="za-setdesc">~2x reel speed.</div></div>
            <div class="za-toggle" id="za-tg-turbo"><i></i></div>
          </div>
          <div class="za-setrow">
            <div><div class="za-setname">Quick Spin</div><div class="za-setdesc">Near-instant resolution.</div></div>
            <div class="za-toggle" id="za-tg-quick"><i></i></div>
          </div>
          <div class="za-setrow">
            <div><div class="za-setname">Reduced Motion</div><div class="za-setdesc">Less shake and parallax.</div></div>
            <div class="za-toggle" id="za-tg-motion"><i></i></div>
          </div>
          <div class="za-setrow">
            <div><div class="za-setname">Show FPS</div></div>
            <div class="za-toggle" id="za-tg-fps"><i></i></div>
          </div>
          <hr/>
          <div style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap;">
            <button class="za-btn is-ghost is-small" id="za-reset-data">Reset Local Data</button>
            <button class="za-btn is-primary" id="za-settings-close">Close</button>
          </div>
        </div>
      </div>

      <div class="za-overlay" id="za-ov-board">
        <div class="za-panel">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <div>
              <div class="za-panel-kicker">Hall of Stars</div>
              <h2 class="za-panel-title">Top 50 Rankings</h2>
            </div>
            <span class="za-board-mode" id="za-board-mode">LOCAL</span>
          </div>
          <hr/>
          <div id="za-board-body"><div class="za-board-loading">Charting star positions…</div></div>
          <hr/>
          <div style="display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap;">
            <span class="za-note" id="za-board-note"></span>
            <div style="display:flex;gap:10px;">
              <button class="za-btn is-small" id="za-board-refresh">Refresh</button>
              <button class="za-btn is-primary is-small" id="za-board-close">Close</button>
            </div>
          </div>
        </div>
      </div>

      <div class="za-overlay" id="za-ov-paytable">
        <div class="za-panel">
          <div class="za-panel-kicker">Star Charts</div>
          <h2 class="za-panel-title">Paytable</h2>
          <p>243 ways · wins pay left to right on adjacent reels, any position. Cascades chain with rising multipliers (x1 → x10). Fill the Ascension rail to arm a x5 cosmic spin. 3+ Lunar Scatters grant 8 / 12 / 20 free spins with a persistent multiplier.</p>
          <div class="za-pay-grid" id="za-pay-grid"></div>
          <hr/>
          <div style="text-align:right;"><button class="za-btn is-primary is-small" id="za-paytable-close">Close</button></div>
        </div>
      </div>

      <div class="za-overlay" id="za-ov-exit">
        <div class="za-panel" style="max-width:440px;text-align:center;">
          <div class="za-panel-kicker">Exit Request</div>
          <h2 class="za-panel-title">Abandon Ascension?</h2>
          <p>Tu sesión actual se cerrará. Si tu puntuación clasifica, podrás registrarla en el Top 50.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:14px;">
            <button class="za-btn" id="za-exit-cancel">Resume</button>
            <button class="za-btn is-danger" id="za-exit-confirm">End & Record</button>
          </div>
        </div>
      </div>

      <div class="za-overlay" id="za-ov-name">
        <div class="za-panel" style="max-width:440px;">
          <div class="za-panel-kicker">Leaderboard Qualified</div>
          <h2 class="za-panel-title">Enter the Stars</h2>
          <p>Tu puntuación clasifica para el <b id="za-name-rank" style="color:var(--gold-hi);">Top 50</b>. Escribe tu nombre de piloto:</p>
          <input class="za-input" id="za-name-input" maxlength="14" placeholder="ORION-7" autocomplete="off"/>
          <div class="za-note" id="za-name-note" style="margin-top:8px;"></div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
            <button class="za-btn is-ghost" id="za-name-skip">Skip</button>
            <button class="za-btn is-primary" id="za-name-submit">Submit Score</button>
          </div>
        </div>
      </div>

      <div class="za-overlay" id="za-ov-gameover">
        <div class="za-panel" style="max-width:520px;text-align:center;">
          <div class="za-panel-kicker" id="za-go-kicker">Session Complete</div>
          <h2 class="za-panel-title" id="za-go-title">The Stars Align Anew</h2>
          <div class="za-stats">
            <div class="za-stat"><div class="za-stat-label">Score</div><div class="za-stat-value" id="za-go-score">0</div></div>
            <div class="za-stat"><div class="za-stat-label">Spins</div><div class="za-stat-value" id="za-go-spins">0</div></div>
            <div class="za-stat"><div class="za-stat-label">Biggest Win</div><div class="za-stat-value" id="za-go-big">0</div></div>
            <div class="za-stat"><div class="za-stat-label">Max Multiplier</div><div class="za-stat-value" id="za-go-mult">x1</div></div>
            <div class="za-stat"><div class="za-stat-label">Cascades</div><div class="za-stat-value" id="za-go-casc">0</div></div>
            <div class="za-stat"><div class="za-stat-label">Ascensions</div><div class="za-stat-value" id="za-go-asc">0</div></div>
          </div>
          <div class="za-note" id="za-go-note"></div>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap;">
            <button class="za-btn" id="za-go-board" style="display:none;">View Rankings</button>
            <button class="za-btn" id="za-go-name" style="display:none;">Record Score</button>
            <button class="za-btn is-primary" id="za-go-restart">New Ascension · 100 Credits</button>
          </div>
        </div>
      </div>

      <div class="za-debug" id="za-debug"></div>
    `;

    // cache refs
    for (const id of ["stage", "balance", "score", "lastwin", "bet", "spin", "spinwrap", "status", "ascension", "asc-nodes", "asc-count",
      "auto", "autopop", "turbo", "quick", "sound", "banner", "banner-title", "banner-amount", "multibadge", "debug",
      "ov-boot", "ov-menu", "ov-pause", "ov-settings", "ov-board", "ov-paytable", "ov-exit", "ov-name", "ov-gameover",
      "boot-fill", "boot-lines", "board-body", "board-mode", "board-note", "pay-grid", "name-input", "name-note", "name-rank",
      "go-score", "go-spins", "go-big", "go-mult", "go-casc", "go-asc", "go-note", "go-board", "go-name", "go-kicker", "go-title"]) {
      el[id] = container.querySelector(`#za-${id}`);
    }

    buildAscensionNodes();
    buildPaytable();
    buildQualitySeg();
    bind();
    syncFromSettings();
    updateHUD();
    return el.stage;
  }

  function iconSound() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path id="za-snd-waves" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12"/></svg>`; }
  function iconTrophy() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v6a5 5 0 0 1-10 0z"/><path d="M7 6H4a2 2 0 0 0 2 5M17 6h3a2 2 0 0 1-2 5"/></svg>`; }
  function iconPause() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`; }
  function iconGear() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>`; }

  function buildAscensionNodes() {
    const wrap = el["asc-nodes"];
    wrap.innerHTML = "";
    ascensionNodes = [];
    for (let i = 0; i < CONFIG.ASCENSION_CHARGES; i++) {
      const n = document.createElement("span");
      n.className = "za-asc-node";
      n.innerHTML = STAR_SVG;
      wrap.appendChild(n);
      ascensionNodes.push(n);
    }
  }
  function buildPaytable() {
    const grid = el["pay-grid"];
    grid.innerHTML = "";
    for (const s of SYMBOLS) {
      const c = TIER_COLORS[s.element];
      const cell = document.createElement("div");
      cell.className = "za-pay-cell";
      cell.style.color = c;
      const nums = s.pay
        ? `<span class="za-pay-nums">3× ${Utils.fmt(s.pay[3])} · 4× ${Utils.fmt(s.pay[4])} · 5× ${Utils.fmt(s.pay[5])}</span>`
        : `<span class="za-pay-nums">3+ → Free Spins 8/12/20<br/>pay 2×/5×/25× bet</span>`;
      cell.innerHTML = `${glyphSVG(s.id, 40, c)}<span class="za-pay-name" style="color:var(--ink);">${s.name}</span>${nums}`;
      grid.appendChild(cell);
    }
  }
  function buildQualitySeg() {
    const seg = $("quality-seg");
    seg.innerHTML = "";
    for (const p of PerformanceManager.presetNames()) {
      const b = document.createElement("button");
      b.textContent = p;
      b.dataset.q = p;
      b.onclick = () => {
        SoundManager.play("ui");
        SettingsManager.set("quality", p);
        PerformanceManager.apply(p);
        syncFromSettings();
      };
      seg.appendChild(b);
    }
  }

  function bind() {
    const $ = (k) => el[k];
    $("spin").addEventListener("click", () => SpinEngine.userSpin());
    $("bet-down").addEventListener("click", () => changeBet(-1));
    $("bet-up").addEventListener("click", () => changeBet(1));
    $("auto").addEventListener("click", (e) => { e.stopPropagation(); toggleAutoPop(); });
    el["autopop"].querySelectorAll("[data-auto]").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const v = b.dataset.auto;
        SoundManager.play("ui");
        if (v === "stop") AutoSpinManager.stop();
        else AutoSpinManager.start(v === "inf" ? Infinity : parseInt(v, 10));
        closeAutoPop();
      });
    });
    document.addEventListener("click", () => closeAutoPop());
    $("turbo").addEventListener("click", () => { SettingsManager.set("turbo", !SettingsManager.get("turbo")); syncFromSettings(); SoundManager.play("ui"); });
    $("quick").addEventListener("click", () => { SettingsManager.set("quick", !SettingsManager.get("quick")); syncFromSettings(); SoundManager.play("ui"); });
    $("sound").addEventListener("click", () => { SettingsManager.set("muted", !SettingsManager.get("muted")); SoundManager.applyVolumes(); syncFromSettings(); SoundManager.play("ui"); });
    $("pausebtn").addEventListener("click", () => GameEngine.requestPause());
    $("settings").addEventListener("click", () => { SoundManager.play("ui"); openOverlay("settings"); });
    $("boardbtn").addEventListener("click", () => { SoundManager.play("ui"); openBoard(); });
    $("paytable").addEventListener("click", () => { SoundManager.play("ui"); openOverlay("paytable"); });
    $("exit").addEventListener("click", () => GameEngine.requestExit());

    $("play").addEventListener("click", () => { SoundManager.play("ui"); closeOverlay("menu"); gameStarted = true; setSpinBusy(false); });
    $("menu-board").addEventListener("click", () => { SoundManager.play("ui"); openBoard(); });
    $("menu-paytable").addEventListener("click", () => { SoundManager.play("ui"); openOverlay("paytable"); });
    $("menu-settings").addEventListener("click", () => { SoundManager.play("ui"); openOverlay("settings"); });

    $("resume").addEventListener("click", () => { SoundManager.play("ui"); GameEngine.resume(); });
    $("pause-settings").addEventListener("click", () => { SoundManager.play("ui"); openOverlay("settings"); });
    $("pause-board").addEventListener("click", () => { SoundManager.play("ui"); openBoard(); });
    $("pause-exit").addEventListener("click", () => { SoundManager.play("ui"); closeOverlay("pause"); GameEngine.requestExit(); });

    $("settings-close").addEventListener("click", () => { SoundManager.play("ui"); closeOverlay("settings"); });
    $("reset-data").addEventListener("click", () => {
      StorageService.remove("settings"); StorageService.remove("board.submitted"); StorageService.remove("board.pending");
      SettingsManager.reset(); SettingsManager.load();
      syncFromSettings(); SoundManager.play("ui");
    });

    $("vol-master").addEventListener("input", (e) => { SettingsManager.set("masterVol", e.target.value / 100); SoundManager.applyVolumes(); paintRange(e.target); });
    $("vol-sfx").addEventListener("input", (e) => { SettingsManager.set("sfxVol", e.target.value / 100); SoundManager.applyVolumes(); paintRange(e.target); });
    $("vol-music").addEventListener("input", (e) => { SettingsManager.set("musicVol", e.target.value / 100); SoundManager.applyVolumes(); paintRange(e.target); });
    $("tg-turbo").addEventListener("click", () => { SettingsManager.set("turbo", !SettingsManager.get("turbo")); syncFromSettings(); SoundManager.play("ui"); });
    $("tg-quick").addEventListener("click", () => { SettingsManager.set("quick", !SettingsManager.get("quick")); syncFromSettings(); SoundManager.play("ui"); });
    $("tg-motion").addEventListener("click", () => { SettingsManager.set("reducedMotion", !SettingsManager.get("reducedMotion")); syncFromSettings(); SoundManager.play("ui"); });
    $("tg-fps").addEventListener("click", () => { SettingsManager.set("showFps", !SettingsManager.get("showFps")); syncFromSettings(); SoundManager.play("ui"); });

    $("board-close").addEventListener("click", () => { SoundManager.play("ui"); closeOverlay("board"); });
    $("board-refresh").addEventListener("click", () => { SoundManager.play("ui"); openBoard(); });
    $("paytable-close").addEventListener("click", () => { SoundManager.play("ui"); closeOverlay("paytable"); });

    $("exit-cancel").addEventListener("click", () => { SoundManager.play("ui"); FSM.set(AutoSpinManager.isActive() ? "AUTO_SPIN" : "IDLE", "exit cancelled"); closeOverlay("exit"); });
    $("exit-confirm").addEventListener("click", () => { SoundManager.play("ui"); closeOverlay("exit"); GameEngine.endSession("exit"); });

    $("name-submit").addEventListener("click", () => submitName());
    $("name-skip").addEventListener("click", () => { SoundManager.play("ui"); closeOverlay("name"); showGameOver(); });
    el["name-input"].addEventListener("keydown", (e) => { if (e.key === "Enter") submitName(); });

    $("go-restart").addEventListener("click", () => { SoundManager.play("ui"); GameEngine.newSession(); });
    $("go-board").addEventListener("click", () => { SoundManager.play("ui"); openBoard(); });
    $("go-name").addEventListener("click", () => { SoundManager.play("ui"); showNameEntry(); });
  }

  function paintRange(input) { input.style.setProperty("--fill", `${input.value}%`); }

  function changeBet(dir) {
    if (!gameStarted || FSM.state === "SPINNING" || BonusEngine.isActive() || AutoSpinManager.isActive()) return;
    const st = GameState.data;
    let idx = CONFIG.BETS.indexOf(st.currentBet);
    if (idx === -1) idx = 1;
    idx = Utils.clamp(idx + dir, 0, CONFIG.BETS.length - 1);
    st.currentBet = CONFIG.BETS[idx];
    SettingsManager.set("betIndex", idx);
    SoundManager.play("ui");
    updateHUD();
  }
  function toggleAutoPop() {
    autoPopOpen = !autoPopOpen;
    el["autopop"].classList.toggle("is-open", autoPopOpen);
    const stop = el["autopop"].querySelector('[data-auto="stop"]');
    stop.style.display = AutoSpinManager.isActive() ? "inline-flex" : "none";
  }
  function closeAutoPop() { autoPopOpen = false; el["autopop"].classList.remove("is-open"); }

  function syncFromSettings() {
    const s = SettingsManager.all();
    el["turbo"].classList.toggle("is-on", s.turbo);
    el["quick"].classList.toggle("is-on", s.quick);
    $("tg-turbo").classList.toggle("is-on", s.turbo);
    $("tg-quick").classList.toggle("is-on", s.quick);
    $("tg-motion").classList.toggle("is-on", s.reducedMotion);
    $("tg-fps").classList.toggle("is-on", s.showFps);
    $("vol-master").value = Math.round(s.masterVol * 100);
    $("vol-sfx").value = Math.round(s.sfxVol * 100);
    $("vol-music").value = Math.round(s.musicVol * 100);
    for (const r of [$("vol-master"), $("vol-sfx"), $("vol-music")]) paintRange(r);
    $("quality-seg").querySelectorAll("button").forEach((b) => b.classList.toggle("is-on", b.dataset.q === s.quality));
    const waves = el["sound"].querySelector("#za-snd-waves");
    if (waves) waves.style.opacity = s.muted ? 0.15 : 1;
    el["sound"].classList.toggle("is-on", !s.muted);
  }
  function $(k) {
    if (!el[k]) el[k] = root ? root.querySelector(`#za-${k}`) : null;
    return el[k];
  }

  function updateHUD() {
    const st = GameState.data;
    el["balance"].textContent = Utils.fmt(st.balance);
    el["score"].textContent = Utils.fmt(st.sessionScore);
    el["lastwin"].textContent = Utils.fmt(st.lastWin);
    el["bet"].textContent = st.currentBet;
    updateAscension();
    updateStatus();
  }
  const CHIP_COLORS = { balance: "#ffe9ad", score: "#6fe3ff", lastwin: "#7dffa8" };
  function flashChip(key) {
    const chip = el[key];
    if (!chip) return;
    gsap.fromTo(chip, { scale: 1.24, color: "#ffffff" }, { scale: 1, color: CHIP_COLORS[key] || "#e8ecff", duration: 0.55, ease: "back.out(3)" });
  }
  function updateAscension() {
    const st = GameState.data;
    ascensionNodes.forEach((n, i) => n.classList.toggle("is-on", i < st.ascensionCharge));
    el["asc-count"].textContent = st.ascensionArmed ? "x5 ARMED" : `${st.ascensionCharge}/${CONFIG.ASCENSION_CHARGES}`;
    el["ascension"].classList.toggle("is-armed", st.ascensionArmed);
  }
  function updateStatus() {
    const st = GameState.data;
    const parts = [];
    if (BonusEngine.isActive()) parts.push(`Free Spins ${BonusEngine.state.total - BonusEngine.state.remaining}/${BonusEngine.state.total} · Mult x${BonusEngine.state.mult}`);
    if (st.ascensionArmed) parts.push("Ascension x5 Armed");
    const s = el["status"];
    if (parts.length) {
      s.textContent = parts.join("  ✦  ");
      s.classList.add("is-visible");
      s.classList.toggle("is-gold", st.ascensionArmed && !BonusEngine.isActive());
    } else {
      s.classList.remove("is-visible");
    }
  }
  function setSpinBusy(busy) {
    el["spinwrap"].classList.toggle("is-busy", busy);
    el["spin"].disabled = busy || !gameStarted;
  }

  /* ---- overlays ---- */
  function openOverlay(name) { el[`ov-${name}`].classList.add("is-open"); }
  function closeOverlay(name) { el[`ov-${name}`].classList.remove("is-open"); }
  function isOverlayOpen(name) { return el[`ov-${name}`].classList.contains("is-open"); }

  async function bootSequence() {
    openOverlay("boot");
    const lines = ["Calibrating RNG core…", "Charting 243 ways…", "Binding constellations…", "Linking leaderboard…", "Ready"];
    for (let i = 0; i < lines.length; i++) {
      el["boot-lines"].textContent = lines[i];
      el["boot-fill"].style.width = `${((i + 1) / lines.length) * 100}%`;
      await Utils.wait(i === lines.length - 1 ? 240 : 200);
    }
    closeOverlay("boot");
    openOverlay("menu");
    el["spin"].disabled = true;
  }

  /* ---- leaderboard overlay ---- */
  async function openBoard() {
    openOverlay("board");
    el["board-body"].innerHTML = `<div class="za-board-loading">Charting star positions…</div>`;
    const { rows, source } = await LeaderboardService.fetchTop50();
    const modeEl = el["board-mode"];
    modeEl.textContent = source === "online" ? "ONLINE" : source === "cache" ? "CACHED" : "LOCAL";
    modeEl.classList.toggle("is-online", source === "online");
    const myScore = GameState.data.sessionScore;
    el["board-body"].innerHTML = `<div class="za-board-list">${rows.map((r, i) => `
      <div class="za-board-row ${myScore > 0 && myScore === r.score ? "" : ""}">
        <span class="za-board-rank">${i + 1}</span>
        <span class="za-board-name">${escapeHtml(r.player_name)}</span>
        <span class="za-board-score">${r.score.toLocaleString()}</span>
      </div>`).join("")}</div>`;
    el["board-note"].textContent = source === "online"
      ? "Synced with Supabase · RLS protected"
      : "Offline board — scores sync when a connection is configured.";
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  /* ---- banners / floaters ---- */
  function showBanner(tierName, amount) {
    return new Promise((resolve) => {
      el["banner-title"].textContent = tierName;
      el["banner-amount"].textContent = "0";
      el["banner"].classList.add("is-open");
      const obj = { v: 0 };
      gsap.fromTo(el["banner-title"], { scale: 2.4, opacity: 0, filter: "blur(14px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.45, ease: "back.out(2)" });
      gsap.to(obj, {
        v: amount, duration: 1.1, delay: 0.25, ease: "power1.out",
        onUpdate: () => { el["banner-amount"].textContent = Math.round(obj.v).toLocaleString(); SoundManager.play("coin"); },
        onComplete: () => {
          gsap.to(el["banner"], { opacity: 0, duration: 0.4, delay: 0.5, onComplete: () => {
            el["banner"].classList.remove("is-open");
            gsap.set(el["banner"], { opacity: 1 });
            resolve();
          } });
        },
      });
    });
  }
  function showMultiplierBadge(mult) {
    const geo = Renderer.frameGeometry();
    const badge = el["multibadge"];
    badge.textContent = `x${mult}`;
    badge.style.left = `${geo.ox + geo.gridW - 10}px`;
    badge.style.top = `${geo.oy - 26}px`;
    gsap.fromTo(badge, { opacity: 0, scale: 0.4, y: 14 }, { opacity: 1, scale: 1, y: 0, duration: 0.28, ease: "back.out(3)" });
    gsap.to(badge, { opacity: 0, scale: 1.25, duration: 0.3, delay: 0.75, ease: "power2.in" });
    if (!SettingsManager.get("reducedMotion")) Renderer.addShake(3);
  }
  function floatText(text, x, y) {
    const f = document.createElement("div");
    f.className = "za-floater";
    f.textContent = text;
    f.style.left = `${x}px`;
    f.style.top = `${y}px`;
    root.appendChild(f);
    gsap.fromTo(f, { opacity: 0, y: 10, scale: 0.8 }, { opacity: 1, y: -26, scale: 1, duration: 0.9, ease: "power2.out", onComplete: () => f.remove() });
    gsap.to(f, { opacity: 0, delay: 0.65, duration: 0.3 });
  }
  async function showBonusGrant(scatter) {
    floatText(`+${scatter.pay} SCATTER PAY`, Renderer.W / 2 - 70, Renderer.frameGeometry().oy - 40);
    const s = el["status"];
    s.textContent = `Ascension Granted — ${scatter.spins} Free Spins`;
    s.classList.add("is-visible");
    await Utils.wait(SettingsManager.get("quick") ? 500 : 1300);
  }
  async function showBonusSummary(totalWon) {
    const s = el["status"];
    s.textContent = `Free Spins Complete — Won ${totalWon}`;
    s.classList.add("is-visible");
    SoundManager.play("win", 2);
    await Utils.wait(SettingsManager.get("quick") ? 600 : 1600);
    s.classList.remove("is-visible");
  }

  /* ---- end-of-session flows ---- */
  function showNameEntry() {
    const st = GameState.data;
    el["name-rank"].textContent = `#${LeaderboardService.rankOf(st.sessionScore)} on the charts`;
    el["name-input"].value = SettingsManager.get("playerName") || "";
    el["name-note"].textContent = "";
    closeOverlay("gameover");
    openOverlay("name");
    FSM.set("NAME_ENTRY", "name entry");
    setTimeout(() => el["name-input"].focus(), 50);
  }
  async function submitName() {
    const name = (el["name-input"].value || "").trim();
    if (name.length < 2) {
      el["name-note"].textContent = "Minimum 2 characters, pilot.";
      el["name-note"].className = "za-note is-err";
      return;
    }
    SettingsManager.set("playerName", name.toUpperCase());
    FSM.set("SUBMITTING_SCORE", "submitting");
    el["name-note"].textContent = "Transmitting to the stars…";
    el["name-note"].className = "za-note";
    const st = GameState.data;
    const res = await LeaderboardService.submitScore({
      playerName: name, score: st.sessionScore, submissionId: `${st.sessionId}`,
    });
    SoundManager.play("submit");
    el["name-note"].textContent = res.online
      ? `Recorded online · Rank #${res.rank}`
      : `Recorded locally · Rank #${res.rank} (syncs when online)`;
    el["name-note"].className = "za-note is-ok";
    await Utils.wait(900);
    closeOverlay("name");
    showGameOver(true);
  }
  function showGameOver(submitted = false) {
    const st = GameState.data;
    FSM.set("GAME_OVER", "game over shown");
    const broke = st.balance < CONFIG.MIN_BET;
    el["go-kicker"].textContent = broke ? "Out of Credits" : "Session Closed";
    el["go-title"].textContent = broke ? "The Void Claims All" : "The Stars Align Anew";
    el["go-score"].textContent = st.sessionScore.toLocaleString();
    el["go-spins"].textContent = st.spinsPlayed;
    el["go-big"].textContent = st.biggestWin.toLocaleString();
    el["go-mult"].textContent = `x${st.highestMultiplier}`;
    el["go-casc"].textContent = st.cascadeCount;
    el["go-asc"].textContent = st.zodiacAscensionCount;
    const qualified = LeaderboardService.qualifies(st.sessionScore);
    el["go-board"].style.display = "inline-flex";
    el["go-name"].style.display = qualified && !submitted ? "inline-flex" : "none";
    el["go-note"].textContent = submitted
      ? "Your score is on the charts. A new ascension awaits."
      : qualified
        ? "You qualify for the Top 50. Record your name among the stars."
        : `Reach ${CONFIG.LEADERBOARD_SIZE > 0 ? "the Top 50" : "the charts"} — current threshold: ${(LeaderboardService.qualifies(1) ? "any score" : "beat the 50th star")}.`;
    SoundManager.play("gameOver");
    openOverlay("gameover");
  }

  return {
    build, updateHUD, flashChip, updateAscension, updateStatus, setSpinBusy,
    openOverlay, closeOverlay, isOverlayOpen, bootSequence, openBoard,
    showBanner, showMultiplierBadge, floatText, showBonusGrant, showBonusSummary,
    showNameEntry, submitName, showGameOver, syncFromSettings,
    get gameStarted() { return gameStarted; },
    get root() { return root; },
  };
})();

/* ========================================================================== *
 * MODULE: AnimationEngine — GSAP presentation layer.
 * Consumes a fully precomputed outcome; never influences math.
 * ========================================================================== */
const AnimationEngine = (() => {
  function timing() {
    const s = SettingsManager.all();
    if (s.quick) return { scale: 0.18, label: "quick" };
    if (s.turbo) return { scale: 0.55, label: "turbo" };
    return { scale: 1, label: "normal" };
  }
  function reduced() { return SettingsManager.get("reducedMotion"); }

  async function animateSpinTo(grid) {
    const T = timing();
    SoundManager.play("spinStart");
    const stopTimes = [];
    for (let c = 0; c < ReelEngine.reels; c++) {
      const col = ReelEngine.view[c];
      col.mode = "spin";
      col.spinOffset = RNG.float() * 24;
      const dur = 0.2 + c * 0.03;
      stopTimes.push((0.62 + c * 0.24) * T.scale);
      Utils.tween(col, { spinSpeed: 17 + c, duration: dur, ease: "power2.out" });
    }
    for (let c = 0; c < ReelEngine.reels; c++) {
      const wait = Math.max(0.05, stopTimes[c] - (0.2 + c * 0.03));
      await Utils.wait(wait * 1000);
      const col = ReelEngine.view[c];
      await Utils.tween(col, { spinSpeed: 0, duration: 0.3 * T.scale, ease: "power3.out" });
      // land this column on its final symbols
      col.mode = "idle";
      col.cells = grid[c].map((sym, r) => ({ sym, row: r, off: -Renderer.frameGeometry().cell * 0.7, scale: 1, alpha: 1, glow: 0 }));
      for (const cl of col.cells) Utils.tween(cl, { off: 0, duration: 0.3 * T.scale, ease: "back.out(2.2)" });
      SoundManager.play("reelStop", c);
      if (!reduced()) Renderer.addShake(2.2);
      EventBus.emit(EVENTS.REEL_STOPPED, { reel: c });
    }
    await Utils.wait(90 * T.scale);
  }

  async function animateWin(step, stepIndex, totalSteps) {
    const T = timing();
    const ev = step.eval;
    // glow pulse on winning cells
    const cells = [];
    for (const key of ev.winCells) {
      const [c, r] = key.split(",").map(Number);
      const cell = ReelEngine.cellAt(c, r);
      if (cell) cells.push(cell);
    }
    const size = step.amount >= 10 * GameState.data.currentBet ? 3 : step.amount >= 4 * GameState.data.currentBet ? 2 : 1;
    SoundManager.play("win", size);
    const pulse = { v: 0 };
    const pulseUp = Utils.tween(pulse, { v: 1, duration: 0.24 * T.scale, ease: "power2.out", repeat: T.label === "quick" ? 0 : 2, yoyo: true,
      onUpdate: () => { for (const cl of cells) cl.glow = pulse.v; } });
    // constellation flash + particles at each winning cell
    const geo = Renderer.frameGeometry();
    for (const key of ev.winCells) {
      const [c, r] = key.split(",").map(Number);
      const p = Renderer.cellCenter(c, r);
      const def = SYMBOL_BY_ID[step.grid[c][r]] || SYMBOL_BY_ID[ev.wins[0]?.symbol || "leo"];
      ParticleEngine.burst(p.x, p.y, TIER_COLORS[def ? def.element : "fire"], 8, { speed: 130, life: 0.7 });
    }
    const firstWin = ev.wins[0];
    if (firstWin && CONSTELLATIONS[firstWin.symbol]) {
      ConstellationEngine.flash(firstWin.symbol, geo.ox + geo.gridW * 0.5 - geo.cell * 1.2, geo.oy - geo.cell * 0.05, geo.cell * 2.4);
    }
    await pulseUp;
    for (const cl of cells) cl.glow = 0;
  }

  async function animateCascade(step) {
    const T = timing();
    if (!step.collapse) return;
    const ev = step.eval;
    EventBus.emit(EVENTS.CASCADE_STARTED, { step: step.collapse });
    SoundManager.play("cascade");
    const geo = Renderer.frameGeometry();
    // explode removed cells
    for (const key of ev.winCells) {
      const [c, r] = key.split(",").map(Number);
      const cell = ReelEngine.cellAt(c, r);
      if (!cell) continue;
      const p = Renderer.cellCenter(c, r);
      const def = SYMBOL_BY_ID[cell.sym];
      ParticleEngine.shards(p.x, p.y, TIER_COLORS[def.element], 9);
      Utils.tween(cell, { scale: 0.05, alpha: 0, duration: 0.2 * T.scale, ease: "power2.in" });
    }
    await Utils.wait(210 * T.scale);
    // rebuild columns: survivors fall, spawns drop in
    const moves = step.collapse.moves;
    for (let c = 0; c < ReelEngine.reels; c++) {
      const col = ReelEngine.view[c];
      const colMoves = moves.filter((m) => m.col === c).sort((a, b) => a.toRow - b.toRow);
      col.cells = colMoves.map((m) => ({
        sym: m.symbol, row: m.toRow,
        off: -(m.fall + (m.spawned ? 1.2 : 0)) * geo.cell,
        scale: 1, alpha: 1, glow: 0,
      }));
      for (const cl of col.cells) {
        Utils.tween(cl, { off: 0, duration: (0.32 + 0.03 * cl.row) * T.scale, ease: "bounce.out" });
      }
    }
    await Utils.wait(400 * T.scale);
    EventBus.emit(EVENTS.CASCADE_FINISHED, {});
  }

  async function animateBigWin(tierName, amount) {
    EventBus.emit(EVENTS.BIG_WIN, { tier: tierName, amount });
    SoundManager.play("bigWin");
    const geo = Renderer.frameGeometry();
    for (let i = 0; i < 5; i++) {
      ParticleEngine.burst(
        geo.ox + RNG.float() * geo.gridW,
        geo.oy + RNG.float() * geo.gridH,
        Utils.pick(["#ffe9ad", "#6fe3ff", "#ff7ad9", "#7dffa8"], RNG.float.bind(RNG)),
        16, { speed: 220, life: 1.1 }
      );
    }
    if (!reduced()) Renderer.addShake(6);
    await UIManager.showBanner(tierName, amount);
  }

  async function animateAscension() {
    SoundManager.play("ascension");
    const geo = Renderer.frameGeometry();
    for (let i = 0; i < 40; i++) {
      ParticleEngine.stardust(geo.ox + RNG.float() * geo.gridW, geo.oy + geo.gridH, "#ffe9ad", 1);
    }
    UIManager.floatText("ASCENSION x5 ARMED", Renderer.W / 2 - 90, geo.oy - 44);
    await Utils.wait(400);
  }

  async function playOutcome(outcome) {
    const T = timing();
    const st = GameState.data;
    const steps = outcome.steps;

    await animateSpinTo(steps[0].grid);
    FSM.set("EVALUATING", "reels stopped");

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const ev = step.eval;
      const hasWin = step.amount > 0;

      if (i === 0 && outcome.scatter) {
        // scatter flash (triggers bonus after cascades resolve)
        for (const [c, r] of outcome.scatter.cells) {
          const cell = ReelEngine.cellAt(c, r);
          if (cell) {
            const p = Renderer.cellCenter(c, r);
            ParticleEngine.burst(p.x, p.y, TIER_COLORS.scatter, 12, { speed: 150, life: 0.9 });
            Utils.tween(cell, { glow: 1, duration: 0.3, yoyo: true, repeat: 1 });
          }
        }
        SoundManager.play("scatter");
      }

      if (hasWin) {
        FSM.set("WINNING", `step ${i}`);
        EventBus.emit(EVENTS.WIN_FOUND, { step: i, amount: step.amount, mult: step.mult, wins: ev.wins });
        await animateWin(step, i, steps.length);
        if (step.mult > 1) {
          EventBus.emit(EVENTS.MULTIPLIER_TRIGGERED, { mult: step.mult });
          SoundManager.play("multiplier");
          UIManager.showMultiplierBadge(step.mult);
          await Utils.wait(260 * T.scale);
        }
        // apply winnings for this step immediately (balance feedback)
        GameState.addBalance(step.amount);
        st.lastWin += step.amount;
        st.sessionScore += step.amount;
        st.biggestWin = Math.max(st.biggestWin, step.amount);
        st.highestMultiplier = Math.max(st.highestMultiplier, step.mult);
        UIManager.updateHUD();
        UIManager.flashChip("balance");
        const geo = Renderer.frameGeometry();
        const chip = document.querySelector("#za-balance").getBoundingClientRect();
        ParticleEngine.coinFlight(geo.ox + geo.gridW / 2, geo.oy + geo.gridH / 2, chip.left + chip.width / 2, chip.top + chip.height / 2, "#ffe9ad", T.label === "quick" ? 3 : 8);
        UIManager.floatText(`+${step.amount.toLocaleString()}`, geo.ox + geo.gridW / 2 - 24, geo.oy - 30);
      }

      if (step.collapse) {
        FSM.set("CASCADING", `step ${i}`);
        st.cascadeCount++;
        await animateCascade(step);
        FSM.set("EVALUATING", "cascade resolved");
      } else {
        break;
      }
    }

    // scatter pay + bonus trigger
    if (outcome.scatter) {
      GameState.addBalance(outcome.scatter.pay);
      st.lastWin += outcome.scatter.pay;
      st.sessionScore += outcome.scatter.pay;
      st.biggestWin = Math.max(st.biggestWin, outcome.scatter.pay);
      UIManager.updateHUD();
      UIManager.flashChip("balance");
      const geoS = Renderer.frameGeometry();
      UIManager.floatText(`+${outcome.scatter.pay.toLocaleString()} SCATTER`, geoS.ox + geoS.gridW / 2 - 48, geoS.oy - 30);
    }

    // big win banner
    const bet = outcome.bet || st.currentBet;
    if (outcome.totalWin > 0) {
      const ratio = outcome.totalWin / Math.max(1, bet);
      const tier = CONFIG.BIG_WIN_TIERS.find((t) => ratio >= t.mult);
      if (tier) await animateBigWin(tier.name, outcome.totalWin);
    }

    return outcome;
  }

  return { playOutcome, animateSpinTo, animateWin, animateCascade, animateBigWin, animateAscension, timing, reduced };
})();

/* ========================================================================== *
 * MODULE: SpinEngine — orchestrates the spin pipeline.
 * ========================================================================== */
const SpinEngine = (() => {
  let busy = false;

  function validateSpin(isFree) {
    const st = GameState.data;
    if (busy) return { ok: false, reason: "busy" };
    if (!isFree && st.balance < st.currentBet) return { ok: false, reason: "insufficient" };
    return { ok: true };
  }

  async function spin({ free = false } = {}) {
    if (busy) return null; // hard guard against double execution
    const isFree = free || BonusEngine.isActive();
    const v = validateSpin(isFree);
    if (!v.ok) {
      if (v.reason === "insufficient") {
        SoundManager.play("denied");
        EventBus.emit(EVENTS.ERROR, { type: "INSUFFICIENT_BALANCE" });
      }
      return null;
    }
    const targetState = "SPINNING";
    if (!FSM.can(targetState)) return null;
    busy = true;
    FSM.set(targetState, "spin start");

    const st = GameState.data;
    if (!isFree) {
      st.balance -= st.currentBet; // single, atomic deduction
      EventBus.emit(EVENTS.BALANCE_CHANGED, { balance: st.balance, delta: -st.currentBet });
    }
    st.spinsPlayed++;
    st.lastWin = 0;
    UIManager.updateHUD();
    UIManager.setSpinBusy(true);
    EventBus.emit(EVENTS.SPIN_STARTED, { bet: isFree ? 0 : st.currentBet, free: isFree });

    // Math first: the entire outcome is decided here, before any animation.
    const outcome = SlotMath.generateOutcome(isFree ? Math.max(1, st.currentBet) : st.currentBet, {
      freeSpin: isFree,
      fsMult: BonusEngine.state.mult,
      ascensionArmed: st.ascensionArmed,
    });
    DebugTools.recordOutcome(outcome);

    if (outcome.ascensionUsed) {
      st.ascensionArmed = false;
      UIManager.updateAscension();
    }

    try {
      await AnimationEngine.playOutcome(outcome);
    } catch (e) {
      console.error("[Spin] animation failure", e);
      EventBus.emit(EVENTS.ERROR, { type: "ANIMATION_FAILURE", detail: String(e) });
    }

    // stats & ascension charging
    const extraCascades = Math.max(0, outcome.cascadeWins - 1);
    chargeAscension(extraCascades + (outcome.scatter ? CONFIG.ASCENSION_PER_SCATTER : 0));
    if (outcome.totalWin > 0) st.totalWins++;
    if (isFree && outcome.fsMultEnd) BonusEngine.state.mult = outcome.fsMultEnd;

    UIManager.setSpinBusy(false);
    EventBus.emit(EVENTS.SPIN_RESOLVED, {
      totalWin: outcome.totalWin, balance: st.balance, scatter: outcome.scatter, free: isFree,
    });

    busy = false;

    // bonus trigger (after cascade resolution, classic order)
    if (outcome.scatter && !isFree) {
      await BonusEngine.start(outcome.scatter);
      return outcome;
    }
    if (!isFree) afterSpin();
    return outcome;
  }

  function chargeAscension(n) {
    if (n <= 0) return;
    const st = GameState.data;
    if (st.ascensionArmed) return;
    st.ascensionCharge = Math.min(CONFIG.ASCENSION_CHARGES, st.ascensionCharge + n);
    if (st.ascensionCharge >= CONFIG.ASCENSION_CHARGES) {
      st.ascensionArmed = true;
      st.ascensionCharge = 0;
      st.zodiacAscensionCount++;
      EventBus.emit(EVENTS.ASCENSION_TRIGGERED, { count: st.zodiacAscensionCount });
      AnimationEngine.animateAscension();
    }
    UIManager.updateAscension();
  }

  function afterSpin() {
    const st = GameState.data;
    if (["NAME_ENTRY", "SUBMITTING_SCORE", "GAME_OVER", "EXIT_CONFIRMATION", "PAUSED"].includes(FSM.state)) return;
    if (AutoSpinManager.isActive()) {
      AutoSpinManager.onSpinDone();
      return;
    }
    FSM.set(FSM.can("IDLE") ? "IDLE" : FSM.state, "spin end");
    if (st.balance < CONFIG.MIN_BET) GameEngine.triggerGameOver();
  }

  function userSpin() {
    if (!UIManager.gameStarted) return;
    const blocked = ["menu", "gameover", "name", "settings", "board", "paytable", "exit", "pause"];
    if (blocked.some((n) => UIManager.isOverlayOpen(n))) return;
    if (FSM.state === "PAUSED") return;
    if (AutoSpinManager.isActive()) { AutoSpinManager.stop(); return; }
    SoundManager.ensure();
    spin();
  }

  function spinGap() {
    const T = AnimationEngine.timing();
    return Math.round(520 * T.scale);
  }

  return { spin, userSpin, afterSpin, spinGap, validateSpin };
})();

/* ========================================================================== *
 * MODULE: AutoSpinManager
 * ========================================================================== */
const AutoSpinManager = (() => {
  let active = false;
  let remaining = 0;
  let stoppedByBonus = false;

  function start(count) {
    if (active || !UIManager.gameStarted) return;
    if (!FSM.can("AUTO_SPIN")) return;
    active = true;
    remaining = count;
    stoppedByBonus = false;
    FSM.set("AUTO_SPIN", "auto start");
    EventBus.emit(EVENTS.AUTO_SPIN_STARTED, { count });
    UIManager.setSpinBusy(true);
    setTimeout(() => UIManager.setSpinBusy(false), 250);
    tick();
  }
  async function tick() {
    if (!active) return;
    const st = GameState.data;
    if (st.balance < st.currentBet) {
      stop("balance");
      GameEngine.triggerGameOver();
      return;
    }
    if (remaining !== Infinity) {
      if (remaining <= 0) { stop("count"); return; }
      remaining--;
    }
    await SpinEngine.spin();
  }
  function onSpinDone() {
    if (!active) { FSM.set("IDLE", "spin end"); return; }
    if (BonusEngine.isActive() || stoppedByBonus) return; // bonus interrupts auto
    setTimeout(tick, SpinEngine.spinGap());
  }
  function stop(reason = "user") {
    if (!active) return;
    active = false;
    remaining = 0;
    EventBus.emit(EVENTS.AUTO_SPIN_STOPPED, { reason });
    if (FSM.can("IDLE")) FSM.set("IDLE", `auto stopped (${reason})`);
  }
  return {
    start, stop, onSpinDone,
    isActive: () => active,
    pause() { active = false; },
    resumeAuto() {
      if (active || remaining <= 0) return false;
      active = true;
      if (FSM.can("AUTO_SPIN")) FSM.set("AUTO_SPIN", "auto resume");
      tick();
      return true;
    },
    remaining: () => remaining,
  };
})();

/* ========================================================================== *
 * MODULE: DebugTools — hidden panel (CTRL+SHIFT+D) + command console.
 * ========================================================================== */
const DebugTools = (() => {
  let panel = null;
  let open = false;
  let lastOutcomeInfo = "—";
  let interval = null;

  function recordOutcome(outcome) {
    const s = outcome.source;
    lastOutcomeInfo = `${s.source} seed=${s.seed ?? "live"} draws=${s.draws} win=${outcome.totalWin} steps=${outcome.steps.length}`;
  }
  function build(container) {
    panel = container.querySelector("#za-debug");
    panel.innerHTML = `
      <h4>ZODIAC DEBUG</h4>
      <div class="row"><span>FPS</span><b id="zd-fps">—</b></div>
      <div class="row"><span>STATE</span><b id="zd-state">—</b></div>
      <div class="row"><span>BALANCE</span><b id="zd-bal">—</b></div>
      <div class="row"><span>BET</span><b id="zd-bet">—</b></div>
      <div class="row"><span>LAST RNG</span><b id="zd-rng">—</b></div>
      <div class="row"><span>SEED</span><b id="zd-seed">—</b></div>
      <div class="row"><span>CASCADES</span><b id="zd-casc">—</b></div>
      <div class="row"><span>PARTICLES</span><b id="zd-part">—</b></div>
      <div class="row"><span>ANIMS</span><b id="zd-anim">—</b></div>
      <div class="row"><span>QUALITY</span><b id="zd-qual">—</b></div>
      <div class="row"><span>FSM</span><b id="zd-fsm">—</b></div>
      <input id="zd-cmd" placeholder="cmd: addcredits 500 | seed 42 | forcebonus | quality low | spin" />
    `;
    panel.querySelector("#zd-cmd").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { runCommand(e.target.value); e.target.value = ""; e.stopPropagation(); }
      e.stopPropagation();
    });
    interval = setInterval(update, 250);
  }
  function update() {
    if (!panel || !open) return;
    const st = GameState.data;
    const set = (id, v) => { const n = panel.querySelector(id); if (n) n.textContent = v; };
    set("#zd-fps", PerformanceManager.fps());
    set("#zd-state", FSM.state);
    set("#zd-bal", st.balance);
    set("#zd-bet", st.currentBet);
    set("#zd-rng", lastOutcomeInfo);
    set("#zd-seed", RNG.isSeeded() ? String(RNG.info().seed) : "crypto-live");
    set("#zd-casc", st.cascadeCount);
    set("#zd-part", ParticleEngine.list.length);
    set("#zd-anim", gsap.globalTimeline.getChildren(true, true, false).length);
    set("#zd-qual", PerformanceManager.get().name);
    set("#zd-fsm", FSM.historySnapshot().slice(-34));
  }
  function toggle() {
    open = !open;
    panel.classList.toggle("is-open", open);
    update();
  }
  function runCommand(raw) {
    const [cmd, ...args] = raw.trim().split(/\s+/);
    const st = GameState.data;
    switch (cmd) {
      case "addcredits": GameState.addBalance(parseFloat(args[0]) || 0); UIManager.updateHUD(); break;
      case "setbet": st.currentBet = Math.max(1, parseInt(args[0], 10) || 1); UIManager.updateHUD(); break;
      case "seed": {
        const s = parseInt(args[0], 10);
        RNG.configure({ debugMode: true, seed: isNaN(s) ? 42 : s });
        CONFIG.DEBUG_MODE = true; CONFIG.DEBUG_SEED = s;
        break;
      }
      case "rng": RNG.configure(args[0] === "live" ? { debugMode: false } : { debugMode: true, seed: 42 }); break;
      case "forcebonus": SlotMath.setDebugForce({ type: "scatter", count: 3 }); break;
      case "forcescatter": SlotMath.setDebugForce({ type: "scatter", count: parseInt(args[0], 10) || 3 }); break;
      case "forcewin": SlotMath.setDebugForce({ type: "symbol", symbol: args[0] || "leo" }); break;
      case "quality": PerformanceManager.apply((args[0] || "AUTO").toUpperCase()); break;
      case "charge": chargeDebug(parseInt(args[0], 10) || 12); break;
      case "spin": SpinEngine.userSpin(); break;
      case "state": console.log("[FSM]", FSM.state, FSM.historySnapshot()); break;
      case "help": console.log("[Debug] addcredits N · setbet N · seed N · rng live|debug · forcebonus · forcescatter N · forcewin SYM · quality X · charge N · spin · state"); break;
      default: console.warn("[Debug] unknown command:", cmd);
    }
    update();
  }
  function chargeDebug(n) {
    const st = GameState.data;
    st.ascensionCharge = Math.min(CONFIG.ASCENSION_CHARGES, st.ascensionCharge + n);
    if (st.ascensionCharge >= CONFIG.ASCENSION_CHARGES && !st.ascensionArmed) {
      st.ascensionArmed = true; st.ascensionCharge = 0; st.zodiacAscensionCount++;
      UIManager.updateAscension();
    } else UIManager.updateAscension();
  }
  function destroy() { if (interval) clearInterval(interval); }
  return { build, toggle, recordOutcome, destroy, isOpen: () => open };
})();

/* ========================================================================== *
 * MODULE: GameEngine — composition root: boot, loop, input, lifecycle.
 * ========================================================================== */
const GameEngine = (() => {
  let rootEl = null;
  let raf = 0;
  let last = 0;
  let running = false;
  let ready = false;
  const cleanups = [];

  function init(container) {
    if (running) return api; // idempotent boot (StrictMode-safe)
    rootEl = container;
    container.innerHTML = "";

    SettingsManager.load();
    RNG.configure({ debugMode: CONFIG.DEBUG_MODE, seed: CONFIG.DEBUG_SEED });
    PerformanceManager.apply(SettingsManager.get("quality") || "AUTO");

    const canvas = UIManager.build(container);
    Renderer.init(canvas);
    ReelEngine.initStrips();
    ReelEngine.setGrid(SlotMath.generateGrid()); // idle attract grid (visual)
    DebugTools.build(container);
    Renderer.resize();

    // Event wiring (loose coupling: UI reacts to engine events)
    cleanups.push(EventBus.on(EVENTS.BALANCE_CHANGED, () => UIManager.updateHUD()));
    cleanups.push(EventBus.on(EVENTS.ERROR, (e) => console.warn("[Game]", e)));

    // Input
    const onKey = (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) { e.preventDefault(); DebugTools.toggle(); return; }
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); SoundManager.unlock(); SpinEngine.userSpin(); }
      if (e.key === "Escape") {
        if (UIManager.isOverlayOpen("menu") || UIManager.isOverlayOpen("gameover") || UIManager.isOverlayOpen("name")) return;
        const anyOpen = ["settings", "board", "paytable", "exit"].some((n) => UIManager.isOverlayOpen(n));
        if (anyOpen) { ["settings", "board", "paytable", "exit"].forEach((n) => UIManager.closeOverlay(n)); return; }
        requestPause();
      }
    };
    const onResize = () => Renderer.resize();
    const onPointer = (e) => AmbientFX.setPointer(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
    const onPointerDown = () => SoundManager.unlock();
    const onCanvasTap = (e) => {
      // small stardust feedback wherever the player taps the cosmos
      const rect = canvas.getBoundingClientRect();
      ParticleEngine.stardust(e.clientX - rect.left, e.clientY - rect.top, "#9fd8ff", 5);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointer);
    window.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerdown", onCanvasTap);
    cleanups.push(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerdown", onCanvasTap);
    });

    // Boot
    running = true;
    ready = true;
    last = performance.now();
    const loop = (now) => {
      if (!running) return;
      const dt = Utils.clamp((now - last) / 1000, 0, 0.05);
      last = now;
      const paused = FSM.state === "PAUSED";
      PerformanceManager.tick(dt);
      if (!paused) {
        ReelEngine.integrate(dt);
        AmbientFX.update(dt, false);
        ParticleEngine.update(dt);
      }
      Renderer.draw(now / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // Async services
    LeaderboardService.init();
    document.fonts?.ready.then(() => Renderer.resize());

    UIManager.bootSequence().then(() => {
      FSM.set("IDLE", "boot complete");
      EventBus.emit(EVENTS.GAME_READY, { version: CONFIG.VERSION });
    });

    window.ZODIAC = api; // debug surface
    return api;
  }

  function requestPause() {
    if (!UIManager.gameStarted) return;
    if (FSM.state === "PAUSED") { resume(); return; }
    if (!FSM.can("PAUSED") && FSM.state !== "IDLE" && FSM.state !== "AUTO_SPIN") return;
    if (FSM.state === "AUTO_SPIN") AutoSpinManager.pause();
    if (FSM.can("PAUSED")) FSM.set("PAUSED", "user pause");
    UIManager.openOverlay("pause");
    SoundManager.play("ui");
  }
  function resume() {
    UIManager.closeOverlay("pause");
    if (FSM.can("IDLE")) FSM.set("IDLE", "resume");
    AutoSpinManager.resumeAuto();
    SoundManager.play("ui");
  }
  function requestExit() {
    if (!UIManager.gameStarted) return;
    if (FSM.state === "SPINNING" || FSM.state === "EVALUATING" || FSM.state === "WINNING" || FSM.state === "CASCADING") {
      SoundManager.play("denied");
      return;
    }
    EventBus.emit(EVENTS.EXIT_REQUESTED, {});
    if (FSM.state === "AUTO_SPIN") AutoSpinManager.stop("exit");
    if (FSM.can("EXIT_CONFIRMATION")) FSM.set("EXIT_CONFIRMATION", "exit requested");
    UIManager.openOverlay("exit");
    SoundManager.play("ui");
  }
  function endSession() {
    AutoSpinManager.stop("exit");
    BonusEngine.abort();
    UIManager.closeOverlay("exit");
    const qualified = LeaderboardService.qualifies(GameState.data.sessionScore);
    if (qualified) {
      EventBus.emit(EVENTS.LEADERBOARD_QUALIFIED, { score: GameState.data.sessionScore });
      UIManager.showNameEntry();
    } else {
      UIManager.showGameOver();
    }
  }
  function triggerGameOver() {
    AutoSpinManager.stop("balance");
    UIManager.showGameOver();
  }
  function newSession() {
    GameState.reset();
    BonusEngine.reset();
    AutoSpinManager.stop("new");
    ReelEngine.setGrid(SlotMath.generateGrid());
    UIManager.closeOverlay("gameover");
    UIManager.closeOverlay("name");
    UIManager.updateHUD();
    UIManager.setSpinBusy(false);
    FSM.set("IDLE", "new session");
    SoundManager.play("ui");
  }
  function destroy() {
    running = false;
    ready = false;
    cancelAnimationFrame(raf);
    for (const fn of cleanups) { try { fn(); } catch { /* noop */ } }
    cleanups.length = 0;
    DebugTools.destroy();
    EventBus.clear();
    SoundManager.stopAmbient();
    if (rootEl) rootEl.innerHTML = "";
    rootEl = null;
    delete window.ZODIAC;
  }

  const api = {
    version: CONFIG.VERSION,
    init, destroy, requestPause, resume, requestExit, endSession, newSession, triggerGameOver,
    get state() { return FSM.state; },
    get ready() { return ready; },
    modules: {
      CONFIG, EventBus, EVENTS, RNG, SlotMath, WinEvaluator, CascadeEngine, MultiplierEngine,
      BonusEngine, GameState, FSM, SpinEngine, ReelEngine, AnimationEngine, ParticleEngine,
      AmbientFX, ConstellationEngine, Renderer, SoundManager, UIManager, SettingsManager,
      AutoSpinManager, StorageService, LeaderboardService, PerformanceManager, DebugTools,
    },
    debug: {
      addCredits: (n) => GameState.addBalance(n),
      setSeed: (s) => RNG.configure({ debugMode: true, seed: s }),
      forceBonus: () => SlotMath.setDebugForce({ type: "scatter", count: 3 }),
      spin: () => SpinEngine.userSpin(),
    },
  };
  return api;
})();

export { GameEngine, CONFIG, EVENTS };
export default GameEngine;
