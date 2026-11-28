/**
 * "Apply to" (decided 6 Nov 2026): how far an edit on a line reaches, the
 * same for every such edit. Each level, narrowest first, with the trips it
 * takes; one that takes none is shown greyed with why, never hidden. The
 * selection set where it started; changing it builds the edit again.
 */
import { Box } from "@mui/material";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { type LineScope, SCOPE_LEVELS, type ScopeLevel } from "@/lib/explorer/edit/ops/lineStops";
import type { ExplorerRouteDrawing } from "@/lib/store/explorer/slice";

import type { SelectorItem } from "@/types/map/common";

import type { DraftEdit } from "@/hooks/explorer/useDraftEdit";
import { useAppSelector } from "@/hooks/store/ContextHooks";

import { directionLabel } from "@/components/explorer/directionWords";
import Selector from "@/components/map/panels/common/Selector";

type Drawing = ExplorerRouteDrawing | null;

/** The variant shown, where it is one (not its direction's main pattern). */
function variantShown(line: LineScope, drawing: Drawing) {
  const direction = drawing?.directions.find((d) => d.patterns.includes(line.pattern_idx));
  return direction?.variants.find((v) => v.pattern_idx === line.pattern_idx) ?? null;
}

/** A level of an edit on a line, named as the direction picker names what it
 * covers: "→ place" for the direction, "Short turn → place" for a variant;
 * the whole line in words. In "Apply to" and the edits list alike. */
export function scopeName(level: ScopeLevel, line: LineScope, drawing: Drawing, t: TFunction): string {
  const direction = drawing?.directions.find((d) => d.patterns.includes(line.pattern_idx));
  const variant = variantShown(line, drawing);
  if (level === "variant" && variant)
    return t(`explorer_variant_${variant.kind}`, {
      destination: variant.destination,
      interpolation: { escapeValue: false },
    });
  if ((level === "direction" || level === "variant") && direction) return directionLabel(direction.name, t);
  return t("explorer_scope_line");
}

export function ScopePicker({ scope }: { scope: NonNullable<DraftEdit["scope"]> }) {
  const { t } = useTranslation("common");
  // The direction and the variant shown, named as the direction picker names
  // them ("→ place", "Short turn → place"); the direction's main pattern is
  // the direction, not a variant of its own.
  const drawing = useAppSelector((s) => s.explorer.drawing);
  const variant = variantShown(scope.line, drawing);
  const name = (level: ScopeLevel) => scopeName(level, scope.line, drawing, t);
  const option = (level: ScopeLevel) => scope.options?.find((o) => o.level === level);
  // Every trip it changes, on any day: not the day's, as the panels count.
  const trips = (level: ScopeLevel) => {
    const o = option(level);
    if (!o) return "…";
    return o.none ? t(`explorer_scope_none_${o.none}`) : t("explorer_trips_all_days", { count: o.trips });
  };
  // GOAT's own selector, labelled above and the panel's full width, as the
  // Stops tab's direction is.
  // Only the levels that reach further than the one before: they are
  // nested (a trip in a variant, in a direction, in the line), so one taking
  // as many trips as the last takes the same ones — a stop only one direction
  // calls at offers no whole line beyond it. The level chosen always shows.
  let last = 0;
  const shown = SCOPE_LEVELS.filter((level) => {
    if (level === "variant" && !variant) return false;
    const n = option(level)?.trips ?? 0;
    const adds = n === 0 || n > last;
    if (n > 0) last = Math.max(last, n);
    return adds || level === scope.level;
  });
  const items: SelectorItem[] = shown.map((level) => ({
    value: level,
    label: `${name(level)} · ${trips(level)}`,
    disabled: !option(level) || !!option(level)?.none,
  }));
  return (
    <Box sx={{ pt: "4px", pb: 0.5 }}>
      <Selector
        label={t("explorer_apply_to")}
        items={items}
        selectedItems={items.find((it) => it.value === scope.level)}
        setSelectedItems={(item) => {
          if (!item || Array.isArray(item)) return;
          scope.set(item.value as ScopeLevel);
        }}
      />
    </Box>
  );
}

/** A stop's own edit (move, delete): it reaches the stop on all its lines,
 * shown where a line edit's picker is, as one choice, so every edit says its
 * scope alike. */
export function FixedScope({ lines, trips }: { lines: number; trips: number }) {
  const { t } = useTranslation("common");
  const item: SelectorItem = {
    value: "stop",
    label: [
      t("explorer_scope_stop"),
      t("explorer_lines_count", { count: lines }),
      t("explorer_trips", { count: trips }),
    ].join(" · "),
  };
  return (
    <Box sx={{ pt: "4px", pb: 0.5 }}>
      <Selector
        label={t("explorer_apply_to")}
        items={[item]}
        selectedItems={item}
        setSelectedItems={() => undefined}
        disabled
      />
    </Box>
  );
}
