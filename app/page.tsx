"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

type Zone = "hihat" | "snare";
type Hand = "left" | "right";
type Mode = "start" | "calibrate" | "play" | "setup";
type DrumPosition = { angle: number };
type DrumPositions = Record<Zone, DrumPosition>;

const ZONES: Zone[] = ["hihat", "snare"];

const ZONE_LABEL: Record<Zone, string> = {
  hihat: "HI-HAT",
  snare: "SNARE",
};

const ZONE_THAI: Record<Zone, string> = {
  hihat: "ไฮ-แฮต",
  snare: "สแนร์",
};

const ZONE_COLOR: Record<Zone, string> = {
  hihat: "#fde047",
  snare: "#f43f5e",
};

const ZONE_CODE: Record<Zone, string> = {
  hihat: "ZONE_HHT",
  snare: "ZONE_SNR",
};

const HAND_LABEL: Record<Hand, string> = {
  left: "LEFT HAND",
  right: "RIGHT HAND",
};

const HAND_EMOJI: Record<Hand, string> = {
  left: "🤚",
  right: "✋",
};

const DEFAULT_POSITIONS_BY_HAND: Record<Hand, DrumPositions> = {
  right: { snare: { angle: 0 }, hihat: { angle: -25 } },
  left: { snare: { angle: 0 }, hihat: { angle: 25 } },
};

// EMA weight on each new gravity sample. Small alpha = heavy smoothing,
// keeping a stable gravity estimate while wrist flicks pass through as
// linear acceleration.
const GRAVITY_ALPHA = 0.1;

// Indicator bar range in degrees of relative roll (±this).
const ROLL_RANGE_DEG = 60;

function getNearestZone(currentAngle: number, positions: DrumPositions): Zone {
  let nearest: Zone = "snare";
  let minDist = Infinity;
  for (const zone of ZONES) {
    const diff = Math.abs(currentAngle - positions[zone].angle);
    if (diff < minDist) {
      minDist = diff;
      nearest = zone;
    }
  }
  return nearest;
}

function rollToPct(roll: number): number {
  return Math.max(
    0,
    Math.min(100, ((roll + ROLL_RANGE_DEG) / (ROLL_RANGE_DEG * 2)) * 100)
  );
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

function playZone(ctx: AudioContext, zone: Zone, velocity: number) {
  const t = ctx.currentTime;
  if (zone === "hihat") playHiHat(ctx, t, velocity);
  else playSnare(ctx, t, velocity);
}

// ----- Component -----

export default function Page() {
  const [mode, setMode] = useState<Mode>("start");
  const [hand, setHand] = useState<Hand>("right");
  const [permError, setPermError] = useState<string | null>(null);
  const [activeZone, setActiveZone] = useState<Zone>("snare");
  const [lastHit, setLastHit] = useState<{
    zone: Zone;
    velocity: number;
    t: number;
  } | null>(null);
  const [sensitivity, setSensitivity] = useState<number>(8);
  const [hits, setHits] = useState(0);
  const [calibrated, setCalibrated] = useState(false);
  const [sensorAlive, setSensorAlive] = useState(false);
  const [drumPositions, setDrumPositions] = useState<DrumPositions>(
    DEFAULT_POSITIONS_BY_HAND.right
  );

  const audioCtxRef = useRef<AudioContext | null>(null);

  // Gravity is isolated from accelerationIncludingGravity via an EMA so wrist
  // flicks (which are linear acceleration) don't corrupt the roll estimate.
  const gravityRef = useRef<{ x: number; y: number; z: number }>({
    x: 0,
    y: 0,
    z: 0,
  });
  const gravityReadyRef = useRef<boolean>(false);
  const currentRollRef = useRef<number>(0);
  const baselineRollRef = useRef<number | null>(null);
  const sensorAliveRef = useRef<boolean>(false);

  // Peak detection on linear acceleration magnitude.
  const linAccelHistoryRef = useRef<number[]>([]);
  const lastTriggerRef = useRef<number>(0);

  // Pre-trigger ring: smoothed roll samples in the last ~250ms.
  const rollSnapshotRef = useRef<{ t: number; roll: number }[]>([]);

  // Mirrors for reading state inside long-lived handlers.
  const activeZoneRef = useRef<Zone>("snare");
  const sensitivityRef = useRef<number>(8);
  const drumPositionsRef = useRef<DrumPositions>(drumPositions);
  const modeRef = useRef<Mode>("start");

  const tiltDotRef = useRef<HTMLDivElement | null>(null);
  const tiltLabelRef = useRef<HTMLSpanElement | null>(null);
  const rawRollLabelRef = useRef<HTMLSpanElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const flashLayerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeZoneRef.current = activeZone;
  }, [activeZone]);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  useEffect(() => {
    drumPositionsRef.current = drumPositions;
  }, [drumPositions]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const recalibrate = useCallback(() => {
    baselineRollRef.current = null;
    setCalibrated(false);
    rollSnapshotRef.current = [];
    setMode("calibrate");
  }, []);

  const setZero = useCallback(() => {
    if (!sensorAliveRef.current) return;
    baselineRollRef.current = currentRollRef.current;
    setCalibrated(true);
    rollSnapshotRef.current = [];
    const ctx = audioCtxRef.current;
    if (ctx) {
      if (ctx.state === "suspended") ctx.resume();
      playSnare(ctx, ctx.currentTime, 0.7);
    }
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(25);
    }
    setMode("play");
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
      const rx = a.x;
      const ry = a.y;
      const rz = a.z;

      // EMA-isolate gravity. Seed with first sample so it doesn't have to
      // converge from (0,0,0).
      const g = gravityRef.current;
      if (!gravityReadyRef.current) {
        g.x = rx;
        g.y = ry;
        g.z = rz;
        gravityReadyRef.current = true;
      } else {
        g.x = GRAVITY_ALPHA * rx + (1 - GRAVITY_ALPHA) * g.x;
        g.y = GRAVITY_ALPHA * ry + (1 - GRAVITY_ALPHA) * g.y;
        g.z = GRAVITY_ALPHA * rz + (1 - GRAVITY_ALPHA) * g.z;
      }

      // Portrait roll from smoothed gravity. atan2(gx, gz):
      //   roll  0  = held straight
      //   roll >0  = tilted right
      //   roll <0  = tilted left
      const roll = (Math.atan2(g.x, g.z) * 180) / Math.PI;
      currentRollRef.current = roll;

      if (!sensorAliveRef.current) {
        sensorAliveRef.current = true;
        setSensorAlive(true);
      }

      // Linear acceleration = raw - gravity. Magnitude is clean of the ~9.8
      // gravity offset, so the threshold scale is smaller than before.
      const lx = rx - g.x;
      const ly = ry - g.y;
      const lz = rz - g.z;
      const mag = Math.sqrt(lx * lx + ly * ly + lz * lz);

      const hist = linAccelHistoryRef.current;
      hist.push(mag);
      if (hist.length > 8) hist.shift();
      const baseline =
        hist.reduce((s, v) => s + v, 0) / Math.max(1, hist.length);
      const delta = mag - baseline;

      const now = performance.now();

      const snap = rollSnapshotRef.current;
      snap.push({ t: now, roll });
      while (snap.length > 0 && now - snap[0].t > 250) snap.shift();

      if (
        modeRef.current === "play" &&
        baselineRollRef.current !== null &&
        delta > sensitivityRef.current &&
        now - lastTriggerRef.current > 90
      ) {
        lastTriggerRef.current = now;
        const velocity = Math.min(1, delta / 20);

        // The flick itself warps roll briefly; the angle ~80ms earlier
        // is what the user was actually aiming at.
        const target = now - 80;
        let preRoll = roll;
        if (snap.length > 0) {
          let best = snap[0];
          let bestDiff = Math.abs(snap[0].t - target);
          for (let i = 1; i < snap.length; i++) {
            const d = Math.abs(snap[i].t - target);
            if (d < bestDiff) {
              bestDiff = d;
              best = snap[i];
            }
          }
          preRoll = best.roll;
        }

        const preRelative = preRoll - baselineRollRef.current;
        const zone = getNearestZone(preRelative, drumPositionsRef.current);
        activeZoneRef.current = zone;
        setActiveZone(zone);
        triggerHit(zone, velocity);
      }
    },
    [triggerHit]
  );

  const isPostStart = mode !== "start";

  // rAF loop drives the indicator dot + numeric readouts; reads `mode` via
  // ref so transitions between calibrate/play/setup don't restart it.
  useEffect(() => {
    if (!isPostStart) return;
    const loop = () => {
      const rawLbl = rawRollLabelRef.current;
      if (rawLbl) rawLbl.textContent = currentRollRef.current.toFixed(1);

      const baseline = baselineRollRef.current;
      if (baseline !== null) {
        const relative = currentRollRef.current - baseline;
        const pct = rollToPct(relative);
        const dot = tiltDotRef.current;
        if (dot) dot.style.left = `${pct}%`;
        const lbl = tiltLabelRef.current;
        if (lbl) lbl.textContent = relative.toFixed(1);

        if (modeRef.current === "play") {
          const nextZone = getNearestZone(relative, drumPositionsRef.current);
          if (nextZone !== activeZoneRef.current) {
            activeZoneRef.current = nextZone;
            setActiveZone(nextZone);
          }
        }
      } else {
        const dot = tiltDotRef.current;
        if (dot) dot.style.left = `50%`;
        const lbl = tiltLabelRef.current;
        if (lbl) lbl.textContent = "0.0";
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [isPostStart]);

  // Motion listener stays mounted across calibrate/play/setup. Peak detection
  // self-gates by `modeRef.current === "play"`.
  useEffect(() => {
    if (!isPostStart) return;
    window.addEventListener("devicemotion", handleMotion);
    return () => {
      window.removeEventListener("devicemotion", handleMotion);
    };
  }, [isPostStart, handleMotion]);

  const startWithHand = useCallback(async (chosenHand: Hand) => {
    setPermError(null);
    try {
      // Unlock audio synchronously on first entry (iOS user-gesture rule).
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

      // iOS 13+ gates DeviceMotionEvent behind requestPermission. Orientation
      // permission is no longer needed since the pipeline is motion-only.
      const MotionAny = DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<"granted" | "denied">;
      };
      const motionP: Promise<"granted" | "denied"> =
        typeof MotionAny.requestPermission === "function"
          ? MotionAny.requestPermission()
          : Promise.resolve("granted");

      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === "suspended") await ctx.resume();
      const m = await motionP;
      if (m !== "granted") {
        setPermError("Motion permission denied — กรุณาอนุญาตการเคลื่อนไหว");
        return;
      }

      setHand(chosenHand);
      setDrumPositions(DEFAULT_POSITIONS_BY_HAND[chosenHand]);
      setActiveZone("snare");
      setHits(0);
      setLastHit(null);
      baselineRollRef.current = null;
      setCalibrated(false);
      linAccelHistoryRef.current = [];
      rollSnapshotRef.current = [];
      gravityRef.current = { x: 0, y: 0, z: 0 };
      gravityReadyRef.current = false;
      sensorAliveRef.current = false;
      setSensorAlive(false);
      setMode("calibrate");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPermError(`Init error: ${msg}`);
    }
  }, []);

  const handleSetDrumPosition = useCallback((zone: Zone) => {
    if (baselineRollRef.current === null) return;
    const relative = currentRollRef.current - baselineRollRef.current;
    setDrumPositions((prev) => ({
      ...prev,
      [zone]: { angle: relative },
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

  const handleTestZone = useCallback((zone: Zone) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    playZone(ctx, zone, 0.8);
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }, []);

  const exitToStart = useCallback(() => {
    setMode("start");
  }, []);

  const enterSetup = useCallback(() => {
    setMode("setup");
  }, []);

  const backToPlay = useCallback(() => {
    setMode("play");
  }, []);

  // ----- Render -----

  if (mode === "start") {
    return <StartScreen onPick={startWithHand} permError={permError} />;
  }

  if (mode === "calibrate") {
    return (
      <CalibrateScreen
        hand={hand}
        sensorAlive={sensorAlive}
        onSetZero={setZero}
        onCancel={exitToStart}
        rawRollLabelRef={rawRollLabelRef}
      />
    );
  }

  if (mode === "setup") {
    return (
      <SetupScreen
        hand={hand}
        positions={drumPositions}
        calibrated={calibrated}
        onSet={handleSetDrumPosition}
        onTest={handleTestZone}
        onBackToPlay={backToPlay}
        onRecal={recalibrate}
        tiltDotRef={tiltDotRef}
        tiltLabelRef={tiltLabelRef}
      />
    );
  }

  const velocityPct = lastHit ? Math.round(lastHit.velocity * 100) : 0;
  const flashKey = lastHit ? lastHit.t : 0;

  return (
    <main className="grid-bg relative h-[100dvh] w-full flex flex-col px-4 pb-4 pt-3 overflow-hidden">
      <div className="scanline" />

      <header className="flex items-center justify-between gap-2 z-10">
        <button
          onClick={exitToStart}
          aria-label="Back to start"
          className="font-mono text-sm w-9 h-9 border border-zinc-700 rounded hover:border-zinc-500 active:scale-95 transition"
        >
          ✕
        </button>
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-base leading-none">{HAND_EMOJI[hand]}</span>
          <span
            className="tracking-widest font-bold"
            style={{ color: ZONE_COLOR[activeZone] }}
          >
            {HAND_LABEL[hand]}
          </span>
        </div>
        <button
          onClick={enterSetup}
          className="font-mono text-xs px-3 py-1.5 border border-zinc-700 rounded hover:border-zinc-500 active:scale-95 transition"
        >
          ⚙ SETUP
        </button>
      </header>

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
          HITS{" "}
          <span
            className="font-bold"
            style={{ color: ZONE_COLOR[activeZone] }}
          >
            {String(hits).padStart(3, "0")}
          </span>
        </div>
        <div className="absolute top-3 right-4 font-mono text-[10px] text-zinc-500">
          {ZONE_CODE[activeZone]}
        </div>
      </section>

      {/* ROLL indicator with SNARE + HI-HAT markers */}
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
                  left: `${rollToPct(pos.angle)}%`,
                  background: color,
                  boxShadow: `0 0 8px ${color}`,
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
            ROLL{" "}
            <span ref={tiltLabelRef} className="text-zinc-300">
              0.0
            </span>
            °
          </span>
        </div>
      </section>

      <section className="mt-3 z-10">
        <div className="flex items-center justify-between font-mono text-xs text-zinc-400 mb-1">
          <span>SENSITIVITY</span>
          <span className="text-zinc-200 font-bold">{sensitivity}</span>
        </div>
        <input
          type="range"
          min={4}
          max={20}
          value={sensitivity}
          onChange={(e) => setSensitivity(Number(e.target.value))}
        />
      </section>

      <footer className="mt-3 text-center text-[10px] text-zinc-500 font-mono leading-relaxed z-10">
        สะบัดข้อมือลงเพื่อตี · เอียงเปลี่ยนเสียง · ⚙ ปรับตำแหน่งใน SETUP
      </footer>
    </main>
  );
}

// ----- Start Screen -----

function StartScreen({
  onPick,
  permError,
}: {
  onPick: (hand: Hand) => void;
  permError: string | null;
}) {
  return (
    <main className="grid-bg relative h-[100dvh] w-full flex flex-col items-center justify-between px-6 py-8 overflow-hidden">
      <div className="scanline" />

      <header className="mt-6 text-center z-10">
        <h1
          className="font-display leading-none"
          style={{
            fontSize: "clamp(56px, 18vw, 120px)",
            letterSpacing: "0.04em",
          }}
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
          มือถือ 1 เครื่อง = ไม้กลอง 1 ข้าง
          <br />
          เลือกว่าเครื่องนี้ถือมือไหน
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 w-full max-w-md z-10">
        <HandButton
          color="#fde047"
          emoji="🤚"
          label="LEFT"
          sub="HAND"
          onClick={() => onPick("left")}
        />
        <HandButton
          color="#f43f5e"
          emoji="✋"
          label="RIGHT"
          sub="HAND"
          onClick={() => onPick("right")}
        />
      </section>

      <div className="flex flex-col items-center gap-3 z-10 min-h-[64px]">
        {permError && (
          <div className="font-mono text-xs text-rose-400 text-center max-w-xs">
            {permError}
          </div>
        )}
        <footer className="font-mono text-[10px] text-zinc-500 text-center leading-relaxed">
          แนะนำ: iOS ต้องอนุญาต Motion · ใส่หูฟังให้ฟีลดี
        </footer>
      </div>
    </main>
  );
}

function HandButton({
  color,
  emoji,
  label,
  sub,
  onClick,
}: {
  color: string;
  emoji: string;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="aspect-square rounded-2xl border-4 flex flex-col items-center justify-center gap-2 active:scale-95 transition"
      style={{
        borderColor: color,
        color,
        boxShadow: `0 0 36px ${color}66, inset 0 0 24px ${color}33`,
        background: `radial-gradient(circle, ${color}22, transparent 75%)`,
      }}
    >
      <div className="text-6xl leading-none">{emoji}</div>
      <div
        className="font-display text-2xl tracking-widest leading-none"
        style={{ textShadow: `0 0 12px ${color}AA` }}
      >
        {label}
      </div>
      <div className="font-mono text-[11px] tracking-widest opacity-80">
        {sub}
      </div>
    </button>
  );
}

// ----- Setup + Test Screen -----

function SetupScreen({
  hand,
  positions,
  calibrated,
  onSet,
  onTest,
  onBackToPlay,
  onRecal,
  tiltDotRef,
  tiltLabelRef,
}: {
  hand: Hand;
  positions: DrumPositions;
  calibrated: boolean;
  onSet: (zone: Zone) => void;
  onTest: (zone: Zone) => void;
  onBackToPlay: () => void;
  onRecal: () => void;
  tiltDotRef: MutableRefObject<HTMLDivElement | null>;
  tiltLabelRef: MutableRefObject<HTMLSpanElement | null>;
}) {
  return (
    <main className="grid-bg relative h-[100dvh] w-full flex flex-col px-4 pb-4 pt-3 overflow-hidden">
      <div className="scanline" />

      <header className="flex items-center justify-between gap-2 z-10">
        <button
          onClick={onBackToPlay}
          className="font-mono text-xs px-3 py-1.5 border border-zinc-700 rounded hover:border-zinc-500 active:scale-95 transition"
        >
          ◂ BACK
        </button>
        <div
          className="font-display text-base tracking-widest text-center"
          style={{ color: "#fde047", textShadow: "0 0 12px #fde04788" }}
        >
          SETUP · {HAND_LABEL[hand]}
        </div>
        <button
          onClick={onRecal}
          className="font-mono text-xs px-3 py-1.5 border border-zinc-700 rounded hover:border-zinc-500 active:scale-95 transition"
        >
          RECAL
        </button>
      </header>

      <p className="mt-3 font-mono text-[11px] text-zinc-400 leading-relaxed text-center z-10">
        🎯 SET = ใช้มุมเอียงปัจจุบันเป็นตำแหน่ง · 🔊 TEST = ฟังเสียงโดยไม่ต้องใช้ sensor
      </p>

      <section className="flex-1 mt-3 flex flex-col gap-3 z-10 overflow-y-auto">
        {ZONES.map((zone) => {
          const pos = positions[zone];
          const color = ZONE_COLOR[zone];
          return (
            <div
              key={zone}
              className="rounded-xl border-2 p-4 transition"
              style={{
                borderColor: color,
                background: `radial-gradient(ellipse at center, ${color}1a 0%, transparent 75%)`,
                boxShadow: `0 0 14px ${color}26, inset 0 0 12px ${color}1a`,
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div
                    className="font-display text-2xl tracking-wider"
                    style={{ color, textShadow: `0 0 10px ${color}AA` }}
                  >
                    {ZONE_LABEL[zone]}
                  </div>
                  <div
                    className="font-mono text-[11px] mt-0.5"
                    style={{ color: `${color}CC` }}
                  >
                    {ZONE_THAI[zone]}
                    <span className="ml-2 text-zinc-200 font-bold">
                      {pos.angle.toFixed(0)}°
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => onTest(zone)}
                    className="font-mono text-xs tracking-wider px-3 py-2.5 rounded border border-zinc-600 text-zinc-200 hover:border-zinc-400 active:scale-95 transition"
                  >
                    🔊 TEST
                  </button>
                  <button
                    onClick={() => onSet(zone)}
                    disabled={!calibrated}
                    className="font-mono text-xs tracking-wider px-3 py-2.5 rounded border-2 active:scale-95 transition disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{
                      borderColor: color,
                      color,
                      boxShadow: calibrated ? `0 0 12px ${color}55` : "none",
                    }}
                  >
                    🎯 SET
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </section>

      {/* ROLL bar with current tilt + 2 zone markers */}
      <section className="mt-3 z-10">
        <div className="relative h-9 rounded-md border border-zinc-800 overflow-hidden bg-zinc-900/40">
          {ZONES.map((z) => {
            const p = positions[z];
            const color = ZONE_COLOR[z];
            return (
              <div
                key={z}
                className="absolute top-0 bottom-0 w-1 -translate-x-1/2"
                style={{
                  left: `${rollToPct(p.angle)}%`,
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
          ROLL{" "}
          <span ref={tiltLabelRef} className="text-zinc-300">
            0.0
          </span>
          °
        </div>
      </section>

      <button
        onClick={onBackToPlay}
        className="mt-4 w-full py-4 font-display text-xl tracking-widest rounded border-2 active:scale-95 transition"
        style={{
          borderColor: "#f43f5e",
          color: "#f43f5e",
          boxShadow: "0 0 24px rgba(244,63,94,0.5)",
          background: "radial-gradient(circle, #f43f5e22, transparent 70%)",
        }}
      >
        BACK TO PLAY
      </button>
    </main>
  );
}

// ----- Calibrate Zero Screen -----

function CalibrateScreen({
  hand,
  sensorAlive,
  onSetZero,
  onCancel,
  rawRollLabelRef,
}: {
  hand: Hand;
  sensorAlive: boolean;
  onSetZero: () => void;
  onCancel: () => void;
  rawRollLabelRef: MutableRefObject<HTMLSpanElement | null>;
}) {
  return (
    <main className="grid-bg relative h-[100dvh] w-full flex flex-col px-4 pb-4 pt-3 overflow-hidden">
      <div className="scanline" />

      <header className="flex items-center justify-between gap-2 z-10">
        <button
          onClick={onCancel}
          aria-label="Back to start"
          className="font-mono text-sm w-9 h-9 border border-zinc-700 rounded hover:border-zinc-500 active:scale-95 transition"
        >
          ✕
        </button>
        <div
          className="font-display text-base tracking-widest text-center"
          style={{ color: "#fde047", textShadow: "0 0 12px #fde04788" }}
        >
          SET ZERO POINT
        </div>
        <div className="w-9" />
      </header>

      <div className="mt-2 text-center font-mono text-xs text-zinc-400 z-10 flex items-center justify-center gap-2">
        <span className="text-base leading-none">{HAND_EMOJI[hand]}</span>
        <span className="tracking-widest font-bold">{HAND_LABEL[hand]}</span>
      </div>

      <p className="mt-6 font-mono text-sm text-zinc-300 leading-relaxed text-center max-w-xs mx-auto z-10">
        ชี้มือถือไปทาง{" "}
        <span className="font-bold" style={{ color: "#f43f5e" }}>
          SNARE
        </span>
        <br />
        แล้วกด <span className="font-bold text-zinc-100">SET ZERO</span>
      </p>

      <section className="flex-1 flex items-center justify-center z-10">
        <button
          onClick={onSetZero}
          disabled={!sensorAlive}
          className="font-display text-2xl tracking-widest w-56 h-56 rounded-full border-4 active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed flex flex-col items-center justify-center leading-tight"
          style={{
            borderColor: "#f43f5e",
            color: "#f43f5e",
            boxShadow: sensorAlive
              ? "0 0 60px rgba(244,63,94,0.7), inset 0 0 32px rgba(244,63,94,0.25)"
              : "none",
            background: "radial-gradient(circle, #f43f5e22, transparent 70%)",
          }}
        >
          <span>● SET</span>
          <span>ZERO</span>
        </button>
      </section>

      <div className="z-10 text-center font-mono text-[11px] text-zinc-500">
        ROLL{" "}
        <span ref={rawRollLabelRef} className="text-zinc-300">
          0.0
        </span>
        °
        {!sensorAlive && (
          <span className="ml-2" style={{ color: "#fde047" }}>
            · รอ sensor...
          </span>
        )}
      </div>

      <footer className="mt-3 text-center text-[10px] text-zinc-500 font-mono leading-relaxed z-10">
        มุมเอียงนี้จะเป็น 0° · ทิศอื่นจะวัดจากมุมนี้ · กด RECAL เพื่อตั้งใหม่
      </footer>
    </main>
  );
}
