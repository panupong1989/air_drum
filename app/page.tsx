"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Zone = "hihat" | "snare" | "tom";

const ZONE_LABEL: Record<Zone, string> = {
  hihat: "HI-HAT",
  snare: "SNARE",
  tom: "TOM",
};

const ZONE_THAI: Record<Zone, string> = {
  hihat: "ไฮ-แฮต",
  snare: "สแนร์",
  tom: "ทอม",
};

const ZONE_COLOR: Record<Zone, string> = {
  hihat: "#fde047",
  snare: "#f43f5e",
  tom: "#38bdf8",
};

const ZONE_CODE: Record<Zone, string> = {
  hihat: "ZONE_HHT",
  snare: "ZONE_SNR",
  tom: "ZONE_TOM",
};

// ----- Drum synthesis (Web Audio API) -----

function makeNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * durationSec));
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function playHiHat(ctx: AudioContext, t: number, velocity: number) {
  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(ctx, 0.1);

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7000;

  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 10000;
  bp.Q.value = 0.6;

  const gain = ctx.createGain();
  const peak = 0.6 * velocity;
  gain.gain.setValueAtTime(peak, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

  noise.connect(hp).connect(bp).connect(gain).connect(ctx.destination);
  noise.start(t);
  noise.stop(t + 0.1);
}

function playSnare(ctx: AudioContext, t: number, velocity: number) {
  // noise component
  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(ctx, 0.2);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1000;
  const noiseGain = ctx.createGain();
  const noisePeak = 0.8 * velocity;
  noiseGain.gain.setValueAtTime(noisePeak, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  noise.connect(hp).connect(noiseGain).connect(ctx.destination);
  noise.start(t);
  noise.stop(t + 0.2);

  // tonal component
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(180, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.1);
  const oscGain = ctx.createGain();
  const oscPeak = 0.7 * velocity;
  oscGain.gain.setValueAtTime(oscPeak, t);
  oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.connect(oscGain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.14);
}

function playTom(ctx: AudioContext, t: number, velocity: number) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(160, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.25);
  const gain = ctx.createGain();
  const peak = 0.9 * velocity;
  gain.gain.setValueAtTime(peak, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.32);
}

function playZone(ctx: AudioContext, zone: Zone, velocity: number) {
  const t = ctx.currentTime;
  if (zone === "hihat") playHiHat(ctx, t, velocity);
  else if (zone === "snare") playSnare(ctx, t, velocity);
  else playTom(ctx, t, velocity);
}

// ----- Component -----

export default function Page() {
  const [started, setStarted] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);
  const [activeZone, setActiveZone] = useState<Zone>("snare");
  const [lastHit, setLastHit] = useState<{
    zone: Zone;
    velocity: number;
    t: number;
  } | null>(null);
  const [sensitivity, setSensitivity] = useState<number>(12);
  const [hits, setHits] = useState(0);
  const [calibrated, setCalibrated] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastTriggerRef = useRef<number>(0);
  const accelHistoryRef = useRef<number[]>([]);
  const baselineYawRef = useRef<number | null>(null);
  const currentYawRef = useRef<number>(0);
  const activeZoneRef = useRef<Zone>("snare");
  const sensitivityRef = useRef<number>(12);
  const startTimeRef = useRef<number>(0);

  const tiltDotRef = useRef<HTMLDivElement | null>(null);
  const tiltLabelRef = useRef<HTMLSpanElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const flashLayerRef = useRef<HTMLDivElement | null>(null);

  // Mirror state -> refs
  useEffect(() => {
    activeZoneRef.current = activeZone;
  }, [activeZone]);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  const recalibrate = useCallback(() => {
    baselineYawRef.current = null;
    setCalibrated(false);
    startTimeRef.current = performance.now();
  }, []);

  const triggerHit = useCallback((zone: Zone, velocity: number) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    playZone(ctx, zone, velocity);
    setHits((h) => h + 1);
    setLastHit({ zone, velocity, t: performance.now() });

    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(15);
    }

    // pulse ring
    const layer = flashLayerRef.current;
    if (layer) {
      const ring = document.createElement("div");
      ring.className =
        "absolute inset-0 rounded-2xl border-4 pulse-ring pointer-events-none";
      ring.style.borderColor = ZONE_COLOR[zone];
      layer.appendChild(ring);
      window.setTimeout(() => ring.remove(), 520);
    }
  }, []);

  const handleMotion = useCallback(
    (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);

      const hist = accelHistoryRef.current;
      hist.push(mag);
      if (hist.length > 8) hist.shift();
      const baseline =
        hist.reduce((s, v) => s + v, 0) / Math.max(1, hist.length);

      const delta = mag - baseline;
      const now = performance.now();
      const sinceLast = now - lastTriggerRef.current;

      if (
        delta > sensitivityRef.current &&
        sinceLast > 90 &&
        baselineYawRef.current !== null
      ) {
        lastTriggerRef.current = now;
        const velocity = Math.min(1, delta / 35);
        triggerHit(activeZoneRef.current, velocity);
      }
    },
    [triggerHit]
  );

  const handleOrientation = useCallback((e: DeviceOrientationEvent) => {
    // Prefer iOS webkitCompassHeading (true compass heading) — note it
    // rotates opposite to alpha, so invert to match alpha's convention.
    const webkitHeading = (e as unknown as { webkitCompassHeading?: number })
      .webkitCompassHeading;
    const alpha =
      webkitHeading != null && !Number.isNaN(webkitHeading)
        ? 360 - webkitHeading
        : e.alpha;
    if (alpha == null) return;
    currentYawRef.current = alpha;

    const since = performance.now() - startTimeRef.current;
    if (baselineYawRef.current === null && since > 800) {
      baselineYawRef.current = alpha;
      setCalibrated(true);
    }
  }, []);

  // requestAnimationFrame loop for live tilt + zone
  useEffect(() => {
    if (!started) return;
    const loop = () => {
      const baseline = baselineYawRef.current;
      const cur = currentYawRef.current;
      let relative = 0;
      if (baseline !== null) {
        relative = cur - baseline;
        // Compass heading wraps at 360° — normalize to [-180, 180]
        if (relative > 180) relative -= 360;
        if (relative < -180) relative += 360;
      }

      // Map [-60, 60] -> [0, 100]
      const pct = Math.max(0, Math.min(100, ((relative + 60) / 120) * 100));
      const dot = tiltDotRef.current;
      if (dot) dot.style.left = `${pct}%`;
      const lbl = tiltLabelRef.current;
      if (lbl) lbl.textContent = relative.toFixed(1);

      let nextZone: Zone = "snare";
      if (relative < -30) nextZone = "hihat";
      else if (relative > 30) nextZone = "tom";

      if (nextZone !== activeZoneRef.current) {
        activeZoneRef.current = nextZone;
        setActiveZone(nextZone);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [started]);

  // Wire native sensor listeners after start
  useEffect(() => {
    if (!started) return;
    window.addEventListener("devicemotion", handleMotion);
    window.addEventListener("deviceorientation", handleOrientation);
    return () => {
      window.removeEventListener("devicemotion", handleMotion);
      window.removeEventListener("deviceorientation", handleOrientation);
    };
  }, [started, handleMotion, handleOrientation]);

  const startApp = useCallback(async () => {
    setPermError(null);
    try {
      // 1) Synchronously create AudioContext + start silent buffer (iOS unlock)
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx({ latencyHint: "interactive" });
      audioCtxRef.current = ctx;
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);

      // 2) Synchronously kick off permission requests so transient
      //    user-activation is still valid (iOS 13+).
      const MotionAny = DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<"granted" | "denied">;
      };
      const OrientAny = DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<"granted" | "denied">;
      };
      const motionP: Promise<"granted" | "denied"> =
        typeof MotionAny.requestPermission === "function"
          ? MotionAny.requestPermission()
          : Promise.resolve("granted");
      const orientP: Promise<"granted" | "denied"> =
        typeof OrientAny.requestPermission === "function"
          ? OrientAny.requestPermission()
          : Promise.resolve("granted");

      // 3) Now safe to await
      if (ctx.state === "suspended") await ctx.resume();
      const m = await motionP;
      const o = await orientP;
      if (m !== "granted") {
        setPermError("Motion permission denied — กรุณาอนุญาตการเคลื่อนไหว");
        return;
      }
      if (o !== "granted") {
        setPermError("Orientation permission denied — กรุณาอนุญาตการหมุนทิศ");
        return;
      }

      startTimeRef.current = performance.now();
      baselineYawRef.current = null;
      setCalibrated(false);
      setStarted(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPermError(`Init error: ${msg}`);
    }
  }, []);

  // ----- UI -----

  if (!started) {
    return <StartScreen onStart={startApp} permError={permError} />;
  }

  const velocityPct = lastHit ? Math.round(lastHit.velocity * 100) : 0;
  const flashKey = lastHit ? lastHit.t : 0;

  return (
    <main className="grid-bg relative h-[100dvh] w-full flex flex-col px-4 pb-4 pt-3 overflow-hidden">
      <div className="scanline" />

      {/* Header */}
      <header className="flex items-center justify-between gap-2 z-10">
        <div className="flex items-center gap-2 font-mono text-xs">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full bg-snare blink-dot"
            style={{ boxShadow: "0 0 10px #f43f5e" }}
          />
          <span className="tracking-widest font-bold">LIVE</span>
        </div>
        <div className="font-display text-sm tracking-wider">
          HITS{" "}
          <span style={{ color: ZONE_COLOR[activeZone] }}>
            {String(hits).padStart(3, "0")}
          </span>
        </div>
        <button
          onClick={recalibrate}
          className="font-mono text-xs px-3 py-1.5 border border-zinc-700 rounded hover:border-zinc-500 active:scale-95 transition"
        >
          RECAL
        </button>
      </header>

      {/* Active Zone Display */}
      <section className="relative flex-1 mt-3 mb-3 rounded-2xl border-2 overflow-hidden"
        style={{
          borderColor: ZONE_COLOR[activeZone],
          background: `radial-gradient(ellipse at center, ${ZONE_COLOR[activeZone]}22 0%, transparent 70%)`,
          transition: "border-color 180ms ease, background 180ms ease",
        }}
      >
        <div ref={flashLayerRef} className="absolute inset-0 pointer-events-none" />

        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
          <div
            key={flashKey}
            className={`font-display leading-none ${lastHit ? "hit-flash" : ""}`}
            style={{
              color: ZONE_COLOR[activeZone],
              fontSize: "clamp(56px, 18vw, 140px)",
              textShadow: `0 0 24px ${ZONE_COLOR[activeZone]}AA`,
              letterSpacing: "0.02em",
            }}
          >
            {ZONE_LABEL[activeZone]}
          </div>
          <div
            className="mt-3 font-mono text-lg opacity-80"
            style={{ color: ZONE_COLOR[activeZone] }}
          >
            {ZONE_THAI[activeZone]}
          </div>
        </div>

        <div className="absolute bottom-3 left-4 font-mono text-xs text-zinc-400">
          VEL <span className="text-zinc-200 font-bold">
            {String(velocityPct).padStart(2, "0")}
          </span>
        </div>
        <div className="absolute bottom-3 right-4 font-mono text-xs text-zinc-400">
          {ZONE_CODE[activeZone]}
        </div>

        {!calibrated && (
          <div className="absolute inset-0 z-20 backdrop-blur-md bg-black/60 flex flex-col items-center justify-center">
            <div
              className="font-display text-2xl tracking-widest"
              style={{ color: "#fde047" }}
            >
              CALIBRATING
            </div>
            <div className="mt-2 font-mono text-xs text-zinc-400">
              ถือมือถือให้นิ่ง · กำลังอ่านค่าเริ่มต้น
            </div>
            <div className="mt-4 flex gap-1">
              <span className="w-2 h-2 rounded-full bg-snare blink-dot" />
              <span
                className="w-2 h-2 rounded-full bg-hihat blink-dot"
                style={{ animationDelay: "120ms" }}
              />
              <span
                className="w-2 h-2 rounded-full bg-tom blink-dot"
                style={{ animationDelay: "240ms" }}
              />
            </div>
          </div>
        )}
      </section>

      {/* Tilt Indicator */}
      <section className="z-10">
        <div className="relative h-9 rounded-md border border-zinc-800 overflow-hidden flex">
          <div className="flex-1 bg-hihat/15" />
          <div className="flex-1 bg-snare/15" />
          <div className="flex-1 bg-tom/15" />
          <div
            ref={tiltDotRef}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-white"
            style={{
              left: "50%",
              boxShadow: "0 0 12px rgba(255,255,255,0.8)",
              transition: "left 60ms linear",
            }}
          />
          <div className="absolute inset-0 flex items-center justify-between px-2 font-mono text-[10px] uppercase tracking-widest text-zinc-300/70 pointer-events-none">
            <span>← HI-HAT</span>
            <span>SNARE</span>
            <span>TOM →</span>
          </div>
        </div>
        <div className="mt-1 font-mono text-[11px] text-zinc-500">
          AIM <span ref={tiltLabelRef} className="text-zinc-300">0.0</span>°
        </div>
      </section>

      {/* Sensitivity slider */}
      <section className="mt-3 z-10">
        <div className="flex items-center justify-between font-mono text-xs text-zinc-400 mb-1">
          <span>SENSITIVITY</span>
          <span className="text-zinc-200 font-bold">{sensitivity}</span>
        </div>
        <input
          type="range"
          min={8}
          max={35}
          value={sensitivity}
          onChange={(e) => setSensitivity(Number(e.target.value))}
        />
      </section>

      <footer className="mt-3 text-center text-[10px] text-zinc-500 font-mono leading-relaxed z-10">
        ถือมือถือเหมือนถือไม้กลอง · สะบัดข้อมือลงเร็วๆ เพื่อตี ·
        ชี้แขนซ้าย/ขวา เปลี่ยนเสียง
      </footer>
    </main>
  );
}

// ----- Start Screen -----

function StartScreen({
  onStart,
  permError,
}: {
  onStart: () => void;
  permError: string | null;
}) {
  return (
    <main className="grid-bg relative h-[100dvh] w-full flex flex-col items-center justify-between px-6 py-8 overflow-hidden">
      <div className="scanline" />

      <header className="mt-6 text-center z-10">
        <h1
          className="font-display leading-none"
          style={{ fontSize: "clamp(56px, 18vw, 120px)", letterSpacing: "0.04em" }}
        >
          <span style={{ color: "#fde047", textShadow: "0 0 24px #fde04788" }}>
            AIR
          </span>
          <br />
          <span style={{ color: "#f43f5e", textShadow: "0 0 32px #f43f5e99" }}>
            DRUM
          </span>
        </h1>
        <p className="mt-5 font-mono text-sm text-zinc-300/90 leading-relaxed max-w-xs mx-auto">
          ถือมือถือเป็นไม้กลอง · สะบัดข้อมือเพื่อตี
          <br />
          ชี้แขนซ้าย/ขวา เปลี่ยนเสียง
        </p>
      </header>

      <section className="grid grid-cols-3 gap-3 w-full max-w-sm z-10">
        <ZonePreview
          color="#fde047"
          label="HI-HAT"
          sub="← ซ้าย"
        />
        <ZonePreview
          color="#f43f5e"
          label="SNARE"
          sub="● กลาง"
        />
        <ZonePreview
          color="#38bdf8"
          label="TOM"
          sub="ขวา →"
        />
      </section>

      <div className="flex flex-col items-center gap-4 z-10">
        <button
          onClick={onStart}
          className="font-display text-2xl tracking-widest w-44 h-44 rounded-full border-4 active:scale-95 transition"
          style={{
            borderColor: "#f43f5e",
            color: "#f43f5e",
            boxShadow:
              "0 0 50px rgba(244,63,94,0.65), inset 0 0 30px rgba(244,63,94,0.25)",
            background: "radial-gradient(circle, #f43f5e22, transparent 70%)",
          }}
        >
          ▶ START
        </button>
        {permError && (
          <div className="font-mono text-xs text-rose-400 text-center max-w-xs">
            {permError}
          </div>
        )}
      </div>

      <footer className="font-mono text-[10px] text-zinc-500 text-center leading-relaxed z-10">
        แนะนำ: เปิดบนมือถือ · iOS ต้องอนุญาต Motion · ใส่หูฟังให้ฟีลดี
      </footer>
    </main>
  );
}

function ZonePreview({
  color,
  label,
  sub,
}: {
  color: string;
  label: string;
  sub: string;
}) {
  return (
    <div
      className="rounded-xl border-2 p-3 text-center"
      style={{
        borderColor: color,
        background: `radial-gradient(circle, ${color}22, transparent 70%)`,
        boxShadow: `0 0 16px ${color}55, inset 0 0 12px ${color}33`,
      }}
    >
      <div
        className="font-display text-base tracking-wider"
        style={{ color, textShadow: `0 0 10px ${color}AA` }}
      >
        {label}
      </div>
      <div className="font-mono text-[10px] text-zinc-300/80 mt-1">{sub}</div>
    </div>
  );
}
