import type { ToyHudActions, ToyHudStatus } from "../../toy/hud";
import { IconCamera, IconCameraOff, IconRecord, IconSnapshot, IconTune } from "../icons";

/**
 * Bottom left, row 2: camera, snapshot, record and the Tune panel, as 32 px icon buttons
 * with the existing tooltip. A small mono tag says when the hands are synthetic.
 */
export function UtilityButtons({ status, actions }: { status: ToyHudStatus; actions: ToyHudActions }) {
  return (
    <div className="util">
      <button
        type="button"
        className="icon-btn"
        aria-pressed={status.cameraOn}
        aria-label={status.cameraOn ? "stop camera" : "start camera"}
        data-tip={status.cameraOn ? "stop camera" : "start camera"}
        onClick={actions.toggleCamera}
      >
        {status.cameraOn ? <IconCamera /> : <IconCameraOff />}
      </button>
      <button type="button" className="icon-btn" aria-label="snapshot" data-tip="snapshot · s" onClick={actions.snapshot}>
        <IconSnapshot />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--rec"
        aria-pressed={status.recording}
        aria-label={status.recording ? "stop recording" : "record"}
        data-tip={status.recording ? "stop recording · e" : "record · e"}
        onClick={actions.toggleRecording}
      >
        <IconRecord />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="tune"
        aria-expanded={status.panelOpen}
        aria-controls="tune-panel"
        data-tip="tune · p"
        onClick={actions.togglePanel}
      >
        <IconTune />
      </button>
      {status.simulated && <span className="util__sim">simulated</span>}
    </div>
  );
}
