/* ============================================================================
 * ZODIAC ASCENSION — Stage 2: Professional UI Module
 *
 * Replaces the stage-1 UI shell. Contract consumed by src/engine.js:
 *   build, updateHUD, flashChip, updateAscension, updateStatus, setSpinBusy,
 *   openOverlay, closeOverlay, isOverlayOpen, bootSequence, openBoard,
 *   showBanner, showMultiplierBadge, floatText, showBonusGrant,
 *   showBonusSummary, showNameEntry, submitName, showGameOver,
 *   syncFromSettings, gameStarted, root.
 *
 * All DOM references resolve lazily through $() — no static cache to drift.
 * Engine bindings are only touched at call time (module cycle safety).
 * ========================================================================== */

import { gsap } from "gsap";
import "./ui.css";
import GameEngine, {
  CONFIG, Utils, EventBus, EVENTS, GameState, FSM, SettingsManager, PerformanceManager,
  LeaderboardService, SoundManager, Renderer, SpinEngine, AutoSpinManager,
  BonusEngine, SlotMath, StorageService, SYMBOLS, TIER_COLORS, Glyphs, glyphSVG,
} from "./engine.js";

const UIManager = (() => {
  let root = null;
  const el = {};
  let gameStarted = false;
  let pauseMode = false;
  let submitting = false;
  let cooldownT = null;
  let ascensionNodes = [];
  let lastSubmitted = null;

  const autoCfg = {
    count: 25, turbo: false, quick: false, skipWin: false,
    stopBelow: 0, stopAbove: 0, stopAfterBonus: true, stopAfterBigWin: false,
  };

  /* Lazy DOM resolution — the fix that makes boot crashes impossible. */
  function $(id) {
    return el[id] || (el[id] = root ? root.querySelector(`#za-${id}`) : null);
  }
  const fmt2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------------------------------------------------------- icons */
  const STAR = `<svg viewBox="0 0 24 24"><path d="M12 2 L14.4 9.6 L22 12 L14.4 14.4 L12 22 L9.6 14.4 L2 12 L9.6 9.6 Z" fill="currentColor"/></svg>`;
  const iconX = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 5 L19 19 M19 5 L5 19"/></svg>`;
  const iconMinus = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12 H19"/></svg>`;
  const iconPlus = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5 V19 M5 12 H19"/></svg>`;
  function iconSound(muted) {
    return `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke="none"/>
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12" opacity="${muted ? 0.15 : 1}"/>
      ${muted ? `<path d="M16 9.5 L22 14.5 M22 9.5 L16 14.5" stroke-width="2.2"/>` : ""}
    </svg>`;
  }
  function iconFullscreen(active) {
    return active
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`;
  }
  const iconGear = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>`;

  function logoSVG() {
    return `<svg width="34" height="34" viewBox="0 0 34 34">
      <circle cx="17" cy="17" r="15" fill="none" stroke="#f5c96b" stroke-width="1.4" opacity="0.75"/>
      <circle cx="17" cy="17" r="10.5" fill="none" stroke="#35e0ff" stroke-width="0.8" opacity="0.55" stroke-dasharray="2 4"/>
      <path d="M17 5 L19.2 13.4 L27.5 17 L19.2 20.6 L17 29 L14.8 20.6 L6.5 17 L14.8 13.4 Z" fill="#ffedbe"/>
      <circle cx="27.5" cy="7.5" r="1.6" fill="#35e0ff"/><circle cx="6.5" cy="25.5" r="1.3" fill="#ff4fd8"/>
    </svg>`;
  }
  function zodiacRingSVG() {
    const ids = ["aries", "taurus", "gemini", "cancer", "leo", "virgo", "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces"];
    let inner = `<circle cx="90" cy="90" r="86" fill="none" stroke="rgba(245,201,107,0.32)" stroke-width="1"/>`;
    inner += `<circle cx="90" cy="90" r="60" fill="none" stroke="rgba(53,224,255,0.22)" stroke-width="0.8" stroke-dasharray="3 6"/>`;
    ids.forEach((id, i) => {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const x = 90 + Math.cos(a) * 73, y = 90 + Math.sin(a) * 73;
      const c = TIER_COLORS[SYMBOLS.find((s) => s.id === id).element];
      const parts = Glyphs[id].map((p) => p.d
        ? `<path d="${p.d}" ${p.fill ? `fill="${c}"` : `fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`}/>`
        : `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="none" stroke="${c}" stroke-width="2"/>`).join("");
      inner += `<svg x="${x - 8}" y="${y - 8}" width="16" height="16" viewBox="0 0 24 24">${parts}</svg>`;
      inner += `<circle cx="${90 + Math.cos(a) * 86}" cy="${90 + Math.sin(a) * 86}" r="1.7" fill="#ffedbe"/>`;
    });
    inner += `<path d="M90 68 L94.6 85.4 L112 90 L94.6 94.6 L90 112 L85.4 94.6 L68 90 L85.4 85.4 Z" fill="#ffedbe" opacity="0.92"/>`;
    return `<svg class="za2-menu-ring" width="172" height="172" viewBox="0 0 180 180">${inner}</svg>`;
  }

  /* ------------------------------------------------------------- template */
  function template() {
    return `
    <canvas id="za-stage"></canvas>

    <header class="za2-hud">
      <div class="za2-logo">
        ${logoSVG()}
        <div>
          <div class="za2-logo-name">ZODIAC ASCENSION</div>
          <span class="za2-logo-sub">CELESTIAL SLOTS</span>
        </div>
      </div>
      <div class="za2-chipset">
        <div class="za2-chip is-gold" id="za-chip-balance"><div class="za2-chip-label">Balance</div><div class="za2-chip-value" id="za-balance">100.00</div></div>
        <div class="za2-chip" id="za-chip-win"><div class="za2-chip-label">Win</div><div class="za2-chip-value" id="za-lastwin">0.00</div></div>
        <div class="za2-chip is-cyan" id="za-chip-bet"><div class="za2-chip-label">Bet</div><div class="za2-chip-value" id="za-bet-chip">1.00</div></div>
      </div>
      <div class="za2-hudbtns">
        <button class="za2-iconbtn" id="za-sound" title="Sonido" aria-label="Toggle sound"></button>
        <button class="za2-iconbtn" id="za-fullscreen" title="Pantalla completa" aria-label="Toggle fullscreen"></button>
        <button class="za2-iconbtn" id="za-settings" title="Ajustes" aria-label="Settings">${iconGear}</button>
      </div>
    </header>

    <div class="za2-rail" id="za-ascension">
      <span class="za2-rail-title">ASCENSION</span>
      <div class="za2-rail-nodes" id="za-asc-nodes"></div>
      <span class="za2-rail-count" id="za-asc-count">0/12</span>
    </div>

    <div class="za2-statusbar" id="za-status"></div>

    <footer class="za2-console">
      <div class="za2-cons-left">
        <div class="za2-betbox">
          <span class="za2-betbox-label">BET</span>
          <button class="za2-betbtn" id="za-bet-down" aria-label="Lower bet">${iconMinus}</button>
          <span class="za2-bet-value" id="za-bet">1.00</span>
          <button class="za2-betbtn" id="za-bet-up" aria-label="Raise bet">${iconPlus}</button>
        </div>
        <button class="za2-btn is-small" id="za-paytable">Paytable</button>
        <button class="za2-btn is-small is-ghost" id="za-howto-btn" title="Cómo jugar">?</button>
      </div>

      <div class="za2-spinzone" id="za-spinwrap">
        <svg class="za2-orbit" viewBox="0 0 122 122">
          <circle cx="61" cy="61" r="58" fill="none" stroke="rgba(245,201,107,0.22)" stroke-width="1.6" stroke-dasharray="3 8" class="o-dash"/>
          <circle cx="61" cy="61" r="51" fill="none" stroke="rgba(53,224,255,0.5)" stroke-width="2" stroke-dasharray="46 276" stroke-linecap="round" class="o-arc"/>
          <circle cx="61" cy="61" r="51" fill="none" stroke="rgba(255,79,216,0.4)" stroke-width="2" stroke-dasharray="30 292" stroke-linecap="round" class="o-arc" style="animation-duration:7.5s"/>
        </svg>
        <button class="za2-spinbtn" id="za-spin" aria-label="Spin">
          <span class="za2-spinbtn-label">SPIN</span>
          <span class="za2-spinbtn-bet" id="za-spin-bet">1.00</span>
        </button>
      </div>

      <div class="za2-cons-right">
        <button class="za2-btn is-small" id="za-auto">Auto</button>
        <button class="za2-btn is-small" id="za-menu">Menu</button>
      </div>
    </footer>

    <div class="za2-multibadge" id="za-multibadge">x2</div>
    <div class="za2-banner" id="za-banner">
      <div class="za2-banner-rays"></div>
      <div class="za2-banner-title" id="za-banner-title">BIG WIN</div>
      <div class="za2-banner-amount" id="za-banner-amount">0</div>
    </div>

    <!-- BOOT -->
    <div class="za2-backdrop" id="za-ov-boot" data-name="boot" data-dismissable="false" style="z-index:90;background:radial-gradient(ellipse at 50% 40%, rgba(10,14,42,0.9), rgba(3,4,20,0.99));">
      <div class="za2-boot">
        <div class="za2-boot-emblem" id="za-boot-emblem">${logoSVG().replace('width="34" height="34"', 'width="74" height="74"')}</div>
        <div class="za2-boot-title">ZODIAC<br/><span class="t2">ASCENSION</span></div>
        <div class="za2-boot-bar"><i id="za-boot-fill"></i></div>
        <div class="za2-boot-lines" id="za-boot-lines">INITIALIZING…</div>
      </div>
    </div>

    <!-- MAIN MENU / PAUSE -->
    <div class="za2-backdrop" id="za-ov-menu" data-name="menu">
      <div class="za2-modal is-narrow" role="dialog" aria-modal="true" tabindex="-1" style="text-align:center;">
        <div class="za2-menu-hero">
          ${zodiacRingSVG()}
          <h1 class="za2-menu-title">ZODIAC<br/><span class="t2">ASCENSION</span></h1>
          <p class="za2-menu-tag">Alinea los doce signos, encadena cascadas estelares y graba tu nombre entre las <b style="color:var(--gold-hi)">Leyendas Cósmicas</b>.</p>
        </div>
        <div class="za2-menu-btns">
          <button class="za2-btn is-primary" id="za-play">Enter the Cosmos</button>
          <button class="za2-btn" id="za-menu-howto">How to Play</button>
          <button class="za2-btn" id="za-menu-paytable">Paytable</button>
          <button class="za2-btn" id="za-menu-board">Cosmic Legends · Top 50</button>
          <button class="za2-btn" id="za-menu-settings">Settings</button>
          <button class="za2-btn is-danger" id="za-menu-exit" style="display:none;">Exit Game</button>
        </div>
        <div class="za2-version" id="za-version">v0.0.0</div>
      </div>
    </div>

    <!-- AUTO SPIN -->
    <div class="za2-backdrop" id="za-ov-auto" data-name="auto">
      <div class="za2-modal is-narrow" role="dialog" aria-modal="true" tabindex="-1">
        <button class="za2-x" data-close="auto" aria-label="Close">${iconX}</button>
        <div class="za2-kicker">Hands-Free Destiny</div>
        <h2 class="za2-title">Auto Spin Settings</h2>
        <div class="za2-countgrid" id="za-auto-counts"></div>

        <div class="za2-auto-section">
          <h4>Spin Options</h4>
          <div class="za2-setrow"><div><div class="za2-setname">Turbo Spin</div><div class="za2-setdesc">~2x reel speed.</div></div><div class="za2-toggle" id="za-auto-turbo"><i></i></div></div>
          <div class="za2-setrow"><div><div class="za2-setname">Quick Spin</div><div class="za2-setdesc">Near-instant resolution.</div></div><div class="za2-toggle" id="za-auto-quick"><i></i></div></div>
          <div class="za2-setrow"><div><div class="za2-setname">Skip Win Animations</div><div class="za2-setdesc">Wins are still paid in full.</div></div><div class="za2-toggle" id="za-auto-skip"><i></i></div></div>
        </div>

        <div class="za2-auto-section">
          <h4>Stop Conditions</h4>
          <div class="za2-setrow"><div><div class="za2-setname">Stop if Balance Below</div><div class="za2-setdesc">0 = disabled</div></div><input type="number" class="za2-numfield" id="za-auto-stopbelow" min="0" step="1" value="0"/></div>
          <div class="za2-setrow"><div><div class="za2-setname">Stop if Single Win Above</div><div class="za2-setdesc">0 = disabled</div></div><input type="number" class="za2-numfield" id="za-auto-stopabove" min="0" step="1" value="0"/></div>
          <div class="za2-setrow"><div><div class="za2-setname">Stop After Bonus</div></div><div class="za2-toggle is-on" id="za-auto-stopbonus"><i></i></div></div>
          <div class="za2-setrow"><div><div class="za2-setname">Stop After Big Win</div></div><div class="za2-toggle" id="za-auto-stopbigwin"><i></i></div></div>
        </div>

        <div class="za2-autoprogress" id="za-auto-progress"><span id="za-auto-progress-text">0 SPINS LEFT</span></div>

        <div style="display:flex;gap:10px;margin-top:16px;">
          <button class="za2-btn is-primary" id="za-auto-start" style="flex:1;">Start Auto Spin</button>
          <button class="za2-btn is-danger" id="za-auto-stop" style="flex:1;display:none;">Stop Auto Spin</button>
        </div>
      </div>
    </div>

    <!-- SETTINGS -->
    <div class="za2-backdrop" id="za-ov-settings" data-name="settings">
      <div class="za2-modal" role="dialog" aria-modal="true" tabindex="-1">
        <button class="za2-x" data-close="settings" aria-label="Close">${iconX}</button>
        <div class="za2-kicker">Configuration</div>
        <h2 class="za2-title">Settings</h2>
        <div class="za2-tabs" id="za-set-tabs">
          <button data-tab="audio" class="is-on">Audio</button>
          <button data-tab="graphics">Graphics</button>
          <button data-tab="animation">Animation</button>
          <button data-tab="gameplay">Gameplay</button>
          <button data-tab="other">Other</button>
        </div>

        <div class="za2-tabpanel is-on" id="za-tab-audio">
          <div class="za2-setrow"><div><div class="za2-setname">Master Volume</div></div><input type="range" class="za2-range" id="za-vol-master" min="0" max="100"/></div>
          <div class="za2-setrow"><div><div class="za2-setname">Sound Effects</div></div><input type="range" class="za2-range" id="za-vol-sfx" min="0" max="100"/></div>
          <div class="za2-setrow"><div><div class="za2-setname">Music / Ambience</div></div><input type="range" class="za2-range" id="za-vol-music" min="0" max="100"/></div>
          <div class="za2-setrow"><div><div class="za2-setname">Mute All</div></div><div class="za2-toggle" id="za-tg-mute"><i></i></div></div>
        </div>

        <div class="za2-tabpanel" id="za-tab-graphics">
          <div class="za2-setrow"><div><div class="za2-setname">Quality Preset</div><div class="za2-setdesc">Visuals only — never affects odds or math.</div></div><div class="za2-seg" id="za-quality-seg"></div></div>
          <p class="za2-note" style="margin-top:10px;">AUTO detects your device and adapts in real time (FPS-driven).</p>
        </div>

        <div class="za2-tabpanel" id="za-tab-animation">
          <div class="za2-setrow"><div><div class="za2-setname">Animation Density</div><div class="za2-setdesc">Full: all effects · Reduced: less shake & parallax · Turbo: fast reels.</div></div><div class="za2-seg" id="za-anim-seg"></div></div>
        </div>

        <div class="za2-tabpanel" id="za-tab-gameplay">
          <div class="za2-setrow"><div><div class="za2-setname">Turbo Spin</div><div class="za2-setdesc">~2x reel speed.</div></div><div class="za2-toggle" id="za-tg-turbo"><i></i></div></div>
          <div class="za2-setrow"><div><div class="za2-setname">Quick Spin</div><div class="za2-setdesc">Near-instant resolution.</div></div><div class="za2-toggle" id="za-tg-quick"><i></i></div></div>
          <div class="za2-setrow"><div><div class="za2-setname">Skip Win Animations</div><div class="za2-setdesc">Wins are still paid in full.</div></div><div class="za2-toggle" id="za-tg-skip"><i></i></div></div>
        </div>

        <div class="za2-tabpanel" id="za-tab-other">
          <div class="za2-setrow"><div><div class="za2-setname">How to Play</div><div class="za2-setdesc">The 11 laws of ascension.</div></div><button class="za2-btn is-small" id="za-oth-howto">Open</button></div>
          <div class="za2-setrow"><div><div class="za2-setname">Paytable</div><div class="za2-setdesc">Symbol values & features.</div></div><button class="za2-btn is-small" id="za-oth-paytable">Open</button></div>
          <div class="za2-setrow"><div><div class="za2-setname">Leaderboard</div><div class="za2-setdesc">Cosmic Legends · Top 50.</div></div><button class="za2-btn is-small" id="za-oth-board">Open</button></div>
          <div class="za2-setrow"><div><div class="za2-setname">Reset Local Data</div><div class="za2-setdesc">Clears settings & local records.</div></div><button class="za2-btn is-small is-danger" id="za-reset-data">Reset</button></div>
        </div>

        <div class="za2-hr"></div>
        <div style="text-align:right;"><button class="za2-btn is-primary is-small" id="za-settings-close">Close</button></div>
      </div>
    </div>

    <!-- PAYTABLE -->
    <div class="za2-backdrop" id="za-ov-paytable" data-name="paytable">
      <div class="za2-modal" role="dialog" aria-modal="true" tabindex="-1">
        <button class="za2-x" data-close="paytable" aria-label="Close">${iconX}</button>
        <div class="za2-kicker">Star Charts</div>
        <h2 class="za2-title">Paytable</h2>
        <p class="za2-lede"><b style="color:var(--ink)">243 ways</b> — wins pay left to right on adjacent reels, any position. Values shown as units (÷ 2.5 × bet = credits).</p>
        <div class="za2-pay-grid" id="za-pay-grid"></div>
        <div class="za2-hr"></div>
        <div class="za2-auto-section">
          <h4>Cascade Multiplier Ladder (base game)</h4>
          <div class="za2-multladder" id="za-mult-ladder"></div>
        </div>
        <div class="za2-auto-section">
          <h4>Features</h4>
          <p class="za2-lede">◆ <b style="color:#ffd98a">SOLAR WILD</b> substitutes every symbol except the Lunar Scatter, and pays its own line.<br/>
          ◆ <b style="color:#ff7ad9">LUNAR SCATTER</b> — 3 / 4 / 5 anywhere grant <b style="color:var(--ink)">8 / 12 / 20 Free Spins</b> and pay 2× / 5× / 25× bet. Scatters do not cascade.<br/>
          ◆ <b style="color:var(--cyan)">FREE SPINS</b> carry a persistent multiplier that grows with every cascade (x2 → x20).<br/>
          ◆ <b style="color:var(--gold-hi)">ZODIAC ASCENSION</b> — every extra cascade charges the rail (+3 per bonus). A full rail arms your next spin with <b style="color:var(--gold-hi)">x5</b>.</p>
        </div>
        <div class="za2-hr"></div>
        <div style="text-align:right;"><button class="za2-btn is-primary is-small" id="za-paytable-close">Close</button></div>
      </div>
    </div>

    <!-- HOW TO PLAY -->
    <div class="za2-backdrop" id="za-ov-howto" data-name="howto">
      <div class="za2-modal" role="dialog" aria-modal="true" tabindex="-1">
        <button class="za2-x" data-close="howto" aria-label="Close">${iconX}</button>
        <div class="za2-kicker">The Astral Codex</div>
        <h2 class="za2-title is-cyan">How to Play</h2>
        <div class="za2-howto" id="za-howto-list"></div>
        <div class="za2-hr"></div>
        <div style="text-align:right;"><button class="za2-btn is-primary is-small" id="za-howto-close">Close</button></div>
      </div>
    </div>

    <!-- LEADERBOARD -->
    <div class="za2-backdrop" id="za-ov-board" data-name="board" style="z-index:70;">
      <div class="za2-modal" role="dialog" aria-modal="true" tabindex="-1">
        <button class="za2-x" data-close="board" aria-label="Close">${iconX}</button>
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
    <div class="za2-backdrop" id="za-ov-exit" data-name="exit">
      <div class="za2-modal is-narrow" role="dialog" aria-modal="true" tabindex="-1" style="text-align:center;">
        <div class="za2-kicker">Exit Request</div>
        <h2 class="za2-title is-magenta">Leave the Cosmos?</h2>
        <p class="za2-lede" style="margin-top:14px;">Your ascension will end and the void will reclaim your credits.</p>
        <div class="za2-kicker" style="margin-top:18px;color:var(--muted);">Your Current Score</div>
        <div class="za2-bigscore" id="za-exit-score">0</div>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;">
          <button class="za2-btn" id="za-exit-cancel">Continue Playing</button>
          <button class="za2-btn is-danger" id="za-exit-confirm">Leave</button>
        </div>
      </div>
    </div>

    <!-- NAME ENTRY -->
    <div class="za2-backdrop" id="za-ov-name" data-name="name" data-dismissable="false">
      <div class="za2-modal is-narrow" role="dialog" aria-modal="true" tabindex="-1" style="text-align:center;">
        <div class="za2-kicker">Leaderboard Qualified</div>
        <h2 class="za2-title">The Stars Have<br/>Remembered You</h2>
        <p class="za2-lede">You entered the <b style="color:var(--gold-hi)">Cosmic Legends</b></p>
        <div class="za2-bigscore" id="za-name-rank" style="font-size:clamp(24px,4vw,34px);">RANK #1</div>
        <div class="za2-kicker" style="margin-top:16px;color:var(--muted);">Enter Your Name</div>
        <input class="za2-input" id="za-name-input" maxlength="16" placeholder="ORION-7" autocomplete="off" spellcheck="false" style="margin-top:8px;"/>
        <div class="za2-note" id="za-name-note" style="margin-top:8px;">Max 16 characters. HTML and control characters are stripped.</div>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;">
          <button class="za2-btn is-ghost" id="za-name-skip">Skip</button>
          <button class="za2-btn is-primary" id="za-name-submit">Save Score</button>
        </div>
      </div>
    </div>

    <!-- GAME OVER / FINAL SUMMARY -->
    <div class="za2-backdrop" id="za-ov-gameover" data-name="gameover" data-dismissable="false" style="z-index:65;">
      <div class="za2-modal" role="dialog" aria-modal="true" tabindex="-1" style="text-align:center;max-width:560px;">
        <div class="za2-kicker" id="za-go-kicker">Session Closed</div>
        <h2 class="za2-title" id="za-go-title">Your Cosmic Journey</h2>
        <div class="za2-stats">
          <div class="za2-stat"><div class="za2-stat-label">Starting Balance</div><div class="za2-stat-value" id="za-go-start">100.00</div></div>
          <div class="za2-stat is-cyan"><div class="za2-stat-label">Final Score</div><div class="za2-stat-value" id="za-go-score">0</div></div>
          <div class="za2-stat"><div class="za2-stat-label">Total Wins</div><div class="za2-stat-value" id="za-go-wins">0</div></div>
          <div class="za2-stat"><div class="za2-stat-label">Biggest Win</div><div class="za2-stat-value" id="za-go-big">0.00</div></div>
          <div class="za2-stat"><div class="za2-stat-label">Best Multiplier</div><div class="za2-stat-value" id="za-go-mult">x1</div></div>
          <div class="za2-stat"><div class="za2-stat-label">Spins</div><div class="za2-stat-value" id="za-go-spins">0</div></div>
          <div class="za2-stat"><div class="za2-stat-label">Cascades</div><div class="za2-stat-value" id="za-go-casc">0</div></div>
          <div class="za2-stat"><div class="za2-stat-label">Zodiac Ascensions</div><div class="za2-stat-value" id="za-go-asc">0</div></div>
        </div>
        <div class="za2-rankline" id="za-go-rankline">
          <span class="rk" id="za-go-rank">#—</span>
          <span class="rt" id="za-go-ranktitle">ASTRAL SEEKER</span>
        </div>
        <p class="za2-note" id="za-go-note"></p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap;">
          <button class="za2-btn" id="za-go-board">Cosmic Legends</button>
          <button class="za2-btn" id="za-go-name" style="display:none;">Record Score</button>
          <button class="za2-btn is-primary" id="za-go-restart">New Ascension · 100 Credits</button>
        </div>
      </div>
    </div>

    <div class="za-debug" id="za-debug"></div>
    `;
  }

  /* ------------------------------------------------------------- builders */
  function buildAscension() {
    const wrap = $("asc-nodes");
    wrap.innerHTML = "";
    ascensionNodes = [];
    for (let i = 0; i < CONFIG.ASCENSION_CHARGES; i++) {
      const n = document.createElement("span");
      n.className = "za2-rail-node";
      n.innerHTML = STAR;
      wrap.appendChild(n);
      ascensionNodes.push(n);
    }
  }
  function buildPaytable() {
    const grid = $("pay-grid");
    grid.innerHTML = "";
    for (const s of SYMBOLS) {
      const c = TIER_COLORS[s.element];
      const cell = document.createElement("div");
      cell.className = "za2-pay-cell";
      cell.style.color = c;
      const nums = s.pay
        ? `<span class="za2-pay-nums">3× ${Utils.fmt(s.pay[3])}<br/>4× ${Utils.fmt(s.pay[4])} · 5× ${Utils.fmt(s.pay[5])}</span>`
        : `<span class="za2-pay-nums">3+ → 8/12/20 Free Spins<br/>pays 2×/5×/25× bet</span>`;
      const tier = s.tier === "special" ? "FEATURE" : s.tier.toUpperCase();
      cell.innerHTML = `${glyphSVG(s.id, 40, c)}<span class="za2-pay-name">${s.name}</span><span class="za2-pay-tier">${tier}</span>${nums}`;
      grid.appendChild(cell);
    }
    const ladder = $("mult-ladder");
    ladder.innerHTML = "";
    CONFIG.MULT_LADDER.forEach((m, i) => {
      const chip = document.createElement("span");
      chip.className = "za2-multchip" + (i === CONFIG.MULT_LADDER.length - 1 ? " is-top" : "");
      chip.textContent = `x${m}`;
      ladder.appendChild(chip);
    });
  }
  function buildHowTo() {
    const items = [
      ["Balance", "Every ascension begins with <b>100.00 créditos</b>. Cada spin descuenta tu apuesta; nunca puedes quedar en negativo."],
      ["Bet", "Ajusta tu apuesta con <b>BET − / BET +</b>: 1 · 2 · 5 · 10 · 20. El control bloquea apuestas mayores que tu balance."],
      ["Spin", "Pulsa <b>SPIN</b> (o la barra espaciadora). El resultado se determina con RNG criptográfico <b>antes</b> de cualquier animación."],
      ["Wins", "243 caminos: símbolos iguales en rodillos adyacentes desde la izquierda, en cualquier fila. El <b>Solar Wild</b> sustituye a todos salvo el Scatter."],
      ["Cascades", "Los símbolos ganadores explotan en esquirlas estelares y nuevos símbolos caen. Cada cascada encadena una nueva evaluación sobre el mismo spin."],
      ["Multipliers", "Cada cascada consecutiva sube el multiplicador del spin: <b>x1 → x2 → x3 → x5 → x8 → x10</b>."],
      ["Scatter", "La <b>Lunar Scatter</b> paga en cualquier posición: 3/4/5 otorgan premio inmediato (2×/5×/25× la apuesta) y disparan el bonus."],
      ["Free Spins", "3, 4 o 5 Scatters conceden <b>8, 12 o 20 giros gratis</b> con multiplicador persistente que crece en cada cascada (x2 → x20)."],
      ["Zodiac Ascension", "Las cascadas extra cargan el riel derecho. Al llenarlo, tu <b>siguiente spin multiplica todo x5</b>. Los Scatters también cargan +3."],
      ["Auto Spin", "Configura hasta 500 giros automáticos con turbo, quick, skip de animaciones y condiciones de parada por balance, premio o bonus."],
      ["Leaderboard", "Tu puntuación de sesión compite por el <b>Top 50 Cosmic Legends</b>. Si clasificas, podrás grabar tu nombre entre las estrellas."],
    ];
    const list = $("howto-list");
    list.innerHTML = "";
    items.forEach(([t, b], i) => {
      const d = document.createElement("div");
      d.className = "za2-howto-item";
      d.innerHTML = `<span class="za2-howto-num">${i + 1}</span><div><h5>${t}</h5><p>${b}</p></div>`;
      list.appendChild(d);
    });
  }
  function buildSettingsSegs() {
    const q = $("quality-seg");
    q.innerHTML = "";
    for (const p of PerformanceManager.presetNames()) {
      const b = document.createElement("button");
      b.textContent = p; b.dataset.q = p;
      b.addEventListener("click", () => {
        SoundManager.play("ui");
        SettingsManager.set("quality", p);
        PerformanceManager.apply(p);
        syncSettings();
      });
      q.appendChild(b);
    }
    const a = $("anim-seg");
    a.innerHTML = "";
    for (const p of ["FULL", "REDUCED", "TURBO"]) {
      const b = document.createElement("button");
      b.textContent = p; b.dataset.a = p;
      b.addEventListener("click", () => {
        SoundManager.play("ui");
        if (p === "FULL") { SettingsManager.set("reducedMotion", false); SettingsManager.set("turbo", false); SettingsManager.set("quick", false); }
        if (p === "REDUCED") { SettingsManager.set("reducedMotion", true); SettingsManager.set("turbo", false); SettingsManager.set("quick", false); }
        if (p === "TURBO") { SettingsManager.set("turbo", true); SettingsManager.set("reducedMotion", false); SettingsManager.set("quick", false); }
        syncSettings();
      });
      a.appendChild(b);
    }
  }
  function buildAutoCounts() {
    const wrap = $("auto-counts");
    wrap.innerHTML = "";
    for (const n of CONFIG.AUTO_COUNTS) {
      const b = document.createElement("div");
      b.className = "za2-count" + (n === autoCfg.count ? " is-on" : "");
      b.textContent = n;
      b.dataset.n = n;
      b.addEventListener("click", () => {
        autoCfg.count = n;
        SoundManager.play("ui");
        wrap.querySelectorAll(".za2-count").forEach((c) => c.classList.toggle("is-on", +c.dataset.n === n));
      });
      wrap.appendChild(b);
    }
  }

  /* -------------------------------------------------------------- binding */
  function on(id, fn) { const n = $(id); if (n) n.addEventListener("click", fn); }
  function bindControls() {
    // Spin — press physics + click
    const spin = $("spin");
    spin.addEventListener("pointerdown", () => { if (!spin.disabled) spin.classList.add("is-pressed"); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
      spin.addEventListener(ev, () => {
        if (!spin.classList.contains("is-pressed")) return;
        spin.classList.remove("is-pressed");
        if (!spin.disabled) gsap.fromTo(spin, { scale: 0.93 }, { scale: 1, duration: 0.4, ease: "elastic.out(1,0.5)", overwrite: "auto" });
      })
    );
    spin.addEventListener("click", () => { SoundManager.unlock(); SpinEngine.userSpin(); });

    on("bet-down", () => changeBet(-1));
    on("bet-up", () => changeBet(1));

    on("auto", () => {
      SoundManager.play("ui");
      if (AutoSpinManager.isActive()) { AutoSpinManager.stop("user"); return; }
      openOverlay("auto");
    });
    on("auto-start", () => {
      if (["SPINNING", "EVALUATING", "WINNING", "CASCADING"].includes(FSM.state)) { SoundManager.play("denied"); return; }
      SoundManager.play("ui");
      AutoSpinManager.start({ ...autoCfg });
      closeOverlay("auto");
    });
    on("auto-stop", () => { SoundManager.play("ui"); AutoSpinManager.stop("user"); });
    on("auto-turbo", () => { autoCfg.turbo = !autoCfg.turbo; SoundManager.play("ui"); syncAutoModal(); });
    on("auto-quick", () => { autoCfg.quick = !autoCfg.quick; SoundManager.play("ui"); syncAutoModal(); });
    on("auto-skip", () => { autoCfg.skipWin = !autoCfg.skipWin; SoundManager.play("ui"); syncAutoModal(); });
    on("auto-stopbonus", () => { autoCfg.stopAfterBonus = !autoCfg.stopAfterBonus; SoundManager.play("ui"); syncAutoModal(); });
    on("auto-stopbigwin", () => { autoCfg.stopAfterBigWin = !autoCfg.stopAfterBigWin; SoundManager.play("ui"); syncAutoModal(); });
    $("auto-stopbelow").addEventListener("input", (e) => { autoCfg.stopBelow = Math.max(0, parseInt(e.target.value, 10) || 0); });
    $("auto-stopabove").addEventListener("input", (e) => { autoCfg.stopAbove = Math.max(0, parseInt(e.target.value, 10) || 0); });

    on("menu", () => { SoundManager.play("ui"); openOverlay("menu"); });
    on("play", () => primaryMenu());
    on("menu-howto", () => { SoundManager.play("ui"); openOverlay("howto"); });
    on("menu-paytable", () => { SoundManager.play("ui"); openOverlay("paytable"); });
    on("menu-board", () => { SoundManager.play("ui"); openBoard(); });
    on("menu-settings", () => { SoundManager.play("ui"); openOverlay("settings"); });
    on("menu-exit", () => { SoundManager.play("ui"); ov("menu").classList.remove("is-open"); pauseMode = false; syncMenuMode(); GameEngine.requestExit(); });

    on("paytable", () => { SoundManager.play("ui"); openOverlay("paytable"); });
    on("paytable-close", () => { SoundManager.play("ui"); closeOverlay("paytable"); });
    on("howto-btn", () => { SoundManager.play("ui"); openOverlay("howto"); });
    on("howto-close", () => { SoundManager.play("ui"); closeOverlay("howto"); });

    on("settings", () => { SoundManager.play("ui"); openOverlay("settings"); });
    on("settings-close", () => { SoundManager.play("ui"); closeOverlay("settings"); });
    on("oth-howto", () => { SoundManager.play("ui"); closeOverlay("settings"); openOverlay("howto"); });
    on("oth-paytable", () => { SoundManager.play("ui"); closeOverlay("settings"); openOverlay("paytable"); });
    on("oth-board", () => { SoundManager.play("ui"); closeOverlay("settings"); openBoard(); });
    on("reset-data", () => {
      StorageService.remove("settings"); StorageService.remove("board.submitted"); StorageService.remove("board.pending");
      SettingsManager.reset(); SettingsManager.load();
      syncFromSettings(); SoundManager.play("ui");
    });

    // Settings tabs
    $("set-tabs").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        SoundManager.play("ui");
        $("set-tabs").querySelectorAll("button").forEach((x) => x.classList.toggle("is-on", x === b));
        for (const t of ["audio", "graphics", "animation", "gameplay", "other"]) {
          $(`tab-${t}`).classList.toggle("is-on", b.dataset.tab === t);
        }
      })
    );

    // Sliders & toggles
    const slider = (id, key) => $(id).addEventListener("input", (e) => {
      SettingsManager.set(key, e.target.value / 100);
      SoundManager.applyVolumes();
      paintRange(e.target);
    });
    slider("vol-master", "masterVol"); slider("vol-sfx", "sfxVol"); slider("vol-music", "musicVol");
    on("tg-mute", () => { SettingsManager.set("muted", !SettingsManager.get("muted")); SoundManager.applyVolumes(); syncFromSettings(); SoundManager.play("ui"); });
    on("tg-turbo", () => { SettingsManager.set("turbo", !SettingsManager.get("turbo")); syncSettings(); SoundManager.play("ui"); });
    on("tg-quick", () => { SettingsManager.set("quick", !SettingsManager.get("quick")); syncSettings(); SoundManager.play("ui"); });
    on("tg-skip", () => { SettingsManager.set("skipAnimations", !SettingsManager.get("skipAnimations")); syncSettings(); SoundManager.play("ui"); });

    on("sound", () => { SettingsManager.set("muted", !SettingsManager.get("muted")); SoundManager.applyVolumes(); syncFromSettings(); SoundManager.play("ui"); });
    on("fullscreen", () => { SoundManager.play("ui"); toggleFullscreen(); });

    on("board-close", () => { SoundManager.play("ui"); closeOverlay("board"); });
    on("board-refresh", () => { SoundManager.play("ui"); refreshBoard(); });

    on("exit-cancel", () => { SoundManager.play("ui"); GameEngine.resumeFromExit(); });
    on("exit-confirm", () => { SoundManager.play("ui"); closeOverlayRaw("exit"); GameEngine.endSession(); });

    on("name-submit", () => submitName());
    on("name-skip", () => { SoundManager.play("ui"); closeOverlayRaw("name"); showGameOver(); });
    $("name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitName(); });
    $("name-input").addEventListener("input", (e) => { e.target.value = sanitizeName(e.target.value); });

    on("go-restart", () => { SoundManager.play("ui"); GameEngine.newSession(); });
    on("go-board", () => { SoundManager.play("ui"); openBoard(); });
    on("go-name", () => { SoundManager.play("ui"); showNameEntry(); });

    // Generic X buttons & backdrop dismissal (delegated)
    root.addEventListener("click", (e) => {
      const x = e.target.closest("[data-close]");
      if (x) { SoundManager.play("ui"); closeOverlay(x.dataset.close); return; }
      if (e.target.classList && e.target.classList.contains("za2-backdrop") && e.target.dataset.dismissable !== "false") {
        closeOverlay(e.target.dataset.name);
      }
    });
  }
  function bindEngineEvents() {
    EventBus.on(EVENTS.BALANCE_CHANGED, () => { updateHUD(); autoAdjustBet(); });
    EventBus.on(EVENTS.AUTO_SPIN_STARTED, () => { updateAutoButton(); });
    EventBus.on(EVENTS.AUTO_SPIN_STOPPED, () => { updateAutoButton(); if (isOverlayOpen("auto")) syncAutoModal(); });
    EventBus.on(EVENTS.AUTO_SPIN_PROGRESS, ({ remaining }) => {
      updateAutoButton();
      if (isOverlayOpen("auto")) $("auto-progress-text").textContent = `${remaining} SPINS LEFT`;
    });
    document.addEventListener("fullscreenchange", syncFullscreenIcon);
  }

  /* ------------------------------------------------------------- gameplay */
  function changeBet(dir) {
    if (!gameStarted || FSM.state === "SPINNING" || BonusEngine.isActive() || AutoSpinManager.isActive()) return;
    const st = GameState.data;
    let idx = CONFIG.BETS.indexOf(st.currentBet);
    if (idx === -1) idx = 0;
    const next = Utils.clamp(idx + dir, 0, CONFIG.BETS.length - 1);
    if (CONFIG.BETS[next] > st.balance && next > idx) { SoundManager.play("denied"); return; }
    st.currentBet = CONFIG.BETS[next];
    SettingsManager.set("betIndex", next);
    SoundManager.play("ui");
    updateHUD();
  }
  function autoAdjustBet() {
    const st = GameState.data;
    if (BonusEngine.isActive() || AutoSpinManager.isActive()) return;
    if (st.currentBet > st.balance) {
      const affordable = CONFIG.BETS.filter((b) => b <= st.balance);
      st.currentBet = affordable.length ? affordable[affordable.length - 1] : CONFIG.BETS[0];
      updateHUD();
    }
  }
  function primaryMenu() {
    SoundManager.play("ui");
    if (pauseMode) { GameEngine.resume(); return; }
    if (gameStarted) { closeOverlayRaw("menu"); return; }
    gameStarted = true;
    closeOverlayRaw("menu");
    SoundManager.unlock();
    setSpinBusy(false);
    syncMenuMode();
    const consoleEl = root.querySelector(".za2-console");
    if (consoleEl) gsap.fromTo(consoleEl, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: "power3.out" });
  }
  function startGame() { primaryMenu(); }

  /* ------------------------------------------------------------- overlays */
  const ALIAS = { pause: "menu" };
  function ov(name) { return $(`ov-${ALIAS[name] || name}`); }
  function openOverlay(name) {
    const real = ALIAS[name] || name;
    if (real === "menu") { pauseMode = name === "pause"; syncMenuMode(); }
    const m = ov(name);
    if (!m) return;
    m.classList.add("is-open");
    const panel = m.querySelector(".za2-modal");
    if (panel) panel.focus({ preventScroll: true });
    if (real === "auto") syncAutoModal();
    if (real === "settings") syncSettings();
    if (real === "exit") $("exit-score").textContent = Math.floor(GameState.data.sessionScore).toLocaleString();
    if (real === "board") refreshBoard();
  }
  function closeOverlayRaw(name) { ov(name)?.classList.remove("is-open"); }
  function closeOverlay(name) {
    const real = ALIAS[name] || name;
    if (real === "menu") {
      if (pauseMode) { pauseMode = false; syncMenuMode(); GameEngine.resume(); return; }
      if (!gameStarted) return; // main menu can't be dismissed before the game starts
      closeOverlayRaw("menu");
      return;
    }
    if (real === "exit") {
      closeOverlayRaw("exit");
      if (FSM.state === "EXIT_CONFIRMATION" && FSM.can("IDLE")) FSM.set("IDLE", "exit dismissed");
      return;
    }
    closeOverlayRaw(name);
    if (real === "name" && FSM.state === "NAME_ENTRY") showGameOver();
  }
  function isOverlayOpen(name) {
    const open = ov(name)?.classList.contains("is-open") || false;
    if (name === "pause") return open && pauseMode;
    return open;
  }
  function syncMenuMode() {
    const play = $("play");
    if (!play) return;
    if (pauseMode) play.textContent = "Resume Session";
    else if (gameStarted) play.textContent = "Resume";
    else play.textContent = "Enter the Cosmos";
    $("menu-exit").style.display = gameStarted || pauseMode ? "inline-flex" : "none";
    const x = ov("menu")?.querySelector(".za2-x");
    if (x) x.remove(); // menu uses primary button / ESC, no floating X
  }

  /* ----------------------------------------------------------------- HUD */
  function updateHUD() {
    const st = GameState.data;
    $("balance").textContent = fmt2(st.balance);
    $("lastwin").textContent = fmt2(st.lastWin);
    $("bet-chip").textContent = fmt2(st.currentBet);
    $("bet").textContent = fmt2(st.currentBet);
    $("spin-bet").textContent = fmt2(st.currentBet);
    $("chip-win").classList.toggle("is-hot", st.lastWin > 0);
    const idx = CONFIG.BETS.indexOf(st.currentBet);
    $("bet-down").disabled = idx <= 0;
    $("bet-up").disabled = idx >= CONFIG.BETS.length - 1 || CONFIG.BETS[idx + 1] > st.balance;
    updateAscension();
    updateStatus();
  }
  function flashChip(key) {
    const chipMap = { balance: "chip-balance", lastwin: "chip-win", bet: "chip-bet" };
    const chip = $(chipMap[key] || chipMap.balance);
    if (!chip) return;
    gsap.fromTo(chip, { scale: 1.16 }, { scale: 1, duration: 0.5, ease: "back.out(3)", overwrite: "auto" });
  }
  function updateAscension() {
    const st = GameState.data;
    ascensionNodes.forEach((n, i) => n.classList.toggle("is-on", i < st.ascensionCharge));
    $("asc-count").textContent = st.ascensionArmed ? "x5 ARMED" : `${st.ascensionCharge}/${CONFIG.ASCENSION_CHARGES}`;
    $("ascension").classList.toggle("is-armed", st.ascensionArmed);
  }
  function updateStatus() {
    const st = GameState.data;
    const parts = [];
    if (BonusEngine.isActive()) {
      const bs = BonusEngine.state;
      parts.push(`FREE SPINS ${bs.total - bs.remaining}/${bs.total} · MULT x${bs.mult}`);
    }
    if (st.ascensionArmed) parts.push("ASCENSION x5 ARMED");
    const s = $("status");
    if (parts.length) {
      s.textContent = parts.join("  ✦  ");
      s.classList.add("is-visible");
      s.classList.toggle("is-gold", st.ascensionArmed && !BonusEngine.isActive());
    } else {
      s.classList.remove("is-visible");
    }
  }
  function setSpinBusy(busy) {
    $("spinwrap").classList.toggle("is-spinning", busy);
    $("spin").disabled = busy || !gameStarted;
    if (!busy && gameStarted) {
      const z = $("spinwrap");
      z.classList.add("is-cooldown");
      clearTimeout(cooldownT);
      cooldownT = setTimeout(() => z.classList.remove("is-cooldown"), 280);
    }
  }
  function updateAutoButton() {
    const b = $("auto");
    if (AutoSpinManager.isActive()) {
      b.classList.add("is-on");
      b.innerHTML = `AUTO <span class="za2-btn-sub">${AutoSpinManager.remaining()}</span>`;
    } else {
      b.classList.remove("is-on");
      b.textContent = "AUTO";
    }
  }

  /* ------------------------------------------------------------- settings */
  function paintRange(input) { input.style.setProperty("--fill", `${input.value}%`); }
  function syncSettings() {
    const s = SettingsManager.all();
    $("vol-master").value = Math.round(s.masterVol * 100);
    $("vol-sfx").value = Math.round(s.sfxVol * 100);
    $("vol-music").value = Math.round(s.musicVol * 100);
    for (const r of [$("vol-master"), $("vol-sfx"), $("vol-music")]) paintRange(r);
    $("tg-mute").classList.toggle("is-on", s.muted);
    $("tg-turbo").classList.toggle("is-on", s.turbo);
    $("tg-quick").classList.toggle("is-on", s.quick);
    $("tg-skip").classList.toggle("is-on", s.skipAnimations);
    $("quality-seg").querySelectorAll("button").forEach((b) => b.classList.toggle("is-on", b.dataset.q === s.quality));
    const animState = s.reducedMotion ? "REDUCED" : s.turbo ? "TURBO" : "FULL";
    $("anim-seg").querySelectorAll("button").forEach((b) => b.classList.toggle("is-on", b.dataset.a === animState));
  }
  function syncFromSettings() {
    const s = SettingsManager.all();
    $("sound").innerHTML = iconSound(s.muted);
    $("sound").classList.toggle("is-on", !s.muted);
    syncFullscreenIcon();
    if (root && $("quality-seg")) syncSettings();
    updateHUD();
  }
  function syncFullscreenIcon() {
    const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
    $("fullscreen").innerHTML = iconFullscreen(active);
    $("fullscreen").classList.toggle("is-on", active);
  }
  function toggleFullscreen() {
    const d = document;
    const elx = d.documentElement;
    if (!d.fullscreenElement && !d.webkitFullscreenElement) {
      const req = elx.requestFullscreen || elx.webkitRequestFullscreen;
      if (req) req.call(elx).catch(() => {});
    } else {
      const exit = d.exitFullscreen || d.webkitExitFullscreen;
      if (exit) exit.call(d).catch(() => {});
    }
  }

  /* ------------------------------------------------------------ auto modal */
  function syncAutoModal() {
    const active = AutoSpinManager.isActive();
    $("auto-start").style.display = active ? "none" : "inline-flex";
    $("auto-stop").style.display = active ? "inline-flex" : "none";
    $("auto-turbo").classList.toggle("is-on", autoCfg.turbo);
    $("auto-quick").classList.toggle("is-on", autoCfg.quick);
    $("auto-skip").classList.toggle("is-on", autoCfg.skipWin);
    $("auto-stopbonus").classList.toggle("is-on", autoCfg.stopAfterBonus);
    $("auto-stopbigwin").classList.toggle("is-on", autoCfg.stopAfterBigWin);
    $("auto-stopbelow").value = autoCfg.stopBelow || 0;
    $("auto-stopabove").value = autoCfg.stopAbove || 0;
    $("auto-counts").querySelectorAll(".za2-count").forEach((c) => c.classList.toggle("is-on", +c.dataset.n === autoCfg.count));
    $("auto-progress").classList.toggle("is-visible", active);
    if (active) $("auto-progress-text").textContent = `${AutoSpinManager.remaining()} SPINS LEFT`;
  }

  /* ----------------------------------------------------------- leaderboard */
  async function refreshBoard() {
    $("board-body").innerHTML = `<div class="za2-board-state"><div class="za2-spinner"></div><p>Charting star positions…</p></div>`;
    const res = await LeaderboardService.getTop50();
    renderBoard(res);
  }
  function openBoard() {
    openOverlay("board"); // openOverlay triggers refreshBoard()
  }
  function renderBoard({ status, rows, source }) {
    const modeEl = $("board-mode");
    const online = source === "online";
    const cached = source === "cache";
    modeEl.textContent = online ? "ONLINE" : cached ? "OFFLINE · CACHED" : "LOCAL SIM";
    modeEl.className = `za2-board-mode ${online ? "is-online" : cached ? "is-offline" : ""}`.trim();
    const body = $("board-body");
    const note = $("board-note");

    if (status === "error") {
      modeEl.classList.add("is-error");
      modeEl.textContent = "ERROR";
      body.innerHTML = `<div class="za2-board-state is-error"><p>Stellar interference — the chart could not be read.</p>
        <button class="za2-btn is-small" style="margin:14px auto 0;" id="za-board-retry">Retry</button></div>`;
      $("board-retry").addEventListener("click", () => { SoundManager.play("ui"); refreshBoard(); });
      note.textContent = "";
      return;
    }
    if (status === "empty") {
      body.innerHTML = `<div class="za2-board-state"><p>The cosmos awaits its first legend.</p></div>`;
      note.textContent = "Be the first to engrave a score.";
      return;
    }
    body.innerHTML = `<div class="za2-board-list">${rows.map((r, i) => {
      const rank = i + 1;
      const you = lastSubmitted && lastSubmitted.name === r.player_name && lastSubmitted.score === r.score;
      const title = rank <= 25 ? LeaderboardService.titleForRank(rank) : "";
      return `<div class="za2-board-row ${you ? "is-you" : ""}">
        <span class="za2-board-rank">${rank}</span>
        <span class="za2-board-name">${escapeHtml(r.player_name)}${you ? " · YOU" : ""}${title ? `<span class="za2-board-ranktitle">${title}</span>` : ""}</span>
        <span class="za2-board-score">${Number(r.score).toLocaleString()}</span>
      </div>`;
    }).join("")}</div>`;
    note.textContent = online
      ? "Synced with Supabase · RLS protected · read & insert only."
      : cached
        ? "Connection lost — showing the last cached star chart."
        : "Local simulation board. Configure Supabase to go online.";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ------------------------------------------------------------- banners */
  function showBanner(tierName, amount) {
    return new Promise((resolve) => {
      $("banner-title").textContent = tierName;
      $("banner-amount").textContent = "0";
      $("banner").classList.add("is-open");
      const obj = { v: 0 };
      gsap.fromTo($("banner-title"), { scale: 2.4, opacity: 0, filter: "blur(14px)" },
        { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.45, ease: "back.out(2)" });
      gsap.to(obj, {
        v: amount, duration: 1.1, delay: 0.25, ease: "power1.out",
        onUpdate: () => { $("banner-amount").textContent = Math.round(obj.v).toLocaleString(); SoundManager.play("coin"); },
        onComplete: () => {
          gsap.to($("banner"), {
            opacity: 0, duration: 0.4, delay: 0.5,
            onComplete: () => {
              $("banner").classList.remove("is-open");
              gsap.set($("banner"), { opacity: 1 });
              resolve();
            },
          });
        },
      });
    });
  }
  function showMultiplierBadge(mult) {
    const geo = Renderer.frameGeometry();
    const badge = $("multibadge");
    badge.textContent = `x${mult}`;
    badge.style.left = `${geo.ox + geo.gridW - 10}px`;
    badge.style.top = `${geo.oy - 30}px`;
    gsap.fromTo(badge, { opacity: 0, scale: 0.4, y: 14 }, { opacity: 1, scale: 1, y: 0, duration: 0.28, ease: "back.out(3)" });
    gsap.to(badge, { opacity: 0, scale: 1.25, duration: 0.3, delay: 0.75, ease: "power2.in" });
    if (!SettingsManager.get("reducedMotion")) Renderer.addShake(3);
  }
  function floatText(text, x, y) {
    const f = document.createElement("div");
    f.className = "za2-floater";
    f.textContent = text;
    f.style.left = `${x}px`;
    f.style.top = `${y}px`;
    root.appendChild(f);
    gsap.fromTo(f, { opacity: 0, y: 10, scale: 0.8 }, { opacity: 1, y: -28, scale: 1, duration: 0.9, ease: "power2.out", onComplete: () => f.remove() });
    gsap.to(f, { opacity: 0, delay: 0.65, duration: 0.3 });
  }
  function quickMode() {
    return SettingsManager.get("quick") || SettingsManager.get("skipAnimations");
  }
  async function showBonusGrant(scatter) {
    floatText(`+${scatter.pay} SCATTER PAY`, Renderer.W / 2 - 80, Renderer.frameGeometry().oy - 44);
    const s = $("status");
    s.textContent = `ASCENSION GRANTED — ${scatter.spins} FREE SPINS`;
    s.classList.add("is-visible");
    await wait(quickMode() ? 500 : 1300);
  }
  async function showBonusSummary(totalWon) {
    const s = $("status");
    s.textContent = `FREE SPINS COMPLETE — WON ${fmt2(totalWon)}`;
    s.classList.add("is-visible");
    SoundManager.play("win", 2);
    await wait(quickMode() ? 600 : 1600);
    s.classList.remove("is-visible");
  }

  /* ------------------------------------------------------------------ boot */
  async function bootSequence() {
    openOverlayRaw("boot");
    const lines = ["Calibrating RNG core…", "Charting 243 ways…", "Binding constellations…", "Linking Cosmic Legends…", "Ready"];
    gsap.fromTo($("boot-emblem"), { scale: 0.3, opacity: 0, rotate: -120 }, { scale: 1, opacity: 1, rotate: 0, duration: 0.8, ease: "back.out(1.5)" });
    const prog = { v: 0 };
    gsap.to(prog, { v: 100, duration: 1.25, ease: "power1.inOut", onUpdate: () => { $("boot-fill").style.width = `${prog.v}%`; } });
    for (let i = 0; i < lines.length; i++) {
      $("boot-lines").textContent = lines[i];
      await wait(i === lines.length - 1 ? 300 : 260);
    }
    await new Promise((r) => gsap.to($("ov-boot"), { opacity: 0, duration: 0.4, onComplete: r }));
    closeOverlayRaw("boot");
    gsap.set($("ov-boot"), { opacity: 1 });
    openOverlayRaw("menu");
    syncMenuMode();
    $("spin").disabled = true;
  }

  /* ---------------------------------------------------------- end flows */
  function sanitizeName(v) {
    return String(v)
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[<>"'&]/g, "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 16)
      .toUpperCase();
  }
  function showNameEntry() {
    const st = GameState.data;
    const rank = LeaderboardService.rankOf(st.sessionScore);
    $("name-rank").textContent = `RANK #${rank} · ${LeaderboardService.titleForRank(rank)}`;
    $("name-input").value = sanitizeName(SettingsManager.get("playerName") || "");
    $("name-note").textContent = "Max 16 characters. HTML and control characters are stripped.";
    $("name-note").className = "za2-note";
    submitting = false;
    $("name-submit").disabled = false;
    $("name-submit").textContent = "Save Score";
    closeOverlayRaw("gameover");
    openOverlayRaw("name");
    FSM.set("NAME_ENTRY", "name entry");
    setTimeout(() => $("name-input").focus({ preventScroll: true }), 80);
  }
  async function submitName() {
    if (submitting) return; // double-click guard
    const name = sanitizeName($("name-input").value).trim();
    if (name.length < 2) {
      $("name-note").textContent = "Minimum 2 characters, pilot.";
      $("name-note").className = "za2-note is-err";
      return;
    }
    submitting = true;
    SettingsManager.set("playerName", name);
    FSM.set("SUBMITTING_SCORE", "submitting");
    $("name-note").textContent = "SUBMITTING…";
    $("name-note").className = "za2-note";
    $("name-submit").disabled = true;
    $("name-submit").textContent = "Submitting…";
    const st = GameState.data;
    let res;
    try {
      res = await LeaderboardService.submitScore({ playerName: name, score: st.sessionScore, submissionId: st.sessionId });
    } catch (e) {
      res = { ok: false, online: false, rank: LeaderboardService.rankOf(st.sessionScore) };
    }
    if (res.ok) {
      lastSubmitted = { name, score: Math.round(st.sessionScore) };
      $("name-note").textContent = res.online ? `SAVED · RANK #${res.rank}` : `SAVED LOCALLY · RANK #${res.rank} — syncs when online`;
      $("name-note").className = "za2-note is-ok";
      SoundManager.play("submit");
      await wait(950);
      closeOverlayRaw("name");
      showGameOver(true);
    } else {
      $("name-note").textContent = "ERROR — could not record the score. Try again.";
      $("name-note").className = "za2-note is-err";
      submitting = false;
      $("name-submit").disabled = false;
      $("name-submit").textContent = "Save Score";
    }
  }
  function showGameOver(submitted = false) {
    const st = GameState.data;
    FSM.set("GAME_OVER", "game over shown");
    const broke = st.balance < CONFIG.MIN_BET;
    $("go-kicker").textContent = broke ? "Out of Credits" : "Session Closed";
    $("go-title").textContent = "Your Cosmic Journey";
    $("go-start").textContent = fmt2(CONFIG.START_BALANCE);
    $("go-score").textContent = Math.round(st.sessionScore).toLocaleString();
    $("go-wins").textContent = st.totalWins;
    $("go-big").textContent = fmt2(st.biggestWin);
    $("go-mult").textContent = `x${st.highestMultiplier}`;
    $("go-spins").textContent = st.spinsPlayed;
    $("go-casc").textContent = st.cascadeCount;
    $("go-asc").textContent = st.zodiacAscensionCount;
    const qualified = LeaderboardService.qualifies(st.sessionScore);
    if (st.sessionScore > 0) {
      const rank = LeaderboardService.rankOf(st.sessionScore);
      $("go-rankline").style.display = "flex";
      $("go-rank").textContent = `#${rank}`;
      $("go-ranktitle").textContent = `COSMIC RANK · ${LeaderboardService.titleForRank(rank)}`;
    } else {
      $("go-rankline").style.display = "none";
    }
    $("go-board").style.display = "inline-flex";
    $("go-name").style.display = qualified && !submitted ? "inline-flex" : "none";
    $("go-note").textContent = submitted
      ? "Your name now burns among the Cosmic Legends."
      : qualified
        ? "You qualify for the Top 50. Record your name among the stars."
        : "The stars did not align this time. Ascend again.";
    SoundManager.play("gameOver");
    openOverlayRaw("gameover");
  }

  /* ---------------------------------------------------------------- build */
  function build(container) {
    root = container;
    container.classList.add("za-root");
    container.innerHTML = template();
    $("version").textContent = `v${CONFIG.VERSION} · ${CONFIG.STAGE}`;
    buildAscension();
    buildPaytable();
    buildHowTo();
    buildSettingsSegs();
    buildAutoCounts();
    bindControls();
    bindEngineEvents();
    syncFromSettings();
    updateAutoButton();
    return $("stage");
  }

  return {
    build, updateHUD, flashChip, updateAscension, updateStatus, setSpinBusy,
    openOverlay, closeOverlay, isOverlayOpen, bootSequence, openBoard,
    showBanner, showMultiplierBadge, floatText, showBonusGrant, showBonusSummary,
    showNameEntry, submitName, showGameOver, syncFromSettings, startGame,
    get gameStarted() { return gameStarted; },
    get root() { return root; },
  };
})();

export { UIManager };
export default UIManager;
