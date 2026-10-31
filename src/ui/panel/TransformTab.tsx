import { useEffect, useState } from "react";
import { PROMPT_LIMIT, presetsFor } from "../../ai/prompts";
import { updateSettings, useSettings } from "../../config/settings";
import type { EngineStatus } from "../../engine/Engine";
import { engine } from "../../engine/instance";
import type { ContentSource } from "../../render/Renderer";
import { aiView, pricePerSecond } from "../aiView";
import { Section, Segmented, Select, Switch } from "../controls";

const MODEL_INFO: Record<string, string> = {
  "lucy-2.6": "Lucy 2.6 · character swap & edits · 720p",
  "lucy-2.5": "Lucy 2.5 · video editing · 720p",
  "lucy-restyle-2": "Lucy Restyle 2 · whole-scene style · 720p",
  "lucy-latest": "Lucy (latest alias)",
};

export function TransformTab({ status }: { status: EngineStatus }) {
  const s = useSettings();
  const ai = status.ai;
  const view = aiView(ai, s.source, status.content);
  const [image, setImage] = useState<{ url: string; blob: Blob } | null>(null);
  const models = ai.allowedModels.length ? ai.allowedModels : [s.model];
  const presets = presetsFor(s.model);
  const over = s.prompt.length > PROMPT_LIMIT;
  const supportsFast = !s.model.startsWith("lucy-restyle");

  // Revoke the previous preview URL whenever the image changes or the tab unmounts.
  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.url);
    },
    [image],
  );

  const setImageFile = (f: File | null) => {
    setImage(f ? { url: URL.createObjectURL(f), blob: f } : null);
    engine.setReferenceImage(f);
  };

  return (
    <>
      <Section label="Portal content">
        <Segmented<ContentSource>
          label="Source"
          value={s.source}
          onChange={(v) => engine.setSource(v)}
          options={[
            { value: "decart", label: "Decart AI" },
            { value: "local", label: "Local preview" },
            { value: "test", label: "Test pattern" },
          ]}
        />
        {s.source === "decart" ? (
          <div className="status-box" data-tone={view.tone === "preview" ? "off" : view.tone}>
            <div className="status-box__head">
              <span>Decart · {view.label}</span>
              {(ai.state === "error" || ai.state === "off" || ai.state === "paused") && (
                <button type="button" className="btn btn--ghost btn--small" onClick={() => engine.retryAI()}>
                  {ai.state === "error" ? "Retry" : "Connect"}
                </button>
              )}
            </div>
            {ai.detail && <div className="status-box__detail">{ai.detail}</div>}
            {ai.state === "unconfigured" && (
              <div className="status-box__detail">
                Put your key in <code>.env</code> as <code>DECART_API_KEY=…</code> and restart <code>npm run dev</code>.
              </div>
            )}
            {status.content === "local" && (
              <div className="status-box__detail">The portal shows the local preview, labelled as not AI output.</div>
            )}
            {ai.state === "live" && (
              <div className="status-box__stats">
                <span>{Math.round(ai.fps)} fps out</span>
                {ai.latencyMs != null && (
                  <span>
                    {Math.round(ai.latencyMs)} ms {ai.latencyKind === "g2g" ? "glass-to-glass" : "rtt"}
                  </span>
                )}
                {ai.ttffMs != null && <span>first frame {Math.round(ai.ttffMs)} ms</span>}
                <span>
                  {ai.seconds}s · ${(ai.seconds * pricePerSecond(s.model, s.fast)).toFixed(2)}
                </span>
                {ai.quality && <span>link {ai.quality}</span>}
              </div>
            )}
          </div>
        ) : (
          <p className="note">
            {s.source === "local"
              ? "An on-device stylisation of your camera, burnt-in labelled “not AI output”. Free, offline."
              : "A geometry test card: straight grid lines, diagonals and a circle show the projective mapping is exact."}
          </p>
        )}
      </Section>

      <Section label="Transformation prompt">
        <div className="chips" role="group" aria-label="Prompt presets">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="chip"
              aria-pressed={s.prompt === p.text}
              onClick={() => updateSettings({ prompt: p.text })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <div className="field__row">
            <label className="field__name" htmlFor="prompt">
              Prompt
            </label>
            <span className="count" data-over={over}>
              {s.prompt.length}/{PROMPT_LIMIT}
            </span>
          </div>
          <textarea
            id="prompt"
            className="textarea"
            value={s.prompt}
            onChange={(e) => updateSettings({ prompt: e.target.value })}
            spellCheck={false}
          />
          <span className="field__help">
            Applied live, without reconnecting. Lucy works best with a command first: “Substitute…”, “Add…”, “Replace…”.
          </span>
        </div>
        <Switch
          label="Prompt enhancement"
          help="Decart rewrites the prompt to fit your video (recommended)."
          checked={s.enhance}
          onChange={(enhance) => updateSettings({ enhance })}
        />
        <div className="field">
          <span className="field__name">Reference image (optional)</span>
          <div className="ref-image">
            {image && <img src={image.url} alt="Reference" />}
            <label className="file-label">
              {image ? "Replace" : "Choose image"}
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
            </label>
            {image && (
              <button type="button" className="text-btn" onClick={() => setImageFile(null)}>
                Remove
              </button>
            )}
          </div>
          <span className="field__help">A clear, front-facing character image (≥ 512 px) improves likeness on Lucy models.</span>
        </div>
      </Section>

      <Section label="Session">
        <Select
          label="Model"
          value={s.model}
          onChange={(model) => updateSettings({ model })}
          options={models.map((m) => ({ value: m, label: `${MODEL_INFO[m] ?? m} · $${pricePerSecond(m, false).toFixed(2)}/s` }))}
        />
        <Switch
          label="Fast mode"
          help={ai.allowFast ? "Lower latency, billed at 2× (Lucy models)." : "Disabled on the server (DECART_ALLOW_FAST)."}
          checked={s.fast && ai.allowFast && supportsFast}
          disabled={!ai.allowFast || !supportsFast}
          onChange={(fast) => updateSettings({ fast })}
        />
        <Switch
          label="Fall back to local preview"
          help="If Decart is unavailable, keep the portal alive with the labelled preview."
          checked={s.autoFallback}
          onChange={(autoFallback) => updateSettings({ autoFallback })}
        />
        <Select
          label="Pause AI when no portal for"
          value={s.idlePauseSec}
          onChange={(idlePauseSec) => updateSettings({ idlePauseSec })}
          options={[
            { value: 20, label: "20 seconds" },
            { value: 45, label: "45 seconds" },
            { value: 90, label: "90 seconds" },
            { value: 0, label: "Never" },
          ]}
          help="Billing is per generated second; the session resumes when the portal reappears."
        />
      </Section>
    </>
  );
}
