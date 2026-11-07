import { useEffect, useMemo, useState } from "react";
import { useSettings } from "./config/settings";
import { useStore } from "./core/store";
import type { EngineStatus } from "./engine/Engine";
import { engine } from "./engine/instance";
import { effectiveFilter } from "./toy/filters";
import { animeSuffix, hintFor, statusLineFor, type ToyHudActions, type ToyHudStatus } from "./toy/hud";
import { CalibrationOverlay } from "./ui/CalibrationOverlay";
import { Dock } from "./ui/Dock";
import { Hud, SimBadge, Toast } from "./ui/Hud";
import { KeyLegend } from "./ui/hud/KeyLegend";
import { ToyHud } from "./ui/hud/ToyHud";
import { SidePanel } from "./ui/panel/SidePanel";
import { Stage } from "./ui/Stage";
import { StartScreen } from "./ui/StartScreen";
import { TopBar, Wordmark } from "./ui/TopBar";
import { useKeyboard } from "./ui/useKeyboard";

/** Everything the toy's bottom band shows, derived from the engine status and the settings. */
function useToyHud(status: EngineStatus, panelOpen: boolean, fullscreen: boolean): ToyHudStatus {
  const s = useSettings();
  const toy = status.toy;
  const anime = status.anime;
  const cost = anime.usedSec * anime.pricePerSec;
  return {
    effect: s.effect,
    filter: effectiveFilter(s.filter, anime.view === "live", s.lastTint),
    trackers: s.trackers,
    anime: anime.view,
    animeSuffix: animeSuffix(anime.view, { seconds: anime.usedSec, cost, connectingSec: anime.connectingSec }),
    hint: hintFor({
      effect: s.effect,
      anime: anime.view,
      gate: toy?.gate ?? "idle",
      locked: toy?.locked ?? false,
      handsFresh: toy?.handsFresh ?? 0,
      handsIdle: toy?.handsIdle ?? false,
      oneL: toy?.oneL ?? false,
      plate: toy?.plate ?? "none",
      countdown: toy?.countdown ?? 0,
      paused: status.paused,
    }),
    statusLine: statusLineFor({
      renderFps: status.renderFps,
      trackFps: status.trackFps,
      hands: status.hands,
      anime: anime.view,
      aiFps: status.ai.fps,
      lagMs: status.ai.latencyKind === "g2g" ? status.ai.latencyMs : null,
      seconds: anime.usedSec,
      cost,
    }),
    cameraOn: status.camera === "on",
    recording: status.recording,
    panelOpen,
    fullscreen,
    simulated: status.simulated,
  };
}

export function App() {
  const status = useStore(engine.status);
  const s = useSettings();
  const [panelOpen, setPanelOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [chromeHidden, setChromeHidden] = useState(false);
  const entered = status.camera === "on" || status.simulated;
  const toy = status.frameStyle === "window";
  // Keep the start screen mounted briefly so it can fade out.
  const [startMounted, setStartMounted] = useState(!entered);

  useEffect(() => {
    if (!entered) setStartMounted(true);
    else {
      const t = setTimeout(() => setStartMounted(false), 520);
      return () => clearTimeout(t);
    }
  }, [entered]);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => {
    const leave = () => engine.dispose();
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, []);

  // The controls can only be hidden in the toy; never leave them hidden behind another layout.
  useEffect(() => {
    if (!toy || !entered) setChromeHidden(false);
  }, [toy, entered]);

  const keys = useMemo(
    () => ({
      togglePanel: () => setPanelOpen((o) => !o),
      closePanel: () => setPanelOpen(false),
      toggleChrome: () => setChromeHidden((h) => !h),
      showChrome: () => setChromeHidden(false),
      enabled: entered,
    }),
    [entered],
  );
  useKeyboard(keys);

  const actions = useMemo<ToyHudActions>(
    () => ({
      setEffect: (e) => engine.setEffect(e),
      toggleTrackers: () => engine.toggleTrackers(),
      toggleAnime: () => engine.toggleAnime(),
      cycleFilter: (dir) => engine.cycleFilter(dir),
      toggleCamera: () => (engine.camera.stream ? engine.stopCamera() : void engine.startCamera()),
      snapshot: () => void engine.snapshot(),
      toggleRecording: () => void engine.toggleRecording(),
      togglePanel: () => setPanelOpen((o) => !o),
      hideChrome: () => setChromeHidden(true),
      showChrome: () => setChromeHidden(false),
    }),
    [],
  );
  const hud = useToyHud(status, panelOpen && entered, fullscreen);

  if (status.webglError) {
    return (
      <div className="start" style={{ placeItems: "center", display: "grid" }}>
        <div className="start__error" role="alert">
          <strong>WebGL2 is unavailable</strong>
          <p>{status.webglError} Enable hardware acceleration in your browser settings and reload.</p>
        </div>
      </div>
    );
  }

  const panel = panelOpen && entered ? "open" : "closed";
  // The stage keeps its place (and its key) in both layouts, so switching the frame
  // style never remounts the canvases or loses the WebGL context.
  return (
    <div className={toy ? "app app--toy" : "app"} data-panel={panel} data-chrome={toy && chromeHidden ? "hidden" : "shown"}>
      {toy && entered && (
        <header key="top" className="band band--top">
          <Wordmark sub={false} />
          <SimBadge status={status} />
          <KeyLegend effect={s.effect} frameStyle="window" />
        </header>
      )}
      <main key="stage" className="stage-wrap">
        <Stage />
      </main>
      {!toy && <div key="scrim-top" className="scrim scrim--top" />}
      {!toy && <div key="scrim-bottom" className="scrim scrim--bottom" />}
      {toy && entered && <ToyHud key="hud" status={hud} actions={actions} chromeHidden={chromeHidden} />}
      {!toy && entered && (
        <>
          <TopBar status={status} />
          <SimBadge status={status} />
          <Hud status={status} />
          <Dock status={status} panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((o) => !o)} fullscreen={fullscreen} />
          <CalibrationOverlay status={status} />
        </>
      )}
      {entered && <SidePanel key="panel" open={panelOpen} onClose={() => setPanelOpen(false)} status={status} />}
      <Toast key="toast" status={status} />
      {startMounted && <StartScreen key="start" status={status} leaving={entered} />}
    </div>
  );
}
