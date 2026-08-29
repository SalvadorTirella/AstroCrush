// @ts-nocheck
import { useEffect, useRef } from "react";
import { GameEngine } from "./engine";

/**
 * ZODIAC ASCENSION — React shell.
 * The full game (engine, math, rendering, UI, services) lives in src/engine.js
 * as a self-contained module graph; React only provides the mount point.
 */
export default function App() {
  const hostRef = useRef(null);

  useEffect(() => {
    const engine = GameEngine.init(hostRef.current);
    return () => engine.destroy();
  }, []);

  return (
    <div
      ref={hostRef}
      style={{ position: "fixed", inset: 0 }}
      aria-label="Zodiac Ascension slot machine"
    />
  );
}
