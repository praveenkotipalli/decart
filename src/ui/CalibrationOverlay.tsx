import type { EngineStatus } from "../engine/Engine";
import { engine } from "../engine/instance";

export function CalibrationOverlay({ status }: { status: EngineStatus }) {
  const c = status.calibration;
  if (c.state !== "waiting" && c.state !== "holding") return null;
  const r = 42;
  const len = 2 * Math.PI * r;
  return (
    <div className="calib" role="dialog" aria-label="Calibration" aria-live="polite">
      <div className="calib__card">
        <svg className="calib__ring" viewBox="0 0 92 92" aria-hidden>
          <circle cx="46" cy="46" r={r} stroke="rgba(255,255,255,0.14)" />
          <circle
            cx="46"
            cy="46"
            r={r}
            stroke="url(#calib-grad)"
            strokeDasharray={len}
            strokeDashoffset={len * (1 - c.progress)}
            strokeLinecap="round"
            transform="rotate(-90 46 46)"
            style={{ transition: "stroke-dashoffset 0.15s linear" }}
          />
          <defs>
            <linearGradient id="calib-grad" x1="0" x2="1">
              <stop offset="0" stopColor="#4a9eff" />
              <stop offset="1" stopColor="#8c66ff" />
            </linearGradient>
          </defs>
        </svg>
        <div className="calib__title">Calibrating</div>
        <div className="calib__msg">{c.message}</div>
        <button type="button" className="text-btn" onClick={() => engine.cancelCalibration()}>
          Cancel (Esc)
        </button>
      </div>
    </div>
  );
}
