/**
 * Playback's vehicles, drawn by the map's own WebGL context rather than as a
 * GeoJSON source. A source is re-tiled in the map's worker for every frame —
 * ten a second, a thousand vehicles — and that churn held some 300 MB while
 * playing; here a frame is an array of positions, projected and drawn in
 * place, and nothing is allocated per frame.
 *
 * A vehicle is a dot in its route's colour, edged in white; from
 * BADGES_FROM_ZOOM, or when it is the selected route's, a badge with the
 * route's number, as the panels' RouteBadge. Badges are drawn once per line
 * into a texture (the atlas) and reused. With a route selected, the others
 * are smaller grey dots beneath its badges,
 * and its own on patterns not picked keep their badges, faded; the vehicle
 * of the trip the right panel shows is ringed.
 *
 * Positions are projected to screen pixels on the CPU, in double precision:
 * no jitter at street level, and the same pixels answer which vehicle the
 * pointer is on. Frames come ten times a second; between them each vehicle
 * glides on every screen refresh, a frame behind, rather than jumping.
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MaplibreMap } from "maplibre-gl";

import { type Vehicle, type VehicleFrame, vehicleAt, vehicleFrame } from "@/lib/explorer/derive/vehicles";
import type { VehicleStyle } from "@/lib/explorer/playback";

export const VEHICLE_LAYER_ID = "explorer-vehicles";

/** From this zoom every vehicle carries its route's badge; further out, a
 * network's thousands of badges would cover each other, and they are dots. */
export const BADGES_FROM_ZOOM = 12;

/** What the layer shows besides the frame: the selected route, the open
 * trip, and the colours that mark them. */
export interface VehicleLook {
  selectedRouteId: string | null;
  openTrip: { trip_idx: number; run_dep_s: number } | null;
  /** `#RRGGBB`: the ring around the open trip's vehicle. */
  ring: string;
  /** `#RRGGBB`: other routes' vehicles while one is selected. */
  faded: string;
  /** With a direction or variant of the selected route picked, the trips
   * (trip_idx) it runs: the route's other vehicles fade with the rest. */
  pickedTrips: Set<number> | null;
}

/** A badge in CSS pixels: the panels' small RouteBadge, a little tighter. */
const BADGE = { height: 16, edge: 1.5, padX: 4, radius: 4.5, minWidth: 20, font: 10 };
/** The open trip's ring (CSS px): as the old circle layer drew it. */
const RING = { radius: 15, stroke: 2.5, fill: 0.15 };
const DOT_STROKE = 1;
/** Other lines' vehicles while one is selected: grey, and smaller, so they
 * step back for it — this share of a dot's size, no less than the least,
 * with a thinner edge. */
const FADED_DOT = { share: 0.8, least: 2, stroke: 0.75 };
/** Shapes the fragment shader tells apart. */
const KIND = { dot: 0, badge: 1, ring: 2 } as const;
/** Frames further apart than this (ms) are not glided between: playback
 * was paused, or the scrubber jumped. */
const MAX_GLIDE_MS = 400;
/** The least time (ms) between the redraws a glide asks for: 30 a second.
 * Each redraws the whole map, basemap and buildings included, and playback
 * glides without pause; at the display's 60 a laptop's GPU ran hot and
 * dropped frames after a minute or two (measured on an Iris Xe, 23 Oct
 * 2026). Vehicles moving a few pixels a step look as smooth at 30. */
const GLIDE_FRAME_MS = 1000 / 30;
/** The passes vehicles are drawn in, bottom to top: other lines' dots, all
 * lines' badges, the selected line's badges for its patterns not picked
 * (faded), and its own. */
const PASS = { dot: 1, badge: 2, faded: 4, mine: 3 } as const;
/** How much of a badge shows for the selected line's vehicles on patterns
 * not picked: the line's own badge, stepped back. */
const FADED_BADGE = 0.45;
/** Floats per vertex: position (2), local (2), kind, size (2), colour (4). */
const STRIDE = 11;
const ATLAS_WIDTH = 2048;
const ATLAS_MAX_HEIGHT = 4096;

const VERTEX = `
attribute vec2 a_pos;
attribute vec2 a_local;
attribute float a_kind;
attribute vec2 a_size;
attribute vec4 a_color;
uniform vec2 u_viewport;
varying vec2 v_local;
varying float v_kind;
varying vec2 v_size;
varying vec4 v_color;
void main() {
  vec2 ndc = a_pos / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  v_local = a_local;
  v_kind = a_kind;
  v_size = a_size;
  v_color = a_color;
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D u_atlas;
varying vec2 v_local;
varying float v_kind;
varying vec2 v_size;
varying vec4 v_color;
void main() {
  if (v_kind > 0.5 && v_kind < 1.5) {
    // A badge, at the opacity it is drawn with (premultiplied, as blended).
    gl_FragColor = texture2D(u_atlas, v_local) * v_size.x;
    return;
  }
  float d = length(v_local);
  float r = v_size.x;
  float s = v_size.y;
  if (v_kind < 0.5) {
    // A dot: its colour, edged in white.
    float outer = clamp(r + s - d + 0.5, 0.0, 1.0);
    float inner = clamp(r - d + 0.5, 0.0, 1.0);
    vec3 rgb = mix(vec3(1.0), v_color.rgb, inner);
    gl_FragColor = vec4(rgb, 1.0) * outer;
  } else {
    // The ring: a faint disc, edged in the full colour.
    float outer = clamp(r + s * 0.5 - d + 0.5, 0.0, 1.0);
    float inner = clamp(r - s * 0.5 - d + 0.5, 0.0, 1.0);
    float a = outer * mix(1.0, ${RING.fill.toFixed(2)}, inner);
    gl_FragColor = vec4(v_color.rgb, 1.0) * a;
  }
}`;

type Rgb = [number, number, number];
const GREY: Rgb = [0.5, 0.5, 0.5];
const WHITE: Rgb = [1, 1, 1];
const parsed = new Map<string, Rgb>();
/** `#RRGGBB` as 0–1 channels, parsed once per colour. */
function rgb(hex: string): Rgb {
  let c = parsed.get(hex);
  if (!c) {
    const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
    c = Number.isNaN(n) ? GREY : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    parsed.set(hex, c);
  }
  return c;
}

/** A dot's radius (CSS px) at `zoom`: 2 px at 8, 4 at 13, 6 from 16. */
function dotRadius(zoom: number): number {
  if (zoom <= 8) return 2;
  if (zoom <= 13) return 2 + ((zoom - 8) / 5) * 2;
  if (zoom <= 16) return 4 + ((zoom - 13) / 3) * 2;
  return 6;
}

interface AtlasEntry {
  /** Where it is in the atlas, in device pixels: texture coordinates are
   * worked out on use, as the atlas may have grown since. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Its size in CSS px. */
  width: number;
  height: number;
}

/** Each line's badge, drawn once into one canvas the GPU samples from. */
class BadgeAtlas {
  canvas: HTMLCanvasElement;
  dirty = true;
  private entries = new Map<string, AtlasEntry | null>();
  private x = 0;
  private y = 0;
  private readonly ratio: number;
  private readonly rowHeight: number;
  private readonly font: string;

  constructor(ratio: number) {
    this.ratio = ratio;
    this.rowHeight = Math.ceil(BADGE.height * ratio) + 2;
    this.canvas = document.createElement("canvas");
    this.canvas.width = ATLAS_WIDTH;
    this.canvas.height = this.rowHeight * 8;
    // The panels' badges are set in the page's font.
    const family = getComputedStyle(document.body).fontFamily || "sans-serif";
    this.font = `700 ${BADGE.font * ratio}px ${family}`;
  }

  /** The badge of `style`, drawn if it is new; null where the atlas is full. */
  /** Each route's badge, by its style: found without building a key on
   * every frame. Styles are kept for as long as the routes are. */
  private byStyle = new WeakMap<VehicleStyle, AtlasEntry | null>();

  get(style: VehicleStyle): AtlasEntry | null {
    const cached = this.byStyle.get(style);
    if (cached !== undefined) return cached;
    const entry = this.byKey(style);
    this.byStyle.set(style, entry);
    return entry;
  }

  private byKey(style: VehicleStyle): AtlasEntry | null {
    const key = `${style.label}|${style.color}|${style.text_color}`;
    const known = this.entries.get(key);
    if (known !== undefined) return known;
    const entry = this.draw(style);
    this.entries.set(key, entry);
    return entry;
  }

  private draw(style: VehicleStyle): AtlasEntry | null {
    const r = this.ratio;
    let ctx = this.canvas.getContext("2d");
    if (!ctx) return null;
    ctx.font = this.font;
    const text = ctx.measureText(style.label).width / r;
    const width = Math.min(
      Math.max(BADGE.minWidth, Math.ceil(text + 2 * (BADGE.padX + BADGE.edge))),
      ATLAS_WIDTH / r - 2
    );
    const [w, h] = [Math.ceil(width * r), Math.ceil(BADGE.height * r)];
    if (this.x + w + 2 > ATLAS_WIDTH) {
      this.x = 0;
      this.y += this.rowHeight;
    }
    if (this.y + this.rowHeight > this.canvas.height) {
      if (this.canvas.height * 2 > ATLAS_MAX_HEIGHT) return null;
      // Twice as tall, keeping what is drawn.
      const grown = document.createElement("canvas");
      grown.width = ATLAS_WIDTH;
      grown.height = this.canvas.height * 2;
      grown.getContext("2d")?.drawImage(this.canvas, 0, 0);
      this.canvas = grown;
      ctx = grown.getContext("2d");
      if (!ctx) return null;
    }
    const [x, y] = [this.x + 1, this.y + 1];
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(r, r);
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.roundRect(0, 0, width, BADGE.height, BADGE.radius);
    ctx.fill();
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.roundRect(
      BADGE.edge,
      BADGE.edge,
      width - 2 * BADGE.edge,
      BADGE.height - 2 * BADGE.edge,
      BADGE.radius - BADGE.edge
    );
    ctx.fill();
    ctx.restore();
    ctx.font = this.font;
    ctx.fillStyle = style.text_color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(style.label, x + w / 2, y + h / 2 + 0.5 * r, w - 2 * BADGE.edge * r);
    this.x += w + 2;
    this.dirty = true;
    return { x, y, w, h, width, height: BADGE.height };
  }
}

export class VehicleLayer implements CustomLayerInterface {
  readonly id = VEHICLE_LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: MaplibreMap | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private atlas: BadgeAtlas | null = null;
  private uploadedHeight = 0;
  private attribs: Record<string, number> = {};
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private data = new Float32Array(0);

  /** The frame's columns, read up to `count`: the frame is filled in place,
   * frame after frame, by playback. */
  private vehicles: VehicleFrame = vehicleFrame();
  private count = 0;
  private styles = new Map<number, VehicleStyle>();
  private look: VehicleLook = {
    selectedRouteId: null,
    openTrip: null,
    ring: "#2BB381",
    faded: "#9E9E9E",
    pickedTrips: null,
  };
  /** Mercator positions of the frame's vehicles, x then y, in double
   * precision: where each was shown when the frame came, and where the frame
   * puts it. Between frames (a tenth of a second apart) a vehicle glides from
   * one to the other on every screen refresh, rather than jumping. */
  private from = new Float64Array(0);
  private to = new Float64Array(0);
  /** The arrays the next frame is written into, swapped in when it is. */
  private nextFrom = new Float64Array(0);
  private nextTo = new Float64Array(0);
  /** When the frame came (ms), and how long it takes to glide: the gap since
   * the last; 0 shows it where it is (the first frame, or after a pause). */
  private frameAt = 0;
  private glide = 0;
  /** Each run's place in the last frame, valid where its stamp is the last
   * frame's: how a vehicle is found again in the next. */
  private runIndex = new Int32Array(0);
  private runStamp = new Uint32Array(0);
  private stamp = 0;
  /** The GPU buffer's size, in floats: grown, never shrunk, so a frame
   * reuses it rather than allocating another. */
  private bufferFloats = 0;
  /** Each vehicle's place on screen this render (CSS px), and what it is:
   * 0 not drawn, else a pass of PASS. Reused from render to render. */
  private screen = new Float64Array(0);
  private pass = new Uint8Array(0);
  /** What was drawn last, in drawing order, for the pointer: the vehicle,
   * its centre and half size (CSS px), and whether it is round. */
  private drawnCount = 0;
  private drawnIndex = new Int32Array(0);
  private drawnBox = new Float64Array(0);
  private drawnRound = new Uint8Array(0);

  /** The vehicles to show now, and their routes' looks. */
  setFrame(vehicles: VehicleFrame, styles: Map<number, VehicleStyle>): void {
    const now = performance.now();
    const gap = now - this.frameAt;
    // Frames that follow each other closely are glided between; a frame after
    // a pause, or the first, is shown as it is.
    const smooth = this.count > 0 && gap < MAX_GLIDE_MS;
    const f = this.progress(now);
    const n = vehicles.n;
    if (this.nextFrom.length < n * 2) {
      this.nextFrom = new Float64Array(n * 4);
      this.nextTo = new Float64Array(n * 4);
    }
    let maxRun = 0;
    for (let i = 0; i < n; i++) maxRun = Math.max(maxRun, vehicles.run[i]);
    if (this.runIndex.length <= maxRun) {
      const index = new Int32Array((maxRun + 1) * 2);
      const stamps = new Uint32Array((maxRun + 1) * 2);
      index.set(this.runIndex);
      stamps.set(this.runStamp);
      this.runIndex = index;
      this.runStamp = stamps;
    }
    const { from, to, nextFrom, nextTo, runIndex, runStamp } = this;
    const last = this.stamp;
    for (let i = 0; i < n; i++) {
      const [lon, lat, run] = [vehicles.lon[i], vehicles.lat[i], vehicles.run[i]];
      const x = (180 + lon) / 360;
      const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
      nextTo[2 * i] = x;
      nextTo[2 * i + 1] = y;
      // From where it is shown now, if it was in the last frame.
      const j = runIndex[run];
      const known = smooth && runStamp[run] === last;
      nextFrom[2 * i] = known ? from[2 * j] + (to[2 * j] - from[2 * j]) * f : x;
      nextFrom[2 * i + 1] = known ? from[2 * j + 1] + (to[2 * j + 1] - from[2 * j + 1]) * f : y;
    }
    this.stamp = last + 1;
    for (let i = 0; i < n; i++) {
      runIndex[vehicles.run[i]] = i;
      runStamp[vehicles.run[i]] = this.stamp;
    }
    [this.from, this.nextFrom] = [nextFrom, from];
    [this.to, this.nextTo] = [nextTo, to];
    this.vehicles = vehicles;
    this.count = n;
    this.styles = styles;
    this.frameAt = now;
    this.glide = smooth ? gap : 0;
    this.map?.triggerRepaint();
  }

  private glideTimer: ReturnType<typeof setTimeout> | null = null;

  /** Ask for the glide's next redraw, GLIDE_FRAME_MS after this one. */
  private glideOn(map: { triggerRepaint: () => void }): void {
    if (this.glideTimer !== null) return;
    this.glideTimer = setTimeout(() => {
      this.glideTimer = null;
      map.triggerRepaint();
    }, GLIDE_FRAME_MS);
  }

  /** How far through the glide to the current frame, 0–1, at `now`. */
  private progress(now: number): number {
    return this.glide > 0 ? Math.min(1, (now - this.frameAt) / this.glide) : 1;
  }

  setLook(look: VehicleLook): void {
    this.look = look;
    this.map?.triggerRepaint();
  }

  /** Where a run's vehicle is in the frame shown, or null when it is not out. */
  find(trip_idx: number, run_dep_s: number): { lon: number; lat: number } | null {
    const v = this.vehicles;
    for (let i = 0; i < this.count; i++)
      if (v.trip_idx[i] === trip_idx && v.run_dep_s[i] === run_dep_s) return { lon: v.lon[i], lat: v.lat[i] };
    return null;
  }

  /** The vehicle under `point` (CSS px), looking `radius` px around it: the
   * nearest, the topmost on a tie. */
  hit(point: { x: number; y: number }, radius: number): Vehicle | null {
    let best = -1;
    let bestDistance = Infinity;
    for (let k = this.drawnCount - 1; k >= 0; k--) {
      const box = this.drawnBox;
      const [x, y, hw, hh] = [box[4 * k], box[4 * k + 1], box[4 * k + 2], box[4 * k + 3]];
      const distance = this.drawnRound[k]
        ? Math.max(0, Math.hypot(point.x - x, point.y - y) - hw)
        : Math.hypot(Math.max(0, Math.abs(point.x - x) - hw), Math.max(0, Math.abs(point.y - y) - hh));
      if (distance <= radius && distance < bestDistance) {
        best = this.drawnIndex[k];
        bestDistance = distance;
      }
    }
    return best >= 0 && best < this.count ? vehicleAt(this.vehicles, best) : null;
  }

  onAdd(map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type) as WebGLShader;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      return s;
    };
    const program = gl.createProgram() as WebGLProgram;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    this.program = program;
    for (const a of ["a_pos", "a_local", "a_kind", "a_size", "a_color"])
      this.attribs[a] = gl.getAttribLocation(program, a);
    for (const u of ["u_viewport", "u_atlas"]) this.uniforms[u] = gl.getUniformLocation(program, u);
    this.buffer = gl.createBuffer();
    this.texture = gl.createTexture();
    this.atlas = new BadgeAtlas(map.getPixelRatio());
    this.uploadedHeight = 0;
  }

  onRemove(_map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (this.glideTimer !== null) clearTimeout(this.glideTimer);
    this.glideTimer = null;
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    this.bufferFloats = 0;
    if (this.texture) gl.deleteTexture(this.texture);
    this.program = this.buffer = this.texture = null;
    this.atlas = null;
    this.drawnCount = 0;
    this.map = null;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const map = this.map;
    const atlas = this.atlas;
    if (!map || !atlas || !this.program || !this.buffer || !this.texture) return;
    const n = this.count;
    this.drawnCount = 0;
    if (n === 0) return;

    const ratio = map.getPixelRatio();
    const width = gl.drawingBufferWidth / ratio;
    const height = gl.drawingBufferHeight / ratio;
    // Mercator coordinates (0–1) to clip space, in double precision.
    const m = options.defaultProjectionData.mainMatrix;
    const zoom = map.getZoom();
    const { selectedRouteId, openTrip, pickedTrips } = this.look;
    const faded = rgb(this.look.faded);
    const r = dotRadius(zoom);
    const badges = zoom >= BADGES_FROM_ZOOM;
    const f = this.progress(performance.now());
    // Until the vehicles reach the frame's places, they move on at most
    // GLIDE_FRAME_MS apart; anything else that redraws the map in between
    // (a pan, a zoom) draws them where they are by then.
    if (f < 1) this.glideOn(map);

    // Where each vehicle is on screen, and in which pass it is drawn, bottom
    // to top: dots, badges, the selected route's badges; the ring over all.
    if (this.pass.length < n) {
      this.pass = new Uint8Array(n * 2);
      this.screen = new Float64Array(n * 4);
      this.drawnIndex = new Int32Array(n * 2);
      this.drawnBox = new Float64Array(n * 8);
      this.drawnRound = new Uint8Array(n * 2);
    }
    const { pass, screen } = this;
    let quads = 0;
    let open = -1;
    for (let i = 0; i < n; i++) {
      pass[i] = 0;
      const mx = this.from[2 * i] + (this.to[2 * i] - this.from[2 * i]) * f;
      const my = this.from[2 * i + 1] + (this.to[2 * i + 1] - this.from[2 * i + 1]) * f;
      const w = m[3] * mx + m[7] * my + m[15];
      if (w <= 0) continue;
      const x = ((m[0] * mx + m[4] * my + m[12]) / w + 1) * 0.5 * width;
      const y = (1 - (m[1] * mx + m[5] * my + m[13]) / w) * 0.5 * height;
      if (x < -60 || y < -30 || x > width + 60 || y > height + 30) continue;
      const v = this.vehicles;
      const style = this.styles.get(v.route_idx[i]);
      if (!style) continue;
      screen[2 * i] = x;
      screen[2 * i + 1] = y;
      pass[i] = selectedRouteId
        ? style.route_id === selectedRouteId
          ? !pickedTrips || pickedTrips.has(v.trip_idx[i])
            ? PASS.mine
            : PASS.faded
          : PASS.dot
        : badges
          ? PASS.badge
          : PASS.dot;
      quads++;
      if (openTrip && v.trip_idx[i] === openTrip.trip_idx && v.run_dep_s[i] === openTrip.run_dep_s) open = i;
    }

    const need = (quads + 1) * 6 * STRIDE;
    if (this.data.length < need) this.data = new Float32Array(Math.max(need, this.data.length * 2));
    const data = this.data;
    let o = 0;
    const vertex = (
      x: number,
      y: number,
      lx: number,
      ly: number,
      kind: number,
      s0: number,
      s1: number,
      c: Rgb
    ) => {
      data[o++] = x;
      data[o++] = y;
      data[o++] = lx;
      data[o++] = ly;
      data[o++] = kind;
      data[o++] = s0;
      data[o++] = s1;
      data[o++] = c[0];
      data[o++] = c[1];
      data[o++] = c[2];
      data[o++] = 1;
    };
    /** Two triangles over [x0, x1] × [y0, y1], with local coordinates
     * running [l0, l1] × [k0, k1]. */
    const quad = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      l0: number,
      k0: number,
      l1: number,
      k1: number,
      kind: number,
      s0: number,
      s1: number,
      c: Rgb
    ) => {
      vertex(x0, y0, l0, k0, kind, s0, s1, c);
      vertex(x1, y0, l1, k0, kind, s0, s1, c);
      vertex(x0, y1, l0, k1, kind, s0, s1, c);
      vertex(x0, y1, l0, k1, kind, s0, s1, c);
      vertex(x1, y0, l1, k0, kind, s0, s1, c);
      vertex(x1, y1, l1, k1, kind, s0, s1, c);
    };
    const circle = (x: number, y: number, radius: number, stroke: number, kind: number, c: Rgb) => {
      const e = radius + stroke + 1;
      quad(x - e, y - e, x + e, y + e, -e, -e, e, e, kind, radius, stroke, c);
    };
    const remember = (i: number, hw: number, hh: number, round: boolean) => {
      const k = this.drawnCount++;
      this.drawnIndex[k] = i;
      const box = this.drawnBox;
      box[4 * k] = screen[2 * i];
      box[4 * k + 1] = screen[2 * i + 1];
      box[4 * k + 2] = hw;
      box[4 * k + 3] = hh;
      this.drawnRound[k] = round ? 1 : 0;
    };
    // Vehicles too far out for badges are dots (squares were tried and
    // dropped, 22 Oct 2026).
    const dot = (i: number, c: Rgb) => {
      circle(screen[2 * i], screen[2 * i + 1], r, DOT_STROKE, KIND.dot, c);
      remember(i, r + DOT_STROKE, r + DOT_STROKE, true);
    };
    const fr = Math.max(FADED_DOT.least, r * FADED_DOT.share);
    const fadedDot = (i: number) => {
      circle(screen[2 * i], screen[2 * i + 1], fr, FADED_DOT.stroke, KIND.dot, faded);
      remember(i, fr + FADED_DOT.stroke, fr + FADED_DOT.stroke, true);
    };
    const cw = atlas.canvas.width;

    for (const p of [PASS.dot, PASS.badge, PASS.faded, PASS.mine]) {
      for (let i = 0; i < n; i++) {
        if (pass[i] !== p) continue;
        const style = this.styles.get(this.vehicles.route_idx[i]) as VehicleStyle;
        if (p === PASS.dot) {
          if (selectedRouteId) fadedDot(i);
          else dot(i, rgb(style.color));
          continue;
        }
        const entry = atlas.get(style);
        if (!entry) {
          dot(i, rgb(style.color));
          continue;
        }
        const ch = atlas.canvas.height;
        // Not snapped to whole pixels: a moving badge would step.
        const x0 = screen[2 * i] - entry.width / 2;
        const y0 = screen[2 * i + 1] - entry.height / 2;
        quad(
          x0,
          y0,
          x0 + entry.w / ratio,
          y0 + entry.h / ratio,
          entry.x / cw,
          entry.y / ch,
          (entry.x + entry.w) / cw,
          (entry.y + entry.h) / ch,
          KIND.badge,
          // Its opacity: the selected line's vehicles on patterns not
          // picked keep their badge, faded.
          p === PASS.faded ? FADED_BADGE : 1,
          0,
          WHITE
        );
        remember(i, entry.width / 2, entry.height / 2, false);
      }
    }
    if (open >= 0)
      circle(
        screen[2 * open],
        screen[2 * open + 1],
        RING.radius,
        RING.stroke,
        KIND.ring,
        rgb(this.look.ring)
      );

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (this.bufferFloats < o) {
      this.bufferFloats = data.length;
      gl.bufferData(gl.ARRAY_BUFFER, data.length * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, o));
    const F = 4;
    const attrib = (name: string, size: number, offset: number) => {
      const loc = this.attribs[name];
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * F, offset * F);
    };
    attrib("a_pos", 2, 0);
    attrib("a_local", 2, 2);
    attrib("a_kind", 1, 4);
    attrib("a_size", 2, 5);
    attrib("a_color", 4, 7);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (atlas.dirty || this.uploadedHeight !== atlas.canvas.height) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      atlas.dirty = false;
      this.uploadedHeight = atlas.canvas.height;
    }
    gl.uniform1i(this.uniforms.u_atlas, 0);
    gl.uniform2f(this.uniforms.u_viewport, width, height);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, o / STRIDE);
    // Left enabled, they would outlive this layer on a context without
    // vertex array objects.
    for (const loc of Object.values(this.attribs)) if (loc >= 0) gl.disableVertexAttribArray(loc);
  }
}
