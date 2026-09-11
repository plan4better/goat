"use client";

import { Box, ButtonBase, Chip, FormControlLabel, Radio, RadioGroup, Typography, alpha, useTheme } from "@mui/material";
import { formatDistance } from "date-fns";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";
import { spaceDisplayName } from "@/lib/utils/content";
import type { Space } from "@/lib/validations/content";
import type { TemplateRead } from "@/lib/validations/template";

export type TemplateSaveMode = "new" | "update";

export interface TemplateSourceChoiceProps {
  /** The source's kind as a word for the sentence ("workflow", "layout"). */
  kindLabel: string;
  /** Templates saved from this same source, newest first. */
  candidates: TemplateRead[];
  mode: TemplateSaveMode;
  onModeChange: (mode: TemplateSaveMode) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  spaces: Space[];
  disabled?: boolean;
}

/** "Templates were already saved from this source": save a new one, or
 * refresh one of them. Candidates arrive newest first; the first is the
 * natural pick and is marked so. Renders nothing when there are none. */
const TemplateSourceChoice = ({
  kindLabel,
  candidates,
  mode,
  onModeChange,
  selectedId,
  onSelect,
  spaces,
  disabled,
}: TemplateSourceChoiceProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dateLocale = useDateFnsLocale();
  if (candidates.length === 0) return null;
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0];
  const ago = (iso: string) => formatDistance(new Date(iso), new Date(), { addSuffix: true, locale: dateLocale });

  const segment = (id: TemplateSaveMode, icon: ICON_NAME, label: string) => {
    const on = mode === id;
    return (
      <ButtonBase
        key={id}
        onClick={() => onModeChange(id)}
        disabled={disabled}
        aria-pressed={on}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          height: 32,
          px: "13px",
          borderRadius: "999px",
          backgroundColor: on ? alpha(theme.palette.primary.main, 0.12) : "transparent",
          color: on ? theme.palette.primary.main : theme.palette.text.secondary,
          fontSize: 13.5,
          fontWeight: 600,
        }}>
        <Icon iconName={icon} style={{ fontSize: 15, color: "inherit" }} />
        {label}
      </ButtonBase>
    );
  };

  return (
    <Box
      sx={{
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: "12px",
        padding: "12px",
        display: "grid",
        gap: "10px",
        backgroundColor: alpha(theme.palette.text.primary, 0.02),
      }}>
      <Typography sx={{ fontSize: 13 }}>
        {t("templates_from_source", { count: candidates.length, kind: kindLabel })}
      </Typography>
      {/* The same pill the Content page's Grid/List switch uses (LayoutToggle):
        two segments, the active one filled with the primary tint. */}
      <Box
        role="group"
        aria-label={t("save_as_new") + " / " + t("update_existing")}
        sx={{
          display: "inline-flex",
          gap: "2px",
          padding: "3px",
          width: "fit-content",
          borderRadius: "999px",
          border: `1px solid ${theme.palette.divider}`,
          backgroundColor: theme.palette.background.paper,
        }}>
        {segment("new", ICON_NAME.PLUS, t("save_as_new"))}
        {segment("update", ICON_NAME.REFRESH, t("update_existing"))}
      </Box>
      {mode === "update" && (
        <>
          <RadioGroup value={selected.id} onChange={(_event, value) => onSelect(value)}>
            {candidates.map((candidate, index) => (
              <FormControlLabel
                key={candidate.id}
                value={candidate.id}
                disabled={disabled}
                control={<Radio size="small" />}
                sx={{ m: 0, py: "4px", "& .MuiFormControlLabel-label": { flex: 1, minWidth: 0 } }}
                label={
                  <Box
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "44px minmax(0, 1fr) auto",
                      gap: "10px",
                      alignItems: "center",
                    }}>
                    <Box
                      aria-hidden
                      sx={{
                        width: 44,
                        height: 30,
                        borderRadius: "5px",
                        backgroundColor: alpha(theme.palette.text.primary, 0.08),
                        backgroundImage: candidate.thumbnail_url ? `url(${candidate.thumbnail_url})` : undefined,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                      }}
                    />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography noWrap sx={{ fontSize: 13, fontWeight: 700 }}>
                        {candidate.name}
                      </Typography>
                      <Typography noWrap sx={{ fontSize: 11.5, color: "text.secondary" }}>
                        {spaceDisplayName(
                          spaces.find((space) => space.id === candidate.space_id),
                          t
                        )}
                      </Typography>
                    </Box>
                    <Box sx={{ textAlign: "right" }}>
                      {index === 0 && (
                        <Chip
                          label={t("latest")}
                          size="small"
                          color="primary"
                          sx={{ height: 18, fontSize: 10.5, fontWeight: 800, mb: "2px" }}
                        />
                      )}
                      <Typography
                        sx={{ fontSize: 11.5, color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
                        {ago(candidate.updated_at)}
                      </Typography>
                    </Box>
                  </Box>
                }
              />
            ))}
          </RadioGroup>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            {t("replaces_snapshot_from", { time: ago(selected.updated_at) })}
          </Typography>
        </>
      )}
    </Box>
  );
};

export default TemplateSourceChoice;
