import { useSettings } from "../config/settings";
import type { EngineStatus } from "../engine/Engine";
import { aiView, dotClass, pricePerSecond } from "./aiView";

export function Wordmark({ sub = true }: { sub?: boolean }) {
  return (
    <div className="wordmark">
      <span className="wordmark__name">Domain</span>
      <span className="wordmark__jp" lang="ja">
        領域
      </span>
      {sub && <span className="wordmark__sub">hand portal · realtime</span>}
    </div>
  );
}

export function TopBar({ status }: { status: EngineStatus }) {
  const s = useSettings();
  const view = aiView(status.ai, s.source, status.content);
  const ai = status.ai;
  const tracking = status.simulated ? "SIM" : status.tracker === "ready" && status.camera === "on" ? `${status.trackFps}` : "—";
  const cost = ai.seconds * pricePerSecond(s.model, s.fast);

  return (
    <header className="topbar">
      <Wordmark />
      <div className="telemetry" role="status" aria-live="off">
        <div className="telemetry__item telemetry__item--opt">
          <span className="telemetry__label">Render</span>
          <span className="telemetry__value">
            {status.renderFps} <small>fps</small>
          </span>
        </div>
        <div className="telemetry__item telemetry__item--opt">
          <span className="telemetry__label">Track</span>
          <span className="telemetry__value">
            {tracking}
            {!status.simulated && status.tracker === "ready" && status.camera === "on" && (
              <small>
                {" "}
                fps · {status.inferenceMs.toFixed(0)}ms
              </small>
            )}
          </span>
        </div>
        <div className="telemetry__item">
          <span className="telemetry__label">Hands</span>
          <span className="telemetry__value">
            {status.hands}
            <small>/{s.mode === "two-hand" ? 2 : 1}</small>
          </span>
        </div>
        <div className="telemetry__item">
          <span className="telemetry__label">AI</span>
          <span className="telemetry__value">
            <span className={dotClass(view.tone)} />
            {view.label}
            {ai.state === "live" && ai.fps > 0 && <small> · {Math.round(ai.fps)}fps</small>}
          </span>
        </div>
        <div className="telemetry__item telemetry__item--wide">
          <span className="telemetry__label">Latency</span>
          <span className="telemetry__value">
            {ai.latencyMs != null && s.source === "decart" ? (
              <>
                {Math.round(ai.latencyMs)}
                <small>ms {ai.latencyKind === "g2g" ? "glass" : "rtt"}</small>
              </>
            ) : (
              "—"
            )}
          </span>
        </div>
        {ai.seconds > 0 && (
          <div className="telemetry__item telemetry__item--wide">
            <span className="telemetry__label">Session</span>
            <span className="telemetry__value">
              {ai.seconds}s <small>· ${cost.toFixed(2)}</small>
            </span>
          </div>
        )}
      </div>
    </header>
  );
}
