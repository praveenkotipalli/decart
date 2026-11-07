import { useSettings } from "../config/settings";
import type { EngineStatus } from "../engine/Engine";
import { engine } from "../engine/instance";
import { IconCamera, IconHands } from "./icons";
import { IntroCanvas } from "./IntroCanvas";
import { Wordmark } from "./TopBar";

const CAMERA_HELP: Record<string, { title: string; body: string }> = {
  denied: {
    title: "Camera access is blocked",
    body: "Allow the camera from the icon at the left of the address bar, then press Open the portal again. You can also watch the simulated demo.",
  },
  notfound: { title: "No camera found", body: "Connect a webcam and try again — or watch the simulated demo." },
  inuse: { title: "The camera is busy", body: "Close other apps or tabs using it (video calls, other demos), then try again." },
  insecure: { title: "Insecure page", body: "Browsers only share the camera with https pages or localhost. Open http://localhost." },
  unsupported: { title: "Camera not supported", body: "This browser cannot access cameras. Try a recent Chrome, Edge or Firefox." },
  error: { title: "The camera did not start", body: "" },
};

interface StartCopy {
  lede: string;
  steps: { title: string; body: string }[];
  noKey: string;
  privacy: string;
}

/** The hand-frame toy (the default experience). */
const WINDOW_COPY: StartCopy = {
  lede: "Make two L shapes and a frame opens between your fingertips. Whoever is inside is redrawn as anime, live. Flip a hand to change the filter; an OK sign is a loupe.",
  steps: [
    {
      title: "Frame",
      body: "Index fingers up, thumbs out. Four fingertips are the four corners, and the frame follows them — tilted, stretched or twisted.",
    },
    {
      title: "Flip · loupe · keys 1–5",
      body: "Turn one hand over to step through the filters. An OK sign is a magnifier. Keys 1–5 switch to drawing, sparks, fog and a vanishing trick.",
    },
    {
      title: "Anime",
      body: "Press D and Decart redraws the camera as anime inside the frame, about a second behind. Billed per second, paused when you stop framing.",
    },
  ],
  noKey: "No Decart key — filters and effects only",
  privacy:
    "Video stays on this device unless you switch anime on — then the camera stream goes to Decart for as long as the session runs, billed per second.",
};

/** The original glowing portal (Tune → Classic). */
const CLASSIC_COPY: StartCopy = {
  lede: "Frame the space in front of you with your thumbs and index fingers. Four fingertips become four corners, and the window between them looks into a live, AI-rewritten version of you — in true perspective, wherever you turn it.",
  steps: [
    { title: "Frame", body: "Index tips set the top corners, thumb tips the bottom ones. One spread hand works too." },
    { title: "Shape", body: "Rotate, tilt, twist and stretch — every corner follows its own finger, with a projective warp." },
    {
      title: "Transform",
      body: "Switch on AI and Decart streams a transformed you into the portal. Pinch thumb + middle to lock it.",
    },
  ],
  noKey: "No Decart key — local preview only",
  privacy:
    "Video stays on this device unless you switch AI on — then the camera stream goes to Decart for as long as the session runs, billed per second.",
};

export function StartScreen({ status, leaving }: { status: EngineStatus; leaving: boolean }) {
  const toy = useSettings().frameStyle === "window";
  const copy = toy ? WINDOW_COPY : CLASSIC_COPY;
  const starting = status.camera === "starting";
  const err = CAMERA_HELP[status.camera];
  const decart =
    status.ai.configured === null ? "Local server offline" : status.ai.configured ? "Decart key configured" : copy.noKey;

  return (
    <main className="start" data-leaving={leaving}>
      <div className="start__top">
        <Wordmark />
        <div className="start__server">
          <b>{decart}</b>
          <br />
          WebGL · MediaPipe Hands · Decart realtime
        </div>
      </div>

      <section className="start__copy" aria-labelledby="start-title">
        <p className="start__kicker">A window you hold with your fingers</p>
        <h1 className="start__title" id="start-title">
          Open a <em>domain</em>
          <br />
          in thin air.
        </h1>
        <p className="start__lede">{copy.lede}</p>
        <div className="start__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void engine.startCamera()}
            disabled={starting}
          >
            <IconCamera />
            {starting ? "Waiting for camera…" : "Open the portal"}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => engine.setSimulated(true)}>
            <IconHands />
            Watch a simulated demo
          </button>
        </div>
        {err && status.camera !== "starting" && (
          <div className="start__error" role="alert">
            <strong>{err.title}</strong>
            <p>{err.body || status.cameraDetail}</p>
          </div>
        )}
      </section>

      <div className="start__visual">
        <IntroCanvas toy={toy} />
      </div>

      <ol className="start__steps" aria-label="How it works">
        {copy.steps.map((step, i) => (
          <li className="step" key={step.title}>
            <span className="step__n">{String(i + 1).padStart(2, "0")}</span>
            <span className="step__t">{step.title}</span>
            <p className="step__d">{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="start__privacy">{copy.privacy}</p>
    </main>
  );
}
