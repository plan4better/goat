import { describe, expect, it } from "vitest";

import { detectGraphicsSupport } from "@/lib/scene/support";

const RENDERER = 0x9246;

/** A canvas whose WebGL 2 answers with a renderer name, and refuses a slow context when `slow`. */
function canvas(opts: { webgl2?: boolean; renderer?: string; slow?: boolean; masked?: boolean } = {}) {
  return () => ({
    getContext: (kind: string, attributes?: { failIfMajorPerformanceCaveat?: boolean }) => {
      if (kind !== "webgl2" || opts.webgl2 === false) return null;
      if (attributes?.failIfMajorPerformanceCaveat && opts.slow) return null;
      return {
        getExtension: (name: string) =>
          name === "WEBGL_debug_renderer_info"
            ? opts.masked
              ? null
              : { UNMASKED_RENDERER_WEBGL: RENDERER }
            : name === "WEBGL_lose_context"
              ? { loseContext: () => undefined }
              : null,
        getParameter: (p: number) => (p === RENDERER ? opts.renderer : null),
      };
    },
  });
}

describe("graphics support", () => {
  it("is none without WebGL 2", () => {
    expect(detectGraphicsSupport(canvas({ webgl2: false }))).toBe("none");
  });

  it("is software for SwiftShader, llvmpipe and basic render drivers", () => {
    for (const renderer of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "ANGLE (Microsoft Basic Render Driver Direct3D11)",
    ])
      expect(detectGraphicsSupport(canvas({ renderer }))).toBe("software");
  });

  it("is software when the browser refuses a context it would draw slowly", () => {
    expect(detectGraphicsSupport(canvas({ masked: true, slow: true }))).toBe("software");
  });

  it("is hardware on a graphics card", () => {
    expect(detectGraphicsSupport(canvas({ renderer: "ANGLE (NVIDIA GeForce RTX 3060)" }))).toBe("hardware");
    expect(detectGraphicsSupport(canvas({ masked: true }))).toBe("hardware");
  });
});
