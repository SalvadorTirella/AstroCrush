/* ============================================================================
 * ZODIAC ASCENSION — Game Engine (Stages 1-3)
 *
 * Logical modules:
 *   Config · Utils · EventBus · RNG · Glyphs/Symbols · StorageService
 *   SettingsManager · GameState · GameStateMachine · SlotMath(cluster pays)
 *   WinEvaluator · CascadeEngine · MultiplierEngine · BonusEngine · ReelEngine
 *   ParticleEngine · AmbientFX · ConstellationEngine · Renderer · SoundManager
 *   AnimationEngine · SpinEngine · AutoSpinManager · LeaderboardService
 *   PerformanceManager · DebugTools · GameEngine
 * The professional UI (HUD, modals, flows) lives in src/ui.js and is imported
 * here as UIManager. It never touches math.
 *
 * Pipeline contract (math fully decoupled from presentation):
 *   RNG -> Spin Result (full cascade chain precomputed) -> GameState
 *       -> Win Evaluation -> Animation. Never the reverse.
 * ========================================================================== */

import { gsap } from "gsap";
import { UIManager } from "./ui.js";

/* ========================================================================== *
 * MODULE: Config + Math config (easy to tune)
 * ========================================================================== */
const CONFIG = {
  VERSION: "0.3.0",
  STAGE: "stage3-gameplay",
  GRID: { reels: 6, rows: 5 },
  START_BALANCE: 100,
  BETS: [1, 2, 5, 10, 20],
  MIN_BET: 1,
  PAY_DIV: 2, // cluster units -> credits divisor: payout = units * bet / PAY_DIV
  FREE_SPINS: { 3: 8, 4: 12, 5: 20 },
  SCATTER_PAY: { 3: 2, 4: 5, 5: 25 }, // x bet, added on trigger
  MULT_LADDER: [1, 2, 3, 5, 10, 25, 50, 100], // base-game cascade step multipliers
  FS_LADDER: [4, 6, 10, 16, 25, 40, 65, 100], // COSMIC ASCENSION cascade multipliers
  FS_MULT_START: 4,
  FS_MULT_CAP: 100,
  ASCENSION_CHARGES: 12,
  ASCENSION_MULT: 5,
  ASCENSION_PER_SCATTER: 3,
  MAX_CASCADE_STEPS: 12,
  BIG_WIN_TIERS: [
    { name: "COSMIC WIN", mult: 100 },
    { name: "EPIC WIN", mult: 50 },
    { name: "MEGA WIN", mult: 25 },
    { name: "BIG WIN", mult: 10 },
  ],
  DEBUG_MODE: false,
  DEBUG_SEED: null,
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  SUPABASE_EDGE_FUNCTION: "",
  SUPABASE_TABLE: "leaderboard",
  STORAGE_PREFIX: "zodiacAscension.v1.",
  LEADERBOARD_SIZE: 50,
  AUTO_COUNTS: [10, 25, 50, 100, 250, 500],
  RANK_TITLES: [
    { max: 1, title: "COSMIC LEGEND" },
    { max: 5, title: "CELESTIAL MASTER" },
    { max: 10, title: "ZODIAC ASCENDANT" },
    { max: 25, title: "STAR WIELDER" },
    { max: 50, title: "ASTRAL SEEKER" },
  ],
};

/* ========================================================================== *
 * MODULE: Utils
 * ========================================================================== */
const Utils = {
  clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
  lerp(a, b, t) { return a + (b - a) * t; },
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); },
  tween(target, vars) {
    return new Promise((resolve) => {
      gsap.to(target, { ...vars, onComplete: () => resolve(target), overwrite: "auto" });
    });
  },
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
  credits(n) { return (Math.round(n * 100) / 100).toFixed(2); },
};

/* ========================================================================== *
 * MODULE: EventBus + EVENTS
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

const EVENTS = {
  GAME_READY: "GAME_READY", SPIN_STARTED: "SPIN_STARTED", REEL_STOPPED: "REEL_STOPPED",
  SPIN_RESOLVED: "SPIN_RESOLVED", WIN_FOUND: "WIN_FOUND", CASCADE_STARTED: "CASCADE_STARTED",
  CASCADE_FINISHED: "CASCADE_FINISHED", MULTIPLIER_TRIGGERED: "MULTIPLIER_TRIGGERED",
  BONUS_STARTED: "BONUS_STARTED", BONUS_FINISHED: "BONUS_FINISHED", BALANCE_CHANGED: "BALANCE_CHANGED",
  BIG_WIN: "BIG_WIN", AUTO_SPIN_STARTED: "AUTO_SPIN_STARTED", AUTO_SPIN_STOPPED: "AUTO_SPIN_STOPPED",
  AUTO_SPIN_PROGRESS: "AUTO_SPIN_PROGRESS",
  EXIT_REQUESTED: "EXIT_REQUESTED", LEADERBOARD_QUALIFIED: "LEADERBOARD_QUALIFIED",
  LEADERBOARD_SUBMITTED: "LEADERBOARD_SUBMITTED", ERROR: "ERROR", STATE_CHANGED: "STATE_CHANGED",
  ASCENSION_TRIGGERED: "ASCENSION_TRIGGERED",
};

/* ========================================================================== *
 * MODULE: RNG — crypto-backed. DEBUG_MODE + DEBUG_SEED => reproducible.
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
      if (debugMode && seed != null) { activeSeed = seed >>> 0; seeded = mulberry32(activeSeed); }
      else { seeded = null; activeSeed = null; }
      draws = 0;
    },
    isSeeded() { return seeded != null; },
    float() { draws++; return seeded ? seeded() : cryptoFloat(); },
    int(n) { return Math.floor(this.float() * n); },
    pickWeighted(entries) {
      let total = 0;
      for (const e of entries) total += e.weight;
      let r = this.float() * total;
      for (const e of entries) { r -= e.weight; if (r < 0) return e.id; }
      return entries[entries.length - 1].id;
    },
    info() {
      return { source: seeded ? "seeded-mulberry32" : "crypto.getRandomValues", seed: activeSeed, draws };
    },
  };
})();

/* ========================================================================== *
 * MODULE: Glyphs — procedural SVG glyph registry (canvas + DOM shared).
 * Glyph space 24x24. Parts: {d, fill?} | {cx,cy,r} | {cx,cy,rx,ry,rot?}.
 * ========================================================================== */
const Glyphs = {
  // ---- gems (LOW) ----
  emerald: [
    { d: "M6 3 H18 L21 6 V18 L18 21 H6 L3 18 V6 Z" },
    { d: "M8.5 6.5 H15.5 L17.5 8.5 V15.5 L15.5 17.5 H8.5 L6.5 15.5 V8.5 Z" },
    { d: "M8.5 6.5 L6.5 8.5 M15.5 6.5 L17.5 8.5 M8.5 17.5 L6.5 15.5 M15.5 17.5 L17.5 15.5" },
  ],
  ruby: [
    { d: "M4 9 L8 4 H16 L20 9 Z" },
    { d: "M4 9 H20 L12 20 Z" },
    { d: "M8 4 L10 9 L12 20 M16 4 L14 9 L12 20 M10 9 H14" },
  ],
  sapphire: [
    { cx: 12, cy: 12, r: 8.5 },
    { cx: 12, cy: 12, r: 4.4 },
    { d: "M12 3.5 V7.6 M12 16.4 V20.5 M3.5 12 H7.6 M16.4 12 H20.5 M6 6 L8.9 8.9 M18 6 L15.1 8.9 M6 18 L8.9 15.1 M18 18 L15.1 15.1" },
  ],
  amethyst: [
    { d: "M12 2 L16.5 7 V16.5 L12 22 L7.5 16.5 V7 Z" },
    { d: "M12 2 V22 M7.5 7 H16.5 M7.5 16.5 H16.5" },
  ],
  topaz: [
    { d: "M12 2.5 C15 6 19.5 9 19.5 14 A7.5 7.5 0 0 1 4.5 14 C4.5 9 9 6 12 2.5 Z" },
    { cx: 12, cy: 14, r: 4.4 },
    { d: "M12 2.5 V9.6" },
  ],
  diamond: [
    { d: "M7 4 H17 L21 9 L12 21 L3 9 Z" },
    { d: "M3 9 H21 M7 4 L10 9 L12 21 M17 4 L14 9 L12 21" },
    { d: "M19.2 2.4 L19.8 3.9 L21.3 4.5 L19.8 5.1 L19.2 6.6 L18.6 5.1 L17.1 4.5 L18.6 3.9 Z", fill: true },
  ],
  // ---- celestial artifacts (MEDIUM) ----
  ring: [
    { cx: 12, cy: 12, r: 5.6 },
    { cx: 12, cy: 12, rx: 9.4, ry: 3.1, rot: -0.32 },
    { d: "M19.6 4.6 L20.1 5.9 L21.4 6.4 L20.1 6.9 L19.6 8.2 L19.1 6.9 L17.8 6.4 L19.1 5.9 Z", fill: true },
  ],
  crown: [
    { d: "M4 18 L4 9.5 L8.5 13 L12 6.5 L15.5 13 L20 9.5 L20 18 Z" },
    { d: "M4 15.4 H20" },
    { cx: 12, cy: 4.4, r: 1.1, fill: true },
    { cx: 4.4, cy: 7.4, r: 0.8, fill: true },
    { cx: 19.6, cy: 7.4, r: 0.8, fill: true },
  ],
  chalice: [
    { d: "M5 3.5 H19 C19 9.6 16.4 12.8 12 12.8 C7.6 12.8 5 9.6 5 3.5 Z" },
    { d: "M12 12.8 V18" },
    { d: "M8 20.5 H16 M12 18 L8.5 20.5 M12 18 L15.5 20.5" },
    { d: "M13.4 5.4 A2.6 2.6 0 1 0 13.4 9.6 A3.3 3.3 0 0 1 13.4 5.4 Z", fill: true },
  ],
  orb: [
    { cx: 12, cy: 12, r: 7.4 },
    { cx: 12, cy: 12, rx: 10, ry: 3.2, rot: 0.35 },
    { d: "M12 8 L13 11 L16 12 L13 13 L12 16 L11 13 L8 12 L11 11 Z", fill: true },
  ],
  // ---- cosmic powers (HIGH) ----
  sun: [
    { cx: 12, cy: 12, r: 4.6 },
    { d: "M12 2.5 V5.5 M12 18.5 V21.5 M2.5 12 H5.5 M18.5 12 H21.5 M5.3 5.3 L7.4 7.4 M16.6 16.6 L18.7 18.7 M18.7 5.3 L16.6 7.4 M7.4 16.6 L5.3 18.7" },
  ],
  moon: [
    { d: "M15.5 3.8 A8.6 8.6 0 1 0 15.5 20.2 A10.2 10.2 0 0 1 15.5 3.8 Z", fill: true },
    { d: "M17.6 5.8 L18.1 7.1 L19.4 7.6 L18.1 8.1 L17.6 9.4 L17.1 8.1 L15.8 7.6 L17.1 7.1 Z", fill: true },
    { cx: 19.2, cy: 12.4, r: 0.8, fill: true },
  ],
  saturn: [
    { cx: 12, cy: 12, r: 5.4 },
    { cx: 12, cy: 12, rx: 9.6, ry: 3, rot: -0.3 },
    { d: "M7.4 10.2 C9.4 9.2 14.6 9.2 16.6 10.2" },
  ],
  blackhole: [
    { cx: 12, cy: 12, r: 7.6 },
    { cx: 12, cy: 12, r: 3.3, fill: true },
    { d: "M4.2 14.4 A8.6 8.6 0 0 0 12 20.6" },
    { d: "M19.8 9.6 A8.6 8.6 0 0 0 12 3.4" },
    { cx: 4.4, cy: 5.8, r: 0.8, fill: true },
    { cx: 19.8, cy: 17.6, r: 0.8, fill: true },
  ],
  // ---- special ----
  scatter: [
    { cx: 12, cy: 12, r: 9 },
    { cx: 12, cy: 12, r: 5.8 },
    { d: "M17.8 12 L21 12 M17 14.9 L19.8 16.5 M14.9 17 L16.5 19.8 M12 17.8 L12 21 M9.1 17 L7.5 19.8 M7 14.9 L4.2 16.5 M6.2 12 L3 12 M7 9.1 L4.2 7.5 M9.1 7 L7.5 4.2 M12 6.2 L12 3 M14.9 7 L16.5 4.2 M17 9.1 L19.8 7.5" },
    { d: "M12 8.6 L12.9 11.1 L15.4 12 L12.9 12.9 L12 15.4 L11.1 12.9 L8.6 12 L11.1 11.1 Z", fill: true },
    { cx: 19.4, cy: 9.6, r: 0.7, fill: true },
    { cx: 5.6, cy: 16.4, r: 0.7, fill: true },
  ],
  // ---- zodiac ring glyphs (menu decoration) ----
  aries: [{ d: "M12 21 V10" }, { d: "M12 10 C12 4.5 6.5 3 5.5 6.5 C4.8 9.2 7.5 10.8 9.6 9.4" }, { d: "M12 10 C12 4.5 17.5 3 18.5 6.5 C19.2 9.2 16.5 10.8 14.4 9.4" }],
  taurus: [{ cx: 12, cy: 14.6, r: 4.5 }, { d: "M5.5 4 C5.5 8 8.5 10.1 12 10.1 C15.5 10.1 18.5 8 18.5 4" }],
  gemini: [{ d: "M5.5 4.5 C8.5 6.6 15.5 6.6 18.5 4.5" }, { d: "M5.5 19.5 C8.5 17.4 15.5 17.4 18.5 19.5" }, { d: "M9.2 6 V18" }, { d: "M14.8 6 V18" }],
  cancer: [{ cx: 8, cy: 9.2, r: 2.6 }, { cx: 16, cy: 14.8, r: 2.6 }, { d: "M4.5 8.2 C8.5 4.2 15 4.8 19.2 9.5" }, { d: "M19.5 15.8 C15.5 19.8 9 19.2 4.8 14.5" }],
  leo: [{ cx: 7, cy: 15.6, r: 2.4 }, { d: "M9.4 15.6 C13.5 15.6 15.2 13.6 14.6 10.6 C14 7.8 10.4 7.4 9.6 9.9 C8.9 12.1 11.6 13.3 14.4 12.9 C17.2 12.5 18.6 14.6 18 16.8 C17.5 18.7 15.2 19 14.6 17.4" }],
  virgo: [{ d: "M4 13 C4 9.5 6.8 9.5 6.8 12 V15.5" }, { d: "M6.8 12 C6.8 9.5 9.6 9.5 9.6 12 V15.5" }, { d: "M9.6 12 C9.6 9.5 12.4 9.5 12.4 12 V16.5" }, { d: "M12.4 13.5 C14.8 10.8 18.2 12.2 17 14.6 C16 16.6 12.6 16.3 12.4 16.3" }, { d: "M15.6 15.6 L19 19" }],
  libra: [{ d: "M4.5 18.5 H19.5" }, { d: "M4.5 15.2 H7.6" }, { d: "M16.4 15.2 H19.5" }, { d: "M7.6 15.2 C7.6 10.8 9.6 8.6 12 8.6 C14.4 8.6 16.4 10.8 16.4 15.2" }],
  scorpio: [{ d: "M4 13 C4 9.5 6.8 9.5 6.8 12 V15.5" }, { d: "M6.8 12 C6.8 9.5 9.6 9.5 9.6 12 V15.5" }, { d: "M9.6 12 C9.6 9.5 12.4 9.5 12.4 12 V16.5 C12.4 19 14.6 19.8 16.6 18.9 L18.6 17.8" }, { d: "M16.6 15.2 L18.8 17.6 L15.9 18.4" }],
  sagittarius: [{ d: "M4.5 19.5 L19 5" }, { d: "M12.8 5 H19 V11.2" }, { d: "M7.8 11.8 L12.2 16.2" }],
  capricorn: [{ d: "M4 9.5 C4 6.5 6.6 6.3 7.2 8.8 C7.9 11.6 7.6 14 9 15.6" }, { d: "M10.6 12.4 C11.4 10.6 13.6 10.2 14.9 11.4 C16.4 12.7 16 14.9 14.2 15.3 C12.6 15.7 11.6 14.2 12.5 13" }, { d: "M14.2 15.3 C17.8 14.6 19.8 16.8 18.2 18.9 C16.6 21 13.9 19.7 14.9 17.8 C15.5 16.6 17.2 16.7 17.4 17.9" }],
  aquarius: [{ d: "M4.5 9.5 L8 6.2 L11.5 9.5 L15 6.2 L18.5 9.5" }, { d: "M4.5 16 L8 12.7 L11.5 16 L15 12.7 L18.5 16" }],
  pisces: [{ d: "M7.5 4 C10.8 8.5 10.8 15.5 7.5 20" }, { d: "M16.5 4 C13.2 8.5 13.2 15.5 16.5 20" }, { d: "M4 12 H20" }],
};

const TIER_COLORS = {
  fire: "#ff8a4a", earth: "#7dffa8", air: "#6fe3ff", water: "#7aa8ff",
  wild: "#ffd98a", scatter: "#ff7ad9",
};

/* ========================================================================== *
 * MODULE: MATH — symbol table (tunable).
 * id · name · tier · weight · minMatch · pay(units per cluster size) · color
 * payout credits = units * bet / CONFIG.PAY_DIV
 * ========================================================================== */
const SYMBOLS = [
  // LOW — gems
  { id: "emerald", name: "Emerald", tier: "low", weight: 11, minMatch: 5, pay: { 5: 1, 6: 1.5, 7: 2.5, 8: 4, 9: 6, 10: 9, 11: 13, 12: 18 }, color: "#3fe88f" },
  { id: "ruby", name: "Ruby", tier: "low", weight: 10, minMatch: 5, pay: { 5: 1, 6: 1.6, 7: 2.7, 8: 4.2, 9: 6.4, 10: 10, 11: 14, 12: 20 }, color: "#ff5d7a" },
  { id: "sapphire", name: "Sapphire", tier: "low", weight: 9, minMatch: 5, pay: { 5: 1.1, 6: 1.7, 7: 2.9, 8: 4.5, 9: 7, 10: 11, 11: 15, 12: 22 }, color: "#4aa8ff" },
  { id: "amethyst", name: "Amethyst", tier: "low", weight: 8, minMatch: 5, pay: { 5: 1.2, 6: 1.8, 7: 3, 8: 4.8, 9: 7.5, 10: 12, 11: 16, 12: 24 }, color: "#b57aff" },
  { id: "topaz", name: "Topaz", tier: "low", weight: 7.5, minMatch: 5, pay: { 5: 1.3, 6: 2, 7: 3.2, 8: 5, 9: 8, 10: 12.5, 11: 17, 12: 25 }, color: "#ffb84d" },
  { id: "diamond", name: "Cosmic Diamond", tier: "low", weight: 7, minMatch: 5, pay: { 5: 1.5, 6: 2.2, 7: 3.5, 8: 5.5, 9: 9, 10: 14, 11: 19, 12: 28 }, color: "#bff3ff" },
  // MEDIUM — celestial artifacts
  { id: "ring", name: "Celestial Ring", tier: "mid", weight: 6.5, minMatch: 4, pay: { 4: 1.4, 5: 2.2, 6: 3.6, 7: 5.5, 8: 8, 9: 11, 10: 15, 11: 20, 12: 26 }, color: "#ffd98a" },
  { id: "crown", name: "Zodiac Crown", tier: "mid", weight: 6, minMatch: 4, pay: { 4: 1.5, 5: 2.4, 6: 4, 7: 6, 8: 9, 9: 12, 10: 16, 11: 22, 12: 30 }, color: "#ffe9ad" },
  { id: "chalice", name: "Lunar Chalice", tier: "mid", weight: 5.5, minMatch: 4, pay: { 4: 1.7, 5: 2.6, 6: 4.3, 7: 6.5, 8: 9.5, 9: 13, 10: 18, 11: 24, 12: 32 }, color: "#c9d6ff" },
  { id: "orb", name: "Astral Orb", tier: "mid", weight: 5, minMatch: 4, pay: { 4: 1.8, 5: 2.8, 6: 4.6, 7: 7, 8: 10, 9: 14, 10: 19, 11: 26, 12: 35 }, color: "#7ee0d2" },
  // HIGH — cosmic powers
  { id: "sun", name: "Sun", tier: "high", weight: 4.5, minMatch: 4, pay: { 4: 2.2, 5: 3.4, 6: 5.5, 7: 8, 8: 12, 9: 16, 10: 22, 11: 30, 12: 40 }, color: "#ffd24d" },
  { id: "moon", name: "Moon", tier: "high", weight: 4, minMatch: 4, pay: { 4: 2.5, 5: 3.8, 6: 6, 7: 9, 8: 13, 9: 18, 10: 25, 11: 34, 12: 45 }, color: "#e8ecff" },
  { id: "saturn", name: "Saturn", tier: "high", weight: 3.5, minMatch: 4, pay: { 4: 3, 5: 4.5, 6: 7, 7: 10.5, 8: 15, 9: 21, 10: 29, 11: 40, 12: 55 }, color: "#f2a65e" },
  { id: "blackhole", name: "Black Hole", tier: "high", weight: 3, minMatch: 4, pay: { 4: 4, 5: 6, 6: 9, 7: 14, 8: 20, 9: 28, 10: 38, 11: 52, 12: 70 }, color: "#9d6bff" },
  // SPECIAL
  { id: "scatter", name: "Zodiac Scatter", tier: "special", weight: 3.5, minMatch: null, pay: null, color: "#ff7ad9" },
];
const SYMBOL_BY_ID = Object.fromEntries(SYMBOLS.map((s) => [s.id, s]));
const PAYABLE = SYMBOLS.filter((s) => s.pay);
for (const s of PAYABLE) s.payKeys = Object.keys(s.pay).map(Number).sort((a, b) => a - b);

/* Constellation maps for ambient/win art (normalized 0..1). */
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
const CONSTELLATION_IDS = Object.keys(CONSTELLATIONS);

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
    } else if (p.rx != null) {
      ctx.beginPath();
      ctx.ellipse(p.cx, p.cy, p.rx, p.ry, p.rot || 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
      if (p.fill) ctx.fill(); else ctx.stroke();
    }
  }
  ctx.restore();
}
function glyphSVG(glyphId, sizePx, color) {
  const parts = Glyphs[glyphId] || [];
  const inner = parts.map((p) => {
    if (p.d) return `<path d="${p.d}" ${p.fill ? `fill="${color}" stroke="none"` : `fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"`}/>`;
    if (p.rx != null) return `<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}" fill="none" stroke="${color}" stroke-width="1.9" ${p.rot ? `transform="rotate(${(p.rot * 180) / Math.PI} ${p.cx} ${p.cy})"` : ""}/>`;
    return `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" ${p.fill ? `fill="${color}"` : `fill="none" stroke="${color}" stroke-width="1.9"`}/>`;
  }).join("");
  return `<svg viewBox="0 0 24 24" width="${sizePx}" height="${sizePx}">${inner}</svg>`;
}

/* ========================================================================== *
 * MODULE: StorageService + SettingsManager
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
  return { read, write, remove };
})();

const SettingsManager = (() => {
  const DEFAULTS = {
    masterVol: 0.8, sfxVol: 0.9, musicVol: 0.5, muted: false,
    quality: "AUTO", turbo: false, quick: false,
    reducedMotion: false, showFps: false, betIndex: 1, playerName: "",
    skipAnimations: false,
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
 * MODULE: GameStateMachine — strict transition table.
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
      if (state === next) return true;
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
 * MODULE: SlotMath — cluster pays on 6x5. Pure & deterministic per RNG stream.
 * ========================================================================== */
const SlotMath = (() => {
  let debugForce = null;

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
        for (let c = 0; c < reels; c++) for (let r = 0; r < rows; r++) cells.push([c, r]);
        for (let i = cells.length - 1; i > 0; i--) { const j = RNG.int(i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
        for (let i = 0; i < n; i++) grid[cells[i][0]][cells[i][1]] = "scatter";
      } else if (f.type === "symbol") {
        // force a guaranteed cluster: full vertical run on column 0
        const sym = f.symbol || "blackhole";
        for (let r = 0; r < rows; r++) grid[0][r] = sym;
      }
    }
    return grid;
  }

  function clusterPay(sym, size) {
    let k = sym.payKeys[0];
    for (const key of sym.payKeys) { if (size >= key) k = key; else break; }
    return sym.pay[k];
  }

  /* Cluster evaluation: orthogonally-connected groups of the same symbol.
     A group pays when size >= symbol.minMatch. */
  function evaluateGrid(grid, bet) {
    const cols = grid.length, rows = grid[0].length;
    const wins = [];
    const winCellSet = new Set();
    let totalUnits = 0;
    let totalBase = 0;

    for (const sym of PAYABLE) {
      const seen = new Set();
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          if (grid[c][r] !== sym.id) continue;
          const startKey = c * rows + r;
          if (seen.has(startKey)) continue;
          const cluster = [];
          const stack = [[c, r]];
          seen.add(startKey);
          while (stack.length) {
            const [cc, rr] = stack.pop();
            cluster.push([cc, rr]);
            const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            for (const [dc, dr] of nb) {
              const nc = cc + dc, nr = rr + dr;
              if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
              if (grid[nc][nr] !== sym.id) continue;
              const k = nc * rows + nr;
              if (!seen.has(k)) { seen.add(k); stack.push([nc, nr]); }
            }
          }
          if (cluster.length >= sym.minMatch) {
            const units = clusterPay(sym, cluster.length);
            const credits = Math.max(1, Math.round((units * bet) / CONFIG.PAY_DIV));
            totalUnits += units;
            totalBase += credits;
            for (const [cc, rr] of cluster) winCellSet.add(`${cc},${rr}`);
            wins.push({ symbol: sym.id, size: cluster.length, units, credits, cells: cluster });
          }
        }
      }
    }

    let scatterCount = 0;
    const scatterCells = [];
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++)
        if (grid[c][r] === "scatter") { scatterCount++; scatterCells.push([c, r]); }

    return { wins, totalUnits, totalBase, winCells: [...winCellSet], scatterCount, scatterCells };
  }

  function collapseGrid(grid, winCellKeys) {
    const remove = new Set(winCellKeys);
    const { rows } = CONFIG.GRID;
    const newGrid = [];
    const moves = [];
    for (let c = 0; c < grid.length; c++) {
      const kept = [];
      for (let r = rows - 1; r >= 0; r--) if (!remove.has(`${c},${r}`)) kept.push({ sym: grid[c][r], fromRow: r });
      kept.reverse();
      const col = new Array(rows).fill(null);
      const missing = rows - kept.length;
      kept.forEach((k, i) => {
        const toRow = missing + i;
        col[toRow] = k.sym;
        moves.push({ col: c, symbol: k.sym, fromRow: k.fromRow, toRow, fall: toRow - k.fromRow, spawned: false });
      });
      for (let i = 0; i < missing; i++) {
        const sym = RNG.pickWeighted(SYMBOLS);
        col[i] = sym;
        moves.push({ col: c, symbol: sym, fromRow: null, toRow: i, fall: missing, spawned: true });
      }
      newGrid.push(col);
    }
    return { grid: newGrid, moves };
  }

  /* Full outcome precomputed before any animation. */
  function generateOutcome(bet, ctx = {}) {
    const source = RNG.info();
    const steps = [];
    let grid = generateGrid();
    let scatter = null;
    const ascensionUsed = !!ctx.ascensionArmed;
    const globalMult = ascensionUsed ? CONFIG.ASCENSION_MULT : 1;
    let maxMult = 1;

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
      const ladder = ctx.freeSpin ? CONFIG.FS_LADDER : CONFIG.MULT_LADDER;
      const stepMult = ladder[Math.min(i, ladder.length - 1)];
      const mult = stepMult * globalMult;
      if (hasWin) maxMult = Math.max(maxMult, mult);
      const step = {
        grid, eval: ev, mult,
        amount: hasWin ? Math.round(ev.totalBase * mult) : 0,
        collapse: null,
      };
      steps.push(step);
      if (!hasWin) break;
      if (i === CONFIG.MAX_CASCADE_STEPS - 1) break;
      const collapsed = collapseGrid(grid, ev.winCells);
      step.collapse = collapsed;
      grid = collapsed.grid;
    }

    const cascadeWins = steps.reduce((a, s) => a + (s.amount > 0 ? 1 : 0), 0);
    const totalWin = steps.reduce((a, s) => a + s.amount, 0) + (scatter ? scatter.pay : 0);
    return { steps, scatter, totalWin, ascensionUsed, fsMultEnd: maxMult, cascadeWins, source, bet };
  }

  return {
    generateGrid, evaluateGrid, collapseGrid, generateOutcome, clusterPay,
    setDebugForce(f) { debugForce = f; },
  };
})();

const WinEvaluator = { evaluate: (grid, bet) => SlotMath.evaluateGrid(grid, bet) };
const CascadeEngine = { collapse: (grid, keys) => SlotMath.collapseGrid(grid, keys) };

const MultiplierEngine = {
  baseLadder: CONFIG.MULT_LADDER,
  fsLadder: CONFIG.FS_LADDER,
  forStep(index, ctx = {}) {
    const ladder = ctx.freeSpin ? this.fsLadder : this.baseLadder;
    return ladder[Math.min(index, ladder.length - 1)];
  },
};

/* ========================================================================== *
 * MODULE: BonusEngine — COSMIC ASCENSION (free spins).
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
        if (!state.active) break;
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
 * MODULE: ReelEngine — per-column view model.
 * ========================================================================== */
const ReelEngine = (() => {
  const { reels, rows } = CONFIG.GRID;
  const view = [];
  for (let c = 0; c < reels; c++) {
    view.push({ mode: "idle", spinSpeed: 0, spinOffset: 0, spinSymbols: [], cells: [] });
  }
  function initStrips() {
    for (const col of view) {
      col.spinSymbols = [];
      for (let i = 0; i < 30; i++) col.spinSymbols.push(RNG.pickWeighted(SYMBOLS));
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
      if (col.mode === "spin") col.spinOffset = (col.spinOffset + col.spinSpeed * dt) % 30;
    }
  }
  return { view, initStrips, setGrid, cellAt, integrate, rows, reels };
})();

/* ========================================================================== *
 * MODULE: ParticleEngine — pooled.
 * ========================================================================== */
const ParticleEngine = (() => {
  const pool = [];
  let cap = 320;
  return {
    get list() { return pool; },
    setCap(n) { cap = n; while (pool.length > cap) pool.shift(); },
    clear() { pool.length = 0; },
    burst(x, y, color, n = 14, opts = {}) {
      for (let i = 0; i < n; i++) {
        if (pool.length >= cap) pool.shift();
        const a = RNG.float() * Math.PI * 2;
        const sp = (opts.speed || 120) * (0.35 + RNG.float());
        pool.push({
          type: opts.type || "spark", x, y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (opts.lift || 40),
          life: 0, maxLife: (opts.life || 0.7) * (0.6 + RNG.float() * 0.8),
          size: (opts.size || 3) * (0.6 + RNG.float()),
          color, rot: RNG.float() * Math.PI * 2, vr: (RNG.float() - 0.5) * 8,
          grav: opts.grav != null ? opts.grav : 260,
        });
      }
    },
    shards(x, y, color, n = 10) { this.burst(x, y, color, n, { type: "shard", speed: 170, life: 0.8, size: 4, grav: 420 }); },
    stardust(x, y, color, n = 8) { this.burst(x, y, color, n, { type: "dust", speed: 40, life: 1.4, size: 2.2, grav: -18 }); },
    coinFlight(x0, y0, x1, y1, color, n = 8) {
      for (let i = 0; i < n; i++) {
        if (pool.length >= cap) pool.shift();
        const t = i / n;
        pool.push({
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
      for (const p of pool) {
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
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.beginPath(); ctx.arc(p.x - p.size * 0.25, p.y - p.size * 0.25, p.size * 0.35, 0, Math.PI * 2); ctx.fill();
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
  let W = 0, H = 0, meteorTimer = 3, t = 0;
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
      g.addColorStop(1, "rgba(3,4,20,0)");
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
          x: fromLeft ? -40 : W * (0.4 + RNG.float() * 0.7), y: -30,
          vx: (fromLeft ? 1 : -1) * (260 + RNG.float() * 220),
          vy: 300 + RNG.float() * 200, life: 0, maxLife: 1.15,
        });
      }
    }
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      m.life += dt; m.x += m.vx * dt; m.y += m.vy * dt;
      if (m.life > m.maxLife || m.y > H + 60) meteors.splice(i, 1);
    }
  }
  function draw(ctx) {
    if (nebula && QUALITY.nebula) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.drawImage(nebula, 0, 0, W, H);
      ctx.restore();
    }
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
        ctx.beginPath(); ctx.arc(x, y, s.r, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    drawPlanet(ctx, W * 0.1, H * 0.8 + Math.sin(t * 0.4) * 5, Math.min(W, H) * 0.1);
    drawMoon(ctx, W * 0.9, H * 0.14 + Math.sin(t * 0.3 + 2) * 4, Math.min(W, H) * 0.032);
    for (const m of meteors) {
      const a = 1 - m.life / m.maxLife;
      const len = 90;
      const nx = m.x - (m.vx / Math.hypot(m.vx, m.vy)) * len;
      const ny = m.y - (m.vy / Math.hypot(m.vx, m.vy)) * len;
      const g = ctx.createLinearGradient(m.x, m.y, nx, ny);
      g.addColorStop(0, `rgba(255,240,200,${0.85 * a})`);
      g.addColorStop(0.35, `rgba(53,224,255,${0.4 * a})`);
      g.addColorStop(1, "rgba(53,224,255,0)");
      ctx.strokeStyle = g;
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(nx, ny); ctx.stroke();
    }
  }
  function drawPlanet(ctx, x, y, r) {
    ctx.save();
    const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, "#3d5aa8"); g.addColorStop(0.55, "#1c2c66"); g.addColorStop(1, "#0a102f");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(53,224,255,0.13)";
    ctx.lineWidth = r * 0.09;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.ellipse(x, y + i * r * 0.28, r * Math.sqrt(Math.max(0.05, 1 - (i * 0.28) ** 2)), r * 0.16, -0.18, 0.3, Math.PI - 0.3);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(245,201,107,0.3)";
    ctx.lineWidth = r * 0.07;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.65, r * 0.42, -0.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  function drawMoon(ctx, x, y, r) {
    ctx.save();
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, "#f4e7c8"); g.addColorStop(0.7, "#b9a878"); g.addColorStop(1, "#5c5138");
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
 * MODULE: ConstellationEngine
 * ========================================================================== */
const ConstellationEngine = (() => {
  const flashes = [];
  const ambient = [];
  let W = 0, H = 0;
  function build(w, h) {
    W = w; H = h;
    ambient.length = 0;
    for (let i = 0; i < 3; i++) {
      ambient.push({
        id: CONSTELLATION_IDS[(i * 4 + 1) % CONSTELLATION_IDS.length],
        x: w * (0.12 + 0.33 * i) + (RNG.float() - 0.5) * 60,
        y: h * (0.16 + (i % 2) * 0.5) + (RNG.float() - 0.5) * 40,
        size: Math.min(w, h) * (0.16 + RNG.float() * 0.08),
        ph: RNG.float() * Math.PI * 2,
      });
    }
  }
  function flash(id, x, y, size) {
    if (!CONSTELLATIONS[id]) return;
    const f = { id, x, y, size, alpha: 0, phase: 0 };
    flashes.push(f);
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
 * MODULE: Renderer — canvas compositing.
 * ========================================================================== */
const Renderer = (() => {
  let canvas, ctx;
  let W = 0, H = 0, dpr = 1;
  const layout = { ox: 0, oy: 0, cell: 80, gridW: 0, gridH: 0, frameX: 0, frameY: 0, frameW: 0, frameH: 0 };
  let shake = 0;
  const qual = { glow: true, blur: true };

  function init(c) { canvas = c; ctx = c.getContext("2d"); }
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
    const { reels, rows } = CONFIG.GRID;
    const narrow = W < 760;
    const topPad = narrow ? 58 : 70;
    const bottomPad = narrow ? 190 : 168;
    const availH = H - topPad - bottomPad;
    const railPad = W >= 900 && !narrow ? 46 : 8;
    let cell = Math.min(availH / (rows + 0.5), (W - railPad * 2 - 24) / (reels + 0.7));
    cell = Utils.clamp(cell, 34, 132);
    layout.cell = cell;
    layout.gridW = cell * reels;
    layout.gridH = cell * rows;
    layout.ox = (W - layout.gridW) / 2 - (W >= 900 ? 14 : 0);
    layout.oy = topPad + Math.max(0, (availH - layout.gridH * 1.08) / 2);
    layout.frameX = layout.ox - cell * 0.18;
    layout.frameY = layout.oy - cell * 0.18;
    layout.frameW = layout.gridW + cell * 0.36;
    layout.frameH = layout.gridH + cell * 0.36;
  }
  function cellCenter(c, r) {
    return { x: layout.ox + c * layout.cell + layout.cell / 2, y: layout.oy + r * layout.cell + layout.cell / 2 };
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
    const base = (def && def.color) || "#9fd8ff";
    const pad = size * 0.06;
    const s = size - pad * 2;
    roundRect(x + pad, y + pad, s, s, s * 0.18);
    const g = ctx.createRadialGradient(x + size / 2, y + size * 0.36, s * 0.1, x + size / 2, y + size / 2, s * 0.75);
    g.addColorStop(0, Utils.rgba(base, 0.28));
    g.addColorStop(0.6, "rgba(13,18,51,0.92)");
    g.addColorStop(1, "rgba(6,9,30,0.96)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = Utils.rgba(base, 0.4);
    ctx.lineWidth = Math.max(1, size * 0.014);
    ctx.stroke();
  }

  function drawReels(t) {
    const { cell } = layout;
    const { reels, rows } = CONFIG.GRID;
    ctx.save();
    roundRect(layout.frameX, layout.frameY, layout.frameW, layout.frameH, cell * 0.16);
    const bg = ctx.createLinearGradient(0, layout.frameY, 0, layout.frameY + layout.frameH);
    bg.addColorStop(0, "rgba(14,20,56,0.92)");
    bg.addColorStop(0.5, "rgba(8,12,38,0.94)");
    bg.addColorStop(1, "rgba(12,17,48,0.92)");
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = "rgba(245,201,107,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = "rgba(245,201,107,0.13)";
    ctx.lineWidth = 1;
    roundRect(layout.frameX - 5, layout.frameY - 5, layout.frameW + 10, layout.frameH + 10, cell * 0.19);
    ctx.stroke();
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
      ctx.fillRect(-2.5, -2.5, 5, 5);
      ctx.restore();
    }
    ctx.restore();

    for (let c = 0; c < reels; c++) {
      const col = ReelEngine.view[c];
      const x0 = layout.ox + c * cell;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 1, layout.oy - cell * 0.08, cell - 2, layout.gridH + cell * 0.16);
      ctx.clip();

      if (col.mode === "spin") {
        const n = col.spinSymbols.length;
        const speedBlur = qual.blur ? Utils.clamp(col.spinSpeed / 20, 0, 1) : 0;
        for (let k = -1; k < rows + 1; k++) {
          const idx = ((Math.floor(col.spinOffset) + k) % n + n) % n;
          const frac = col.spinOffset - Math.floor(col.spinOffset);
          const y = layout.oy + (k - frac) * cell;
          const sym = col.spinSymbols[idx];
          ctx.globalAlpha = 1;
          drawChip(x0, y, cell, sym);
          const gsize = cell * 0.52;
          const color = (SYMBOL_BY_ID[sym] && SYMBOL_BY_ID[sym].color) || "#9fd8ff";
          if (speedBlur > 0.25) {
            ctx.globalAlpha = 0.35;
            drawGlyph(ctx, sym, x0 + cell / 2, y + cell / 2 - cell * 0.16 * speedBlur, gsize, color, 0);
            drawGlyph(ctx, sym, x0 + cell / 2, y + cell / 2 + cell * 0.16 * speedBlur, gsize, color, 0);
          }
          ctx.globalAlpha = 0.95;
          drawGlyph(ctx, sym, x0 + cell / 2, y + cell / 2, gsize, color, qual.glow ? 6 : 0);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(53,224,255,${0.05 * speedBlur})`;
        ctx.fillRect(x0 + cell * 0.2, layout.oy, cell * 0.06, layout.gridH);
        ctx.fillRect(x0 + cell * 0.7, layout.oy, cell * 0.05, layout.gridH);
      } else {
        for (const cl of col.cells) {
          if (!cl) continue;
          const x = x0;
          const y = layout.oy + cl.row * cell + cl.off;
          ctx.save();
          ctx.globalAlpha = cl.alpha;
          const cx = x + cell / 2, cy = y + cell / 2;
          ctx.translate(cx, cy);
          ctx.scale(cl.scale, cl.scale);
          ctx.translate(-cx, -cy);
          drawChip(x, y, cell, cl.sym);
          const def = SYMBOL_BY_ID[cl.sym];
          const color = (def && def.color) || "#9fd8ff";
          let extraGlow = 0;
          if (cl.sym === "scatter") extraGlow = 0.35 + 0.3 * Math.sin(t * 3 + c * 1.7 + cl.row);
          const glow = qual.glow ? 5 + cl.glow * 22 + extraGlow * 16 : extraGlow * 16;
          drawGlyph(ctx, cl.sym, cx, cy, cell * 0.52, color, glow);
          if (cl.sym === "scatter") {
            ctx.strokeStyle = Utils.rgba("#ffe9ad", 0.35 + 0.25 * Math.sin(t * 3 + c));
            ctx.lineWidth = 1.4;
            roundRect(x + cell * 0.07, y + cell * 0.07, cell * 0.86, cell * 0.86, cell * 0.15);
            ctx.stroke();
          }
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

      if (c > 0) {
        ctx.strokeStyle = "rgba(245,201,107,0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, layout.oy + 4);
        ctx.lineTo(x0, layout.oy + layout.gridH - 4);
        ctx.stroke();
      }
    }

    const sh = ctx.createLinearGradient(0, layout.oy, 0, layout.oy + cell * 0.4);
    sh.addColorStop(0, "rgba(3,4,20,0.6)");
    sh.addColorStop(1, "rgba(3,4,20,0)");
    ctx.fillStyle = sh;
    ctx.fillRect(layout.ox, layout.oy, layout.gridW, cell * 0.4);
    const sh2 = ctx.createLinearGradient(0, layout.oy + layout.gridH - cell * 0.4, 0, layout.oy + layout.gridH);
    sh2.addColorStop(0, "rgba(3,4,20,0)");
    sh2.addColorStop(1, "rgba(3,4,20,0.6)");
    ctx.fillStyle = sh2;
    ctx.fillRect(layout.ox, layout.oy + layout.gridH - cell * 0.4, layout.gridW, cell * 0.4);
  }

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const base = ctx.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, "#05071d");
    base.addColorStop(0.5, "#030414");
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

    const v = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.35, W / 2, H * 0.5, Math.max(W, H) * 0.78);
    v.addColorStop(0, "rgba(3,4,20,0)");
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
  function detectBaseline() {
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    const mobile = /Mobi|Android/i.test(navigator.userAgent);
    if (mobile || cores <= 3 || mem <= 3) return "MEDIUM";
    return "HIGH";
  }
  function apply(name) {
    if (name === "AUTO") current = { name, ...PRESETS[detectBaseline()] };
    else if (PRESETS[name]) current = { name, ...PRESETS[name] };
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
 * MODULE: SoundManager — procedural WebAudio.
 * ========================================================================== */
const SoundManager = (() => {
  let ctx = null, master = null, sfx = null, music = null;
  let ambientNodes = null;
  let lastCoin = 0;

  function ensure() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume(); return ctx; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); sfx = ctx.createGain(); music = ctx.createGain();
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
    reelStop: (i = 0) => { tone(120 - i * 6, 0.11, { type: "sine", gain: 0.2, slide: 55 }); noise(0.06, { gain: 0.05, from: 2200, to: 900 }); },
    tease: () => { tone(220, 0.7, { type: "sine", gain: 0.07, slide: 660 }); tone(330, 0.7, { type: "sine", gain: 0.05, slide: 990, delayT: 0.08 }); },
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
    ambientNodes = { o1, o2, lfo, shimmer, vib };
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
 * MODULE: AnimationEngine — GSAP presentation layer.
 * Consumes a fully precomputed outcome; never influences math.
 * ========================================================================== */
const AnimationEngine = (() => {
  function timing() {
    const s = SettingsManager.all();
    const auto = AutoSpinManager.isActive() ? AutoSpinManager.cfg() : null;
    if (s.quick || (auto && auto.quick)) return { scale: 0.18, label: "quick" };
    if (s.turbo || (auto && auto.turbo)) return { scale: 0.55, label: "turbo" };
    return { scale: 1, label: "normal" };
  }
  function reduced() { return SettingsManager.get("reducedMotion"); }
  function skipWins() {
    const auto = AutoSpinManager.isActive() ? AutoSpinManager.cfg() : null;
    return !!SettingsManager.get("skipAnimations") || !!(auto && auto.skipWin);
  }

  async function animateSpinTo(grid) {
    const T = timing();
    SoundManager.play("spinStart");
    const stopTimes = [];
    for (let c = 0; c < ReelEngine.reels; c++) {
      const col = ReelEngine.view[c];
      col.mode = "spin";
      col.spinOffset = RNG.float() * 30;
      stopTimes.push((0.6 + c * 0.2) * T.scale);
      Utils.tween(col, { spinSpeed: 17 + c, duration: 0.2 + c * 0.03, ease: "power2.out" });
    }
    let landedScatters = 0;
    let teased = false;
    for (let c = 0; c < ReelEngine.reels; c++) {
      const col = ReelEngine.view[c];
      let wait = Math.max(0.05, stopTimes[c] - (0.2 + c * 0.03));
      // Scatter anticipation: 2 landed, later reels still spinning -> suspense.
      if (!teased && landedScatters === 2 && c >= 4 && T.label !== "quick") {
        teased = true;
        wait *= 1.9;
        SoundManager.play("tease");
        for (let cc = 0; cc < c; cc++) {
          for (const cl of ReelEngine.view[cc].cells) {
            if (cl && cl.sym === "scatter") Utils.tween(cl, { glow: 1, duration: 0.26, yoyo: true, repeat: 3, ease: "sine.inOut" });
          }
        }
      }
      await Utils.wait(wait * 1000);
      await Utils.tween(col, { spinSpeed: 0, duration: 0.3 * T.scale, ease: "power3.out" });
      col.mode = "idle";
      col.cells = grid[c].map((sym, r) => ({ sym, row: r, off: -Renderer.frameGeometry().cell * 0.7, scale: 1, alpha: 1, glow: 0 }));
      for (const cl of col.cells) Utils.tween(cl, { off: 0, duration: 0.3 * T.scale, ease: "back.out(2.2)" });
      SoundManager.play("reelStop", c);
      if (!reduced()) Renderer.addShake(2);
      landedScatters += grid[c].filter((s) => s === "scatter").length;
      EventBus.emit(EVENTS.REEL_STOPPED, { reel: c });
    }
    await Utils.wait(90 * T.scale);
  }

  async function animateWin(step) {
    const T = timing();
    const ev = step.eval;
    const cells = [];
    for (const key of ev.winCells) {
      const [c, r] = key.split(",").map(Number);
      const cell = ReelEngine.cellAt(c, r);
      if (cell) cells.push(cell);
    }
    const size = step.amount >= 10 * GameState.data.currentBet ? 3 : step.amount >= 4 * GameState.data.currentBet ? 2 : 1;
    SoundManager.play("win", size);
    const pulse = { v: 0 };
    const pulseUp = Utils.tween(pulse, {
      v: 1, duration: 0.24 * T.scale, ease: "power2.out", repeat: T.label === "quick" ? 0 : 2, yoyo: true,
      onUpdate: () => { for (const cl of cells) cl.glow = pulse.v; },
    });
    const geo = Renderer.frameGeometry();
    for (const key of ev.winCells) {
      const [c, r] = key.split(",").map(Number);
      const p = Renderer.cellCenter(c, r);
      const def = SYMBOL_BY_ID[step.grid[c][r]];
      ParticleEngine.burst(p.x, p.y, (def && def.color) || "#ffe9ad", 7, { speed: 130, life: 0.7 });
    }
    const flashId = CONSTELLATION_IDS[RNG.int(CONSTELLATION_IDS.length)];
    ConstellationEngine.flash(flashId, geo.ox + geo.gridW * 0.5 - geo.cell * 1.2, geo.oy - geo.cell * 0.05, geo.cell * 2.4);
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
    for (const key of ev.winCells) {
      const [c, r] = key.split(",").map(Number);
      const cell = ReelEngine.cellAt(c, r);
      if (!cell) continue;
      const p = Renderer.cellCenter(c, r);
      const def = SYMBOL_BY_ID[cell.sym];
      ParticleEngine.shards(p.x, p.y, (def && def.color) || "#ffe9ad", 8);
      Utils.tween(cell, { scale: 0.05, alpha: 0, duration: 0.2 * T.scale, ease: "power2.in" });
    }
    await Utils.wait(210 * T.scale);
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
        Utils.tween(cl, { off: 0, duration: (0.3 + 0.03 * cl.row) * T.scale, ease: "bounce.out" });
      }
    }
    await Utils.wait(380 * T.scale);
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
        ["#ffe9ad", "#35e0ff", "#ff4fd8", "#7dffa8"][RNG.int(4)],
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
        const skip = skipWins();
        if (!skip) await animateWin(step);
        if (step.mult > 1) {
          EventBus.emit(EVENTS.MULTIPLIER_TRIGGERED, { mult: step.mult });
          SoundManager.play("multiplier");
          if (!skip) {
            UIManager.showMultiplierBadge(step.mult);
            await Utils.wait(260 * T.scale);
          }
        }
        GameState.addBalance(step.amount);
        st.lastWin += step.amount;
        st.sessionScore += step.amount;
        st.biggestWin = Math.max(st.biggestWin, step.amount);
        st.highestMultiplier = Math.max(st.highestMultiplier, step.mult);
        UIManager.updateHUD();
        UIManager.flashChip("balance");
        if (!skip) {
          const geo = Renderer.frameGeometry();
          const chipEl = document.querySelector("#za-balance");
          if (chipEl) {
            const chip = chipEl.getBoundingClientRect();
            ParticleEngine.coinFlight(geo.ox + geo.gridW / 2, geo.oy + geo.gridH / 2, chip.left + chip.width / 2, chip.top + chip.height / 2, "#ffe9ad", T.label === "quick" ? 3 : 8);
          }
          UIManager.floatText(`+${step.amount.toLocaleString()}`, geo.ox + geo.gridW / 2 - 24, geo.oy - 26);
        } else {
          await Utils.wait(110 * T.scale);
        }
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

    if (outcome.scatter) {
      GameState.addBalance(outcome.scatter.pay);
      st.lastWin += outcome.scatter.pay;
      st.sessionScore += outcome.scatter.pay;
      st.biggestWin = Math.max(st.biggestWin, outcome.scatter.pay);
      UIManager.updateHUD();
      UIManager.flashChip("balance");
      const geoS = Renderer.frameGeometry();
      UIManager.floatText(`+${outcome.scatter.pay.toLocaleString()} SCATTER`, geoS.ox + geoS.gridW / 2 - 48, geoS.oy - 26);
    }

    const bet = outcome.bet || st.currentBet;
    outcome.bigTier = false;
    if (outcome.totalWin > 0) {
      const ratio = outcome.totalWin / Math.max(1, bet);
      const tier = CONFIG.BIG_WIN_TIERS.find((t) => ratio >= t.mult);
      outcome.bigTier = !!tier;
      if (tier && !skipWins()) await animateBigWin(tier.name, outcome.totalWin);
    }

    return outcome;
  }

  return { playOutcome, animateSpinTo, animateWin, animateCascade, animateBigWin, animateAscension, timing, reduced, skipWins };
})();

/* ========================================================================== *
 * MODULE: SpinEngine — the single spin pipeline. AutoSpin only repeats this.
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
    if (busy) return null;
    const isFree = free || BonusEngine.isActive();
    const v = validateSpin(isFree);
    if (!v.ok) {
      if (v.reason === "insufficient") {
        SoundManager.play("denied");
        EventBus.emit(EVENTS.ERROR, { type: "INSUFFICIENT_BALANCE" });
      }
      return null;
    }
    if (!FSM.can("SPINNING")) return null;
    busy = true;
    FSM.set("SPINNING", "spin start");

    const st = GameState.data;
    if (!isFree) {
      st.balance -= st.currentBet; // single atomic deduction
      EventBus.emit(EVENTS.BALANCE_CHANGED, { balance: st.balance, delta: -st.currentBet });
    }
    st.spinsPlayed++;
    st.lastWin = 0;
    UIManager.updateHUD();
    UIManager.setSpinBusy(true);
    EventBus.emit(EVENTS.SPIN_STARTED, { bet: isFree ? 0 : st.currentBet, free: isFree });

    // Math first: the ENTIRE outcome is decided here, before any animation.
    const outcome = SlotMath.generateOutcome(isFree ? Math.max(1, st.currentBet) : st.currentBet, {
      freeSpin: isFree,
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

    const extraCascades = Math.max(0, outcome.cascadeWins - 1);
    chargeAscension(extraCascades + (outcome.scatter ? CONFIG.ASCENSION_PER_SCATTER : 0));
    if (outcome.totalWin > 0) st.totalWins++;
    if (isFree && outcome.fsMultEnd) BonusEngine.state.mult = outcome.fsMultEnd;
    AutoSpinManager.recordOutcome({ ...outcome, free: isFree });

    UIManager.setSpinBusy(false);
    EventBus.emit(EVENTS.SPIN_RESOLVED, {
      totalWin: outcome.totalWin, balance: st.balance, scatter: outcome.scatter, free: isFree,
    });

    busy = false;

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
    if (["NAME_ENTRY", "SUBMITTING_SCORE", "GAME_OVER", "EXIT_CONFIRMATION", "PAUSED"].includes(FSM.state)) return;
    if (AutoSpinManager.isActive()) {
      AutoSpinManager.onSpinDone();
      return;
    }
    if (FSM.can("IDLE")) FSM.set("IDLE", "spin end");
    if (GameState.data.balance < CONFIG.MIN_BET) GameEngine.triggerGameOver();
  }

  function userSpin() {
    if (!UIManager.gameStarted) return;
    const blocked = ["menu", "gameover", "name", "settings", "board", "paytable", "exit", "pause", "auto", "howto", "boot"];
    if (blocked.some((n) => UIManager.isOverlayOpen(n))) return;
    if (FSM.state === "PAUSED") return;
    if (AutoSpinManager.isActive()) { AutoSpinManager.stop(); return; }
    SoundManager.ensure();
    spin();
  }

  function spinGap() {
    const T = AnimationEngine.timing();
    return Math.round(480 * T.scale);
  }

  return { spin, userSpin, afterSpin, spinGap, validateSpin };
})();

/* ========================================================================== *
 * MODULE: AutoSpinManager — just repeats spin(); no alternate gameplay path.
 * ========================================================================== */
const AutoSpinManager = (() => {
  let active = false;
  let remaining = 0;
  let lastOutcome = null;
  let cfg = {
    count: 25, turbo: false, quick: false, skipWin: false,
    stopBelow: 0, stopAbove: 0, stopAfterBonus: true, stopAfterBigWin: false,
  };

  function start(opts = {}) {
    if (active || !UIManager.gameStarted) return;
    if (!FSM.can("AUTO_SPIN")) return;
    cfg = { ...cfg, ...opts };
    active = true;
    remaining = cfg.count;
    lastOutcome = null;
    FSM.set("AUTO_SPIN", "auto start");
    EventBus.emit(EVENTS.AUTO_SPIN_STARTED, { ...cfg });
    UIManager.setSpinBusy(true);
    setTimeout(() => UIManager.setSpinBusy(false), 250);
    tick();
  }
  function recordOutcome(o) { lastOutcome = o; }
  function evaluateStops() {
    const st = GameState.data;
    if (st.balance < st.currentBet) return "balance";
    if (cfg.stopBelow > 0 && st.balance < cfg.stopBelow) return "balance-below";
    if (lastOutcome) {
      if (cfg.stopAbove > 0 && lastOutcome.totalWin >= cfg.stopAbove) return "win-above";
      if (cfg.stopAfterBonus && lastOutcome.scatter && !lastOutcome.free) return "bonus";
      if (cfg.stopAfterBigWin && lastOutcome.bigTier) return "big-win";
    }
    return null;
  }
  async function tick() {
    if (!active) return;
    const stopReason = evaluateStops();
    if (stopReason) {
      stop(stopReason);
      if (stopReason === "balance") GameEngine.triggerGameOver();
      return;
    }
    if (remaining !== Infinity) {
      if (remaining <= 0) { stop("count"); return; }
      remaining--;
    }
    EventBus.emit(EVENTS.AUTO_SPIN_PROGRESS, { remaining });
    await SpinEngine.spin();
  }
  function onSpinDone() {
    if (!active) { if (FSM.can("IDLE")) FSM.set("IDLE", "spin end"); return; }
    if (BonusEngine.isActive()) return; // bonus pauses auto; resumes when bonus ends
    setTimeout(tick, SpinEngine.spinGap());
  }
  function stop(reason = "user") {
    if (!active) return;
    active = false;
    EventBus.emit(EVENTS.AUTO_SPIN_STOPPED, { reason });
    if (FSM.can("IDLE")) FSM.set("IDLE", `auto stopped (${reason})`);
  }
  return {
    start, stop, onSpinDone, recordOutcome,
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
    cfg: () => ({ ...cfg }),
  };
})();

/* ========================================================================== *
 * MODULE: LeaderboardService — Supabase-ready, offline-first.
 * ========================================================================== */
const LeaderboardService = (() => {
  let client = null;
  let mode = "local";
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
          StorageService.write("board.cache", data);
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

  async function getTop50() {
    try {
      const { rows, source } = await fetchTop50();
      return { status: rows.length ? "loaded" : "empty", rows, source };
    } catch (e) {
      console.warn("[Leaderboard] getTop50 error", e);
      return { status: "error", rows: [], source: "local" };
    }
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
  function titleForRank(rank) {
    for (const t of CONFIG.RANK_TITLES) if (rank <= t.max) return t.title;
    return "ASTRAL SEEKER";
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

  return { init, fetchTop50, getTop50, submitScore, qualifies, rankOf, titleForRank, getMode: () => mode };
})();

/* ========================================================================== *
 * MODULE: DebugTools — CTRL+SHIFT+D panel + command console.
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
    if (!panel) return;
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
      <input id="zd-cmd" placeholder="cmd: addcredits 500 | seed 42 | forcebonus | forcewin blackhole | spin" />
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
    if (panel) panel.classList.toggle("is-open", open);
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
      case "forcewin": SlotMath.setDebugForce({ type: "symbol", symbol: args[0] || "blackhole" }); break;
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
    }
    UIManager.updateAscension();
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
    if (running) return api;
    rootEl = container;
    container.innerHTML = "";

    SettingsManager.load();
    RNG.configure({ debugMode: CONFIG.DEBUG_MODE, seed: CONFIG.DEBUG_SEED });
    PerformanceManager.apply(SettingsManager.get("quality") || "AUTO");

    const canvas = UIManager.build(container);
    Renderer.init(canvas);
    ReelEngine.initStrips();
    ReelEngine.setGrid(SlotMath.generateGrid()); // idle attract grid (visual only)
    DebugTools.build(container);
    Renderer.resize();

    cleanups.push(EventBus.on(EVENTS.BALANCE_CHANGED, () => UIManager.updateHUD()));
    cleanups.push(EventBus.on(EVENTS.ERROR, (e) => console.warn("[Game]", e)));

    const onKey = (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) { e.preventDefault(); DebugTools.toggle(); return; }
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); SoundManager.unlock(); SpinEngine.userSpin(); }
      if (e.key === "Escape") {
        if (UIManager.isOverlayOpen("gameover") || UIManager.isOverlayOpen("name")) return;
        const anyOpen = ["settings", "board", "paytable", "exit", "auto", "howto", "menu"].some((n) => UIManager.isOverlayOpen(n));
        if (anyOpen) { ["settings", "board", "paytable", "exit", "auto", "howto", "menu"].forEach((n) => UIManager.closeOverlay(n)); return; }
        requestPause();
      }
    };
    const onResize = () => Renderer.resize();
    const onPointer = (e) => AmbientFX.setPointer(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
    const onPointerDown = () => SoundManager.unlock();
    const onCanvasTap = (e) => {
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

    LeaderboardService.init();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (running) Renderer.resize(); });

    UIManager.bootSequence().then(() => {
      FSM.set("IDLE", "boot complete");
      EventBus.emit(EVENTS.GAME_READY, { version: CONFIG.VERSION });
    });

    window.ZODIAC = api;
    return api;
  }

  function requestPause() {
    if (!UIManager.gameStarted) return;
    if (FSM.state === "PAUSED") { resume(); return; }
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
    if (["SPINNING", "EVALUATING", "WINNING", "CASCADING"].includes(FSM.state)) {
      SoundManager.play("denied");
      return;
    }
    EventBus.emit(EVENTS.EXIT_REQUESTED, {});
    if (FSM.state === "AUTO_SPIN") AutoSpinManager.stop("exit");
    if (FSM.can("EXIT_CONFIRMATION")) FSM.set("EXIT_CONFIRMATION", "exit requested");
    UIManager.openOverlay("exit");
    SoundManager.play("ui");
  }
  function resumeFromExit() {
    UIManager.closeOverlay("exit");
    if (FSM.can("IDLE")) FSM.set("IDLE", "exit cancelled");
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
    init, destroy, requestPause, resume, requestExit, resumeFromExit, endSession, newSession, triggerGameOver,
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

export {
  CONFIG, Utils, EventBus, EVENTS, RNG, Glyphs, TIER_COLORS, SYMBOLS, SYMBOL_BY_ID,
  CONSTELLATIONS, CONSTELLATION_IDS, drawGlyph, glyphSVG, StorageService, SettingsManager,
  GameState, FSM, SlotMath, WinEvaluator, CascadeEngine, MultiplierEngine, BonusEngine,
  ReelEngine, ParticleEngine, AmbientFX, ConstellationEngine, Renderer, PerformanceManager,
  SoundManager, AnimationEngine, SpinEngine, AutoSpinManager, LeaderboardService, DebugTools,
  GameEngine,
};
export default GameEngine;
