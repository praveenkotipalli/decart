import { updateSettings, useSettings } from "../../config/settings";
import { GESTURE_LABELS, type GestureBindings, type GestureKind } from "../../gestures/GestureMachine";
import { Section, Select, Slider } from "../controls";

const KINDS: GestureKind[] = ["pinch-middle", "pinch-index", "fist", "open-palm", "open-palm-solo", "none"];

export function GesturesTab() {
  const s = useSettings();
  const b = s.gestures[s.mode];
  const set = (patch: Partial<GestureBindings>) =>
    updateSettings({ gestures: { ...s.gestures, [s.mode]: { ...b, ...patch } } });
  const options = KINDS.map((k) => ({ value: k, label: GESTURE_LABELS[k] }));

  return (
    <>
      <Section label={`Bindings · ${s.mode === "two-hand" ? "two hands" : "one hand"}`}>
        <Select<GestureKind> label="Lock / unlock" value={b.lock} onChange={(lock) => set({ lock })} options={options} />
        <Slider
          label="Hold to lock"
          value={b.lockHoldMs}
          min={0}
          max={1200}
          step={20}
          format={(v) => `${v} ms`}
          onChange={(lockHoldMs) => set({ lockHoldMs })}
        />
        <Select<GestureKind> label="Reset" value={b.reset} onChange={(reset) => set({ reset })} options={options} />
        <Slider
          label="Hold to reset"
          value={b.resetHoldMs}
          min={0}
          max={2500}
          step={50}
          format={(v) => `${v} ms`}
          onChange={(resetHoldMs) => set({ resetHoldMs })}
        />
      </Section>
      <Section label="Why these defaults">
        <p className="note" style={{ marginTop: 0 }}>
          Your thumbs and index fingers are the corners, so the lock gesture uses the <em>middle</em> finger: a thumb–middle
          pinch barely disturbs the frame, and the lock restores the pose from just before the pinch began.
        </p>
        <p className="note">
          The portal pose is already fairly open, so reset needs something unmistakable: in two-hand mode, drop one hand and
          show the other as an open palm; in one-hand mode — where an open palm <em>is</em> the portal — make a fist.
        </p>
        <p className="note">Every action also has a key and a button, so a gesture is never the only way.</p>
      </Section>
    </>
  );
}
