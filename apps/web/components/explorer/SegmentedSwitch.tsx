/**
 * The Explorer's way to pick between a few options in place: a quiet pill
 * holding them, the chosen one raised on paper, as the playback speed's.
 * The stop's Timetable | Next, and the trip strip's Chart | List. Every
 * option has its icon before its words.
 */
import { ButtonBase, Stack } from "@mui/material";
import type { ReactNode } from "react";

import type { ICON_NAME } from "@p4b/ui/components/Icon";
import { Icon } from "@p4b/ui/components/Icon";

export function SegmentedSwitch<V extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: V; label: ReactNode; icon: ICON_NAME }[];
  value: V;
  onChange: (value: V) => void;
  /** The group's accessible name. */
  label?: string;
}) {
  return (
    <Stack
      direction="row"
      role="radiogroup"
      aria-label={label}
      sx={{ p: 0.25, borderRadius: "14px", bgcolor: "action.hover", flexShrink: 0 }}>
      {options.map((o) => {
        const chosen = o.value === value;
        return (
          <ButtonBase
            key={o.value}
            role="radio"
            aria-checked={chosen}
            onClick={() => onChange(o.value)}
            sx={{
              height: 24,
              minWidth: 72,
              px: 1.75,
              gap: 0.75,
              borderRadius: "12px",
              fontSize: 12,
              fontWeight: 700,
              // GOAT's grey for every option; the chosen one is told by its
              // raised chip.
              color: "text.secondary",
              bgcolor: chosen ? "background.paper" : "transparent",
              boxShadow: chosen ? "0 1px 2px rgba(0, 0, 0, 0.12)" : "none",
            }}>
            <Icon iconName={o.icon} style={{ fontSize: 11 }} htmlColor="inherit" />
            {o.label}
          </ButtonBase>
        );
      })}
    </Stack>
  );
}
