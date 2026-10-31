import { DEFAULT_SETTINGS, updateSettings, useSettings } from "../../config/settings";
import type { EngineStatus } from "../../engine/Engine";
import { engine } from "../../engine/instance";
import { CORNER_LABELS, CORNER_NAMES, type CornerMapping } from "../../portal/cornerMapping";
import type { HandRole, TrackingMode } from "../../tracking/handAssignment";
import { CORNER_LANDMARK_OPTIONS, type LandmarkIndex } from "../../tracking/landmarks";
import { Section, Segmented, Select, Slider, Switch } from "../controls";

export function TrackingTab({ status }: { status: EngineStatus }) {
  const s = useSettings();
  const twoHand = s.mode === "two-hand";
  const mapping = twoHand ? s.twoHandMapping : s.oneHandMapping;
  const key = twoHand ? "twoHandMapping" : "oneHandMapping";

  const setCorner = (i: number, patch: Partial<CornerMapping[number]>) => {
    const next = mapping.map((c, k) => (k === i ? { ...c, ...patch } : c)) as CornerMapping;
    updateSettings({ [key]: next });
  };

  return (
    <>
      <Section label="Mode">
        <Segmented<TrackingMode>
          label="Hands"
          value={s.mode}
          onChange={(mode) => updateSettings({ mode })}
          options={[
            { value: "two-hand", label: "Two hands" },
            { value: "one-hand", label: "One hand" },
          ]}
        />
        <p className="note">
          {twoHand
            ? "Most precise: each hand drives two corners. Hand A is the one on the left of the screen when both appear."
            : "One spread hand, palm to the camera: index, pinky, wrist and thumb. The mapping mirrors itself automatically if you show the back of your hand."}
        </p>
      </Section>

      <Section label="Corner mapping">
        <table className="mapping">
          <thead>
            <tr>
              <th />
              {twoHand && <th>Hand</th>}
              <th>Landmark</th>
            </tr>
          </thead>
          <tbody>
            {mapping.map((c, i) => (
              <tr key={i}>
                <td title={CORNER_LABELS[i]}>{CORNER_NAMES[i]}</td>
                {twoHand && (
                  <td>
                    <Select<HandRole>
                      value={c.role}
                      onChange={(role) => setCorner(i, { role })}
                      options={[
                        { value: "A", label: "A · left" },
                        { value: "B", label: "B · right" },
                      ]}
                    />
                  </td>
                )}
                <td>
                  <Select<LandmarkIndex>
                    value={c.landmark}
                    onChange={(landmark) => setCorner(i, { landmark })}
                    options={CORNER_LANDMARK_OPTIONS.map((o) => ({ value: o.index, label: o.label }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          className="text-btn"
          style={{ marginTop: 8, paddingLeft: 0 }}
          onClick={() => updateSettings({ [key]: DEFAULT_SETTINGS[key] })}
        >
          Restore default mapping
        </button>
      </Section>

      <Section label="Filtering">
        <Slider
          label="Stability"
          value={s.smoothing}
          min={0.3}
          max={3}
          step={0.05}
          format={(v) => `${v.toFixed(2)} Hz`}
          onChange={(smoothing) => updateSettings({ smoothing })}
          help="One Euro cutoff at rest. Lower is steadier; higher reacts sooner to small moves."
        />
        <Slider
          label="Responsiveness"
          value={s.responsiveness}
          min={0}
          max={20}
          step={0.5}
          format={(v) => v.toFixed(1)}
          onChange={(responsiveness) => updateSettings({ responsiveness })}
          help="How fast smoothing gets out of the way when your hands move quickly."
        />
        <Slider
          label="Dropout grace"
          value={s.graceMs}
          min={100}
          max={1200}
          step={50}
          format={(v) => `${v} ms`}
          onChange={(graceMs) => updateSettings({ graceMs })}
          help="A hand that vanishes for less than this keeps its corners in place."
        />
        <Slider
          label="Detection confidence"
          value={s.detectionConfidence}
          min={0.3}
          max={0.9}
          step={0.05}
          onChange={(detectionConfidence) => updateSettings({ detectionConfidence })}
        />
        <Switch label="Mirror view" help="Show the camera like a mirror." checked={s.mirror} onChange={(mirror) => updateSettings({ mirror })} />
      </Section>

      <Section label="Calibration">
        <p className="note" style={{ marginTop: 0 }}>
          {s.calibration
            ? `Calibrated ${new Date(s.calibration.at).toLocaleString()} · jitter ${(s.calibration.noise * 1000).toFixed(1)}‰ of frame`
            : "Not calibrated. Hold your portal pose still for under two seconds: it learns your pose, your home position and how much to smooth."}
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => engine.startCalibration()}
            disabled={status.camera !== "on" && !status.simulated}
          >
            {s.calibration ? "Recalibrate" : "Calibrate"}
          </button>
          {s.calibration && (
            <button
              type="button"
              className="text-btn"
              onClick={() =>
                updateSettings({
                  calibration: null,
                  twoHandMapping: DEFAULT_SETTINGS.twoHandMapping,
                  smoothing: DEFAULT_SETTINGS.smoothing,
                })
              }
            >
              Forget calibration
            </button>
          )}
        </div>
      </Section>
    </>
  );
}
