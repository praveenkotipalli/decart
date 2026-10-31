import { useEffect, useMemo, useState } from "react";
import { useStore } from "./core/store";
import { engine } from "./engine/instance";
import { CalibrationOverlay } from "./ui/CalibrationOverlay";
import { Dock } from "./ui/Dock";
import { Hud, SimBadge, Toast } from "./ui/Hud";
import { SidePanel } from "./ui/panel/SidePanel";
import { Stage } from "./ui/Stage";
import { StartScreen } from "./ui/StartScreen";
import { TopBar } from "./ui/TopBar";
import { useKeyboard } from "./ui/useKeyboard";

export function App() {
  const status = useStore(engine.status);
  const [panelOpen, setPanelOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const entered = status.camera === "on" || status.simulated;
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

  const keys = useMemo(
    () => ({ togglePanel: () => setPanelOpen((o) => !o), closePanel: () => setPanelOpen(false), enabled: entered }),
    [entered],
  );
  useKeyboard(keys);

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

  return (
    <div className="app" data-panel={panelOpen && entered ? "open" : "closed"}>
      <Stage />
      <div className="scrim scrim--top" />
      <div className="scrim scrim--bottom" />
      {entered && (
        <>
          <TopBar status={status} />
          <SimBadge status={status} />
          <Hud status={status} />
          <Dock status={status} panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((o) => !o)} fullscreen={fullscreen} />
          <CalibrationOverlay status={status} />
          <SidePanel open={panelOpen} onClose={() => setPanelOpen(false)} status={status} />
        </>
      )}
      <Toast status={status} />
      {startMounted && <StartScreen status={status} leaving={entered} />}
    </div>
  );
}
