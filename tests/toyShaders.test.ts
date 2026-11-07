/**
 * Static checks of the toy's GLSL that run in node (no GL context): the shaders cannot be
 * compiled here, so this catches what a template or a uniform table can get wrong.
 * scripts/check-shaders.mjs compiles the same table in a real WebGL2 context.
 */
import { describe, expect, it } from "vitest";
import { FULLSCREEN_VS, PARTICLE_FS, PARTICLE_VS } from "../src/render/shaders";
import { FRAME_FS, TOY_PROGRAMS, TREATMENT } from "../src/render/toyShaders";

const EXPECTED = ["frame", "stamp", "decay", "downsample", "fog", "ink", "plate", "onion", "sparks"];

/** GLSL source without its comments, so a name in a comment never satisfies a check. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** The names declared in `uniform` statements, including multi-declarator and array forms. */
function declaredUniforms(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(src))) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/\[.*$/, "").trim();
      if (name) out.add(name);
    }
  }
  return out;
}

describe("TOY_PROGRAMS", () => {
  it("lists every pass of the toy", () => {
    expect(Object.keys(TOY_PROGRAMS).sort()).toEqual([...EXPECTED].sort());
  });

  it("builds every full-screen pass on FULLSCREEN_VS and the sparks on the existing point shaders", () => {
    for (const [name, p] of Object.entries(TOY_PROGRAMS)) {
      if (name === "sparks") {
        expect(p.vs).toBe(PARTICLE_VS);
        expect(p.fs).toBe(PARTICLE_FS);
      } else {
        expect(p.vs).toBe(FULLSCREEN_VS);
      }
    }
  });

  for (const [name, p] of Object.entries(TOY_PROGRAMS)) {
    describe(name, () => {
      it("vs and fs start with #version 300 es", () => {
        expect(p.vs.startsWith("#version 300 es")).toBe(true);
        expect(p.fs.startsWith("#version 300 es")).toBe(true);
      });

      it("fs declares a float precision", () => {
        expect(p.fs).toMatch(/precision\s+(highp|mediump)\s+float;/);
      });

      it("has no broken template interpolation", () => {
        for (const src of [p.vs, p.fs]) {
          expect(src).not.toContain("undefined");
          expect(src).not.toContain("[object");
          expect(src).not.toContain("${");
        }
      });

      it("lists each uniform once", () => {
        expect(new Set(p.uniforms).size).toBe(p.uniforms.length);
        expect(p.uniforms.length).toBeGreaterThan(0);
      });

      it("every listed uniform is declared in its vs or fs", () => {
        const declared = new Set([...declaredUniforms(p.vs), ...declaredUniforms(p.fs)]);
        for (const u of p.uniforms) expect(declared, `uniform ${u} of ${name}`).toContain(u);
      });

      it("every declared uniform is in the table (the renderer can set it)", () => {
        const declared = new Set([...declaredUniforms(p.vs), ...declaredUniforms(p.fs)]);
        for (const u of declared) expect(p.uniforms, `declared uniform ${u} of ${name}`).toContain(u);
      });

      it("every listed uniform is used outside its declaration", () => {
        // A uniform that is declared but never read is optimised out and getUniformLocation
        // returns null; the renderer would then be setting nothing.
        const body = stripComments(p.vs + "\n" + p.fs).replace(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+[^;]+;/g, " ");
        for (const u of p.uniforms) expect(body, `uniform ${u} of ${name} is never read`).toMatch(new RegExp(`\\b${u}\\b`));
      });
    });
  }
});

describe("FRAME_FS", () => {
  it("contains the even-odd polygon SDF (sdQuad) and the segment distance", () => {
    expect(FRAME_FS).toContain("float sdQuad(vec2 p)");
    expect(FRAME_FS).toContain("float sdSeg(vec2 p, vec2 a, vec2 b)");
    expect(FRAME_FS).toContain("sdQuad(p)");
  });

  it("keeps the sign flip of the crossing-number rule so a bow-tie fills both lobes", () => {
    expect(FRAME_FS).toContain("if (all(c) || all(not(c))) s *= -1.0;");
  });

  it("samples the treatment through the stage rect, never assuming the stage is the canvas", () => {
    expect(FRAME_FS).toContain("uniform vec4 uStage;");
    expect(FRAME_FS).toContain("treat((sp - uStage.xy) / uStage.zw)");
    expect(FRAME_FS).not.toContain("treat(sp / uRes)");
  });

  it("includes the TREATMENT chunk once", () => {
    expect(FRAME_FS).toContain(TREATMENT);
    expect(FRAME_FS.split("vec3 treat(vec2 st)").length).toBe(2);
  });

  it("has the four corners, two loupes and their visibilities as arrays", () => {
    expect(FRAME_FS).toContain("uniform vec2 uQ[4];");
    expect(FRAME_FS).toContain("uniform vec4 uLoupe[2];");
    expect(FRAME_FS).toContain("uniform float uLoupeVis[2];");
  });
});

describe("TREATMENT", () => {
  it("reads the plate as a stage-uv target (no y flip)", () => {
    expect(TREATMENT).toContain("texture(uPlate, st)");
    expect(TREATMENT).not.toContain("1.0 - st.y");
  });

  it("mirrors only the camera, never the AI picture", () => {
    expect(TREATMENT).toContain("mix(st.x, 1.0 - st.x, uCamMirror)");
    expect(TREATMENT).toContain("texture(uAi, a)");
    expect(TREATMENT).not.toMatch(/texture\(uAi,\s*vec2\(1\.0\s*-/);
  });

  it("uses the design's tile size and 720 px reference height", () => {
    expect(TREATMENT).toContain("vec2 cell = vec2(72.0, 54.0);");
    expect(TREATMENT).toContain("720.0 * uAspect, 720.0");
  });
});

describe("offscreen passes", () => {
  it("write targets in stage-uv space with the documented flip", () => {
    for (const name of ["stamp", "downsample", "plate"]) {
      expect(TOY_PROGRAMS[name].fs, name).toContain("vec2 vt = vec2(vUv.x, 1.0 - vUv.y);");
    }
  });

  it("read targets with the plain stage uv on screen", () => {
    expect(TOY_PROGRAMS.ink.fs).toContain("texture(uPaint, st)");
    expect(TOY_PROGRAMS.fog.fs).toContain("texture(uMask, st)");
    expect(TOY_PROGRAMS.fog.fs).not.toContain("1.0 - st.y");
    expect(TOY_PROGRAMS.ink.fs).not.toContain("1.0 - st.y");
  });
});
