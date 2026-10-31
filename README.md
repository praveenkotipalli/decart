# Domain — hand-held AI portal

Frame the air with your fingers and a four-cornered window opens between them. Each
corner follows one fingertip. The window shows a live, AI-rewritten version of you (via
[Decart](https://docs.platform.decart.ai) realtime video), projected in true perspective.
The camera image outside the window stays untouched.

- **Hand tracking:** MediaPipe Hand Landmarker, running in a Web Worker on the GPU.
- **Projection:** a per-pixel inverse homography in a WebGL2 shader. It is a real
  projective map; nothing is faked with a CSS rotation.
- **AI:** Decart `lucy-2.6` realtime over WebRTC, through the official `@decartai/sdk`.
  The API key stays on a small Node server, which mints short-lived scoped tokens.
- **Without a key:** the portal still works with a local preview that is clearly labelled
  as not AI output.

---

## Quick start

Requirements: Node 20+, a webcam, and a Chromium-based browser or Firefox with WebGL2.

```bash
npm install          # also copies the MediaPipe runtime and downloads the hand model (7.8 MB)
cp .env.example .env # then put your Decart key in .env (optional, see below)
npm run dev          # API on :8787 + app on http://localhost:5199
```

Open **http://localhost:5199**, press **Open the portal**, and allow the camera.
**Watch a simulated demo** runs the whole pipeline without a camera.

Production build, served by the same Node process on :8787:

```bash
npm run build
npm start            # http://localhost:8787
```

### Decart credentials

1. Create an account at **https://platform.decart.ai**. New accounts get free credits.
2. Create an API key (it starts with `dct_`).
3. Put it in `.env` as `DECART_API_KEY=dct_…` and restart `npm run dev`.
4. In the app, press **A** (or the **AI** button). The status rail shows
   *Connecting → First frame… → Live*, then output fps, latency and session cost.

Billing is per generated second: `lucy-2.6` costs $0.02/s, or $0.04/s in fast mode.
`lucy-restyle-2` costs $0.01/s. Three guards limit the cost:

- The session stops when you switch AI off.
- It pauses after 45 s with no visible portal. This is configurable, and it resumes on its own.
- The server caps every session at `DECART_MAX_SESSION_SECONDS` (default 600).

---

## How to hold the portal

### Two hands (default, most precise)

| Corner | Finger |
|---|---|
| P1 top-left | index tip of the hand on the **left** of the screen (hand A) |
| P2 top-right | index tip of the hand on the **right** of the screen (hand B) |
| P3 bottom-right | thumb tip of hand B |
| P4 bottom-left | thumb tip of hand A |

**Pose:** palms toward the camera, index fingers up, thumbs spread inward and down. The
four tips outline the window.

- **Move:** each corner follows its own finger, so you can move, scale, tilt and twist
  the portal freely.
- **Rotate:** turn both hands together and the whole portal rotates.
- **Crossing:** hands keep their identity while they are tracked. Hand matching uses
  constant-velocity prediction and MediaPipe's left/right label. So when your hands
  pass each other, the portal flips over like a turned card instead of swapping corners
  at random.

### One hand

Spread one hand, palm to the camera. The index tip, pinky tip, wrist and thumb tip
become the four corners. The mapping mirrors itself automatically when the back of the
hand faces the camera, so the outline stays clockwise. An in-plane rotation still
rotates the portal.

Every binding can be changed under **Tune → Tracking → Corner mapping**. **Calibrate**
(**K**) learns your pose: hold it still for under two seconds. It then:

- flips a hand's top/bottom fingers if your pose has the thumb above the index finger,
- saves your neutral portal as the reset position,
- tunes smoothing to your measured jitter.

### Gestures

| Action | Two-hand default | One-hand default | Why |
|---|---|---|---|
| Lock / unlock | pinch thumb + **middle** (0.32 s) | same | Thumbs and index fingers *are* the corners. A thumb–middle pinch barely moves the frame, and lock restores the pose from just *before* the pinch began. |
| Reset | drop one hand and show the other as an **open palm** (1.1 s) | **fist** (0.9 s) | The frame pose is already open, so reset must be unmistakable. In one-hand mode an open palm *is* the portal. |
| Pause / resume | **Space** | | Freezes tracking and the portal; rendering continues. |

A hold ring appears at your hand while a gesture is arming. Gestures fire once per hold.
Both bindings are configurable under **Tune → Gestures**, and every action also has a
button and a key.

### Keys

`Space` pause · `L` lock · `R` reset · `K` calibrate · `A` AI on/off · `M` two-/one-hand ·
`D` landmarks · `S` snapshot (PNG) · `E` record (WebM) · `F` full screen · `T` tune panel ·
`Esc` close panel or cancel calibration.

---

## Architecture

```
 webcam ──► CameraManager ──► <video> ─┬──► VideoFrame ─► tracker.worker (MediaPipe, GPU) ─┐
                                       │                                                   │ landmarks
                                       │      HandAssigner (identity, roles A/B, chirality) ◄┘
                                       │      classifyHand → GestureMachine (lock / reset)
                                       │      cornerMapping → PortalController
                                       │        One Euro filter · validity · hold/untangle ·
                                       │        lock (pre-gesture pose) · reset · transitions ·
                                       │        render-time prediction
                                       │                       │ quad (stage space)
                                       ├──► DecartSession ─WebRTC─► Decart lucy-2.6 ─► <video>
                                       │      (token from /api/realtime-token)            │
                                       ▼                                                   ▼
                              Renderer (WebGL2): camera pass ─► portal pass ─► sparks ─► canvas
                                                 per-pixel inverse homography, SDF edge,
                                                 glow, refraction · Overlay (2D labels)
```

### Rendering

The portal pass runs a fullscreen fragment shader, scissored to the portal's bounding
box. For every pixel it:

- **Maps the pixel:** evaluates `uv = H⁻¹·(x, y, 1)`. Here `H` maps the unit square onto
  the four corners (Heckbert's square-to-quad), so all four corners land exactly on their
  fingertips. Interpolation is exact projective, so there is no seam along a triangle
  diagonal.
- **Masks and antialiases:** an exact signed-distance function to the quad gives a 1 px
  edge and drives the glow. It also rejects points beyond the projective horizon via the
  sign of `w`.
- **Fits the content:** crops the 16:9 AI frame to the portal's apparent aspect
  (*Cover*, anchored high, because webcam faces sit in the upper third), or stretches it.
  *Window* mapping instead keeps the AI frame aligned with the room.

### Latency and smoothness

- **Off the main thread:** inference runs in a worker, so a 60 ms inference never drops
  a rendered frame.
- **No queue:** only one frame is ever in flight. A camera frame that arrives while the
  worker is busy is sent the moment the worker frees up, so results always describe the
  newest frame.
- **Smooth between samples:** corners are filtered with a One Euro filter (low jitter at
  rest, little lag in motion). They are then dead-reckoned a bounded 48 ms ahead, so
  15–30 Hz tracking still glides at 60 fps.
- **Latest AI frame only:** the AI stream is uploaded once per decoded frame
  (`requestVideoFrameCallback`), and the latest frame always wins.
- **Few React renders:** React re-renders about 6 times a second from a status snapshot,
  never per landmark.

### Decart integration

These are the official SDK calls used, each checked against the installed SDK's type
declarations:

- `createDecartClient({ apiKeyProvider })`
- `models.realtime("lucy-2.6")`
- `client.realtime.connect(stream, { model, mirror, initialState, onRemoteStream, onCapacityWait, onQueuePosition })`
- `realtimeClient.set({ prompt, enhance, image })`
- the events `connectionChange`, `error`, `sessionEnded`, `generationTick`, `stats` and
  `connectionQuality`

How it is used:

- **Tokens:** `apiKeyProvider` fetches a fresh client token for every connect and
  reconnect. The server mints it with `client.tokens.create`: a 60 s TTL, scoped to the
  requested model and the page's origin, with a `maxSessionDuration` cap.
- **Errors:** the SDK auto-reconnects up to five times. The app adds up to four slower
  retries for transient failures. It stops immediately on terminal errors: bad key, no
  credits, moderation, or a copyright refusal. In those cases it falls back to the
  labelled local preview.

### Project layout

```
server/         Express: /api/health, /api/realtime-token, /api/realtime-quota; serves dist/ in production
src/
  camera/       getUserMedia, error classification
  tracking/     MediaPipe worker + façade, landmark types, One Euro filter, hand identity,
                synthetic hand model and the scripted simulated-hands demo
  gestures/     hand-shape classifier (world landmarks, hysteresis), hold-to-fire state machine
  portal/       corner mapping, PortalController, Calibrator
  geometry/     homography, quad validity/repair helpers
  render/       WebGL2 renderer, shaders, particles, 2D overlay, canvas textures
  ai/           DecartSession, prompt presets
  engine/       orchestration, status store
  capture/      snapshot / MediaRecorder
  config/       persisted settings
  ui/           React chrome: start screen, top bar, HUD, dock, tune panel, calibration
tests/          Vitest: geometry, filter, gestures, tracking, portal, calibration, server
scripts/        setup-assets.mjs, qa.mjs (end-to-end), qa-ui.mjs, bench-tracking.mjs
```

---

## Testing and verification

```bash
npm test                         # 73 unit tests (geometry, gestures, tracking, portal, server)
npm run typecheck
node scripts/qa.mjs              # start screen + simulated demo, with screenshots → qa-output/
node scripts/qa.mjs --video clip.y4m           # + real MediaPipe on a fake webcam clip
node scripts/qa.mjs --video clip.y4m --decart  # + a short real Decart session (billed, ~$0.10–0.20)
node scripts/bench-tracking.mjs --video clip.y4m   # worker/main × GPU/CPU comparison
```

`qa.mjs` drives the running dev server in headless Chrome. `--video` feeds a Y4M clip as
the webcam, through Chrome's fake-capture flags.

### Results measured on the development machine

The machine was an Intel i5-1135G7 laptop with Iris Xe graphics. It was **heavily loaded**
by other software during testing (WSL, Docker and a busy browser held the CPU at 50–100%).

| What | Result |
|---|---|
| Real MediaPipe detects both hands and opens the portal | ✅ |
| Portal follows rotation of the hands | ✅ |
| Locking and crossed-corner handling (simulated) | ✅ |
| Rendering while tracking | **59–60 fps** in every run |
| Hand tracking (worker, GPU) | **13–17 Hz** at 52–66 ms inference; **5–7 Hz** at 130–166 ms when the CPU was at ~80%. Below the 30 Hz goal in all runs. |
| Simulated hands | 30 Hz tracking at 60 fps |
| Decart `lucy-2.6`: press A → live | 7.6 s and 8.5 s (two sessions) |
| Decart: first transformed frame (TTFF) | 6.5 s |
| Decart output | 21–23 fps |
| Decart glass-to-glass latency (Decart's own metric) | ≈ 0.86–1.06 s; link quality "fair", then "critical" under load |
| Decart transformed frames render inside the portal only | ✅ (`qa-output/31-decart-live.png`) |

The table's latency is camera-to-screen for the AI picture. The portal geometry itself
follows your hands at tracking latency, independent of the AI.

On an idle machine, expect faster MediaPipe inference. Run `bench-tracking.mjs` to compare
`?tracker=main|worker` and `?delegate=gpu|cpu` on your hardware.

---

## What works, what needs credentials, and limits

**Works without credentials:**

- the camera, hand tracking, the four-corner portal with true projective mapping,
  rotate/scale/tilt/twist, lock/reset/pause gestures, calibration, invalid-shape handling,
  and the energy effects
- the local preview (labelled "LOCAL PREVIEW — NOT AI OUTPUT" inside the portal) and the
  geometry test pattern
- the simulated-hands demo, snapshots and recording

**Needs a Decart key:** the AI transformation itself.

**Limitations:**

- **Named characters are refused.** Decart rejects prompts that name copyrighted
  characters. Verified live: "Gojo Satoru from Jujutsu Kaisen" returned *"Content contains
  copyrighted IP that cannot be generated."* So the presets describe the look instead (a
  white-haired sorcerer in a black blindfold and high-collared uniform, with blue energy),
  and that look renders well. Typing a character name shows that exact refusal and keeps
  the portal alive on the local preview. Decart's Acceptable Use Policy also forbids
  IP-infringing use: keep fan transformations personal.
- **AI latency is under a second, not instant.** Decart reported ~0.9 s glass-to-glass
  here, which is well behind the hands. The portal geometry stays instant; only the
  picture inside lags.
- **Tracking rate depends on hardware and load.** 30 Hz needs ≤ 33 ms inference.
- **Vision is MediaPipe's.** Fast motion blur, hands at the frame edge, or gloves reduce
  detection quality. The portal coasts for 0.45 s through dropouts, then lingers 1.4 s.
- **One session at a time.** Each AI session counts against your Decart concurrent-session
  quota.

---

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DECART_API_KEY` | — | Server-side only. Empty means local preview only. |
| `DECART_MODEL` | `lucy-2.6` | Default realtime model. |
| `DECART_ALLOWED_MODELS` | `lucy-2.6,lucy-restyle-2` | Models the browser may request. |
| `DECART_TOKEN_TTL_SECONDS` | `60` | Client token lifetime. It gates new connections only. |
| `DECART_MAX_SESSION_SECONDS` | `600` | Hard cap per realtime session. |
| `DECART_ALLOW_FAST` | `false` | Allow fast mode (2× price). |
| `DECART_BASE_URL` | `https://api.decart.ai` | SDK default. |
| `PORT` / `WEB_PORT` | `8787` / `5199` | API / Vite dev server. |
| `ALLOWED_ORIGINS` | — | Extra origins allowed to mint tokens. Localhost is always allowed. |
| `TOKEN_RATE_LIMIT_PER_MINUTE` | `20` | Per client IP. |

The token endpoint has no user authentication. That is fine on localhost; **add your own
auth before exposing it on the internet**, or anyone who can reach it can spend your
credits.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Camera access is blocked" | Allow the camera from the address-bar icon, then retry. The page must be on `localhost` or `https`. |
| "The camera is busy" | Close other apps or tabs that use the camera. |
| "Port 5199 is in use" in the terminal | Another dev server is running. Vite picks the next port; use the URL it prints. |
| Hands not detected | Use even light and keep both hands fully in frame, palms toward the camera. Try **Tune → Tracking → Detection confidence** 0.5. |
| Portal jittery / laggy | Run **Calibrate**, or adjust *Stability* (lower = steadier) and *Responsiveness*. |
| Portal shows "Corners crossed" | The fingertips no longer form a convex shape. Untangle your fingers, or set *When corners cross* → *Untangle*. |
| AI: "No API key" | Set `DECART_API_KEY` in `.env` and restart `npm run dev`. |
| AI: "copyrighted IP" | Describe the look instead of naming the character (see presets). |
| AI: "Concurrent session limit reached" | Close other Decart sessions (other tabs). |
| AI: stuck on "Connecting" / "Network problem" | Check the firewall allows WebRTC (UDP), see Decart's [network requirements](https://docs.platform.decart.ai/integrations/network-requirements.md). |
| Low tracking fps | Try `?tracker=main` (faster inference, choppier rendering) or close GPU-heavy apps. The status rail shows the inference time. |
| Black screen | WebGL2 is disabled. Enable hardware acceleration in the browser settings. |
| Model download failed on install | The app falls back to the MediaPipe CDN automatically. Re-run `node scripts/setup-assets.mjs` to cache it locally. |
#   d e c a r t  
 