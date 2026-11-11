// Space behind the globe: with Globe on, MapLibre leaves the canvas transparent where it shows space (its sky is
// seen from outside the atmosphere there), so a backdrop behind the canvas shows through. One element carries it, in
// three background layers: a soft blue halo around the globe's disc, a static starfield and a dark backdrop. The halo
// is the globe glow the map shows: it follows the globe through four CSS variables set on `move`, and its strength and
// colours (the scene's Globe glow at the current zoom) through four more; nothing else changes after the first paint. Under
// the globe and the sky the backdrop is hidden, so zooming in covers it without a fade.
import type { Map as MaplibreMap } from "maplibre-gl";
import type { CSSProperties } from "react";

import { type AutoSource, autoForm, sceneForm } from "@/lib/scene/auto";
import { fromForm, valueAt } from "@/lib/style/compile/values";
import type { Scene } from "@/lib/style/generated/types";

export interface GlobeView {
  width: number;
  height: number;
  zoom: number;
  /** The map centre's latitude: MapLibre scales the globe by it to keep a constant scale at the centre. */
  lat: number;
  pitch: number;
  /** The vertical field of view, degrees. */
  fov: number;
  padding?: { top?: number; bottom?: number; left?: number; right?: number };
}

/**
 * The globe's outline on screen as an ellipse: MapLibre's globe radius in pixels (`worldSize / 2π / cos(lat)`), seen
 * with a perspective camera that stands `height / 2 / tan(fov / 2)` pixels from the map centre and looks at it with
 * the map's tilt. The top and bottom are exact (the tangents from the camera to the sphere), the width is the
 * outline's width through the direction of the globe's centre: close enough for a soft halo.
 */
export function globeDisc(v: GlobeView): { x: number; y: number; rx: number; ry: number } {
  const rad = Math.PI / 180;
  const pad = { top: 0, bottom: 0, left: 0, right: 0, ...v.padding };
  const x = pad.left + (v.width - pad.left - pad.right) / 2;
  const y = pad.top + (v.height - pad.top - pad.bottom) / 2;
  const camera = v.height / 2 / Math.tan((v.fov * rad) / 2);
  const radius = (512 * 2 ** v.zoom) / (2 * Math.PI) / Math.cos(Math.min(Math.abs(v.lat), 85.051129) * rad);
  const pitch = v.pitch * rad;
  // The globe's centre lies `radius` below the map centre along the ground's normal, which the tilt turns away from
  // the camera: `down` and `ahead` of the camera, seen `towards` that far below the view's centre line.
  const down = radius * Math.sin(pitch);
  const ahead = camera + radius * Math.cos(pitch);
  const towards = Math.atan2(down, ahead);
  const spread = Math.asin(Math.min(radius / Math.hypot(down, ahead), 1));
  const top = camera * Math.tan(towards - spread);
  // The bottom may lie behind the camera's view: it is off screen then, far enough below.
  const bottom = camera * Math.tan(Math.min(towards + spread, 89 * rad));
  return {
    x,
    y: y + (top + bottom) / 2,
    rx: camera * Math.tan(spread),
    ry: (bottom - top) / 2,
  };
}

/** A small seeded random generator (mulberry32): the same stars on every load. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A square SVG tile of `count` stars: mostly small and dim, a few larger and brighter, some faintly blue or warm. */
export function starfieldTile(seed: number, size: number, count: number): string {
  const next = random(seed);
  const tints = ["#ffffff", "#ffffff", "#ffffff", "#cfe0ff", "#ffe9cf"];
  const stars: string[] = [];
  for (let i = 0; i < count; i++) {
    const bright = next() < 0.06;
    const r = bright ? 1 + next() * 0.4 : 0.35 + next() * 0.45;
    const opacity = bright ? 0.75 + next() * 0.2 : 0.2 + next() * 0.45;
    const tint = tints[Math.floor(next() * tints.length)];
    stars.push(
      `<circle cx="${(next() * size).toFixed(1)}" cy="${(next() * size).toFixed(1)}" r="${r.toFixed(2)}" ` +
        `fill="${tint}" fill-opacity="${opacity.toFixed(2)}"/>`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${stars.join("")}</svg>`;
}

const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

/** A halo stop: the colour in `--globe-glow-<name>` (an `r, g, b` triplet, `rgb` until it is set) at `alpha` times the
 * glow's strength (`--globe-glow`, 0 to 1, full until it is set). */
const glowing = (name: string, rgb: string, alpha: number) =>
  `rgba(var(--globe-glow-${name}, ${rgb}), calc(${alpha} * var(--globe-glow, 1)))`;

/** The halo: clear inside the globe, a thin lighter edge, then the glow's colour fading out to a quarter of the
 * radius (stops in percent of 1.25 radii: the edge at 80 %), as strong as the glow. */
const HALO =
  "radial-gradient(ellipse calc(var(--globe-rx) * 1.25) calc(var(--globe-ry) * 1.25) at var(--globe-x) var(--globe-y), " +
  "rgba(160, 200, 255, 0) 79.6%, " +
  `${glowing("edge", "170, 210, 255", 0.6)} 80%, ` +
  `${glowing("color", "110, 165, 245", 0.26)} 82.4%, ` +
  `${glowing("outer", "80, 135, 230", 0.1)} 88%, ` +
  "rgba(60, 110, 220, 0) 100%)";

/** The halo at a zoom: its strength, 0 (none) to 1 (full), and its colour. */
export interface Halo {
  strength: number;
  color: [number, number, number];
}

/** A `#rgb`, `#rrggbb` or `#rrggbbaa` colour as red, green, blue and alpha (0 to 1); null for anything else. */
function rgba(color: unknown): [number, number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(color));
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const [r, g, b, a = 255] = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16)).filter((n) => !isNaN(n));
  return [r, g, b, a / 255];
}

/**
 * The halo at a zoom: the scene's Globe glow, its strength and colour fixed or by zoom, the automatic values where it
 * sets none; a colour's alpha weakens it.
 */
export function haloOf(scene: Scene | undefined, look: AutoSource, zoom: number): Halo {
  const at = (key: string, kind: "number" | "color") =>
    valueAt(fromForm(sceneForm(scene, look, key), kind, null), zoom);
  const color = rgba(at("glow.color", "color")) ?? rgba(autoForm(look, "glow.color")) ?? [110, 165, 245, 1];
  const strength = Number(at("glow.strength", "number"));
  return {
    strength: (Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1) * color[3],
    color: [color[0], color[1], color[2]],
  };
}

/** A colour mixed towards `to` by `share` (0: the colour, 1: `to`), as an `r, g, b` triplet. */
const mixed = (color: Halo["color"], to: number, share: number) =>
  color.map((c) => Math.round(c + (to - c) * share)).join(", ");

/** Sets the halo's strength and colours on the space element: the edge lighter, the outer glow a little darker. */
function paintHalo(element: HTMLElement, halo: Halo): void {
  element.style.setProperty("--globe-glow", halo.strength.toFixed(3));
  element.style.setProperty("--globe-glow-edge", mixed(halo.color, 255, 0.45));
  element.style.setProperty("--globe-glow-color", halo.color.join(", "));
  element.style.setProperty("--globe-glow-outer", mixed(halo.color, 0, 0.15));
}

/** Two star tiles of different sizes, so their repeats do not line up. */
const STARS = [svgUrl(starfieldTile(11, 640, 150)), svgUrl(starfieldTile(29, 487, 70))];

/** The element behind the map canvas that shows space around the globe. */
export const SPACE_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  backgroundColor: "#070c18",
  backgroundImage: [HALO, ...STARS, "radial-gradient(ellipse at 50% 45%, #0f1c33 0%, #070c18 75%)"].join(
    ", "
  ),
  backgroundSize: "100% 100%, 640px 640px, 487px 487px, 100% 100%",
  backgroundRepeat: "no-repeat, repeat, repeat, no-repeat",
  backgroundPosition: "0 0, 0 0, 213px 131px, 0 0",
};

/** Keeps `element`'s halo on the globe while the map moves, as `halo` gives it at the map's zoom (the automatic halo
 * without it); returns the function that stops it. */
export function followGlobe(
  map: MaplibreMap,
  element: HTMLElement,
  halo: (zoom: number) => Halo = (zoom) => haloOf(undefined, "light", zoom)
): () => void {
  const place = () => {
    const canvas = map.getCanvas();
    const disc = globeDisc({
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      zoom: map.getZoom(),
      lat: map.getCenter().lat,
      pitch: map.getPitch(),
      fov: map.getVerticalFieldOfView(),
      padding: map.getPadding(),
    });
    element.style.setProperty("--globe-x", `${disc.x.toFixed(1)}px`);
    element.style.setProperty("--globe-y", `${disc.y.toFixed(1)}px`);
    element.style.setProperty("--globe-rx", `${disc.rx.toFixed(1)}px`);
    element.style.setProperty("--globe-ry", `${disc.ry.toFixed(1)}px`);
    paintHalo(element, halo(map.getZoom()));
  };
  place();
  map.on("move", place);
  map.on("resize", place);
  return () => {
    map.off("move", place);
    map.off("resize", place);
  };
}
