import { useEffect, useState } from "react";
import { useSettings } from "../config/settings";
import type { EngineStatus } from "../engine/Engine";

const PHASE_LABEL: Record<EngineStatus["phase"], string> = {
  searching: "Searching",
  tracking: "Tracking",
  coasting: "Coasting",
  locked: "Locked",
  home: "Home",
};

export function Hud({ status }: { status: EngineStatus }) {
  const s = useSettings();
  const invalid = status.validity !== "valid" && !status.locked && status.phase !== "searching";
  return (
    <div className="hud" aria-live="polite">
      <div className="hud__state">
        <span>
          <b>{s.mode === "two-hand" ? "Two-hand" : "One-hand"}</b>
        </span>
        <span className={status.phase === "tracking" ? "is-blue" : undefined}>
          {status.paused ? "Paused" : PHASE_LABEL[status.phase]}
        </span>
        <span>{status.locked ? "Locked" : "Unlocked"}</span>
        {invalid && <span className="is-warn">{status.validity}</span>}
      </div>
      <div className="hud__hint">{status.hint}</div>
    </div>
  );
}

export function SimBadge({ status }: { status: EngineStatus }) {
  if (!status.simulated) return null;
  return (
    <div className="badge-sim" role="status">
      <b>SIMULATED HANDS</b>
      <span>{status.simCaption}</span>
    </div>
  );
}

export function Toast({ status }: { status: EngineStatus }) {
  const [shown, setShown] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => {
    if (!status.toast) return;
    setShown(status.toast);
    const t = setTimeout(() => setShown(null), 2300);
    return () => clearTimeout(t);
  }, [status.toast]);
  if (!shown) return null;
  return (
    <div className="toast" key={shown.id} role="status">
      {shown.text}
    </div>
  );
}
