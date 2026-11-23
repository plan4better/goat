// JSON pointers (RFC 6901) as GOAT Style uses them (goatlib `style/pointer.py`): a list item with an `id` is
// addressed by its id (`/classify/density/classes/c2`), any other list item by its index.
import { isObject } from "@/lib/style/json";

export const toPointer = (segments: string[]): string =>
  segments.map((s) => "/" + s.replace(/~/g, "~0").replace(/\//g, "~1")).join("");

export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`A JSON pointer starts with '/': ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** How a list item is addressed: its id when it has one, otherwise its index. */
export const itemKey = (item: unknown, index: number): string =>
  isObject(item) && typeof item.id === "string" ? item.id : String(index);
