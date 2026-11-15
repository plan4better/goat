"use client";

import { Box, IconButton, Popover, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useFeatures } from "@/lib/api/users";
import { hostedPlace } from "@/lib/assistant/aiCredits";
import type { UsageMetadata } from "@/lib/assistant/types";
import { formatCredits } from "@/lib/utils/credits";
import { providerName } from "@/lib/validations/assistant";

import { eyebrowSx, headerIconButtonSx, mutedText } from "@/components/assistant/styles";

/** GOAT AI is a product name: the same in every language. */
const GOAT_AI = "GOAT AI";

/**
 * Per-answer details (spec §10, D3). An own connection's answer names its
 * provider, model and tokens. A GOAT AI answer names GOAT AI, never the model
 * behind it, with what it was charged (AI credits, where billing counts them,
 * and steps) and where its model ran, as saved with the answer.
 */
export default function AnswerDetails({ usage }: { usage: UsageMetadata | undefined }) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const { features } = useFeatures();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // Every answer has its details: built once per language, not on every render.
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const goatAi = usage?.goat_ai === true;
  let rows: [string, string][] = [];
  if (usage && goatAi) {
    if (features?.billing && usage.ai_credits !== undefined)
      rows.push(["usage_ai_credits", formatCredits(usage.ai_credits, i18n.language)]);
    if (usage.steps !== undefined) rows.push(["assistant_details_steps", number.format(usage.steps)]);
    rows.push(["assistant_details_model", GOAT_AI]);
  } else if (usage) {
    rows = [
      ["assistant_details_model", usage.model],
      [
        "assistant_details_provider",
        usage.provider ? providerName(usage.provider, t("assistant_details_provider_openai_compatible")) : "",
      ],
      ["assistant_details_input_tokens", number.format(usage.input_tokens)],
      ["assistant_details_output_tokens", number.format(usage.output_tokens)],
      ["assistant_details_cached_tokens", number.format(usage.cache_read_tokens ?? 0)],
    ];
  }
  const hosted =
    goatAi && usage?.hosted_in
      ? t("assistant_details_hosted_in", { place: hostedPlace(usage.hosted_in, t) })
      : null;
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
        PaperProps={{ sx: { mt: "6px" } }}>
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
          {hosted && (
            <Typography
              sx={{
                mt: "8px",
                pt: "8px",
                borderTop: 1,
                borderColor: "divider",
                maxWidth: 240,
                fontSize: 12,
                lineHeight: 1.45,
                color: mutedText,
              }}>
              {hosted}
            </Typography>
          )}
        </Box>
      </Popover>
    </>
  );
}
