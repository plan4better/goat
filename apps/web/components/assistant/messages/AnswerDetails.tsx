"use client";

import { Box, IconButton, Popover, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { UsageMetadata } from "@/lib/assistant/types";
import { ASSISTANT_PROVIDERS, type AssistantProvider, PROVIDER_NAMES } from "@/lib/validations/assistant";

import { CARD_RADIUS, eyebrowSx, headerIconButtonSx, mutedText } from "@/components/assistant/styles";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

const KNOWN: ReadonlySet<string> = new Set(ASSISTANT_PROVIDERS);

/** A provider by its product name, an OpenAI-compatible endpoint by `compatible`, an unknown id as it is. */
const providerName = (provider: string, compatible: string): string =>
  KNOWN.has(provider) ? (PROVIDER_NAMES[provider as AssistantProvider] ?? compatible) : provider;

/** Per-answer details (spec §10, D3): the model is never hidden. */
export default function AnswerDetails({ usage }: { usage: UsageMetadata | undefined }) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // Every answer has its details: built once per language, not on every render.
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const rows: [string, string][] = usage
    ? [
        ["assistant_details_model", usage.model],
        [
          "assistant_details_provider",
          usage.provider
            ? providerName(usage.provider, t("assistant_details_provider_openai_compatible"))
            : "",
        ],
        ["assistant_details_input_tokens", number.format(usage.input_tokens)],
        ["assistant_details_output_tokens", number.format(usage.output_tokens)],
        ["assistant_details_cached_tokens", number.format(usage.cache_read_tokens ?? 0)],
      ]
    : [];
  return (
    <>
      <Tooltip title={t("assistant_details")}>
        <IconButton
          aria-label={t("assistant_details")}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={headerIconButtonSx(theme)}>
          <Icon iconName={ICON_NAME.CIRCLEINFO} style={{ fontSize: 15, color: "inherit" }} />
        </IconButton>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        PaperProps={{
          sx: {
            mt: "4px",
            borderRadius: CARD_RADIUS,
            border: 1,
            borderColor: "divider",
            boxShadow: surfaceShadows(theme).hover,
          },
        }}>
        <Box sx={{ px: "14px", py: "12px", minWidth: 240 }}>
          <Typography sx={{ ...eyebrowSx, color: mutedText }}>{t("assistant_details")}</Typography>
          {rows.length === 0 && (
            <Typography sx={{ mt: "8px", fontSize: 13, color: "text.primary" }}>
              {t("assistant_details_none")}
            </Typography>
          )}
          {rows.map(([label, value]) => (
            <Stack key={label} direction="row" gap="16px" justifyContent="space-between" sx={{ mt: "6px" }}>
              <Typography sx={{ fontSize: 12.5, color: mutedText }}>{t(label)}</Typography>
              <Typography sx={{ fontSize: 12.5, fontWeight: 700, color: "text.primary" }}>{value}</Typography>
            </Stack>
          ))}
        </Box>
      </Popover>
    </>
  );
}
