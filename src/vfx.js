/* ============================================================================
 * ZODIAC ASCENSION — Stage 4 VFX layer
 * Camera · Ascension cinematic · particle sub-modules (WinFX, CosmicFX,
 * MultiplierFX, BonusFX, ConstellationFX, MeteorFX).
 *
 * Presentation ONLY. This module never touches RNG, SlotMath, payouts or
 * probabilities. It imports engine modules; engine imports this module back.
 * All cross-module usage happens inside functions (after both modules are
 * evaluated), so the ESM circular reference is safe.
 * ========================================================================== */

import { gsap } from "gsap";
import {
  Utils, Renderer, ParticleEngine, ConstellationEngine,
  CONSTELLATION_IDS, SoundManager, SettingsManager,
  AmbientFX,
} from "./engine";

/* Ascension titles, indexed by magnitude (0 = small … 4 = cosmic). */
const ASCENSION_TITLES = [
  ["STAR SEEKER", "ASTRAL POWER", "ZODIAC FORTUNE"],
  ["COSMIC AWAKENING", "DESTINY AWAKENS", "CELESTIAL BLESSING"],
  ["ASCENDING", "CHOSEN BY THE STARS", "COSMIC ALIGNMENT", "DESTINY UNFOLDS"],
  ["CREATOR OF DESTINY", "MASTER OF THE ZODIAC", "CELESTIAL ASCENSION", "THE STARS HAVE CHOSEN YOU"],
  ["COSMIC SOVEREIGN", "IMMORTAL", "TRANSCENDING FATE", "MASTER OF DESTINY", "BEYOND THE ZODIAC", "ASCENDED", "ETERNAL COSMIC POWER"],
];

/* ========================================================================== *
 * Camera — subtle zoom / drift / shake / flash / radial burst.
 * ========================================================================== */
const Camera = (() => {
  const cam = { zoom: 1, x: 0, y: 0, flash: 0, flashColor: "255,233,173", burst: 0 };
  let driftT = 0;
  function reduced() { return !!SettingsManager.get("reducedMotion"); }
  function update(dt) {
    driftT += dt;
    if (!reduced()) {
      cam.x = Math.sin(driftT * 0.25) * 3;
      cam.y = Math.cos(driftT * 0.18) * 2.5;
    } else {
      cam.x = 0; cam.y = 0;
    }
    if (cam.flash > 0) cam.flash = Math.max(0, cam.flash - dt * 2.4);
    if (cam.burst > 0) cam.burst = Math.max(0, cam.burst - dt * 1.4);
  }
  function zoomTo(z, dur = 0.5, ease = "power2.out") {
    return Utils.tween(cam, { zoom: z, duration: dur, ease });
  }
  function zoomPulse(z = 1.05, dur = 0.4) {
    return Utils.tween(cam, { zoom: z, duration: dur * 0.4, ease: "power2.out" })
      .then(() => Utils.tween(cam, { zoom: 1, duration: dur * 0.6, ease: "power2.inOut" }));
  }
  function impactFlash(color = "255,233,173", strength = 0.5) {
    if (reduced()) return;
    cam.flashColor = color;
    cam.flash = Math.max(cam.flash, strength);
  }
  function radialBurst(strength = 1) {
    if (reduced()) return;
    cam.burst = Math.max(cam.burst, strength);
  }
  function reset() { cam.zoom = 1; cam.x = 0; cam.y = 0; cam.flash = 0; cam.burst = 0; }
  return { cam, update, zoomTo, zoomPulse, impactFlash, radialBurst, reset };
})();

/* ========================================================================== *
 * Particle sub-modules — thin orchestrators over the pooled ParticleEngine.
 * ========================================================================== */
const WinFX = {
  sparkle(x, y, color, n = 10) { ParticleEngine.burst(x, y, color, n, { speed: 140, life: 0.7, size: 2.6 }); },
  ring(x, y, color) { ParticleEngine.burst(x, y, color, 16, { speed: 220, life: 0.5, size: 2.2, grav: 0 }); },
};
const CosmicFX = {
  explosion(n = 60) {
    const geo = Renderer.frameGeometry();
    const cx = geo.ox + geo.gridW / 2, cy = geo.oy + geo.gridH / 2;
    const colors = ["#ffe9ad", "#35e0ff", "#ff4fd8", "#7dffa8", "#bff3ff"];
    for (let i = 0; i < n; i++) {
      ParticleEngine.burst(
        geo.ox + Math.random() * geo.gridW,
        geo.oy + Math.random() * geo.gridH,
        colors[i % colors.length], 3, { speed: 260, life: 1.2, size: 3, grav: 60 }
      );
    }
    ParticleEngine.burst(cx, cy, "#ffe9ad", 30, { speed: 380, life: 1, size: 3.4, grav: 0 });
  },
  lightBurst() {
    const geo = Renderer.frameGeometry();
    ParticleEngine.burst(geo.ox + geo.gridW / 2, geo.oy + geo.gridH / 2, "#ffffff", 24, { speed: 460, life: 0.55, size: 2.4, grav: 0 });
  },
};
const MultiplierFX = {
  orb(x, y, color = "#35e0ff") {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ParticleEngine.burst(x + Math.cos(a) * 26, y + Math.sin(a) * 26, color, 1, { speed: 30, life: 0.6, size: 2.4, grav: 0 });
    }
    ParticleEngine.burst(x, y, color, 10, { speed: 120, life: 0.5, size: 2.6, grav: 0 });
  },
};
const MeteorFX = {
  streak() {
    const geo = Renderer.frameGeometry();
    const x = geo.ox + Math.random() * geo.gridW;
    ParticleEngine.burst(x, geo.oy - 20, "#ffd98a", 8, { speed: 60, life: 0.8, size: 2.4, grav: 500 });
  },
};
const ConstellationFX = {
  play(id, x, y, size, dur) { return ConstellationEngine.cinematic(id, x, y, size, dur); },
  randomAtBoard(dur = 2.2) {
    const geo = Renderer.frameGeometry();
    const id = CONSTELLATION_IDS[Math.floor(Math.random() * CONSTELLATION_IDS.length)];
    return ConstellationEngine.cinematic(id, geo.ox + geo.gridW * 0.5 - geo.cell * 1.2, geo.oy - geo.cell * 0.05, geo.cell * 2.4, dur);
  },
};
const BonusFX = {
  portal() {
    const geo = Renderer.frameGeometry();
    const cx = geo.ox + geo.gridW / 2, cy = geo.oy + geo.gridH / 2;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const r = geo.cell * 2.2;
      ParticleEngine.burst(cx + Math.cos(a) * r, cy + Math.sin(a) * r, i % 2 ? "#ff4fd8" : "#35e0ff", 2, { speed: -60, life: 1, size: 2.8, grav: 0 });
    }
  },
};

/* ========================================================================== *
 * Ascension — the signature ZODIAC ASCENSION cinematic.
 * ========================================================================== */
const Ascension = (() => {
  let playing = false;
  let veil = null, titleEl = null, signEl = null;

  function ensureDom() {
    if (veil) return;
    veil = document.createElement("div");
    veil.className = "za-asc-veil";
    veil.innerHTML = `
      <div class="za-asc-sign" id="za-asc-sign"></div>
      <div class="za-asc-kicker">ZODIAC ASCENSION</div>
      <div class="za-asc-title" id="za-asc-title"></div>
    `;
    document.body.appendChild(veil);
    titleEl = veil.querySelector("#za-asc-title");
    signEl = veil.querySelector("#za-asc-sign");
  }
  function pickTitle(magnitude) {
    const tier = ASCENSION_TITLES[Utils.clamp(magnitude, 0, ASCENSION_TITLES.length - 1)];
    return tier[Math.floor(Math.random() * tier.length)];
  }
  async function play({ magnitude = 1, sign = null } = {}) {
    if (playing || SettingsManager.get("skipAnimations")) return;
    playing = true;
    ensureDom();
    const reduced = SettingsManager.get("reducedMotion");
    const id = sign || CONSTELLATION_IDS[Math.floor(Math.random() * CONSTELLATION_IDS.length)];
    const title = pickTitle(magnitude);
    const geo = Renderer.frameGeometry();
    const cx = geo.ox + geo.gridW / 2, cy = geo.oy + geo.gridH / 2;

    SoundManager.play("ascension");
    AmbientFX.hype(3);

    veil.classList.add("is-open");
    await Utils.tween(veil, { opacity: 1, duration: reduced ? 0.15 : 0.45, ease: "power2.out" });
    Camera.zoomTo(reduced ? 1 : 1.06, 0.7);

    const constSize = Math.min(geo.gridW, geo.gridH) * 0.9;
    ConstellationFX.play(id, cx - constSize / 2, cy - constSize / 2, constSize, reduced ? 1.2 : 2.4);

    signEl.textContent = (id || "").toUpperCase();
    titleEl.textContent = title;
    if (!reduced) {
      gsap.fromTo(signEl, { scale: 0.6, opacity: 0, filter: "blur(8px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.6, delay: 0.5, ease: "back.out(2)" });
      gsap.fromTo(titleEl, { y: 26, opacity: 0, letterSpacing: "0.6em" }, { y: 0, opacity: 1, letterSpacing: "0.24em", duration: 0.7, delay: 0.85, ease: "power3.out" });
    } else {
      gsap.set(signEl, { opacity: 1 });
      gsap.set(titleEl, { opacity: 1 });
    }

    await Utils.wait(reduced ? 700 : 1500);
    Camera.radialBurst(1);
    Camera.impactFlash("255,233,173", 0.55);
    CosmicFX.explosion(40);
    Renderer.addShake(reduced ? 0 : 5);

    await Utils.wait(reduced ? 400 : 900);
    await Utils.tween(veil, { opacity: 0, duration: reduced ? 0.2 : 0.5, ease: "power2.in" });
    veil.classList.remove("is-open");
    Camera.zoomTo(1, 0.5);
    playing = false;
  }
  function destroy() {
    if (veil) { veil.remove(); veil = null; titleEl = null; signEl = null; }
    playing = false;
  }
  return { play, destroy };
})();

export const VFX = {
  Camera, Ascension,
  WinFX, CosmicFX, MultiplierFX, MeteorFX, ConstellationFX, BonusFX,
};
export default VFX;
