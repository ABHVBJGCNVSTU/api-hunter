"use client";

import { useEffect, useRef } from "react";

// Subtle matrix rain background — binary/katakana glyphs falling.
// Throttled to ~16fps, disabled when prefers-reduced-motion.
export default function MatrixRain() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    let w = 0;
    let h = 0;
    let drops: number[] = [];
    const fontSize = 14;

    const resize = () => {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
      const cols = Math.ceil(w / fontSize);
      drops = Array.from({ length: cols }, () => Math.floor(Math.random() * (h / fontSize)));
    };
    resize();
    window.addEventListener("resize", resize);

    const glyphs = "01アカサタナハマヤラワｦｱｳｴｶｷｽﾎﾔﾜ<>{}[]#$%&*+=;:";
    let last = 0;
    let raf = 0;

    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      if (ts - last < 62) return; // ~16 fps, mobile friendly
      last = ts;

      ctx.fillStyle = "rgba(2, 5, 3, 0.14)";
      ctx.fillRect(0, 0, w, h);
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const ch = glyphs[Math.floor(Math.random() * glyphs.length)];
        const x = i * fontSize;
        const y = drops[i] * fontSize;
        // leading glyph brighter
        ctx.fillStyle = Math.random() > 0.975 ? "rgba(120,255,170,0.5)" : "rgba(0,255,65,0.16)";
        ctx.fillText(ch, x, y);
        if (y > h && Math.random() > 0.976) drops[i] = 0;
        drops[i]++;
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 opacity-60"
    />
  );
}
