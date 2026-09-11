"use client";

import { Box, Chip, Switch, Typography, alpha, useTheme } from "@mui/material";
import { format } from "date-fns";
import { useTranslation } from "react-i18next";

import { useDateFnsLocale } from "@/i18n/utils";
import type { TemplateInput } from "@/lib/validations/template";

export interface TemplateCatalogSwitchProps {
  /** Whether the template is in the catalog now; false for a new one. */
  published: boolean;
  publishedAt?: string | null;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Shipped inputs that would refuse a publish (see `blockedShipInputs`). */
  blocked: TemplateInput[];
  /** The "update existing" path: the catalog keeps it and gets the new snapshot. */
  updating?: boolean;
  disabled?: boolean;
}

/** The superuser's "Publish to GOAT catalog" switch with what it will do:
 * published and on → stays; published and off → unpublishes on save; new
 * and on with an uploaded shipped dataset → blocked, naming the dataset. */
const TemplateCatalogSwitch = ({
  published,
  publishedAt,
  checked,
  onChange,
  blocked,
  updating,
  disabled,
}: TemplateCatalogSwitchProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dateLocale = useDateFnsLocale();

  let status: { tone: "ok" | "warn"; chip: string; text: string } | null = null;
  if (published && checked) {
    const since = publishedAt
      ? t("published_in_catalog_since", { date: format(new Date(publishedAt), "P", { locale: dateLocale }) })
      : t("published_in_catalog");
    status = {
      tone: "ok",
      chip: t("published"),
      text: updating ? `${since} ${t("catalog_stays_published")}` : since,
    };
  } else if (published && !checked) {
    status = { tone: "warn", chip: t("unpublish_from_goat_catalog"), text: t("unpublish_on_save") };
  } else if (!published && checked && blocked.length > 0) {
    status = {
      tone: "warn",
      chip: t("blocked"),
      text: t("publish_blocked_uploaded", { names: blocked.map((input) => input.label).join(", ") }),
    };
  }
  const tone = status?.tone === "warn" ? theme.palette.warning.main : theme.palette.primary.main;
  // The title is the switch's label, so clicking it toggles the switch the
  // way the plain FormControlLabel it replaces did.
  const switchId = "template-catalog-switch";

  return (
    <Box
      sx={{
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: "10px",
        padding: "10px 12px",
        display: "grid",
        gap: "8px",
      }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
        <Box>
          <Typography
            component="label"
            htmlFor={switchId}
            sx={{ display: "block", fontSize: 13, fontWeight: 700, cursor: disabled ? "default" : "pointer" }}>
            {t("publish_to_goat_catalog")}
          </Typography>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            {t("publish_to_goat_catalog_explainer")}
          </Typography>
        </Box>
        <Switch
          size="small"
          checked={checked}
          disabled={disabled}
          onChange={(_event, next) => onChange(next)}
          inputProps={{ id: switchId, "aria-label": t("publish_to_goat_catalog") }}
        />
      </Box>
      {status && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            paddingTop: "8px",
            borderTop: `1px solid ${theme.palette.divider}`,
          }}>
          <Chip
            label={status.chip}
            size="small"
            sx={{
              height: 19,
              fontSize: 11,
              fontWeight: 800,
              flexShrink: 0,
              color: tone,
              backgroundColor: alpha(tone, 0.14),
            }}
          />
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{status.text}</Typography>
        </Box>
      )}
    </Box>
  );
};

export default TemplateCatalogSwitch;
