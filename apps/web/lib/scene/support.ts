// What the browser's graphics can do for the map (3D in GOAT): WebGL 2 on a graphics card, WebGL 2 drawn in software
// (SwiftShader, llvmpipe, a "basic render" driver, or a context the browser flags as slow), or none at all. 3D needs
// the first; the map itself needs WebGL 2. Checked once, on first use, in the browser.

export type GraphicsSupport = "hardware" | "software" | "none";

const SOFTWARE = /swiftshader|llvmpipe|software|basic render/i;

/** A canvas maker, replaceable in tests. */
type CanvasMaker = () => { getContext: (kind: string, attributes?: object) => unknown };

interface Gl {
  getExtension(name: string): unknown;
  getParameter(parameter: number): unknown;
}

/** The support of a fresh canvas's WebGL 2 context. */
export function detectGraphicsSupport(
  makeCanvas: CanvasMaker = () => document.createElement("canvas")
): GraphicsSupport {
  let gl: Gl | null;
  try {
    gl = makeCanvas().getContext("webgl2") as Gl | null;
  } catch {
    gl = null;
  }
  if (!gl) return "none";
  const info = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "") : "";
  (gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
  if (SOFTWARE.test(renderer)) return "software";
  // The browser refuses a context it would draw slowly (a software fallback it does not name).
  let fast: Gl | null;
  try {
    fast = makeCanvas().getContext("webgl2", { failIfMajorPerformanceCaveat: true }) as Gl | null;
  } catch {
    fast = null;
  }
  if (!fast) return "software";
  (fast.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
  return "hardware";
}

let cached: GraphicsSupport | null = null;

/** The browser's graphics support, checked once. A page without WebGL 2 at all (a test DOM) counts as "none". */
export function graphicsSupport(): GraphicsSupport {
  if (cached) return cached;
  if (typeof window === "undefined") return "hardware";
  cached = "WebGL2RenderingContext" in window ? detectGraphicsSupport() : "none";
  return cached;
}

/** The mode the map can show: a saved 3D view opens in 2D where 3D is drawn in software. */
export const shownMode = <M extends "2d" | "3d">(mode: M): M | "2d" =>
  mode === "3d" && graphicsSupport() === "software" ? "2d" : mode;
