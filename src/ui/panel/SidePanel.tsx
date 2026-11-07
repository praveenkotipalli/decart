import { useEffect, useState } from "react";
import { ANIME_PRESETS, animePrompt } from "../../ai/animePrompts";
import { PROMPT_LIMIT } from "../../ai/prompts";
import { resetSettings, updateSettings, useSettings, type Settings } from "../../config/settings";
import type { EngineStatus } from "../../engine/Engine";
import { engine } from "../../engine/instance";
import { IconClose } from "../icons";
import { shortcutsFor } from "../useKeyboard";
import { AnimeTab } from "./AnimeTab";
import { GesturesTab } from "./GesturesTab";
import { LookTab } from "./LookTab";
import { PortalTab } from "./PortalTab";
import { TrackingTab } from "./TrackingTab";
import { TransformTab } from "./TransformTab";

/** Each experience shows only its own settings. */
const TABS = {
  window: ["Look", "Anime", "Tracking", "Keys"],
  classic: ["Transform", "Portal", "Tracking", "Gestures", "Keys"],
} as const;
type Tab = (typeof TABS)[keyof typeof TABS][number];

const STYLES: { value: Settings["frameStyle"]; label: string; title: string }[] = [
  { value: "window", label: "Hand frame", title: "Two L shapes open a frame: filters, anime, loupe and four more effects" },
  { value: "classic", label: "Classic portal", title: "The original glowing portal with a perspective-mapped picture" },
];

export function SidePanel({ open, onClose, status }: { open: boolean; onClose: () => void; status: EngineStatus }) {
  const s = useSettings();
  const style = s.frameStyle;
  const tabs: readonly Tab[] = TABS[style];
  const [tab, setTab] = useState<Tab>(tabs[0]);
  // Switching the experience swaps the tab list: land on the first tab the new one has.
  useEffect(() => {
    if (!tabs.includes(tab)) setTab(tabs[0]);
  }, [tabs, tab]);
  const current = tabs.includes(tab) ? tab : tabs[0];
  const anime = status.anime;

  return (
    <aside id="tune-panel" className="panel" data-open={open} aria-label="Tune" aria-hidden={!open} inert={!open}>
      <div className="panel__head">
        <span className="panel__title">Tune</span>
        <div className="seg seg--head" role="radiogroup" aria-label="Experience">
          {STYLES.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={style === o.value}
              title={o.title}
              onClick={() => updateSettings({ frameStyle: o.value })}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label="Close panel" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            className="tab"
            id={`tab-${t}`}
            aria-selected={current === t}
            aria-controls="tab-panel"
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="panel__body" role="tabpanel" id="tab-panel" aria-labelledby={`tab-${current}`}>
        {current === "Look" && <LookTab settings={s} onChange={updateSettings} />}
        {current === "Anime" && (
          <AnimeTab
            settings={s}
            onChange={updateSettings}
            view={anime.view}
            seconds={anime.usedSec}
            cost={anime.usedSec * anime.pricePerSec}
            allowedModels={status.ai.allowedModels}
            presets={ANIME_PRESETS.map((p) => ({ id: p.id, label: p.label, text: animePrompt(p.id, anime.model || s.animeModel).text }))}
            promptLimit={PROMPT_LIMIT}
            pricePerSec={anime.pricePerSec}
            warning={anime.warning}
            onToggleAnime={() => engine.toggleAnime()}
          />
        )}
        {current === "Transform" && <TransformTab status={status} />}
        {current === "Portal" && <PortalTab />}
        {current === "Tracking" && <TrackingTab status={status} />}
        {current === "Gestures" && <GesturesTab />}
        {current === "Keys" && (
          <section className="section">
            <h3 className="section__label">Keyboard</h3>
            <div className="keys">
              {shortcutsFor(style).map(([k, label]) => (
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
