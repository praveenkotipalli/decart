import { useState } from "react";
import { resetSettings } from "../../config/settings";
import type { EngineStatus } from "../../engine/Engine";
import { IconClose } from "../icons";
import { SHORTCUTS } from "../useKeyboard";
import { GesturesTab } from "./GesturesTab";
import { PortalTab } from "./PortalTab";
import { TrackingTab } from "./TrackingTab";
import { TransformTab } from "./TransformTab";

const TABS = ["Transform", "Portal", "Tracking", "Gestures", "Keys"] as const;
type Tab = (typeof TABS)[number];

export function SidePanel({ open, onClose, status }: { open: boolean; onClose: () => void; status: EngineStatus }) {
  const [tab, setTab] = useState<Tab>("Transform");
  return (
    <aside id="tune-panel" className="panel" data-open={open} aria-label="Tune" aria-hidden={!open} inert={!open}>
      <div className="panel__head">
        <span className="panel__title">Tune</span>
        <button type="button" className="icon-btn" aria-label="Close panel" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            className="tab"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls="tab-panel"
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="panel__body" role="tabpanel" id="tab-panel" aria-labelledby={`tab-${tab}`}>
        {tab === "Transform" && <TransformTab status={status} />}
        {tab === "Portal" && <PortalTab />}
        {tab === "Tracking" && <TrackingTab status={status} />}
        {tab === "Gestures" && <GesturesTab />}
        {tab === "Keys" && (
          <section className="section">
            <h3 className="section__label">Keyboard</h3>
            <div className="keys">
              {SHORTCUTS.map(([k, label]) => (
                <div key={k} style={{ display: "contents" }}>
                  <kbd>{k}</kbd>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <div className="panel__foot">
        <button type="button" className="text-btn" style={{ paddingLeft: 0 }} onClick={() => resetSettings()}>
          Reset all settings
        </button>
        <span className="count">saved in this browser</span>
      </div>
    </aside>
  );
}
