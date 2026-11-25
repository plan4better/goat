"use client";

import { Box, Link, Skeleton, Typography, useTheme } from "@mui/material";
import NextLink from "next/link";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { settingsUsagePath } from "@/lib/settingsRoutes";

import { accentText } from "@/components/assistant/styles";
import SurfaceCard from "@/components/dashboard/common/SurfaceCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import SwitchRow from "@/components/settings/common/SwitchRow";
import { UsageMark } from "@/components/settings/usage/UsageMark";

const SWITCH_ID = "ai-enabled";

/** The period's AI credits as the card shows them: the figures, still loading, or failed. */
export type AiCredits =
  | { state: "ready"; used: string; total: string | null }
  | { state: "loading" }
  | { state: "failed"; retry: () => void };

/** KI für diese Organisation: the switch (saves at once) and, with billing, the period's AI credits. */
export default function AiSwitchCard({
  enabled,
  answeringName,
  nameLoading,
  credits,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  /** "GOAT AI (inklusive)" or the active connection's name; null while it is not known. */
  answeringName: string | null;
  /** The connections, and so the active one's name, are still being read. */
  nameLoading: boolean;
  /** null without billing. */
  credits: AiCredits | null;
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <SurfaceCard
      component="section"
      aria-labelledby={`${SWITCH_ID}-label`}
      hoverable={false}
      sx={{ px: 6, py: 5, display: "flex", flexDirection: "column", gap: 4 }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 3 }}>
        <UsageMark icon={ICON_NAME.SPARKLES} tone="primary" />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <SwitchRow
            id={SWITCH_ID}
            label={t("settings_ai_switch_title")}
            line={
              !enabled ? (
                t("settings_ai_off")
              ) : answeringName !== null ? (
                t("settings_ai_on", { name: answeringName, interpolation: { escapeValue: false } })
              ) : nameLoading ? (
                <Skeleton variant="text" width={280} sx={{ maxWidth: "100%" }} />
              ) : (
                // The connections failed to load (their card offers a retry).
                t("settings_ai_on_unnamed")
              )
            }
            checked={enabled}
            disabled={disabled}
            onChange={onToggle}
          />
        </Box>
      </Box>
      {credits?.state === "failed" ? (
        <SettingsLoadError onRetry={credits.retry} />
      ) : (
        credits && (
          <Link
            component={NextLink}
            href={settingsUsagePath("ai")}
            underline="none"
            sx={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 2,
              p: 3,
              borderRadius: "8px",
              backgroundColor: "action.hover",
              color: "text.primary",
            }}>
            <Typography component="span" variant="body2" fontWeight={700}>
              {t("usage_ai_credits")}
            </Typography>
            {/* The Usage tile's Beta tag. */}
            <Box
              component="span"
              sx={{
                px: "6px",
                border: `1px solid ${theme.palette.primary.main}`,
                borderRadius: "999px",
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: accentText(theme),
              }}>
              {t("beta")}
            </Box>
            <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: "auto" }}>
              {credits.state === "loading" ? (
                <Skeleton variant="text" width={120} />
              ) : credits.total === null ? (
                t("settings_ai_credits_used", { used: credits.used })
              ) : (
                t("settings_ai_credits_of", { used: credits.used, total: credits.total })
              )}
            </Typography>
            <Icon
              iconName={ICON_NAME.CHEVRON_RIGHT}
              style={{ fontSize: 12 }}
              htmlColor={theme.palette.text.secondary}
            />
          </Link>
        )
      )}
    </SurfaceCard>
  );
}
