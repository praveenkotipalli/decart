import { useEffect, useRef } from "react";
import { useSettings } from "../config/settings";
import { engine } from "../engine/instance";

/** The GL composite and the 2D annotation layer. Everything inside is drawn by the engine. */
export function Stage() {
  const container = useRef<HTMLDivElement>(null);
  const gl = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const toy = useSettings().frameStyle === "window";

  useEffect(() => {
    engine.attach(gl.current!, overlay.current!, container.current!);
    return () => engine.detach();
  }, []);

  return (
    <div className="stage" ref={container}>
      <canvas
        ref={gl}
        aria-label={toy ? "Camera view with the frame held between your hands" : "Camera view with the hand-controlled portal"}
        role="img"
      />
      <canvas ref={overlay} className="overlay" aria-hidden />
    </div>
  );
}
