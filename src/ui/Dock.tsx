import { settingsStore, updateSettings, useSettings } from "../config/settings";
import type { EngineStatus } from "../engine/Engine";
import { engine } from "../engine/instance";
import { aiView } from "./aiView";
import {
  IconCalibrate,
  IconCamera,
  IconCameraOff,
  IconFullscreen,
  IconLock,
  IconPause,
  IconPlay,
  IconPortal,
  IconRecord,
  IconReset,
  IconSkeleton,
  IconSnapshot,
  IconTune,
  IconUnlock,
} from "./icons";

export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => undefined);
}

/** AI on = stream to Decart; AI off = back to the last preview source. */
export function toggleAI() {
  const s = settingsStore.get();
  engine.setSource(s.source === "decart" ? s.previewSource : "decart");
}

export function Dock({
  status,
  panelOpen,
  onTogglePanel,
  fullscreen,
}: {
  status: EngineStatus;
  panelOpen: boolean;
  onTogglePanel: () => void;
  fullscreen: boolean;
}) {
  const s = useSettings();
  const view = aiView(status.ai, s.source, status.content);
  const cameraOn = status.camera === "on";
  const live = cameraOn || status.simulated;
  const aiTone = view.tone === "preview" || view.tone === "off" ? "off" : view.tone;

  return (
    <nav className="dock" aria-label="Portal controls">
      <div className="dock__group">
        <button
          type="button"
          className="icon-btn"
          aria-pressed={cameraOn}
          data-tip={cameraOn ? "Stop camera" : "Start camera"}
          aria-label={cameraOn ? "Stop camera" : "Start camera"}
          onClick={() => (cameraOn ? engine.stopCamera() : void engine.startCamera())}
        >
          {cameraOn ? <IconCamera /> : <IconCameraOff />}
        </button>
        <button
          type="button"
          className="ai-btn"
          data-state={aiTone}
          aria-pressed={s.source === "decart"}
          data-tip="AI transform · A"
          aria-label={`AI transform: ${view.label}`}
          onClick={toggleAI}
        >
          <IconPortal width={18} height={18} />
          <span className="ai-btn__label">AI</span>
          <span className="ai-btn__state">{view.label}</span>
        </button>
      </div>

      <span className="dock__divider" aria-hidden />

      <div className="dock__group">
        <button
          type="button"
          className="icon-btn"
          aria-pressed={status.paused}
          data-tip={status.paused ? "Resume tracking · Space" : "Pause tracking · Space"}
          aria-label={status.paused ? "Resume tracking" : "Pause tracking"}
          disabled={!live}
          onClick={() => engine.togglePause()}
        >
          {status.paused ? <IconPlay /> : <IconPause />}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={status.locked}
          data-tip={status.locked ? "Unlock portal · L" : "Lock portal · L"}
          aria-label={status.locked ? "Unlock portal" : "Lock portal"}
          disabled={!live}
          onClick={() => engine.toggleLock()}
        >
          {status.locked ? <IconLock /> : <IconUnlock />}
        </button>
        <button
          type="button"
          className="icon-btn"
          data-tip="Reset portal · R"
          aria-label="Reset portal"
          disabled={!live}
          onClick={() => engine.reset()}
        >
          <IconReset />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={status.calibration.state === "waiting" || status.calibration.state === "holding"}
          data-tip="Calibrate · K"
          aria-label="Calibrate"
          disabled={!live}
          onClick={() => engine.startCalibration()}
        >
          <IconCalibrate />
        </button>
      </div>

      <span className="dock__divider" aria-hidden />

      <div className="dock__group">
        <button
          type="button"
          className="icon-btn"
          aria-pressed={s.showSkeleton}
          data-tip="Hand landmarks · D"
          aria-label="Show hand landmarks"
          onClick={() => updateSettings({ showSkeleton: !s.showSkeleton })}
        >
          <IconSkeleton />
        </button>
        <button
          type="button"
          className="icon-btn"
          data-tip="Snapshot · S"
          aria-label="Save snapshot"
          onClick={() => void engine.snapshot()}
        >
          <IconSnapshot />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--rec"
          aria-pressed={status.recording}
          data-tip={status.recording ? "Stop recording · E" : "Record · E"}
          aria-label={status.recording ? "Stop recording" : "Start recording"}
          onClick={() => void engine.toggleRecording()}
        >
          <IconRecord />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={fullscreen}
          data-tip="Full screen · F"
          aria-label="Toggle full screen"
          onClick={toggleFullscreen}
        >
          <IconFullscreen />
        </button>
      </div>

      <span className="dock__divider" aria-hidden />

      <button
        type="button"
        className="tune-btn"
        aria-label="Tune"
        aria-expanded={panelOpen}
        aria-controls="tune-panel"
        onClick={onTogglePanel}
      >
        <IconTune />
        <span>Tune</span>
      </button>
    </nav>
  );
}
