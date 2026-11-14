"use client";

// What the filter leaves: how many of the dataset's features it keeps, as a line and a bar, with "Clear" beside it
// and the caller's action on the result under it.
// Without a condition that applies it names all the features and asks for no second count.
import { Box, Button, Typography } from "@mui/material";
import { type ReactNode, memo, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";

import { useFeatureCount } from "@/lib/api/processes";

export interface ResultHeaderProps {
  /** The dataset to count; no count without it. */
  layerId?: string;
  /** The filter as it is saved (CQL2 JSON text); none while no condition applies. */
  filter?: string;
  /** Removes every condition; no button without it. */
  onClear?: () => void;
  /** The caller's action on what the filter keeps (save it as a layer), under the bar. */
  actions?: ReactNode;
}

export const ResultHeader = memo(function ResultHeader({
  layerId,
  filter,
  onClear,
  actions,
}: ResultHeaderProps) {
  const { t, i18n } = useTranslation("common");
  const all = useFeatureCount(layerId);
  const kept = useFeatureCount(filter ? layerId : undefined, filter);
  // While another filter is counted the last count stays, so the line does not blink per change.
  const last = useRef<number | undefined>(undefined);
  if (!filter) last.current = undefined;
  else if (kept.featureCount !== undefined) last.current = kept.featureCount;

  if (!layerId && !onClear) return null;
  const total = all.featureCount;
  const count = filter ? (kept.featureCount ?? last.current) : total;
  const known = total !== undefined && count !== undefined && !all.isError && !kept.isError;
  const shown = (n: number) => n.toLocaleString(i18n.language);
  const number = (
    <Box
      component="b"
      sx={{ color: filter && count === 0 ? "warning.main" : "text.primary", fontSize: 16, fontWeight: 700 }}
    />
  );
  return (
    <Box sx={{ px: 3, pt: 2.5, pb: 3, borderBottom: 1, borderColor: "divider" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minHeight: 28 }}>
        <Typography
          variant="body2"
          color="text.secondary"
          noWrap
          aria-live="polite"
          sx={{ flex: 1, minWidth: 0 }}>
          {known &&
            (filter ? (
              <Trans
                t={t}
                i18nKey="filter_panel.result_of"
                count={total}
                values={{ n: shown(count), total: shown(total) }}
                components={{ b: number }}
              />
            ) : (
              <Trans
                t={t}
                i18nKey="filter_panel.result_all"
                count={total}
                values={{ n: shown(total) }}
                components={{ b: number }}
              />
            ))}
        </Typography>
        {onClear && (
          <Button variant="text" size="small" onClick={onClear} sx={{ minWidth: 0, my: -1, mr: -2 }}>
            {t("filter_panel.clear")}
          </Button>
        )}
      </Box>
      {layerId && (
        <Box
          aria-hidden
          sx={{ height: 4, mt: 1.5, borderRadius: "2px", bgcolor: "divider", overflow: "hidden" }}>
          {known && filter && (
            <Box
              sx={(theme) => ({
                height: "100%",
                width: total > 0 ? `${(count / total) * 100}%` : 0,
                minWidth: count > 0 ? 4 : 0,
                borderRadius: "2px",
                bgcolor: "primary.main",
                transition: theme.transitions.create("width"),
              })}
            />
          )}
        </Box>
      )}
      {actions && <Box sx={{ mt: 2.5 }}>{actions}</Box>}
    </Box>
  );
});
