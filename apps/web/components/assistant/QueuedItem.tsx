"use client";

import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import ScheduleRounded from "@mui/icons-material/ScheduleRounded";
import { Box, Button, Stack, Typography, alpha, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import type { QueuedMessage } from "@/lib/assistant/store";

import {
  CARD_RADIUS,
  accentSoft,
  accentText,
  eyebrowSx,
  focusRing,
  mutedText,
  pillButtonSx,
} from "@/components/assistant/styles";

/** The compact pills of the item, like Undo on an applied proposal. */
const smallPill = { ...pillButtonSx, "&&": { ...pillButtonSx["&&"], px: "10px", py: "3px" } };

/**
 * The message waiting above the composer for the running answer to end: its
 * text cut to two lines, "Send now" and "Remove". A dashed edge marks it as
 * not sent yet; a refusal shows its reason underneath. Without `onSendNow`
 * (nothing can be sent now: the AI credits are used up) only Remove stays.
 */
export default function QueuedItem({
  queued,
  onSendNow,
  onRemove,
}: {
  queued: QueuedMessage;
  onSendNow?: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Box
      role="group"
      aria-label={t("assistant_queued")}
      sx={{
        mb: "10px",
        px: "12px",
        pt: "6px",
        pb: "10px",
        borderRadius: CARD_RADIUS,
        border: "1px dashed",
        borderColor: alpha(theme.palette.primary.main, 0.5),
        bgcolor: accentSoft(theme),
      }}>
      <Stack direction="row" alignItems="center" gap="6px" flexWrap="wrap">
        <ScheduleRounded sx={{ fontSize: 14, color: accentText(theme) }} />
        <Typography component="span" sx={{ ...eyebrowSx, flex: 1, color: accentText(theme) }}>
          {t("assistant_queued")}
        </Typography>
        {onSendNow && (
          <Button
            size="small"
            variant="text"
            onClick={onSendNow}
            sx={{ ...smallPill, color: accentText(theme), ...focusRing(theme) }}>
            {t("assistant_send_now")}
          </Button>
        )}
        <Button
          size="small"
          variant="text"
          color="inherit"
          onClick={onRemove}
          sx={{ ...smallPill, color: mutedText(theme), ...focusRing(theme) }}>
          {t("remove")}
        </Button>
      </Stack>
      <Typography
        title={queued.text}
        sx={{
          mt: "2px",
          fontSize: 13,
          lineHeight: "19px",
          color: "text.primary",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
        {queued.text}
      </Typography>
      {queued.reason && (
        <Stack direction="row" alignItems="flex-start" gap="6px" role="alert" sx={{ mt: "6px" }}>
          <ErrorOutlineRounded sx={{ fontSize: 15, mt: "1px", color: "error.main" }} />
          <Typography sx={{ fontSize: 12, lineHeight: 1.5, color: "text.primary" }}>
            {t(queued.reason)}
          </Typography>
        </Stack>
      )}
    </Box>
  );
}
