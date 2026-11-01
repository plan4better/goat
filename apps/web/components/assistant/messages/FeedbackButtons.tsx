"use client";

import { Button, IconButton, Popover, Stack, TextField, Tooltip, Typography, useTheme } from "@mui/material";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { saveFeedback } from "@/lib/assistant/transport";
import type { AnswerFeedback, Rating } from "@/lib/assistant/types";

import { accentText, headerIconButtonSx } from "@/components/assistant/styles";

const MAX_COMMENT = 500;

/**
 * Thumbs up or down for one answer. Thumbs down asks for an optional comment;
 * clicking the chosen thumb again removes the rating. The choice shows at once
 * and goes back if saving fails.
 */
export default function FeedbackButtons({
  conversationId,
  messageId,
  initial,
}: {
  conversationId: string;
  messageId: string;
  initial?: AnswerFeedback;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [rating, setRating] = useState<Rating | null>(initial?.rating ?? null);
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  const downButton = useRef<HTMLButtonElement>(null);

  const save = (next: Rating | null, text: string | null) => {
    const previous = rating;
    setRating(next);
    setFailed(false);
    saveFeedback(conversationId, messageId, next, text).catch(() => {
      setRating(previous);
      setFailed(true);
    });
  };

  const choose = (choice: Rating) => {
    if (rating === choice) {
      save(null, null);
      return;
    }
    save(choice, choice === "down" ? comment.trim() || null : null);
    if (choice === "down") setAsking(true);
  };

  const button = (choice: Rating, label: string, icon: ICON_NAME, ref?: typeof downButton) => (
    <Tooltip title={failed ? t("assistant_feedback_failed") : label}>
      <IconButton
        ref={ref}
        aria-label={label}
        aria-pressed={rating === choice}
        onClick={() => choose(choice)}
        sx={headerIconButtonSx(theme)}>
        <Icon
          iconName={icon}
          style={{
            fontSize: 14,
            color: rating === choice ? accentText(theme) : theme.palette.text.secondary,
          }}
        />
      </IconButton>
    </Tooltip>
  );

  return (
    <>
      {button("up", t("assistant_feedback_good"), ICON_NAME.THUMBS_UP)}
      {button("down", t("assistant_feedback_bad"), ICON_NAME.THUMBS_DOWN, downButton)}
      <Popover
        open={asking}
        anchorEl={downButton.current}
        onClose={() => setAsking(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}>
        <Stack gap="10px" sx={{ p: "12px", width: 320 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
            {t("assistant_feedback_comment_title")}
          </Typography>
          <TextField
            autoFocus
            multiline
            minRows={2}
            maxRows={6}
            size="small"
            value={comment}
            placeholder={t("assistant_feedback_comment_placeholder")}
            onChange={(event) => setComment(event.target.value.slice(0, MAX_COMMENT))}
            inputProps={{ maxLength: MAX_COMMENT, "aria-label": t("assistant_feedback_comment_title") }}
          />
          <Stack direction="row" gap="8px" justifyContent="flex-end">
            <Button size="small" color="inherit" onClick={() => setAsking(false)}>
              {t("skip")}
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={!comment.trim()}
              onClick={() => {
                save("down", comment.trim());
                setAsking(false);
              }}>
              {t("assistant_feedback_send")}
            </Button>
          </Stack>
        </Stack>
      </Popover>
    </>
  );
}
