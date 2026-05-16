"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

type Zone = "hihat" | "snare" | "tom";
type Mode = "start" | "setup" | "play";
type DrumPosition = { angle: number; set: boolean };
type DrumPositions = Record<Zone, DrumPosition>;

const ZONES: Zone[] = ["hihat", "snare", "tom"];

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

const DEFAULT_POSITIONS: DrumPositions = {
  hihat: { angle: -30, set: false },
  snare: { angle: 0, set: false },
  tom: { angle: 30, set: false },
};

const STORAGE_KEY = "airdrum_positions";

function loadPositions(): DrumPositions {
  if (typeof window === "undefined") return DEFAULT_POSITIONS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_POSITIONS;
    const parsed = JSON.parse(raw) as Partial<DrumPositions>;
    const out: DrumPositions = {
      hihat: { ...DEFAULT_POSITIONS.hihat },
      snare: { ...DEFAULT_POSITIONS.snare },
      tom: { ...DEFAULT_POSITIONS.tom },
    };
    for (const z of ZONES) {
      const p = parsed[z];
      if (
        p &&
        typeof p.angle === "number" &&
        Number.isFinite(p.angle) &&
        typeof p.set === "boolean"
      ) {
        out[z] = { angle: p.angle, set: p.set };
      }
    }
    return out;
  } catch {
    return DEFAULT_POSITIONS;
  }
}

function getNearestZone(currentAngle: number, positions: DrumPositions): Zone {
  // If user hasn't customized any drum, fall back to comparing against the
  // default positions so play mode works out of the box.
  const anySet = ZONES.some((z) => positions[z].set);
  let nearest: Zone = "snare";
  let minDist = Infinity;
  for (const zone of ZONES) {
    if (anySet && !positions[zone].set) continue;
    let diff = Math.abs(currentAngle - positions[zone].angle);
    if (diff > 180) diff = 360 - diff;
    if (diff < minDist) {
      minDist = diff;
      nearest = zone;
    }
  }
  return nearest;
}

function angleToPct(angle: number): number {
  return Math.max(0, Math.min(100, ((angle + 60) / 120) * 100));
}

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
  const [mode, setMode] = useState<Mode>("start");
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
  const [drumPositions, setDrumPositions] =
    useState<DrumPositions>(loadPositions);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastTriggerRef = useRef<number>(0);
  const accelHistoryRef = useRef<number[]>([]);
  const baselineYawRef = useRef<number | null>(null);
  const currentYawRef = useRef<number>(0);
  const activeZoneRef = useRef<Zone>("snare");
  const sensitivityRef = useRef<number>(12);
  const startTimeRef = useRef<number>(0);
  const drumPositionsRef = useRef<DrumPositions>(drumPositions);

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

  // Persist drum positions + mirror to ref for use inside the rAF loop
  useEffect(() => {
    drumPositionsRef.current = drumPositions;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drumPositions));
    } catch {
      // ignore quota / privacy-mode errors
    }
  }, [drumPositions]);

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
    // iOS Safari exposes a true compass via webkitCompassHeading; it rotates
    // opposite to e.alpha, so invert it to share one convention downstream.
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

  // rAF loop — drives the indicator dot in both setup & play, plus zone
  // selection in play.
  useEffect(() => {
    if (mode === "start") return;
    const loop = () => {
      const baseline = baselineYawRef.current;
      let relative = 0;
      if (baseline !== null) {
        relative = currentYawRef.current - baseline;
        if (relative > 180) relative -= 360;
        if (relative < -180) relative += 360;
      }

      const pct = angleToPct(relative);
      const dot = tiltDotRef.current;
      if (dot) dot.style.left = `${pct}%`;
      const lbl = tiltLabelRef.current;
      if (lbl) lbl.textContent = relative.toFixed(1);

      if (mode === "play") {
        const nextZone = getNearestZone(relative, drumPositionsRef.current);
        if (nextZone !== activeZoneRef.current) {
          activeZoneRef.current = nextZone;
          setActiveZone(nextZone);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [mode]);

  // Sensor listeners — orientation in both setup & play, motion only in play.
  useEffect(() => {
    if (mode === "start") return;
    window.addEventListener("deviceorientation", handleOrientation);
    if (mode === "play") {
      window.addEventListener("devicemotion", handleMotion);
    }
    return () => {
      window.removeEventListener("deviceorientation", handleOrientation);
      window.removeEventListener("devicemotion", handleMotion);
    };
  }, [mode, handleMotion, handleOrientation]);

  const enterMode = useCallback(async (target: "setup" | "play") => {
    setPermError(null);
    try {
      // 1) Unlock audio synchronously on first entry (iOS user-gesture rule).
      if (!audioCtxRef.current) {
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
      }

      // 2) Kick off permission requests synchronously so the iOS gesture is
      //    still valid.
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

      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === "suspended") await ctx.resume();
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
      setMode(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPermError(`Init error: ${msg}`);
    }
  }, []);

  const handleSetDrumPosition = useCallback((zone: Zone) => {
    const baseline = baselineYawRef.current;
    if (baseline === null) return;
    let relative = currentYawRef.current - baseline;
    if (relative > 180) relative -= 360;
    if (relative < -180) relative += 360;
    setDrumPositions((prev) => ({
      ...prev,
      [zone]: { angle: relative, set: true },
    }));
    const ctx = audioCtxRef.current;
    if (ctx) {
      if (ctx.state === "suspended") ctx.resume();
      playZone(ctx, zone, 0.7);
    }
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(20);
    }
  }, []);

  const handleResetDrumPosition = useCallback((zone: Zone) => {
    setDrumPositions((prev) => ({
      ...prev,
      [zone]: { angle: DEFAULT_POSITIONS[zone].angle, set: false },
    }));
  }, []);

  const finishSetup = useCallback(() => {
    // Preserve baseline so positions captured during setup stay meaningful.
    setMode("play");
  }, []);

  const exitSetup = useCallback(() => {
    setMode("start");
  }, []);

  // ----- Render -----

  if (mode === "start") {
    return (
      <StartScreen
        onStart={() => enterMode("play")}
        onSetup={() => enterMode("setup")}
        permError={permError}
      />
    );
  }

  if (mode === "setup") {
    return (
      <SetupScreen
        positions={drumPositions}
        calibrated={calibrated}
        onSet={handleSetDrumPosition}
        onReset={handleResetDrumPosition}
        onDone={finishSetup}
        onCancel={exitSetup}
        tiltDotRef={tiltDotRef}
        tiltLabelRef={tiltLabelRef}
      />
    );
  }

  const velocityPct = lastHit ? Math.round(lastHit.velocity * 100) : 0;
  const flashKey = lastHit ? lastHit.t : 0;
  const allCustom = ZONES.every((z) => drumPositions[z].set);

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
      <section
        className="relative flex-1 mt-3 mb-3 rounded-2xl border-2 overflow-hidden"
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
          VEL{" "}
          <span className="text-zinc-200 font-bold">
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

      {/* AIM Indicator with per-drum markers */}
      <section className="z-10">
        <div className="relative h-9 rounded-md border border-zinc-800 overflow-hidden bg-zinc-900/40">
          {ZONES.map((z) => {
            const pos = drumPositions[z];
            const color = ZONE_COLOR[z];
            return (
              <div
                key={z}
                className="absolute top-0 bottom-0 w-1 -translate-x-1/2"
                style={{
                  left: `${angleToPct(pos.angle)}%`,
                  background: color,
                  boxShadow: `0 0 8px ${color}`,
                  opacity: pos.set ? 1 : 0.5,
                }}
                aria-label={ZONE_LABEL[z]}
              />
            );
          })}
          <div
            ref={tiltDotRef}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-white"
            style={{
              left: "50%",
              boxShadow: "0 0 12px rgba(255,255,255,0.8)",
              transition: "left 60ms linear",
            }}
          />
        </div>
        <div className="mt-1 font-mono text-[11px] flex justify-between">
          <span className="text-zinc-500">
            AIM{" "}
            <span ref={tiltLabelRef} className="text-zinc-300">
              0.0
            </span>
            °
          </span>
          {!allCustom && (
            <span className="text-zinc-600 tracking-wider">DEFAULT KIT</span>
          )}
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
        ชี้แขนซ้าย/ขวา เปลี่ยนเสียง · RECAL = รีเซ็ตทิศปัจจุบัน
      </footer>
    </main>
  );
}

// ----- Start Screen -----

function StartScreen({
  onStart,
  onSetup,
  permError,
}: {
  onStart: () => void;
  onSetup: () => void;
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
        <ZonePreview color="#fde047" label="HI-HAT" sub="← ซ้าย" />
        <ZonePreview color="#f43f5e" label="SNARE" sub="● กลาง" />
        <ZonePreview color="#38bdf8" label="TOM" sub="ขวา →" />
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
        <button
          onClick={onSetup}
          className="font-mono text-xs tracking-widest px-5 py-2.5 border border-zinc-600 rounded text-zinc-300 hover:border-zinc-400 hover:text-zinc-100 active:scale-95 transition"
        >
          ⚙ SETUP DRUMS
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

// ----- Setup Screen -----

function SetupScreen({
  positions,
  calibrated,
  onSet,
  onReset,
  onDone,
  onCancel,
  tiltDotRef,
  tiltLabelRef,
}: {
  positions: DrumPositions;
  calibrated: boolean;
  onSet: (zone: Zone) => void;
  onReset: (zone: Zone) => void;
  onDone: () => void;
  onCancel: () => void;
  tiltDotRef: MutableRefObject<HTMLDivElement | null>;
  tiltLabelRef: MutableRefObject<HTMLSpanElement | null>;
}) {
  const allSet = ZONES.every((z) => positions[z].set);
  return (
    <main className="grid-bg relative h-[100dvh] w-full flex flex-col px-4 pb-4 pt-3 overflow-hidden">
      <div className="scanline" />

      <header className="flex items-center justify-between gap-2 z-10">
        <div
          className="font-display text-lg tracking-widest"
          style={{ color: "#fde047", textShadow: "0 0 12px #fde04788" }}
        >
          SETUP YOUR KIT
        </div>
        <button
          onClick={onCancel}
          className="font-mono text-sm w-9 h-9 border border-zinc-700 rounded hover:border-zinc-500 active:scale-95 transition"
          aria-label="Cancel setup"
        >
          ✕
        </button>
      </header>

      <p className="mt-3 font-mono text-[11px] text-zinc-400 leading-relaxed text-center z-10">
        ชี้มือถือไปทิศที่ต้องการให้กลองอยู่ · แล้วกดปุ่มของกลองใบนั้น
      </p>

      <section className="flex-1 mt-4 flex flex-col gap-3 z-10 overflow-y-auto">
        {ZONES.map((zone) => {
          const pos = positions[zone];
          const color = ZONE_COLOR[zone];
          return (
            <div
              key={zone}
              className="rounded-xl border-2 p-4 flex items-center justify-between transition"
              style={{
                borderColor: pos.set ? color : "#3f3f46",
                background: pos.set
                  ? `radial-gradient(ellipse at center, ${color}22 0%, transparent 75%)`
                  : "rgba(24,24,27,0.4)",
                boxShadow: pos.set
                  ? `0 0 18px ${color}33, inset 0 0 12px ${color}1f`
                  : "none",
              }}
            >
              <div>
                <div
                  className="font-display text-2xl tracking-wider flex items-center gap-2"
                  style={{
                    color: pos.set ? color : "#a1a1aa",
                    textShadow: pos.set ? `0 0 10px ${color}AA` : "none",
                  }}
                >
                  {pos.set && <span>✓</span>}
                  {ZONE_LABEL[zone]}
                </div>
                <div
                  className="font-mono text-[11px] mt-0.5"
                  style={{ color: pos.set ? `${color}CC` : "#71717a" }}
                >
                  {ZONE_THAI[zone]}
                  {pos.set && (
                    <span className="ml-2 text-zinc-200 font-bold">
                      {pos.angle.toFixed(0)}°
                    </span>
                  )}
                </div>
              </div>
              {pos.set ? (
                <button
                  onClick={() => onReset(zone)}
                  className="font-mono text-xs px-3 py-2 border border-zinc-700 rounded hover:border-zinc-500 active:scale-95 transition"
                >
                  RESET
                </button>
              ) : (
                <button
                  onClick={() => onSet(zone)}
                  disabled={!calibrated}
                  className="font-mono text-xs tracking-wider px-4 py-2.5 rounded border-2 active:scale-95 transition disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{
                    borderColor: color,
                    color,
                    boxShadow: calibrated ? `0 0 12px ${color}55` : "none",
                  }}
                >
                  SET ▸
                </button>
              )}
            </div>
          );
        })}
      </section>

      {/* AIM bar with markers for already-set drums */}
      <section className="mt-3 z-10">
        <div className="relative h-9 rounded-md border border-zinc-800 overflow-hidden bg-zinc-900/40">
          {ZONES.map((z) => {
            const p = positions[z];
            if (!p.set) return null;
            const color = ZONE_COLOR[z];
            return (
              <div
                key={z}
                className="absolute top-0 bottom-0 w-1 -translate-x-1/2"
                style={{
                  left: `${angleToPct(p.angle)}%`,
                  background: color,
                  boxShadow: `0 0 8px ${color}`,
                }}
              />
            );
          })}
          <div
            ref={tiltDotRef}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-white"
            style={{
              left: "50%",
              boxShadow: "0 0 12px rgba(255,255,255,0.8)",
              transition: "left 60ms linear",
            }}
          />
        </div>
        <div className="mt-1 font-mono text-[11px] text-zinc-500">
          AIM{" "}
          <span ref={tiltLabelRef} className="text-zinc-300">
            0.0
          </span>
          °
        </div>
      </section>

      <button
        onClick={onDone}
        disabled={!allSet}
        className="mt-4 w-full py-4 font-display text-xl tracking-widest rounded border-2 active:scale-95 transition disabled:opacity-30 disabled:border-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed"
        style={
          allSet
            ? {
                borderColor: "#f43f5e",
                color: "#f43f5e",
                boxShadow: "0 0 24px rgba(244,63,94,0.5)",
                background: "radial-gradient(circle, #f43f5e22, transparent 70%)",
              }
            : undefined
        }
      >
        DONE
      </button>

      {!calibrated && (
        <div className="absolute inset-0 z-30 backdrop-blur-md bg-black/70 flex flex-col items-center justify-center">
          <div
            className="font-display text-2xl tracking-widest"
            style={{ color: "#fde047" }}
          >
            CALIBRATING
          </div>
          <div className="mt-2 font-mono text-xs text-zinc-400 text-center px-6">
            ถือมือถือให้นิ่งในท่าที่จะเล่น
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
    </main>
  );
}
