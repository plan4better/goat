"use client";

import { Box, Tooltip, useTheme } from "@mui/material";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import { plainTranslate } from "@/lib/assistant/chips";
import { fullTime, relativeTime } from "@/lib/assistant/messageTimes";

import { useNow } from "@/hooks/assistant/useNow";

import { focusRing, mutedText } from "@/components/assistant/styles";

/**
 * When a message was written, relative ("2 minutes ago"), with the full date
 * and time on hover or focus. The visible words are its name; the full date
 * describes it. Memoized: the transcript renders again on every streamed
 * chunk, a time only when its value or the shared tick changes.
 */
function MessageTime({ time }: { time: number }) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const now = useNow();
  const language = i18n?.language ?? "en";
  return (
    <Tooltip title={fullTime(time, language)} describeChild>
      <Box
        component="time"
        dateTime={new Date(time).toISOString()}
        tabIndex={0}
        sx={{
          display: "block",
          px: "4px",
          borderRadius: "4px",
          fontSize: 11.5,
          lineHeight: 1.5,
          color: mutedText(theme),
          whiteSpace: "nowrap",
          ...focusRing(theme),
        }}>
        {relativeTime(time, now, plainTranslate(t), language)}
      </Box>
    </Tooltip>
  );
}

export default memo(MessageTime);
