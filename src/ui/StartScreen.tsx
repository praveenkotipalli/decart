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

export function StartScreen({ status, leaving }: { status: EngineStatus; leaving: boolean }) {
  const starting = status.camera === "starting";
  const err = CAMERA_HELP[status.camera];
  const decart =
    status.ai.configured === null
      ? "Local server offline"
      : status.ai.configured
        ? "Decart key configured"
        : "No Decart key — local preview only";

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
        <p className="start__lede">
          Frame the space in front of you with your thumbs and index fingers. Four fingertips become four corners, and the
          window between them looks into a live, AI-rewritten version of you — in true perspective, wherever you turn it.
        </p>
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
        <IntroCanvas />
      </div>

      <ol className="start__steps" aria-label="How it works">
        <li className="step">
          <span className="step__n">01</span>
          <span className="step__t">Frame</span>
          <p className="step__d">Index tips set the top corners, thumb tips the bottom ones. One spread hand works too.</p>
        </li>
        <li className="step">
          <span className="step__n">02</span>
          <span className="step__t">Shape</span>
          <p className="step__d">Rotate, tilt, twist and stretch — every corner follows its own finger, with a projective warp.</p>
        </li>
        <li className="step">
          <span className="step__n">03</span>
          <span className="step__t">Transform</span>
          <p className="step__d">Switch on AI and Decart streams a transformed you into the portal. Pinch thumb + middle to lock it.</p>
        </li>
      </ol>
      <p className="start__privacy">
        Video stays on this device unless you switch AI on — then the camera stream goes to Decart for as long as the
        session runs, billed per second.
      </p>
    </main>
  );
}
