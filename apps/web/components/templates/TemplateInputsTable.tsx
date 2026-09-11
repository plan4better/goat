"use client";

import { Box, Chip, Switch, Typography, alpha, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { TemplateInput } from "@/lib/validations/template";

/** A declared input's ship/ask state, as edited in the save dialog before
 * the fixed set from `TemplateInput.mode` is written back. */
export type TemplateInputMode = "ship" | "ask";

interface TemplateInputsTableProps {
  inputs: TemplateInput[];
  modeFor: (key: string) => TemplateInputMode;
  onModeChange: (key: string, mode: TemplateInputMode) => void;
  /** False for a project payload: the backend's `_project_inputs` hard-codes
   * `mode="ship"` for every input (no ask option in v1 — the frozen copy
   * already holds a real project layer for each one), so the row shows a
   * static "Ships with template" label instead of a live switch. */
  allowAsk: boolean;
  /** A frozen snapshot's inputs: shown, not switchable. */
  disabled?: boolean;
}

/** T5/T8's inputs table: one row per layer reference the save preview
 * detected, each showing its type/geometry, a "Sample data" badge for a
 * catalog-origin dataset, and — for a workflow payload — the ship/ask
 * switch defaulted from the preview's `detected_inputs`. Rendered only for
 * workflow/project payloads — a layout payload carries no inputs at all
 * (T5). */
const TemplateInputsTable = ({ inputs, modeFor, onModeChange, allowAsk, disabled }: TemplateInputsTableProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();

  const typeLabel = (input: TemplateInput): string => {
    if (!input.layer_type) return "";
    const kind = t(input.layer_type);
    return input.geometry_type ? `${kind} · ${t(input.geometry_type)}` : kind;
  };

  return (
    <Box sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: "10px", overflow: "hidden" }}>
      {inputs.map((input, index) => {
        const mode = modeFor(input.key);
        return (
          <Box
            key={input.key}
            data-testid={`template-input-row-${input.key}`}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "7px 12px",
              borderTop: index > 0 ? `1px solid ${theme.palette.divider}` : undefined,
            }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography component="div" noWrap sx={{ fontSize: 13, fontWeight: 600 }}>
                {input.label}
              </Typography>
              <Typography component="div" sx={{ fontSize: 11.5, color: "text.secondary" }}>
                {typeLabel(input)}
              </Typography>
            </Box>
            {input.from_catalog && (
              <Chip
                size="small"
                icon={<Icon iconName={ICON_NAME.DATABASE} style={{ fontSize: 12 }} />}
                label={t("sample_data")}
                sx={{ height: 22, fontSize: 11, backgroundColor: alpha(theme.palette.info.main, 0.12) }}
              />
            )}
            <Box sx={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
              {allowAsk ? (
                <>
                  <Switch
                    size="small"
                    checked={mode === "ship"}
                    disabled={disabled}
                    onChange={(_event, checked) => onModeChange(input.key, checked ? "ship" : "ask")}
                    inputProps={{ "aria-label": `${input.label} — ${t("ship_dataset")}` }}
                  />
                  <Typography sx={{ fontSize: 11.5, color: "text.secondary", whiteSpace: "nowrap" }}>
                    {mode === "ship" ? t("ship_dataset") : t("ask_on_use")}
                  </Typography>
                </>
              ) : (
                <Typography sx={{ fontSize: 11.5, color: "text.secondary", whiteSpace: "nowrap" }}>
                  {t("ships_with_template")}
                </Typography>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};

export default TemplateInputsTable;
