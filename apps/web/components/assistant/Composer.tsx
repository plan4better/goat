"use client";

import ArrowUpwardRounded from "@mui/icons-material/ArrowUpwardRounded";
import StopRounded from "@mui/icons-material/StopRounded";
import {
  Box,
  Chip,
  IconButton,
  InputBase,
  Link,
  Stack,
  type Theme,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ContextChip } from "@/lib/assistant/chips";
import type { SourceRef } from "@/lib/assistant/types";

import SourcePicker from "@/components/assistant/SourcePicker";
import ContextChips, { chipSx } from "@/components/assistant/messages/ContextChips";
import { focusRing, mutedText } from "@/components/assistant/styles";
import { MAX_SOURCES } from "@/components/assistant/useComposerContext";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";
import { useReportProblemHref } from "@/components/support/SupportMenu";

export interface ComposerProps {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  /** Shown while an answer runs: instead of Send, or next to it with `queueWhileBusy`. */
  onStop?: () => void;
  busy: boolean;
  /** Send stays available while an answer runs; the parent queues the message. */
  queueWhileBusy?: boolean;
  disabled?: boolean;
  chips: ContextChip[];
  onRemoveChip: (key: string) => void;
  mentionsEnabled: boolean;
  onAddSource: (source: SourceRef) => void;
  /** The message carries as many sources as it may: no further picks. */
  sourcesFull?: boolean;
  excludeProjectId?: string;
  big?: boolean;
  /** The text takes the focus when the composer mounts (it takes an ask card's place again). */
  autoFocus?: boolean;
  /** A new value focuses the text with the caret at its end (a starter filled it). */
  focusRequest?: number;
}

/** The longest message the assistant service accepts (its MAX_MESSAGE_CHARS). */
export const MAX_MESSAGE_CHARS = 32768;

/** A trailing "@word" at the end of the draft opens the source picker. */
const MENTION = /(^|\s)@([^\s@]*)$/;

/** The round buttons at the composer's foot: Send, and Stop. */
const roundButtonSx = (theme: Theme) => ({
  width: 32,
  height: 32,
  p: 0,
  flexShrink: 0,
  bgcolor: "primary.main",
  color: "primary.contrastText",
  "&:hover": { bgcolor: "primary.dark" },
  "&.Mui-disabled": { bgcolor: "action.disabledBackground", color: "action.disabled" },
  ...focusRing(theme),
});

/**
 * Stops the running answer, in the composer and in the ask panel that takes
 * its place. Next to Send it steps back to a neutral outline (`neutral`):
 * Send keeps the accent.
 */
export function StopButton({ onStop, neutral = false }: { onStop: () => void; neutral?: boolean }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const sx = neutral
    ? {
        ...roundButtonSx(theme),
        bgcolor: "background.paper",
        color: "text.primary",
        border: 1,
        borderColor: "divider",
        "&:hover": { bgcolor: "action.hover", borderColor: alpha(theme.palette.text.primary, 0.24) },
      }
    : roundButtonSx(theme);
  return (
    <IconButton aria-label={t("stop")} onClick={onStop} sx={sx}>
      <StopRounded sx={{ fontSize: 18 }} />
    </IconButton>
  );
}

/**
 * The line above the composer: that answers can be wrong, and where to report
 * one (the support entry's "Report a problem"; left out where there is none).
 */
function ComposerNote() {
  const { t } = useTranslation("common");
  const href = useReportProblemHref();
  const text = { fontSize: 12, lineHeight: 1.45, color: mutedText };
  return (
    <Stack direction="row" alignItems="baseline" gap="8px" sx={{ mb: "8px", px: "2px" }}>
      <Typography sx={{ ...text, flex: 1, minWidth: 0 }}>{t("assistant_scope_note")}</Typography>
      {href && (
        <Link
          // The ticket form opens in a new tab: support pages have no dock, so in this tab the
          // answer being reported would leave the screen. The email opens the mail client.
          {...(href.startsWith("/") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          href={href}
          color="inherit"
          underline="always"
          sx={{ ...text, flexShrink: 0 }}>
          {t("assistant_feedback_link")}
        </Link>
      )}
    </Stack>
  );
}

export default function Composer(props: ComposerProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  // A callback ref into state: the picker can anchor to the box from the first
  // render after mount, which a plain ref would not trigger.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const footer = useRef<HTMLDivElement | null>(null);
  const [chipAnchor, setChipAnchor] = useState<HTMLElement | null>(null);
  const canPick = props.mentionsEnabled && !props.sourcesFull;
  const mention = canPick ? MENTION.exec(props.draft) : null;
  const pickerAnchor = chipAnchor ?? (mention ? box : null);
  const canSend = (!props.busy || !!props.queueWhileBusy) && !props.disabled && props.draft.trim().length > 0;
  const withoutMention = () => props.draft.replace(MENTION, "$1");
  const closePicker = () => {
    setChipAnchor(null);
    if (mention) props.onDraftChange(withoutMention());
  };
  // While an answer runs, Stop stands alone until there is something to queue; then Send joins it.
  const canStop = props.busy && !!props.onStop;
  const queueing = canStop && !!props.queueWhileBusy && props.draft.trim().length > 0;
  const stopButton = canStop && props.onStop && <StopButton onStop={props.onStop} neutral={queueing} />;
  const sendButton = (!canStop || queueing) && (
    <IconButton
      aria-label={t("assistant_send")}
      disabled={!canSend}
      onClick={props.onSend}
      sx={roundButtonSx(theme)}>
      <ArrowUpwardRounded sx={{ fontSize: 18 }} />
    </IconButton>
  );
  const hasContext = props.chips.length > 0 || props.mentionsEnabled;
  useEffect(() => {
    const text = input.current;
    if (!props.focusRequest || !text) return;
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
  }, [props.focusRequest]);
  return (
    <Box>
      <ComposerNote />
      {/* One box: the text on top, the message's context and Send in a row at its foot. */}
      <Box
        ref={setBox}
        onMouseDown={(event) => {
          // A click on the box's padding or its empty bottom row puts the caret in the text.
          if (event.target === event.currentTarget || event.target === footer.current) {
            event.preventDefault();
            input.current?.focus();
          }
        }}
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          cursor: "text",
          border: 1,
          borderColor: "divider",
          borderRadius: "14px",
          bgcolor: "background.paper",
          boxShadow: surfaceShadows(theme).rest,
          p: props.big ? "14px 10px 10px 16px" : "10px 8px 8px 14px",
          transition: theme.transitions.create(["border-color", "box-shadow"], { duration: 140 }),
          "&:hover": { borderColor: alpha(theme.palette.text.primary, 0.24) },
          "&:focus-within": {
            borderColor: "primary.main",
            boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.12)}`,
          },
        }}>
        <InputBase
          multiline
          minRows={props.big ? 2 : 1}
          maxRows={8}
          fullWidth
          inputRef={input}
          autoFocus={props.autoFocus}
          value={props.draft}
          disabled={props.disabled}
          placeholder={t("assistant_composer_placeholder")}
          inputProps={{ "aria-label": t("assistant_composer_placeholder"), maxLength: MAX_MESSAGE_CHARS }}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend) props.onSend();
            }
          }}
          sx={{
            p: 0,
            pr: "6px",
            fontSize: props.big ? 15 : 13.5,
            lineHeight: "20px",
            color: "text.primary",
            "& textarea::placeholder": { color: mutedText(theme), opacity: 1 },
          }}
        />
        <Stack ref={footer} direction="row" alignItems="flex-end" gap="8px">
          <Stack
            role={hasContext ? "group" : undefined}
            aria-label={hasContext ? t("assistant_context_label") : undefined}
            direction="row"
            flexWrap="wrap"
            alignItems="center"
            gap="6px"
            sx={{ flex: 1, minWidth: 0, pb: "5px", cursor: "default" }}>
            <ContextChips chips={props.chips} onRemove={props.onRemoveChip} />
            {props.mentionsEnabled && (
              // At the limit the chip is disabled; the tooltip says why (a disabled element gets no hover).
              <Tooltip title={props.sourcesFull ? t("assistant_sources_full", { count: MAX_SOURCES }) : ""}>
                <Box component="span" sx={{ display: "inline-flex" }}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={t("assistant_add_source")}
                    disabled={props.sourcesFull}
                    onClick={(event) => setChipAnchor(event.currentTarget)}
                    sx={(theme) => ({ ...chipSx(theme), borderStyle: "dashed", color: mutedText })}
                  />
                </Box>
              </Tooltip>
            )}
          </Stack>
          {stopButton}
          {sendButton}
        </Stack>
      </Box>
      {canPick && pickerAnchor && (
        <SourcePicker
          anchorEl={pickerAnchor}
          query={mention?.[2] ?? ""}
          excludeProjectId={props.excludeProjectId}
          onClose={closePicker}
          onPick={(source) => {
            props.onAddSource(source);
            closePicker();
          }}
        />
      )}
    </Box>
  );
}
