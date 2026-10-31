import { updateSettings, useSettings } from "../../config/settings";
import type { InvalidPolicy } from "../../portal/PortalController";
import type { ContentFit, ContentMapping } from "../../render/Renderer";
import { Section, Segmented, Slider, Switch } from "../controls";

export function PortalTab() {
  const s = useSettings();
  return (
    <>
      <Section label="Energy">
        <Slider label="Glow" value={s.glow} min={0} max={1.6} step={0.05} onChange={(glow) => updateSettings({ glow })} />
        <Slider
          label="Distortion & filaments"
          value={s.energy}
          min={0}
          max={1}
          step={0.05}
          onChange={(energy) => updateSettings({ energy })}
        />
        <Switch
          label="Energy particles"
          help="Sparks shed from the rim. Off automatically with reduced motion."
          checked={s.particles}
          onChange={(particles) => updateSettings({ particles })}
        />
      </Section>

      <Section label="Projection">
        <Segmented<ContentMapping>
          label="Mapping"
          value={s.mapping}
          onChange={(mapping) => updateSettings({ mapping })}
          options={[
            { value: "projected", label: "Projected" },
            { value: "window", label: "Window" },
          ]}
        />
        <p className="note">
          Projected warps the whole AI frame onto your four corners with a homography. Window keeps it aligned with the room, so
          the portal reveals the transformed scene behind it.
        </p>
        <Segmented<ContentFit>
          label="Content fit"
          value={s.fit}
          onChange={(fit) => updateSettings({ fit })}
          options={[
            { value: "cover", label: "Cover" },
            { value: "stretch", label: "Stretch" },
          ]}
        />
        <Switch
          label="Full-screen transform"
          help="The AI output fills the frame; the portal becomes a window back to reality."
          checked={s.fullscreenTransform}
          onChange={(fullscreenTransform) => updateSettings({ fullscreenTransform })}
        />
      </Section>

      <Section label="Geometry">
        <Slider
          label="Portal scale"
          value={s.portalScale}
          min={0.8}
          max={1.8}
          step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(portalScale) => updateSettings({ portalScale })}
          help="1× puts the corners exactly on your fingertips."
        />
        <Segmented<InvalidPolicy>
          label="When corners cross"
          value={s.invalidPolicy}
          onChange={(invalidPolicy) => updateSettings({ invalidPolicy })}
          options={[
            { value: "hold", label: "Hold" },
            { value: "untangle", label: "Untangle" },
            { value: "allow", label: "Allow" },
          ]}
        />
        <p className="note">
          A crossed or concave outline is not a perspective view of a rectangle. Hold keeps the last valid shape, Untangle
          re-orders the corners, Allow draws it clipped.
        </p>
        <Slider
          label="Linger after losing a hand"
          value={s.lingerMs}
          min={300}
          max={4000}
          step={100}
          format={(v) => `${(v / 1000).toFixed(1)} s`}
          onChange={(lingerMs) => updateSettings({ lingerMs })}
        />
      </Section>

      <Section label="Annotations">
        <Switch label="Corner labels" checked={s.showLabels} onChange={(showLabels) => updateSettings({ showLabels })} />
        <Switch
          label="Hand landmarks"
          help="All 21 points per hand, with role and track id."
          checked={s.showSkeleton}
          onChange={(showSkeleton) => updateSettings({ showSkeleton })}
        />
      </Section>
    </>
  );
}
