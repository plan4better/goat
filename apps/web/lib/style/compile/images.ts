// The images compiled layers name: library icons, GOAT's arrow, uploads (fill patterns are drawn on demand). The
// compiler lists them with where they come from; the renderer loads each one once (`loadImage`).
import { API_BASE_URL, ASSETS_URL } from "@/lib/constants";
import { ICON_HEIGHT, IMAGE_PIXEL_RATIO } from "@/lib/style/compile/constants";
import type { ImageRequest } from "@/lib/style/compile/types";
import { ICON_NAMES } from "@/lib/style/generated/catalog";

const LIBRARY = new Set(ICON_NAMES);

const UPLOAD_ID = /^[A-Za-z0-9-]+$/;
const EMOJI_CODE = /^[0-9a-f]+(-[0-9a-f]+)*$/;

/**
 * GOAT's own images: library icons (`goat:<name>`) and emoji (`emoji:<code>`) from the asset host, the arrow from the app
 * itself, and uploads (`asset:<id>`) through core's public route by id, so every viewer of a map draws them.
 */
export function defaultResolveIcon(ref: string): { url: string; sdf: boolean } | null {
  if (ref.startsWith("asset:")) {
    const id = ref.slice("asset:".length);
    return UPLOAD_ID.test(id) && API_BASE_URL
      ? { url: `${API_BASE_URL.replace(/\/+$/, "")}/api/v2/asset/${id}/file`, sdf: false }
      : null;
  }
  // Emoji keep their colors (the library's images, `scripts/build-emoji.mjs`).
  if (ref.startsWith("emoji:") && EMOJI_CODE.test(ref.slice("emoji:".length)))
    return { url: `${ASSETS_URL}/icons/emoji/${ref.slice("emoji:".length)}.webp`, sdf: false };
  if (ref === "goat:arrow") return { url: "/sprites/goat-arrow.svg", sdf: true };
  if (ref.startsWith("goat:") && LIBRARY.has(ref.slice(5)))
    return { url: `${ASSETS_URL}/icons/maki/${ref.slice(5)}.svg`, sdf: true };
  return null;
}

export class ImageCollector {
  private readonly requests = new Map<string, ImageRequest>();

  constructor(private readonly resolve?: (ref: string) => { url: string; sdf: boolean } | null) {}

  /** Lists `ref` once; false when nothing says where its image comes from. */
  add(ref: string): boolean {
    if (this.requests.has(ref)) return true;
    const found = this.resolve?.(ref) ?? defaultResolveIcon(ref);
    if (!found) return false;
    this.requests.set(ref, {
      name: ref,
      url: found.url,
      sdf: found.sdf,
      height: ICON_HEIGHT,
      pixelRatio: IMAGE_PIXEL_RATIO,
    });
    return true;
  }

  list(): ImageRequest[] {
    return [...this.requests.values()];
  }
}
