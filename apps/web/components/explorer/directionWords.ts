/**
 * How the Explorer words a direction, in the reader's language: derivations
 * name directions as data (`DirectionName`), the words live in the locale
 * files like every other label.
 */
import type { TFunction } from "i18next";

import type { DirectionName } from "@/lib/explorer/derive/directions";

/** Stop names are data, not markup: React escapes them itself. */
const raw = { interpolation: { escapeValue: false } };

/** "→ Goerdelersteg", "Loop via Third", "→ Sixth via Second": a direction
 * goes where its arrow points, wherever it is named. */
export function directionLabel(name: DirectionName, t: TFunction): string {
  const key = `explorer_direction_${name.kind}${name.via ? "_via" : ""}`;
  return t(key, { place: name.place, via: name.via, ...raw });
}

/** Where a direction goes, without the "To": for a column headed by it. */
export function directionPlace(name: DirectionName, t: TFunction): string {
  return name.kind === "loop"
    ? directionLabel(name, t)
    : name.via
      ? `${name.place} (${name.via})`
      : name.place;
}
