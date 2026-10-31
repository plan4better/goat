"use client";

import { Chip, type Theme, alpha } from "@mui/material";

import type { ContextChip } from "@/lib/assistant/chips";

import { accentSoft, accentText, focusRing, mutedText } from "@/components/assistant/styles";

/** The dock's small chip: 22px, upright (the theme's chips are italic), 11px bold. */
export const chipSx = (theme: Theme) => ({
  height: 22,
  maxWidth: 260,
  borderRadius: "6px",
  fontStyle: "normal",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.2px",
  border: `1px solid ${theme.palette.divider}`,
  bgcolor: "background.default",
  color: mutedText(theme),
  "& .MuiChip-label": { px: "8px" },
  "& .MuiChip-deleteIcon": { width: 14, height: 14, mr: "4px", ml: "-4px", color: "inherit", opacity: 0.7 },
  "& .MuiChip-deleteIcon:hover": { color: "inherit", opacity: 1 },
  ...focusRing(theme),
});

/**
 * What a message carried about its page (spec §6.3); removable in the composer only.
 * The chips go into the caller's row, so they wrap together with what else it holds.
 */
export default function ContextChips({
  chips,
  onRemove,
}: {
  chips: ContextChip[];
  onRemove?: (key: string) => void;
}) {
  return (
    <>
      {chips.map((chip) => (
        <Chip
          key={chip.key}
          size="small"
          label={chip.label}
          variant={chip.kind === "source" ? "outlined" : "filled"}
          onDelete={onRemove && chip.removable ? () => onRemove(chip.key) : undefined}
          sx={(theme) => ({
            ...chipSx(theme),
            // The proposal's target stands out in the primary tint; a source is a plain outline.
            ...(chip.kind === "target" && {
              bgcolor: accentSoft(theme),
              borderColor: alpha(theme.palette.primary.main, 0.4),
              color: accentText(theme),
            }),
            ...(chip.kind === "source" && { bgcolor: "transparent" }),
          })}
        />
      ))}
    </>
  );
}
