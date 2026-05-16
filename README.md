# AIR DRUM

Mobile web app that turns your phone into a drumstick. Hold the phone in your hand, **flick your wrist** to hit, **tilt left/right** to switch between hi-hat / snare / tom.

Built with Next.js 14 (App Router) + TypeScript + Tailwind + Web Audio API. Sensors via native `DeviceMotionEvent` + `DeviceOrientationEvent`. No audio files — all drums are synthesized.

## Local dev

```bash
npm install
npm run dev
```

Then open `http://<your-LAN-ip>:3000` on your phone. **Sensors require HTTPS in production** — `localhost` is exempt in most browsers, but cross-device LAN access may need an HTTPS tunnel (e.g. `ngrok http 3000`).

## Deploy to Vercel

```bash
vercel
```

Or push to GitHub and import on [vercel.com](https://vercel.com). HTTPS is automatic.

## How it works

- **Hit detection** — reads `accelerationIncludingGravity`, computes magnitude, compares against rolling baseline. Peak > sensitivity threshold (default 18 m/s²) fires a hit. 90ms debounce.
- **Zone detection** — reads `gamma` (left/right tilt). Baseline captured ~800ms after Start. Relative tilt < -15° → hi-hat, > 15° → tom, otherwise snare.
- **Velocity** — `min(1, delta / 35)` mapped to audio gain.
- **Audio** — Web Audio API: hi-hat = filtered noise burst, snare = noise + tonal sweep, tom = sine pitch sweep.

## iOS notes

iOS 13+ requires user-gesture permission for motion/orientation. The **START** button calls `requestPermission()` — grant when prompted. If denied, you'll see an error in the start screen.

## Tuning

- **SENSITIVITY** slider (8–35) adjusts the peak-detection threshold live.
- **RECAL** button resets the center-tilt baseline to your current orientation.
