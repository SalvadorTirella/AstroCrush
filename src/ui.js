/* ============================================================================
 * ZODIAC ASCENSION — Professional UI (Stage 2, updated for Stage 3)
 * HUD, SPIN, bet, auto-spin, settings, paytable, how-to-play, leaderboard,
 * exit flow, final summary, Top-50 entry, fullscreen, audio, responsive.
 *
 * DOM is resolved lazily ($helper) so a missing id can never crash boot.
 * No game math lives here — it consumes engine services & events only.
 * ========================================================================== */

import "./ui.css";
import { gsap } from "gsap";
import {
  GameEngine, CONFIG, EVENTS, EventBus, GameState, FSM, Renderer, SoundManager,
  SettingsManager, AutoSpinManager, BonusEngine, StorageService, LeaderboardService,
  PerformanceManager, SYMBOLS, glyphSVG, TIER_COLORS, Utils, SpinEngine,
} from "./engine";

const STAR_SVG = `<svg viewBox="0 0 24 24"><path d="M12 2 L14.4 9.6 L22 12 L14.4 14.4 L12 22 L9.6 14.4 L2 12 L9.6 9.6 Z" fill="currentColor"/></svg>`;
const ZODIAC_IDS = ["aries", "taurus", "gemini", "cancer", "leo", "virgo", "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces"];

const ICONS = {
  sound: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path class="waves" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12"/></svg>`,
  trophy: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v6a5 5 0 0 1-10 0z"/><path d="M7 6H4a2 2 0 0 0 2 5M17 6h3a2 2 0 0 1-2 5"/></svg>`,
  pause: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`,
  gear: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>`,
  expand: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5 L19 19 M19 5 L5 19"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12 H19"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5 V19 M5 12 H19"/></svg>`,
};

function logoSVG() {
  return `<svg width="34" height="34" viewBox="0 0 34 34">
    <circle cx="17" cy="17" r="15" fill="none" stroke="#f5c96b" stroke-width="1.4" opacity="0.7"/>
    <circle cx="17" cy="17" r="10.5" fill="none" stroke="#35e0ff" stroke-width="0.8" opacity="0.55"/>
    <path d="M17 5 L19.2 13.4 L27.5 17 L19.2 20.6 L17 29 L14.8 20.6 L6.5 17 L14.8 13.4 Z" fill="#ffedbe"/>
    <circle cx="27" cy="8" r="1.6" fill="#35e0ff"/><circle cx="7" cy="25" r="1.3" fill="#ff4fd8"/>
  </svg>`;
}
function zodiacRingSVG(size) {
  let inner = `<circle cx="90" cy="90" r="86" fill="none" stroke="rgba(245,201,107,0.35)" stroke-width="1"/>`;
  inner += `<circle cx="90" cy="90" r="62" fill="none" stroke="rgba(53,224,255,0.25)" stroke-width="0.8" stroke-dasharray="3 6"/>`;
  ZODIAC_IDS.forEach((id, i) => {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const x = 90 + Math.cos(a) * 74, y = 90 + Math.sin(a) * 74;
    const c = TIER_COLORS[["fire", "earth", "air", "water"][i % 4]];
    inner += `<g transform="translate(${x - 9},${y - 9}) scale(0.75)">${glyphSVGParts(id, c)}</g>`;
    inner += `<circle cx="${90 + Math.cos(a) * 86}" cy="${90 + Math.sin(a) * 86}" r="1.6" fill="#ffedbe"/>`;
  });
  inner += `<path d="M90 66 L95 85 L114 90 L95 95 L90 114 L85 95 L66 90 L85 85 Z" fill="#ffedbe" opacity="0.9"/>`;
  return `<svg class="za2-menu-ring" width="${size}" height="${size}" viewBox="0 0 180 180">${inner}</svg>`;
}
function glyphSVGParts(id, color) {
  const svg = glyphSVG(id, 24, color);
  return svg.replace(/<\/?svg[^>]*>/g, "");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function sanitizeName(v) {
  return v
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[<>&"'`\\/]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .slice(0, 16);
}

export const UIManager = (() => {
  let root = null;
  const cache = {};
  let gameStarted = false;
  let railNodes = [];
  let autoCfg = {
    count: 25, turbo: false, quick: false, skipWin: false,
    stopBelow: 0, stopAbove: 0, stopAfterBonus: true, stopAfterBigWin: false,
  };
  let submitting = false;

  function $(id) {
    if (!cache[id]) cache[id] = document.getElementById(id);
    return cache[id];
  }

  const OVERLAY_Z = {
    menu: 56, pause: 58, exit: 59, auto: 60, settings: 62, paytable: 62,
    howto: 62, gameover: 64, name: 66, board: 68, boot: 90,
  };

  /* ------------------------------------------------------------------ build */
  function build(container) {
    root = container;
    root.style.display = "flex";
    root.style.flexDirection = "column";
    container.innerHTML = `
      <canvas id="za-stage"></canvas>

      <div class="za2-hud">
        <div class="za2-logo">
          ${logoSVG()}
          <div>
            <div class="za2-logo-name">ZODIAC ASCENSION</div>
            <span class="za2-logo-sub">COSMIC SLOT</span>
          </div>
        </div>
        <div class="za2-chipset">
          <div class="za2-chip is-gold" id="za-chip-balance"><div class="za2-chip-label">Balance</div><div class="za2-chip-value" id="za-balance">100.00</div></div>
          <div class="za2-chip" id="za-chip-win"><div class="za2-chip-label">Win</div><div class="za2-chip-value" id="za-lastwin">0.00</div></div>
          <div class="za2-chip is-cyan" id="za-chip-score"><div class="za2-chip-label">Score</div><div class="za2-chip-value" id="za-score">0</div></div>
        </div>
        <div class="za2-hudbtns">
          <button class="za2-iconbtn is-on" id="za-sound" title="Sound">${ICONS.sound}</button>
          <button class="za2-iconbtn" id="za-fs" title="Fullscreen">${ICONS.expand}</button>
          <button class="za2-iconbtn" id="za-boardbtn" title="Cosmic Legends">${ICONS.trophy}</button>
          <button class="za2-iconbtn" id="za-pausebtn" title="Menu / Pause">${ICONS.pause}</button>
        </div>
      </div>

      <div class="za2-rail" id="za-rail">
        <span class="za2-rail-title">Ascension</span>
        <div class="za2-rail-nodes" id="za-rail-nodes"></div>
        <span class="za2-rail-count" id="za-rail-count">0/12</span>
      </div>

      <div class="za2-statusbar" id="za-statusbar"></div>

      <div class="za2-console">
        <div class="za2-cons-left">
          <div class="za2-betbox">
            <span class="za2-betbox-label">BET</span>
            <button class="za2-betbtn" id="za-bet-down" aria-label="Decrease bet">${ICONS.minus}</button>
            <span class="za2-bet-value" id="za-bet">2</span>
            <button class="za2-betbtn" id="za-bet-up" aria-label="Increase bet">${ICONS.plus}</button>
          </div>
          <button class="za2-btn is-small" id="za-paytable">Paytable</button>
          <button class="za2-btn is-small is-ghost" id="za-howto">How to Play</button>
          <button class="za2-btn is-small is-danger is-ghost" id="za-exit">Exit</button>
        </div>
        <div class="za2-spinzone" id="za-spinzone">
          <svg class="za2-orbit" viewBox="0 0 100 100">
            <circle class="o-dash" cx="50" cy="50" r="47" fill="none" stroke="rgba(245,201,107,0.3)" stroke-width="1.6" stroke-dasharray="3 8"/>
            <circle class="o-arc" cx="50" cy="50" r="47" fill="none" stroke="#ffedbe" stroke-width="2.4" stroke-dasharray="54 242" stroke-linecap="round"/>
          </svg>
          <button class="za2-spinbtn" id="za-spinbtn" aria-label="Spin">
            <span class="za2-spinbtn-label" id="za-spinlabel">SPIN</span>
            <span class="za2-spinbtn-bet" id="za-spinbet">BET 2</span>
          </button>
        </div>
        <div class="za2-cons-right">
          <button class="za2-btn is-small" id="za-auto">Auto Spin</button>
          <button class="za2-btn is-small is-ghost" id="za-settings">Settings</button>
        </div>
      </div>

      <div class="za2-multibadge" id="za-multibadge">x2</div>
      <div class="za2-banner" id="za-banner">
        <div class="za2-banner-rays"></div>
        <div class="za2-banner-title" id="za-banner-title">BIG WIN</div>
        <div class="za2-banner-amount" id="za-banner-amount">0</div>
      </div>

      <!-- BOOT -->
      <div class="za2-backdrop" id="za-ov-boot" style="background:rgba(3,4,20,0.98);">
        <div class="za2-boot">
          <div class="za2-boot-emblem">${logoSVG().replace('width="34" height="34"', 'width="72" height="72"')}</div>
          <div class="za2-boot-title">ZODIAC<br/><span class="t2">ASCENSION</span></div>
          <div class="za2-boot-bar"><i id="za-boot-fill"></i></div>
          <div class="za2-boot-lines" id="za-boot-lines">CALIBRATING RNG CORE…</div>
        </div>
      </div>

      <!-- MAIN MENU -->
      <div class="za2-backdrop" id="za-ov-menu">
        <div class="za2-modal is-narrow" role="dialog" aria-modal="true" style="text-align:center;">
          <div class="za2-menu-hero">
            ${zodiacRingSVG(172)}
            <h1 class="za2-menu-title">ZODIAC<br/><span class="t2">ASCENSION</span></h1>
            <p class="za2-menu-tag">Connect celestial glyphs across the 6×5 cosmos. Chain cascades up to x100. Trigger the Cosmic Ascension. Enter the legends.</p>
          </div>
          <div class="za2-menu-btns">
            <button class="za2-btn is-primary" id="za-play">Enter the Cosmos</button>
            <button class="za2-btn" id="za-menu-board">Cosmic Legends · Top 50</button>
            <button class="za2-btn" id="za-menu-paytable">Paytable</button>
            <button class="za2-btn" id="za-menu-howto">How to Play</button>
            <button class="za2-btn is-ghost" id="za-menu-settings">Settings</button>
          </div>
          <div class="za2-version">v${CONFIG.VERSION} · ${CONFIG.STAGE}</div>
        </div>
      </div>

      <!-- PAUSE -->
      <div class="za2-backdrop" id="za-ov-pause">
        <div class="za2-modal is-narrow" role="dialog" aria-modal="true">
          <div class="za2-kicker">System</div>
          <h2 class="za2-title">Paused</h2>
          <div class="za2-hr"></div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <button class="za2-btn is-primary" id="za-resume">Resume</button>
            <button class="za2-btn" id="za-pause-settings">Settings</button>
            <button class="za2-btn" id="za-pause-board">Cosmic Legends</button>
            <button class="za2-btn is-danger" id="za-pause-exit">End Session</button>
          </div>
        </div>
      </div>

      <!-- SETTINGS -->
      <div class="za2-backdrop" id="za-ov-settings">
        <div class="za2-modal" role="dialog" aria-modal="true">
          <button class="za2-x" id="za-settings-x" aria-label="Close">${ICONS.x}</button>
          <div class="za2-kicker">Configuration</div>
          <h2 class="za2-title">Settings</h2>
          <div class="za2-tabs" id="za-settabs">
            <button data-tab="audio" class="is-on">Audio</button>
            <button data-tab="graphics">Graphics</button>
            <button data-tab="animation">Animation</button>
            <button data-tab="gameplay">Gameplay</button>
            <button data-tab="other">Other</button>
          </div>
          <div class="za2-tabpanel is-on" id="za-panel-audio">
            <div class="za2-setrow">
              <div><div class="za2-setname">Master Volume</div></div>
              <input type="range" class="za2-range" id="za-vol-master" min="0" max="100" aria-label="Master volume"/>
            </div>
            <div class="za2-setrow">
              <div><div class="za2-setname">Sound Effects</div></div>
              <input type="range" class="za2-range" id="za-vol-sfx" min="0" max="100" aria-label="SFX volume"/>
            </div>
            <div class="za2-setrow">
              <div><div class="za2-setname">Music / Ambience</div></div>
              <input type="range" class="za2-range" id="za-vol-music" min="0" max="100" aria-label="Music volume"/>
            </div>
            <div class="za2-setrow">
              <div><div class="za2-setname">Mute All</div></div>
              <div class="za2-toggle" id="za-tg-mute" role="switch" tabindex="0"><i></i></div>
            </div>
          </div>
          <div class="za2-tabpanel" id="za-panel-graphics">
            <div class="za2-setrow">
              <div><div class="za2-setname">Quality Preset</div><div class="za2-setdesc">Visuals only — never touches odds or math.</div></div>
              <div class="za2-seg" id="za-quality-seg"></div>
            </div>
          </div>
          <div class="za2-tabpanel" id="za-panel-animation">
            <div class="za2-setrow">
              <div><div class="za2-setname">Animation Mode</div><div class="za2-setdesc">Full · Reduced motion · Turbo presentation.</div></div>
              <div class="za2-seg" id="za-anim-seg">
                <button data-anim="full">Full</button>
                <button data-anim="reduced">Reduced</button>
                <button data-anim="turbo">Turbo</button>
              </div>
            </div>
          </div>
          <div class="za2-tabpanel" id="za-panel-gameplay">
            <div class="za2-setrow">
              <div><div class="za2-setname">Turbo Spin</div><div class="za2-setdesc">~2x reel speed.</div></div>
              <div class="za2-toggle" id="za-tg-turbo" role="switch" tabindex="0"><i></i></div>
            </div>
            <div class="za2-setrow">
              <div><div class="za2-setname">Quick Spin</div><div class="za2-setdesc">Near-instant resolution with feedback.</div></div>
              <div class="za2-toggle" id="za-tg-quick" role="switch" tabindex="0"><i></i></div>
            </div>
            <div class="za2-setrow">
              <div><div class="za2-setname">Skip Win Animations</div><div class="za2-setdesc">Math always resolves — only presentation is skipped.</div></div>
              <div class="za2-toggle" id="za-tg-skip" role="switch" tabindex="0"><i></i></div>
            </div>
          </div>
          <div class="za2-tabpanel" id="za-panel-other">
            <div class="za2-setrow">
              <div><div class="za2-setname">How to Play</div><div class="za2-setdesc">The eleven laws of ascension.</div></div>
              <button class="za2-btn is-small" id="za-ot-howto">Open</button>
            </div>
            <div class="za2-setrow">
              <div><div class="za2-setname">Paytable</div><div class="za2-setdesc">Glyphs, clusters and multipliers.</div></div>
              <button class="za2-btn is-small" id="za-ot-paytable">Open</button>
            </div>
            <div class="za2-setrow">
              <div><div class="za2-setname">Cosmic Legends</div><div class="za2-setdesc">Top 50 rankings.</div></div>
              <button class="za2-btn is-small" id="za-ot-board">Open</button>
            </div>
            <div class="za2-setrow">
              <div><div class="za2-setname">Reset Local Data</div><div class="za2-setdesc">Clears settings and local leaderboard marks.</div></div>
              <button class="za2-btn is-small is-danger" id="za-reset-data">Reset</button>
            </div>
          </div>
        </div>
      </div>

      <!-- PAYTABLE -->
      <div class="za2-backdrop" id="za-ov-paytable">
        <div class="za2-modal" role="dialog" aria-modal="true">
          <button class="za2-x" id="za-paytable-x" aria-label="Close">${ICONS.x}</button>
          <div class="za2-kicker">Star Charts</div>
          <h2 class="za2-title">Paytable</h2>
          <p class="za2-lede">Cluster pays on a 6×5 cosmos — connect <b style="color:var(--cyan)">touching glyphs</b> (up / down / left / right). Each cascade step raises the multiplier. Values shown are bet units (payout = units × bet ÷ 2).</p>
          <div class="za2-pay-grid" id="za-pay-grid"></div>
          <div class="za2-hr"></div>
          <div class="za2-kicker" style="color:var(--magenta)">Cascade Multipliers</div>
          <div class="za2-multladder" id="za-mult-ladder"></div>
          <div class="za2-kicker" style="margin-top:14px;">Cosmic Ascension Multipliers</div>
          <div class="za2-multladder" id="za-fs-ladder"></div>
          <div class="za2-hr"></div>
          <div style="text-align:right;"><button class="za2-btn is-primary is-small" id="za-paytable-close">Close</button></div>
        </div>
      </div>

      <!-- HOW TO PLAY -->
      <div class="za2-backdrop" id="za-ov-howto">
        <div class="za2-modal" role="dialog" aria-modal="true">
          <button class="za2-x" id="za-howto-x" aria-label="Close">${ICONS.x}</button>
          <div class="za2-kicker">The Eleven Laws</div>
          <h2 class="za2-title">How to Play</h2>
          <div class="za2-howto">
            <div class="za2-howto-item"><div class="za2-howto-num">1</div><div><h5>Balance</h5><p>You enter the cosmos with <b>100.00 credits</b>. Every spin wagers your current bet; every cluster returns credits.</p></div></div>
            <div class="za2-howto-item"><div class="za2-howto-num">2</div><div><h5>Bet</h5><p>Choose between <b>1 and 20 credits</b> with the − / + controls. You can never bet more than your balance.</p></div></div>
            <div class="za2-howto-item"><div class="za2-howto-num">3</div><div><h5>Spin</h5><p>Press <b>SPIN</b> or hit Space. Six reels accelerate, cruise and stop one by one — the result is sealed by crypto-RNG before a single reel moves.</p></div></div>
            <div class="za2-howto-item"><div class="za2-howto-num">4</div><div><h5>Wins</h5><p>Groups of <b>touching matching glyphs</b> pay. Gems need 5+, artifacts and cosmic powers need 4+. Bigger clusters pay far more.</p></div></div>
            <div class="za2-howto-item"><div class="za2-howto-num">5</div><div><h5>Cascades</h5><p>Winning glyphs shatter, the column collapses and new glyphs fall from the void. Evaluation repeats — <b>chains of cascades</b> are the heart of ascension.</p></div></div>
            <div class="za2-howto-item"><div class="za2-howto-num">6</div><div><h5>Multipliers</h5><p>Each cascade step climbs the ladder <b>x1 → x2 → x3 → x5 → x10 → x25 → x50 → x100</b>. Multipliers belong to the math, never to the animation.</p></div></div>
            <div class="za2-howto-item"><div class="za2-howto-num">7</div><div><h5>Zodiac Scatter</h5><p>The celestial wheel pays anywhere: 3+ scatters pay <b>2× / 5× / 25×</b> your bet and open the gate…</p></div></div>
            <div class="za2-howto-item"><div class="za2-howto-num">8</div><div><h5>Cosmic Ascension</h5><p>3 / 4 / 5 scatters grant <b>8 / 12 / 20 free spins</b> with their own multiplier ladder starting at <b>x4</b> — no bet is deducted.</p></div></div>
            <div class="za2-howto-item"><div class="za2-howto-num">9</div><div><h5>Zodiac Ascension Meter</h5><p>Deep cascade chains and scatters charge the right rail. When it fills, your next spin is <b>ARMED ×5</b>.</p></div></div>
            <div class="za2-howto-item"><div class="za2-howto-num">10</div><div><h5>Auto Spin</h5><p>Delegate 10–500 spins with turbo, quick, skip-win and <b>stop conditions</b> (balance below, win above, after bonus, after big win). Any spin button press halts it.</p></div></div>
            <div class="za2-howto-item"><div class="za2-howto-num">11</div><div><h5>Cosmic Legends</h5><p>Your session score competes for the <b>Top 50</b>. Qualify and the stars will remember your name — from ASTRAL SEEKER to COSMIC LEGEND.</p></div></div>
          </div>
          <div class="za2-hr"></div>
          <div style="text-align:right;"><button class="za2-btn is-primary is-small" id="za-howto-close">Understood</button></div>
        </div>
      </div>

      <!-- AUTO SPIN -->
      <div class="za2-backdrop" id="za-ov-auto">
        <div class="za2-modal is-narrow" role="dialog" aria-modal="true">
          <button class="za2-x" id="za-auto-x" aria-label="Close">${ICONS.x}</button>
          <div class="za2-kicker">Autopilot</div>
          <h2 class="za2-title">Auto Spin Settings</h2>
          <div class="za2-auto-section">
            <h4>Number of Spins</h4>
            <div class="za2-countgrid" id="za-auto-counts"></div>
          </div>
          <div class="za2-auto-section">
            <h4>Spin Mode</h4>
            <div class="za2-setrow"><div><div class="za2-setname">Turbo Spin</div></div><div class="za2-toggle" id="za-auto-turbo" role="switch" tabindex="0"><i></i></div></div>
            <div class="za2-setrow"><div><div class="za2-setname">Quick Spin</div></div><div class="za2-toggle" id="za-auto-quick" role="switch" tabindex="0"><i></i></div></div>
            <div class="za2-setrow"><div><div class="za2-setname">Skip Win Animations</div></div><div class="za2-toggle" id="za-auto-skip" role="switch" tabindex="0"><i></i></div></div>
          </div>
          <div class="za2-auto-section">
            <h4>Stop Conditions</h4>
            <div class="za2-setrow"><div><div class="za2-setname">Stop if Balance Below</div><div class="za2-setdesc">0 = disabled</div></div><input type="number" class="za2-numfield" id="za-auto-stopbelow" min="0" step="1" value="0"/></div>
            <div class="za2-setrow"><div><div class="za2-setname">Stop if Single Win Above</div><div class="za2-setdesc">0 = disabled</div></div><input type="number" class="za2-numfield" id="za-auto-stopabove" min="0" step="1" value="0"/></div>
            <div class="za2-setrow"><div><div class="za2-setname">Stop After Bonus</div></div><div class="za2-toggle" id="za-auto-stopbonus" role="switch" tabindex="0"><i></i></div></div>
            <div class="za2-setrow"><div><div class="za2-setname">Stop After Big Win</div></div><div class="za2-toggle" id="za-auto-stopbigwin" role="switch" tabindex="0"><i></i></div></div>
          </div>
          <div class="za2-autoprogress" id="za-autoprogress">SPINS LEFT <b id="za-autoprogress-text">0</b>
            <button class="za2-btn is-small is-danger" id="za-autostop-inline" style="margin-left:10px;">Stop</button>
          </div>
          <div class="za2-hr"></div>
          <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button class="za2-btn is-ghost" id="za-auto-cancel">Cancel</button>
            <button class="za2-btn is-primary" id="za-autostart">Start Auto Spin</button>
          </div>
        </div>
      </div>

      <!-- COSMIC LEGENDS -->
      <div class="za2-backdrop" id="za-ov-board">
        <div class="za2-modal" role="dialog" aria-modal="true">
          <button class="za2-x" id="za-board-x" aria-label="Close">${ICONS.x}</button>
          <div class="za2-board-head">
            <div>
              <div class="za2-kicker">Hall of Stars</div>
              <h2 class="za2-title">Cosmic Legends</h2>
            </div>
            <span class="za2-board-mode" id="za-board-mode">LOCAL</span>
          </div>
          <div class="za2-hr"></div>
          <div class="za2-board-cols"><span>Rank</span><span>Player</span><span>Score</span></div>
          <div id="za-board-body"><div class="za2-board-state"><div class="za2-spinner"></div><p>Charting star positions…</p></div></div>
          <div class="za2-hr"></div>
          <div style="display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap;">
            <span class="za2-note" id="za-board-note"></span>
            <div style="display:flex;gap:10px;">
              <button class="za2-btn is-small" id="za-board-refresh">Refresh</button>
              <button class="za2-btn is-primary is-small" id="za-board-close">Close</button>
            </div>
          </div>
        </div>
      </div>

      <!-- EXIT -->
      <div class="za2-backdrop" id="za-ov-exit">
        <div class="za2-modal is-narrow" role="dialog" aria-modal="true" style="text-align:center;">
          <div class="za2-kicker">Exit Request</div>
          <h2 class="za2-title is-magenta">Leave the Cosmos?</h2>
          <p class="za2-lede">Your current score</p>
          <div class="za2-bigscore" id="za-exit-score">0</div>
          <p class="za2-note">If you qualify for the Top 50, you may still record your name among the legends.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;">
            <button class="za2-btn" id="za-exit-cancel">Continue Playing</button>
            <button class="za2-btn is-danger" id="za-exit-confirm">Leave</button>
          </div>
        </div>
      </div>

      <!-- NAME ENTRY -->
      <div class="za2-backdrop" id="za-ov-name">
        <div class="za2-modal is-narrow" role="dialog" aria-modal="true" style="text-align:center;">
          <div class="za2-kicker">Leaderboard Qualified</div>
          <h2 class="za2-title">The Stars Have<br/>Remembered You</h2>
          <p class="za2-lede">You entered the <b style="color:var(--gold-hi)">COSMIC LEGENDS</b></p>
          <div class="za2-rankline"><span class="rk" id="za-name-rank">#17</span><span class="rt" id="za-name-title">ZODIAC ASCENDANT</span></div>
          <p class="za2-kicker" style="margin-top:16px;">Enter your name</p>
          <input class="za2-input" id="za-name-input" maxlength="16" placeholder="ORION-7" autocomplete="off" aria-label="Player name"/>
          <div class="za2-note" id="za-name-note" style="margin-top:8px;min-height:18px;">Max 16 characters.</div>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:14px;">
            <button class="za2-btn is-ghost" id="za-name-skip">Skip</button>
            <button class="za2-btn is-primary" id="za-name-submit">Save Score</button>
          </div>
        </div>
      </div>

      <!-- GAME OVER / FINAL SUMMARY -->
      <div class="za2-backdrop" id="za-ov-gameover">
        <div class="za2-modal" role="dialog" aria-modal="true" style="text-align:center;">
          <div class="za2-kicker" id="za-go-kicker">Session Closed</div>
          <h2 class="za2-title">Cosmic Journey<br/>Complete</h2>
          <p class="za2-lede" style="margin-bottom:2px;">Your Cosmic Journey</p>
          <div class="za2-bigscore" id="za-go-score">0</div>
          <div class="za2-stats">
            <div class="za2-stat"><div class="za2-stat-label">Starting Balance</div><div class="za2-stat-value">${CONFIG.START_BALANCE}</div></div>
            <div class="za2-stat"><div class="za2-stat-label">Spins</div><div class="za2-stat-value" id="za-go-spins">0</div></div>
            <div class="za2-stat"><div class="za2-stat-label">Total Wins</div><div class="za2-stat-value" id="za-go-wins">0</div></div>
            <div class="za2-stat"><div class="za2-stat-label">Biggest Win</div><div class="za2-stat-value" id="za-go-big">0</div></div>
            <div class="za2-stat is-cyan"><div class="za2-stat-label">Best Multiplier</div><div class="za2-stat-value" id="za-go-mult">x1</div></div>
            <div class="za2-stat is-cyan"><div class="za2-stat-label">Cascades</div><div class="za2-stat-value" id="za-go-casc">0</div></div>
            <div class="za2-stat" style="grid-column:1/-1;"><div class="za2-stat-label">Zodiac Ascensions</div><div class="za2-stat-value" id="za-go-asc">0</div></div>
          </div>
          <div class="za2-rankline" id="za-go-rankline" style="display:none;"><span class="rk" id="za-go-rank">#—</span><span class="rt" id="za-go-ranktitle">ASTRAL SEEKER</span></div>
          <div class="za2-note" id="za-go-note"></div>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap;">
            <button class="za2-btn" id="za-go-board" style="display:none;">View Rankings</button>
            <button class="za2-btn" id="za-go-name" style="display:none;">Record Score</button>
            <button class="za2-btn is-primary" id="za-go-restart">New Ascension · ${CONFIG.START_BALANCE} Credits</button>
          </div>
        </div>
      </div>

      <div class="za-debug" id="za-debug"></div>
    `;

    for (const [name, z] of Object.entries(OVERLAY_Z)) {
      const ov = $("za-ov-" + name);
      if (ov) ov.style.zIndex = String(z);
    }

    buildRail();
    buildAutoCounts();
    buildPaytable();
    buildQualitySeg();
    bind();
    wireEvents();
    syncFromSettings();
    updateHUD();
    return $("za-stage");
  }

  /* ------------------------------------------------------------- builders */
  function buildRail() {
    const wrap = $("za-rail-nodes");
    if (!wrap) return;
    wrap.innerHTML = "";
    railNodes = [];
    for (let i = 0; i < CONFIG.ASCENSION_CHARGES; i++) {
      const n = document.createElement("span");
      n.className = "za2-rail-node";
      n.innerHTML = STAR_SVG;
      wrap.appendChild(n);
      railNodes.push(n);
    }
  }
  function buildAutoCounts() {
    const wrap = $("za-auto-counts");
    if (!wrap) return;
    wrap.innerHTML = "";
    for (const n of CONFIG.AUTO_COUNTS) {
      const b = document.createElement("button");
      b.className = "za2-count" + (n === autoCfg.count ? " is-on" : "");
      b.textContent = n;
      b.addEventListener("click", () => {
        autoCfg.count = n;
        SoundManager.play("ui");
        wrap.querySelectorAll(".za2-count").forEach((x) => x.classList.toggle("is-on", x === b));
      });
      wrap.appendChild(b);
    }
  }
  function buildPaytable() {
    const grid = $("za-pay-grid");
    if (!grid) return;
    grid.innerHTML = "";
    for (const s of SYMBOLS) {
      const cell = document.createElement("div");
      cell.className = "za2-pay-cell";
      cell.style.color = s.color;
      let nums;
      if (s.pay) {
        const keys = s.payKeys;
        const pick = [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]];
        nums = pick.map((k) => `≥${k} · ${Utils.fmt(s.pay[k])}`).join("<br/>");
      } else {
        nums = `3+ → ${CONFIG.FREE_SPINS[3]} FS<br/>4+ → ${CONFIG.FREE_SPINS[4]} FS<br/>5+ → ${CONFIG.FREE_SPINS[5]} FS<br/><span style="color:var(--muted)">scatter pay 2×/5×/25× bet</span>`;
      }
      cell.innerHTML = `${glyphSVG(s.id, 44, s.color)}
        <span class="za2-pay-tier">${s.tier.toUpperCase()}</span>
        <span class="za2-pay-name" style="color:var(--ink);">${s.name}</span>
        <span class="za2-pay-nums">${nums}</span>`;
      grid.appendChild(cell);
    }
    const lad = $("za-mult-ladder");
    if (lad) lad.innerHTML = CONFIG.MULT_LADDER.map((m, i) => `<span class="za2-multchip ${i === CONFIG.MULT_LADDER.length - 1 ? "is-top" : ""}">x${m}</span>`).join("");
    const fsl = $("za-fs-ladder");
    if (fsl) fsl.innerHTML = CONFIG.FS_LADDER.map((m, i) => `<span class="za2-multchip ${i === CONFIG.FS_LADDER.length - 1 ? "is-top" : ""}">x${m}</span>`).join("");
  }
  function buildQualitySeg() {
    const seg = $("za-quality-seg");
    if (!seg) return;
    seg.innerHTML = "";
    for (const p of PerformanceManager.presetNames()) {
      const b = document.createElement("button");
      b.textContent = p;
      b.dataset.q = p;
      b.addEventListener("click", () => {
        SoundManager.play("ui");
        SettingsManager.set("quality", p);
        PerformanceManager.apply(p);
        syncFromSettings();
      });
      seg.appendChild(b);
    }
  }

  /* ----------------------------------------------------------------- bind */
  function on(id, fn) {
    const el = $(id);
    if (el) el.addEventListener("click", (e) => { fn(e); });
  }
  function bind() {
    // spin + bet
    const spin = $("za-spinbtn");
    if (spin) {
      spin.addEventListener("click", () => SpinAction());
      spin.addEventListener("pointerdown", () => spin.classList.add("is-pressed"));
      ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
        spin.addEventListener(ev, () => spin.classList.remove("is-pressed")));
    }
    on("za-bet-down", () => changeBet(-1));
    on("za-bet-up", () => changeBet(1));

    // console buttons
    on("za-auto", () => { SoundManager.play("ui"); syncAutoModal(); openOverlay("auto"); });
    on("za-settings", () => { SoundManager.play("ui"); openOverlay("settings"); });
    on("za-paytable", () => { SoundManager.play("ui"); openOverlay("paytable"); });
    on("za-howto", () => { SoundManager.play("ui"); openOverlay("howto"); });
    on("za-exit", () => GameEngine.requestExit());

    // hud buttons
    on("za-sound", () => {
      SettingsManager.set("muted", !SettingsManager.get("muted"));
      SoundManager.applyVolumes();
      syncFromSettings();
      SoundManager.play("ui");
    });
    on("za-fs", () => toggleFullscreen());
    on("za-boardbtn", () => { SoundManager.play("ui"); openBoard(); });
    on("za-pausebtn", () => GameEngine.requestPause());

    // menu
    on("za-play", () => {
      SoundManager.unlock();
      SoundManager.play("ui");
      closeOverlay("menu");
      gameStarted = true;
      setSpinBusy(false);
    });
    on("za-menu-board", () => { SoundManager.play("ui"); openBoard(); });
    on("za-menu-paytable", () => { SoundManager.play("ui"); openOverlay("paytable"); });
    on("za-menu-howto", () => { SoundManager.play("ui"); openOverlay("howto"); });
    on("za-menu-settings", () => { SoundManager.play("ui"); openOverlay("settings"); });

    // pause
    on("za-resume", () => GameEngine.resume());
    on("za-pause-settings", () => { SoundManager.play("ui"); openOverlay("settings"); });
    on("za-pause-board", () => { SoundManager.play("ui"); openBoard(); });
    on("za-pause-exit", () => { SoundManager.play("ui"); closeOverlay("pause"); GameEngine.requestExit(); });

    // settings
    on("za-settings-x", () => { SoundManager.play("ui"); closeOverlay("settings"); });
    const tabs = $("za-settabs");
    if (tabs) {
      tabs.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          SoundManager.play("ui");
          tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("is-on", x === b));
          ["audio", "graphics", "animation", "gameplay", "other"].forEach((t) => {
            const p = $("za-panel-" + t);
            if (p) p.classList.toggle("is-on", t === b.dataset.tab);
          });
        });
      });
    }
    const range = (id, key) => {
      const el = $(id);
      if (el) el.addEventListener("input", (e) => {
        SettingsManager.set(key, e.target.value / 100);
        SoundManager.applyVolumes();
        paintRange(e.target);
      });
    };
    range("za-vol-master", "masterVol");
    range("za-vol-sfx", "sfxVol");
    range("za-vol-music", "musicVol");
    toggleBind("za-tg-mute", () => {
      SettingsManager.set("muted", !SettingsManager.get("muted"));
      SoundManager.applyVolumes();
    });
    const animSeg = $("za-anim-seg");
    if (animSeg) {
      animSeg.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          SoundManager.play("ui");
          const mode = b.dataset.anim;
          SettingsManager.set("reducedMotion", mode === "reduced");
          SettingsManager.set("turbo", mode === "turbo");
          if (mode === "turbo") SettingsManager.set("quick", false);
          syncFromSettings();
        });
      });
    }
    toggleBind("za-tg-turbo", () => SettingsManager.set("turbo", !SettingsManager.get("turbo")));
    toggleBind("za-tg-quick", () => SettingsManager.set("quick", !SettingsManager.get("quick")));
    toggleBind("za-tg-skip", () => SettingsManager.set("skipAnimations", !SettingsManager.get("skipAnimations")));
    on("za-ot-howto", () => { SoundManager.play("ui"); closeOverlay("settings"); openOverlay("howto"); });
    on("za-ot-paytable", () => { SoundManager.play("ui"); closeOverlay("settings"); openOverlay("paytable"); });
    on("za-ot-board", () => { SoundManager.play("ui"); closeOverlay("settings"); openBoard(); });
    on("za-reset-data", () => {
      StorageService.remove("settings");
      StorageService.remove("board.submitted");
      StorageService.remove("board.pending");
      SettingsManager.reset();
      SettingsManager.load();
      syncFromSettings();
      SoundManager.play("ui");
    });

    // paytable / howto close
    on("za-paytable-x", () => closeOverlay("paytable"));
    on("za-paytable-close", () => { SoundManager.play("ui"); closeOverlay("paytable"); });
    on("za-howto-x", () => closeOverlay("howto"));
    on("za-howto-close", () => { SoundManager.play("ui"); closeOverlay("howto"); });

    // auto modal
    on("za-auto-x", () => closeOverlay("auto"));
    on("za-auto-cancel", () => { SoundManager.play("ui"); closeOverlay("auto"); });
    toggleBind("za-auto-turbo", () => { autoCfg.turbo = !autoCfg.turbo; });
    toggleBind("za-auto-quick", () => { autoCfg.quick = !autoCfg.quick; });
    toggleBind("za-auto-skip", () => { autoCfg.skipWin = !autoCfg.skipWin; });
    toggleBind("za-auto-stopbonus", () => { autoCfg.stopAfterBonus = !autoCfg.stopAfterBonus; });
    toggleBind("za-auto-stopbigwin", () => { autoCfg.stopAfterBigWin = !autoCfg.stopAfterBigWin; });
    const nb = $("za-auto-stopbelow");
    if (nb) nb.addEventListener("change", (e) => { autoCfg.stopBelow = Math.max(0, parseInt(e.target.value, 10) || 0); e.target.value = autoCfg.stopBelow; });
    const na = $("za-auto-stopabove");
    if (na) na.addEventListener("change", (e) => { autoCfg.stopAbove = Math.max(0, parseInt(e.target.value, 10) || 0); e.target.value = autoCfg.stopAbove; });
    on("za-autostart", () => {
      SoundManager.play("ui");
      closeOverlay("auto");
      AutoSpinManager.start({ ...autoCfg });
    });
    on("za-autostop-inline", () => { SoundManager.play("ui"); AutoSpinManager.stop("user"); });

    // board
    on("za-board-x", () => closeOverlay("board"));
    on("za-board-close", () => { SoundManager.play("ui"); closeOverlay("board"); });
    on("za-board-refresh", () => { SoundManager.play("ui"); refreshBoard(); });

    // exit
    on("za-exit-cancel", () => GameEngine.resumeFromExit());
    on("za-exit-confirm", () => { SoundManager.play("ui"); GameEngine.endSession(); });

    // name entry
    on("za-name-submit", () => submitName());
    on("za-name-skip", () => { SoundManager.play("ui"); closeOverlay("name"); showGameOver(); });
    const nameInput = $("za-name-input");
    if (nameInput) {
      nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitName(); });
      nameInput.addEventListener("input", () => {
        const clean = sanitizeName(nameInput.value);
        if (clean !== nameInput.value.toUpperCase()) nameInput.value = clean;
      });
    }

    // game over
    on("za-go-restart", () => { SoundManager.play("ui"); GameEngine.newSession(); });
    on("za-go-board", () => { SoundManager.play("ui"); openBoard(); });
    on("za-go-name", () => { SoundManager.play("ui"); showNameEntry(); });
  }
  function toggleBind(id, fn) {
    const el = $(id);
    if (!el) return;
    const h = () => { SoundManager.play("ui"); fn(); syncFromSettings(); };
    el.addEventListener("click", h);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); h(); } });
  }
  function paintRange(input) { input.style.setProperty("--fill", `${input.value}%`); }

  function wireEvents() {
    EventBus.on(EVENTS.AUTO_SPIN_STARTED, () => {
      setSpinLabel(true);
      updateStatus();
      syncAutoProgress();
    });
    EventBus.on(EVENTS.AUTO_SPIN_PROGRESS, () => { updateStatus(); syncAutoProgress(); });
    EventBus.on(EVENTS.AUTO_SPIN_STOPPED, () => {
      setSpinLabel(false);
      updateStatus();
      syncAutoProgress();
    });
    EventBus.on(EVENTS.BONUS_STARTED, () => updateStatus());
    EventBus.on(EVENTS.BONUS_FINISHED, () => updateStatus());
    EventBus.on(EVENTS.ASCENSION_TRIGGERED, () => updateAscension());
    EventBus.on("SETTINGS_CHANGED", () => syncFromSettings());
    document.addEventListener("fullscreenchange", () => {
      const b = $("za-fs");
      if (b) b.classList.toggle("is-on", !!document.fullscreenElement);
    });
  }

  /* -------------------------------------------------------------- actions */
  function SpinAction() {
    SpinEngine.userSpin();
  }
  function changeBet(dir) {
    if (!gameStarted) return;
    if (FSM.state === "SPINNING" || BonusEngine.isActive() || AutoSpinManager.isActive()) return;
    const st = GameState.data;
    let idx = CONFIG.BETS.indexOf(st.currentBet);
    if (idx === -1) idx = 0;
    idx = Utils.clamp(idx + dir, 0, CONFIG.BETS.length - 1);
    while (idx > 0 && CONFIG.BETS[idx] > st.balance) idx--; // never above balance
    st.currentBet = CONFIG.BETS[idx];
    SettingsManager.set("betIndex", idx);
    SoundManager.play("ui");
    updateHUD();
  }
  function toggleFullscreen() {
    SoundManager.play("ui");
    try {
      if (!document.fullscreenElement) {
        (root.requestFullscreen || root.webkitRequestFullscreen || function () {}).call(root);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
      }
    } catch { /* unsupported */ }
  }

  /* ------------------------------------------------------------ HUD state */
  function locked() {
    return FSM.state === "SPINNING" || BonusEngine.isActive() || AutoSpinManager.isActive();
  }
  function updateHUD() {
    const st = GameState.data;
    const bal = $("za-balance"); if (bal) bal.textContent = Utils.credits(st.balance);
    const sc = $("za-score"); if (sc) sc.textContent = st.sessionScore.toLocaleString();
    const lw = $("za-lastwin"); if (lw) lw.textContent = Utils.credits(st.lastWin);
    const winChip = $("za-chip-win"); if (winChip) winChip.classList.toggle("is-hot", st.lastWin > 0);
    // bet affordability: never allow a bet above balance
    let idx = CONFIG.BETS.indexOf(st.currentBet);
    if (idx === -1) idx = 0;
    if (CONFIG.BETS[idx] > st.balance) {
      while (idx > 0 && CONFIG.BETS[idx] > st.balance) idx--;
      st.currentBet = CONFIG.BETS[idx];
    }
    const bet = $("za-bet"); if (bet) bet.textContent = st.currentBet;
    const sb = $("za-spinbet"); if (sb) sb.textContent = `BET ${st.currentBet}`;
    const dn = $("za-bet-down"); if (dn) dn.disabled = idx <= 0 || locked();
    const up = $("za-bet-up");
    if (up) up.disabled = idx >= CONFIG.BETS.length - 1 || locked() || CONFIG.BETS[Math.min(idx + 1, CONFIG.BETS.length - 1)] > st.balance;
    updateAscension();
    updateStatus();
  }
  function flashChip(key) {
    const map = { balance: "za-chip-balance", score: "za-chip-score", lastwin: "za-chip-win" };
    const chip = $(map[key] || map.balance);
    if (!chip) return;
    gsap.fromTo(chip, { scale: 1.18 }, { scale: 1, duration: 0.5, ease: "back.out(3)" });
  }
  function updateAscension() {
    const st = GameState.data;
    railNodes.forEach((n, i) => n.classList.toggle("is-on", i < st.ascensionCharge));
    const cnt = $("za-rail-count");
    if (cnt) cnt.textContent = st.ascensionArmed ? "x5 ARMED" : `${st.ascensionCharge}/${CONFIG.ASCENSION_CHARGES}`;
    const rail = $("za-rail");
    if (rail) rail.classList.toggle("is-armed", st.ascensionArmed);
  }
  function updateStatus() {
    const st = GameState.data;
    const bar = $("za-statusbar");
    if (!bar) return;
    const parts = [];
    if (BonusEngine.isActive()) {
      const b = BonusEngine.state;
      parts.push(`COSMIC ASCENSION ${b.total - b.remaining}/${b.total} · MULT x${b.mult}`);
    }
    if (AutoSpinManager.isActive()) parts.push(`AUTO · ${AutoSpinManager.remaining()} LEFT`);
    if (st.ascensionArmed) parts.push("ASCENSION x5 ARMED");
    if (parts.length) {
      bar.textContent = parts.join("  ✦  ");
      bar.classList.add("is-visible");
      bar.classList.toggle("is-gold", st.ascensionArmed && !BonusEngine.isActive());
    } else {
      bar.classList.remove("is-visible");
    }
  }
  function setSpinBusy(busy) {
    const zone = $("za-spinzone");
    const btn = $("za-spinbtn");
    if (zone) zone.classList.toggle("is-spinning", busy);
    if (btn) btn.disabled = busy || !gameStarted;
  }
  function setSpinLabel(auto) {
    const l = $("za-spinlabel");
    if (l) l.textContent = auto ? "STOP" : "SPIN";
  }

  /* ------------------------------------------------------------- overlays */
  function openOverlay(name) {
    const ov = $("za-ov-" + name);
    if (ov) ov.classList.add("is-open");
    if (name === "board") refreshBoard();
    if (name === "settings") syncFromSettings();
    if (name === "auto") syncAutoModal();
    if (name === "exit") {
      const s = $("za-exit-score");
      if (s) s.textContent = GameState.data.sessionScore.toLocaleString();
    }
  }
  function closeOverlay(name) {
    const ov = $("za-ov-" + name);
    if (ov) ov.classList.remove("is-open");
  }
  function isOverlayOpen(name) {
    const ov = $("za-ov-" + name);
    return !!ov && ov.classList.contains("is-open");
  }

  function syncFromSettings() {
    const s = SettingsManager.all();
    const snd = $("za-sound");
    if (snd) {
      snd.classList.toggle("is-on", !s.muted);
      const w = snd.querySelector(".waves");
      if (w) w.style.opacity = s.muted ? 0.15 : 1;
    }
    const tgl = (id, v) => { const el = $(id); if (el) el.classList.toggle("is-on", !!v); };
    tgl("za-tg-mute", s.muted);
    tgl("za-tg-turbo", s.turbo);
    tgl("za-tg-quick", s.quick);
    tgl("za-tg-skip", s.skipAnimations);
    const vols = [["za-vol-master", s.masterVol], ["za-vol-sfx", s.sfxVol], ["za-vol-music", s.musicVol]];
    for (const [id, v] of vols) {
      const el = $(id);
      if (el) { el.value = Math.round(v * 100); paintRange(el); }
    }
    const qseg = $("za-quality-seg");
    if (qseg) qseg.querySelectorAll("button").forEach((b) => b.classList.toggle("is-on", b.dataset.q === s.quality));
    const aseg = $("za-anim-seg");
    if (aseg) {
      const mode = s.quick ? "turbo" : s.reducedMotion ? "reduced" : s.turbo ? "turbo" : "full";
      aseg.querySelectorAll("button").forEach((b) => b.classList.toggle("is-on", b.dataset.anim === (s.turbo ? "turbo" : mode)));
    }
    // auto modal toggles reflect local cfg
    tgl("za-auto-turbo", autoCfg.turbo);
    tgl("za-auto-quick", autoCfg.quick);
    tgl("za-auto-skip", autoCfg.skipWin);
    tgl("za-auto-stopbonus", autoCfg.stopAfterBonus);
    tgl("za-auto-stopbigwin", autoCfg.stopAfterBigWin);
  }
  function syncAutoModal() {
    const nb = $("za-auto-stopbelow"); if (nb) nb.value = autoCfg.stopBelow;
    const na = $("za-auto-stopabove"); if (na) na.value = autoCfg.stopAbove;
    syncFromSettings();
    syncAutoProgress();
    const start = $("za-autostart");
    if (start) {
      start.disabled = AutoSpinManager.isActive();
      start.textContent = AutoSpinManager.isActive() ? "Auto Running…" : "Start Auto Spin";
    }
  }
  function syncAutoProgress() {
    const p = $("za-autoprogress");
    if (!p) return;
    const active = AutoSpinManager.isActive();
    p.classList.toggle("is-visible", active);
    const t = $("za-autoprogress-text");
    if (t) t.textContent = AutoSpinManager.remaining() === Infinity ? "∞" : AutoSpinManager.remaining();
  }

  /* ----------------------------------------------------------- leaderboard */
  async function openBoard() { openOverlay("board"); }
  async function refreshBoard() {
    const body = $("za-board-body");
    if (!body) return;
    body.innerHTML = `<div class="za2-board-state"><div class="za2-spinner"></div><p>Charting star positions…</p></div>`;
    const res = await LeaderboardService.getTop50();
    const modeEl = $("za-board-mode");
    const noteEl = $("za-board-note");
    if (modeEl) {
      modeEl.className = "za2-board-mode";
      if (res.source === "online") { modeEl.textContent = "ONLINE"; modeEl.classList.add("is-online"); }
      else if (res.source === "cache") { modeEl.textContent = "OFFLINE · CACHED"; modeEl.classList.add("is-offline"); }
      else { modeEl.textContent = "LOCAL STARS"; modeEl.classList.add("is-offline"); }
    }
    if (res.status === "error") {
      body.innerHTML = `<div class="za2-board-state is-error"><p>Signal lost in the void.</p><p style="margin-top:8px;font-size:10px;">Use Refresh to try again — the local stars remain.</p></div>`;
      if (noteEl) noteEl.textContent = "";
      return;
    }
    if (res.status === "empty" || !res.rows.length) {
      body.innerHTML = `<div class="za2-board-state"><p>No legends yet — the cosmos awaits your name.</p></div>`;
      if (noteEl) noteEl.textContent = "";
      return;
    }
    const myScore = GameState.data.sessionScore;
    body.innerHTML = `<div class="za2-board-list">${res.rows.map((r, i) => {
      const you = myScore > 0 && r.score === myScore;
      return `<div class="za2-board-row${you ? " is-you" : ""}">
        <span class="za2-board-rank">#${i + 1}</span>
        <span class="za2-board-name">${escapeHtml(r.player_name)}${you ? " · YOU" : ""}<span class="za2-board-ranktitle">${LeaderboardService.titleForRank(i + 1)}</span></span>
        <span class="za2-board-score">${Number(r.score).toLocaleString()}</span>
      </div>`;
    }).join("")}</div>`;
    if (noteEl) {
      noteEl.textContent = res.source === "online"
        ? "Synced with Supabase · RLS protected · read & insert only."
        : "Offline board — scores sync once a connection is configured.";
    }
  }

  /* ------------------------------------------------------ banners & flourishes */
  function showBanner(tierName, amount) {
    return new Promise((resolve) => {
      const banner = $("za-banner");
      const title = $("za-banner-title");
      const amountEl = $("za-banner-amount");
      if (!banner || !title || !amountEl) { resolve(); return; }
      title.textContent = tierName;
      amountEl.textContent = "0";
      banner.classList.add("is-open");
      gsap.fromTo(title, { scale: 2.4, opacity: 0, filter: "blur(14px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.45, ease: "back.out(2)" });
      const obj = { v: 0 };
      gsap.to(obj, {
        v: amount, duration: 1.1, delay: 0.25, ease: "power1.out",
        onUpdate: () => { amountEl.textContent = Math.round(obj.v).toLocaleString(); SoundManager.play("coin"); },
        onComplete: () => {
          gsap.to(banner, {
            opacity: 0, duration: 0.4, delay: 0.5,
            onComplete: () => {
              banner.classList.remove("is-open");
              gsap.set(banner, { opacity: 1 });
              resolve();
            },
          });
        },
      });
    });
  }
  function showMultiplierBadge(mult) {
    const badge = $("za-multibadge");
    if (!badge) return;
    const geo = Renderer.frameGeometry();
    badge.textContent = `x${mult}`;
    badge.style.left = `${geo.ox + geo.gridW - 8}px`;
    badge.style.top = `${geo.oy - 24}px`;
    gsap.fromTo(badge, { opacity: 0, scale: 0.4, y: 14 }, { opacity: 1, scale: 1, y: 0, duration: 0.28, ease: "back.out(3)" });
    gsap.to(badge, { opacity: 0, scale: 1.25, duration: 0.3, delay: 0.75, ease: "power2.in" });
    if (!SettingsManager.get("reducedMotion")) Renderer.addShake(3);
  }
  function floatText(text, x, y) {
    if (!root) return;
    const f = document.createElement("div");
    f.className = "za2-floater";
    f.textContent = text;
    f.style.left = `${x}px`;
    f.style.top = `${y}px`;
    root.appendChild(f);
    gsap.fromTo(f, { opacity: 0, y: 10, scale: 0.8 }, { opacity: 1, y: -28, scale: 1, duration: 0.9, ease: "power2.out", onComplete: () => f.remove() });
    gsap.to(f, { opacity: 0, delay: 0.65, duration: 0.3 });
  }

  /* ----------------------------------------------------------------- boot */
  async function bootSequence() {
    openOverlay("boot");
    const lines = ["CALIBRATING RNG CORE…", "CHARTING THE 6×5 COSMOS…", "BINDING 15 CELESTIAL GLYPHS…", "LINKING COSMIC LEGENDS…", "READY"];
    for (let i = 0; i < lines.length; i++) {
      const l = $("za-boot-lines"); if (l) l.textContent = lines[i];
      const f = $("za-boot-fill"); if (f) f.style.width = `${((i + 1) / lines.length) * 100}%`;
      await Utils.wait(i === lines.length - 1 ? 260 : 210);
    }
    closeOverlay("boot");
    openOverlay("menu");
    const btn = $("za-spinbtn");
    if (btn) btn.disabled = true;
  }

  /* -------------------------------------------------------- bonus banners */
  async function showBonusGrant(scatter) {
    const banner = $("za-banner");
    const title = $("za-banner-title");
    const amountEl = $("za-banner-amount");
    if (!banner) return;
    title.textContent = "COSMIC ASCENSION";
    amountEl.textContent = `${scatter.spins} FREE SPINS · x${CONFIG.FS_MULT_START}`;
    banner.classList.add("is-open");
    gsap.fromTo(title, { scale: 2.6, opacity: 0, filter: "blur(16px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "back.out(2)" });
    gsap.fromTo(amountEl, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4, delay: 0.25 });
    await Utils.wait(SettingsManager.get("quick") ? 600 : 1700);
    await new Promise((res) => {
      gsap.to(banner, { opacity: 0, duration: 0.35, onComplete: () => { banner.classList.remove("is-open"); gsap.set(banner, { opacity: 1 }); res(); } });
    });
  }
  async function showBonusSummary(totalWon) {
    await showBanner("ASCENSION COMPLETE", totalWon);
  }

  /* ------------------------------------------------------------- end flows */
  function showNameEntry() {
    const st = GameState.data;
    const rank = LeaderboardService.rankOf(st.sessionScore);
    const rk = $("za-name-rank"); if (rk) rk.textContent = `#${rank}`;
    const rt = $("za-name-title"); if (rt) rt.textContent = LeaderboardService.titleForRank(rank);
    const input = $("za-name-input"); if (input) input.value = SettingsManager.get("playerName") || "";
    const note = $("za-name-note");
    if (note) { note.textContent = "Max 16 characters."; note.className = "za2-note"; }
    const btn = $("za-name-submit"); if (btn) btn.disabled = false;
    closeOverlay("gameover");
    openOverlay("name");
    FSM.set("NAME_ENTRY", "name entry");
    setTimeout(() => { if (input) input.focus(); }, 60);
  }
  async function submitName() {
    if (submitting) return; // no double-submit
    const input = $("za-name-input");
    const note = $("za-name-note");
    const btn = $("za-name-submit");
    const name = sanitizeName(input ? input.value : "");
    if (name.length < 2) {
      if (note) { note.textContent = "Minimum 2 characters, pilot."; note.className = "za2-note is-err"; }
      SoundManager.play("denied");
      return;
    }
    submitting = true;
    if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }
    if (note) { note.textContent = "SUBMITTING…"; note.className = "za2-note"; }
    SettingsManager.set("playerName", name);
    const st = GameState.data;
    FSM.set("SUBMITTING_SCORE", "submitting");
    let res = { ok: false, online: false, rank: LeaderboardService.rankOf(st.sessionScore) };
    try {
      res = await LeaderboardService.submitScore({ playerName: name, score: st.sessionScore, submissionId: st.sessionId });
    } catch (e) {
      console.warn("[UI] submit error", e);
    }
    SoundManager.play("submit");
    if (note) {
      note.textContent = res.ok
        ? `SAVED · RANK #${res.rank}${res.online ? " · ONLINE" : " · STORED LOCALLY"}`
        : "ALREADY RECORDED FOR THIS JOURNEY";
      note.className = "za2-note " + (res.ok ? "is-ok" : "is-err");
    }
    await Utils.wait(950);
    if (btn) { btn.disabled = false; btn.textContent = "Save Score"; }
    submitting = false;
    closeOverlay("name");
    showGameOver(true);
  }
  function showGameOver(submitted = false) {
    const st = GameState.data;
    if (FSM.can("GAME_OVER")) FSM.set("GAME_OVER", "game over shown");
    const broke = st.balance < CONFIG.MIN_BET;
    const kicker = $("za-go-kicker");
    if (kicker) kicker.textContent = broke ? "Out of Credits" : "Session Closed";
    const setTxt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    setTxt("za-go-score", st.sessionScore.toLocaleString());
    setTxt("za-go-spins", st.spinsPlayed);
    setTxt("za-go-wins", st.totalWins);
    setTxt("za-go-big", st.biggestWin.toLocaleString());
    setTxt("za-go-mult", `x${st.highestMultiplier}`);
    setTxt("za-go-casc", st.cascadeCount);
    setTxt("za-go-asc", st.zodiacAscensionCount);
    const rankline = $("za-go-rankline");
    const qualified = LeaderboardService.qualifies(st.sessionScore);
    if (rankline) {
      if (st.sessionScore > 0) {
        rankline.style.display = "flex";
        setTxt("za-go-rank", `#${LeaderboardService.rankOf(st.sessionScore)}`);
        setTxt("za-go-ranktitle", `COSMIC RANK · ${LeaderboardService.titleForRank(LeaderboardService.rankOf(st.sessionScore))}`);
      } else {
        rankline.style.display = "none";
      }
    }
    const goBoard = $("za-go-board"); if (goBoard) goBoard.style.display = "inline-flex";
    const goName = $("za-go-name"); if (goName) goName.style.display = qualified && !submitted ? "inline-flex" : "none";
    const note = $("za-go-note");
    if (note) {
      note.textContent = submitted
        ? "Your name is written among the stars. A new ascension awaits."
        : qualified
          ? "You qualify for the Cosmic Legends. Record your name among the stars."
          : "The void keeps its secrets. Reach the Top 50 and the stars will remember you.";
    }
    SoundManager.play("gameOver");
    openOverlay("gameover");
  }

  return {
    build, updateHUD, flashChip, updateAscension, updateStatus, setSpinBusy,
    openOverlay, closeOverlay, isOverlayOpen, bootSequence, openBoard, refreshBoard,
    showBanner, showMultiplierBadge, floatText, showBonusGrant, showBonusSummary,
    showNameEntry, submitName, showGameOver, syncFromSettings,
    get gameStarted() { return gameStarted; },
    get root() { return root; },
  };
})();

export default UIManager;
