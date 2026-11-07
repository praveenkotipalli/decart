# Domain — a frame you hold with your fingers

Make two L shapes with your hands and a four-cornered frame opens between your
fingertips. Whoever is inside the frame is redrawn as anime, live (via
[Decart](https://docs.platform.decart.ai) realtime video), or tinted by a colour filter.
The camera image outside the frame stays untouched.

- **Flip one hand** to step through the filters.
- **Make an OK sign** and you get a round magnifier.
- **Keys 1–5** switch between five effects: frame, draw, particles, fog and vanish.
- **Thin tracker graphics** show what the app sees: hand skeletons, fingertip
  coordinates, hand speed and a face box.

Under the hood:

- **Hand tracking:** MediaPipe Hand Landmarker in a Web Worker, on the GPU.
- **Rendering:** WebGL2. The frame is a mask over the same screen pixels, so the anime
  lines up with the real picture around it.
- **AI:** Decart `lucy-restyle-2` realtime over WebRTC, through the official
  `@decartai/sdk`. The API key stays on a small Node server, which mints short-lived
  scoped tokens.
- **Without a key:** everything except anime works: filters, loupe and effects 2–5.

The original glowing portal with its perspective-mapped picture is still here, under
**Tune → Classic portal** ([details below](#the-classic-portal)).

---

## Quick start

Requirements: Node 20+, a webcam, and a Chromium-based browser or Firefox with WebGL2.

```bash
npm install          # also copies the MediaPipe runtime and downloads two models (8 MB)
cp .env.example .env # then put your Decart key in .env (optional, see below)
npm run dev          # API on :8787 + app on http://localhost:5199
```

Open **http://localhost:5199**, press **Open the portal**, and allow the camera.
**Watch a simulated demo** runs the whole thing without a camera, on a drawn picture.

Production build, served by the same Node process on :8787:

```bash
npm run build
npm start            # http://localhost:8787
```

### Decart credentials

1. Create an account at **https://platform.decart.ai**. New accounts get free credits.
2. Create an API key (it starts with `dct_`).
3. Put it in `.env` as `DECART_API_KEY=dct_…` and restart `npm run dev`.
4. In the app, press **D** (or the **anime** pill). It connects in about 8 seconds; the
   filter shows inside the frame until the anime picture is live.

Anime is billed per second of generation: `lucy-restyle-2` costs $0.01/s, `lucy-2.6`
$0.02/s. The app limits the cost in five ways:

- **Off by default.** Anime is off on every page load. Only pressing **D** starts a
  session, and the first press shows the price.
- **Idle pause.** After 30 s without a frame or loupe on screen, the session is
  disconnected. It reconnects when you make an L or an OK sign again.
- **Hidden tab.** The session pauses after 10 s with the tab in the background.
- **Budget.** Each press of **D** allows 180 billed seconds; then anime switches off
  until you press **D** again. Both numbers are in **Tune → Anime**.
- **Server cap.** The server caps every session at `DECART_MAX_SESSION_SECONDS`
  (default 600).

The seconds used and their cost are always on screen while anime is on.

---

## How to use it

### The frame (key 1)

Hold both hands up with the palms toward the camera, **index fingers up and thumbs
out**, the other fingers curled: two L shapes. The frame opens between the four
fingertips.

| Corner | Finger |
|---|---|
| top-left | index tip of the hand on the **left** of the screen |
| top-right | index tip of the hand on the **right** of the screen |
| bottom-right | thumb tip of the right hand |
| bottom-left | thumb tip of the left hand |

- **Shape:** every corner follows its own fingertip, so the frame can be wide, tall,
  tilted or skewed. If the corners cross, it is drawn as a bow-tie.
- **Letting go:** open your hands, make a fist, or drop a hand. Open palms never make
  a frame, which is how you move your hands around without one.
- **Lock:** **L** freezes the frame where it is, so you can take your hands away.
- **Flip:** turn one hand over (tip it upside down, or rotate the forearm) and the
  filter steps once. Turning it back does not step it again.
- **Loupe:** an OK sign (thumb and index tips together, other fingers out) opens a 2×
  round magnifier on the ring. It shows the same filter or anime as the frame.

Filters, in the order **F** and a flip step through them: `rose`, `clear`, `cobalt`,
`violet`, `silver`. `clear` shows the anime in its own colours, so it is skipped while
anime is not on screen (an unfiltered frame over the camera would be invisible).

### The five effects

| Key | Effect | What your hands do |
|---|---|---|
| **1** | frame | Two L shapes open the frame. Flip a hand for the next filter. OK sign for a loupe. |
| **2** | draw | Point with one finger to draw in the air. Open the hand to lift the pen. Hold a fist to wipe it clean (**C** also clears). |
| **3** | particles | Fingertips shed sparks, more when they move fast. A fist gathers them; opening it throws them out. |
| **4** | fog | The picture is fogged glass. Wipe it with an open hand, write in it with one finger. It mists over again. |
| **5** | vanish | Step out of view and press **C**: the empty room is memorised after a 3 s countdown. Then two L shapes make whoever is inside the frame disappear. |

Anime and filters belong to the frame effect only.

### Keys

`H` hide the controls · `G` full screen · `1`–`5` effects · `D` anime · `F` next filter
(`Shift+F` previous) · `T` trackers · `C` the effect's own action · `L` lock the frame ·
`Space` pause tracking · `S` snapshot (PNG) · `E` record (WebM) · `P` tune panel ·
`Esc` close the panel, cancel a countdown, or bring the controls back.

Snapshots and recordings include the tracker graphics (switch that off in
**Tune → Look**).

### What "anime" shows, exactly

- The camera is streamed to Decart, which returns the whole picture restyled. The frame
  and the loupe show that picture **at the same screen position**, so it lines up with
  the room. Nothing is drawn locally to imitate it.
- The word **anime** appears (pill, hint line, tag next to the frame) only while AI
  pixels are actually on screen. While connecting, paused or stalled, the frame shows
  the camera through the current filter and says so.
- The AI picture is about a second behind your hands. The frame itself, the trackers
  and the camera are never delayed to hide that.
- Five styles are built in (**Tune → Anime**), or write your own prompt. Describe the
  look; do not name characters, series or studios: Decart refuses those.

### Trackers and the face box

`T` toggles the tracker graphics. Fingertip labels read like `L08 599,131`: the side of
the screen, the MediaPipe landmark number, and the position in camera pixels. Hands in
a recognised pose also get square reticles and a caption with their speed and pose.

The dashed face box needs a second small model (BlazeFace). It starts by itself only
when hand tracking has time to spare (inference ≤ 120 ms), and switches off again
under load. **Tune → Look → Face box** forces it on or off; `?face=0` disables it.

---

## The classic portal

**Tune → Classic portal** switches to the original experience: a glowing portal whose
picture is mapped in true perspective (a per-pixel inverse homography), with lock and
reset gestures, one-hand mode and calibration. Its settings and keys are separate.

| Corner | Two hands (default) | One hand |
|---|---|---|
| P1 top-left | index tip, left hand | index tip |
| P2 top-right | index tip, right hand | pinky tip |
| P3 bottom-right | thumb tip, right hand | wrist |
| P4 bottom-left | thumb tip, left hand | thumb tip |

- **Lock / unlock:** pinch thumb + middle finger (0.32 s), or **L**.
- **Reset:** show one open palm (two-hand mode) or a fist (one-hand mode), or **R**.
- **Calibrate:** **K** learns your pose, your home position and how much to smooth.
- **AI:** **D** streams to Decart `lucy-2.6` with a character-swap prompt. Without a
  key the portal shows a local preview labelled "LOCAL PREVIEW — NOT AI OUTPUT".
- **Keys:** `Space` pause · `L` lock · `R` reset · `K` calibrate · `D` AI · `M` two-/one-hand ·
  `T` landmarks · `S` snapshot · `E` record · `G` full screen · `P` tune panel.

---

## Architecture

```
 webcam ─► CameraManager ─► <video> ─┬─► VideoFrame ─► tracker.worker (MediaPipe hands, GPU)
                                     │                  └─ optional FaceDetector (CPU, ≤ 3 Hz)
                                     │                         │ landmarks, face boxes
                                     │   HandAssigner (identity, left/right role) ◄┘
                                     │   classifyHand ─► classifyPose (L · OK · point · fist · palm)
                                     │
                                     │   ToyController (pure logic, no DOM)
                                     │     FrameGate ─ two Ls open it, with hysteresis
                                     │     FrameController ─ One Euro + render-rate glide per corner
                                     │     FlipDetector · LoupeController · effects 2–5
                                     │       │ ToyScene            │ TrackerScene
                                     │       ▼                     ▼
                                     ├─► Renderer (WebGL2)       TrackerOverlay (2D canvas)
                                     │     camera ─► frame pass (mask, filter LUT, brackets, loupes)
                                     │                 ▲ AI picture, sampled at the same screen position
                                     └─► AnimeDriver ─► DecartSession ─WebRTC─► Decart ─► <video>
                                           billing guards     (token from /api/realtime-token)
```

- **Poses, not just fingertips.** A frame needs both hands in an L. Each pose has
  separate thresholds to start and to keep it, and the frame opens after two consecutive
  results, so nothing flickers at 5–17 Hz tracking.
- **Real hands decided the thresholds.** `tests/fixtures/real-hands.json` holds
  MediaPipe's landmarks for a set of photographs. The pose rules are tested against
  them, not only against the tidy synthetic hand.
- **Smooth between results.** Corners pass through a One Euro filter and then a
  two-pole follower timed to the tracking interval, so 10 Hz tracking still moves at
  60 fps without steps or overshoot. The same follower moves the tracker graphics.
- **One shader for the frame.** An even-odd polygon mask (both lobes of a bow-tie are
  inside), a luminance ramp from a 256×4 lookup texture, the tile transition, the
  loupes and the corner brackets are one scissored pass.
- **Aligned AI picture.** The camera is opened at the model's own frame size. If it
  cannot be, the input is cropped to the model's shape in the browser, and the shader
  maps the AI picture back onto exactly that region.
- **No queue.** Only one camera frame is ever in flight to the tracker, and the newest
  AI frame always wins.

### Decart integration

These are the official SDK calls used, each checked against the installed SDK's type
declarations:

- `createDecartClient({ apiKeyProvider })`
- `models.realtime("lucy-restyle-2" | "lucy-2.6")`
- `client.realtime.connect(stream, { model, mirror, initialState, onRemoteStream, onCapacityWait, onQueuePosition })`
- `realtimeClient.set({ prompt, enhance, image })`
- the events `connectionChange`, `error`, `sessionEnded`, `generationTick`, `stats` and
  `connectionQuality`

How it is used:

- **Tokens:** `apiKeyProvider` fetches a fresh client token for every connect and
  reconnect. The server mints it with `client.tokens.create`: a 60 s TTL, scoped to the
  requested model and the page's origin, with a `maxSessionDuration` cap.
- **Errors:** the SDK auto-reconnects up to five times. The app adds up to four slower
  retries for transient failures, and stops at once on terminal errors: bad key, no
  credits, moderation, or a copyright refusal. The frame then shows the filter.

### Project layout

```
server/         Express: /api/health, /api/realtime-token, /api/realtime-quota; serves dist/ in production
src/
  camera/       getUserMedia, error classification
  tracking/     MediaPipe worker + façade, face task, One Euro filter, render-rate glide,
                hand identity, synthetic hands and poses
  gestures/     hand-shape classifier, pose classifier (L, OK, point, fist, palm), classic gestures
  toy/          the hand frame: gate, corners, flip, loupe, filters, effects 2–5, controller,
                scripted demo, HUD copy
  portal/       the classic portal: corner mapping, PortalController, Calibrator
  geometry/     homography, quad helpers
  render/       WebGL2 renderer, toy passes and shaders, tracker overlay, classic shaders
  ai/           DecartSession, anime presets, anime state, billing guard, input cropping
  engine/       orchestration, AnimeDriver, status store
  capture/      snapshot, MediaRecorder, compositor (GL + tracker graphics)
  config/       persisted settings and their migration
  ui/           React chrome: start screen, bands and HUD, tune panel, classic chrome
tests/          Vitest: every pure module, plus pose rules on real-hand landmarks
scripts/        setup-assets.mjs, qa-toy.mjs, qa.mjs (classic), qa/ (real-hand frames and landmarks)
```

---

## Testing and verification

```bash
npm test                     # unit tests
npm run typecheck
node scripts/check-shaders.mjs   # compiles every toy shader in a real WebGL2 context
node scripts/qa-toy.mjs          # start screen, simulated demo, layout → screenshots in qa-output/
node scripts/qa.mjs              # the same for the classic portal
```

`qa-toy.mjs` and `qa.mjs` drive the running dev server in headless Chrome.

### Testing on real hands

The gesture rules are checked against real MediaPipe landmarks in two ways. Both start
from still photographs of hands (L shapes, OK signs, open hands, fists), which are
**not part of this repository**: use your own photos or stock images you may use.

```bash
# 1. Photos → 1280×720 camera frames and fake-webcam clips
python -I scripts/qa/make_frames.py <photos_dir> <out_dir>

# 2. Frames → landmarks as a unit-test fixture (numbers only, no pixels)
node scripts/qa/landmarks.mjs <out_dir>/frames tests/fixtures/real-hands.json
npx vitest run tests/realHands.test.ts

# 3. The whole app on the clips, through Chrome's fake webcam
node scripts/qa-toy.mjs --clips <out_dir>/clips
node scripts/qa-toy.mjs --clips <out_dir>/clips --decart   # + a short real Decart session (billed, about $0.20)
```

`make_frames.py` expects the file names it lists at the top of `main()`; adapt them to
your photos. `scripts/qa/draw_landmarks.py` draws the detected landmarks over the frames,
to see what MediaPipe made of each photo.

RESULTS_PLACEHOLDER

---

## Limits

- **Named characters are refused.** Decart rejects prompts that name copyrighted
  characters, series or (possibly) studios with *"Content contains copyrighted IP that
  cannot be generated."* The built-in styles only describe a look. Decart's Acceptable
  Use Policy also forbids IP-infringing use.
- **Anime is about a second late.** Only the picture inside the frame lags; the frame
  follows your hands at tracking speed.
- **The AI redraws, it does not trace.** An anime face has bigger eyes and a different
  outline, so where the frame edge cuts through a face the two pictures will not meet
  exactly.
- **Tracking rate depends on hardware and load.** 30 Hz needs ≤ 33 ms inference.
- **Vision is MediaPipe's.** Motion blur, hands cut off by the picture edge, gloves, or
  two hands overlapping reduce detection quality. Very large hands close to the lens
  are sometimes mis-fitted.
- **Vanish needs a still camera** and a room that was empty when it was memorised. It
  shows a remembered picture; it does not segment people.
- **Portrait cameras** (phones): the AI models are landscape, so anime covers only a
  landscape band across the middle of a portrait picture. Filters and effects cover it all.
- **One session at a time.** Each AI session counts against your Decart
  concurrent-session quota.

---

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DECART_API_KEY` | — | Server-side only. Empty means no anime. |
| `DECART_MODEL` | `lucy-2.6` | Default model of the classic portal. |
| `DECART_ALLOWED_MODELS` | `lucy-2.6,lucy-restyle-2` | Models the browser may request. Anime uses `lucy-restyle-2` when it is listed. |
| `DECART_TOKEN_TTL_SECONDS` | `60` | Client token lifetime. It gates new connections only. |
| `DECART_MAX_SESSION_SECONDS` | `600` | Hard cap per realtime session. |
| `DECART_ALLOW_FAST` | `false` | Allow fast mode in the classic portal (2× price). |
| `DECART_BASE_URL` | `https://api.decart.ai` | SDK default. |
| `PORT` / `WEB_PORT` | `8787` / `5199` | API / Vite dev server. |
| `ALLOWED_ORIGINS` | — | Extra origins allowed to mint tokens. Localhost is always allowed. |
| `TOKEN_RATE_LIMIT_PER_MINUTE` | `20` | Per client IP. |

The token endpoint has no user authentication. That is fine on localhost; **add your own
auth before exposing it on the internet**, or anyone who can reach it can spend your
credits.

URL switches for diagnosis: `?debug=poses` (pose numbers under each hand),
`?debug=onion` (the AI picture at 50% over the whole stage, to check alignment),
`?face=0`, `?tracker=main|worker`, `?delegate=gpu|cpu`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Camera access is blocked" | Allow the camera from the address-bar icon, then retry. The page must be on `localhost` or `https`. |
| "The camera is busy" | Close other apps or tabs that use the camera. |
| "Port 5199 is in use" in the terminal | Another dev server is running. Vite picks the next port; use the URL it prints. |
| Hands not detected | Use even light and keep both hands fully in the picture. Try **Tune → Tracking → Detection confidence** 0.4. |
| No frame appears | Both hands must be an L: index up, thumb out, the other fingers curled, palms roughly toward the camera. With trackers on, a hand that is recognised gets square reticles and its caption ends in `L`. `?debug=poses` shows the numbers. |
| The frame flickers | Raise **Tune → Tracking → Dropout grace**, or lower *Stability*. |
| The filter changes by itself | A hand is being read as turned over. Keep the palms facing the camera, or the backs, not edge-on. |
| Anime: "no key" | Set `DECART_API_KEY` in `.env` and restart `npm run dev`. |
| Anime: "copyrighted IP" | Describe the look instead of naming a character, series or studio. |
| Anime: stuck on "connecting" | Check the firewall allows WebRTC (UDP); see Decart's [network requirements](https://docs.platform.decart.ai/integrations/network-requirements.md). |
| Anime stops after three minutes | That is the budget. Press **D** again, or raise it in **Tune → Anime**. |
| Low tracking rate | Close GPU-heavy apps, or try `?tracker=main`. **Tune → Tracking** shows the inference time. |
| Black screen | WebGL2 is disabled. Enable hardware acceleration in the browser settings. |
| Model download failed on install | The app falls back to the MediaPipe CDN automatically. Re-run `node scripts/setup-assets.mjs` to cache the models locally. |
