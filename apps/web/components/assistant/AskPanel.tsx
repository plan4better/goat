"use client";

import EditOutlined from "@mui/icons-material/EditOutlined";
import {
  Box,
  Button,
  ButtonBase,
  Stack,
  type Theme,
  Typography,
  alpha,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { keyframes } from "@mui/material/styles";
import { visuallyHidden } from "@mui/utils";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  type Choice,
  answerItem,
  answerParts,
  answerText,
  chooseOption,
  displayOrder,
  emptyChoice,
  hasAnswer,
  isAnswered,
  toAnswer,
} from "@/lib/assistant/ask";
import { getAskChoices, getAskTab, saveAskChoices, saveAskTab } from "@/lib/assistant/store";
import type { AskAnswer, AskCardData } from "@/lib/assistant/types";

import { StopButton } from "@/components/assistant/Composer";
import { QuestionField, askChipSx } from "@/components/assistant/messages/AskQuestion";
import {
  CARD_RADIUS,
  accentSoft,
  accentText,
  focusRing,
  mutedText,
  neutralPillSx,
  pillButtonSx,
} from "@/components/assistant/styles";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

export interface AskPanelProps {
  card: AskCardData;
  /** An answer runs, or this answer is on its way: Send waits. */
  busy: boolean;
  /** Sends the answer as the next message. */
  onSend: (answer: AskAnswer, text: string) => void;
  /** "Reply in text instead", and Esc: the composer takes the panel's place for this card. */
  onReplyInText: () => void;
  /**
   * The panel opened during the session (a card that came, the way back to
   * it): it takes the focus. Mounted again (a reload, expanding the dock), it leaves the focus be.
   */
  autoFocus?: boolean;
  /** Stops the running answer: Stop shows while it is given, as in the composer. */
  onStop?: () => void;
  /** Raised (a new number) to move the focus into the panel: to the tab shown, or a single question's first option. */
  focusRequest?: number;
}

/** Input types nobody types text into: the focus and the number keys are the panel's there. */
const NOT_TYPED = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** The person types in `element`: the panel leaves the focus and the number keys to it. */
export const isEditable = (element: Element | null): boolean =>
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLInputElement && !NOT_TYPED.has(element.type)) ||
  (element instanceof HTMLElement && element.isContentEditable);

/** The panel rises into the composer's place as it opens. */
const slideUp = keyframes`
  from { transform: translateY(12px); opacity: 0; }
  to { transform: none; opacity: 1; }
`;

const sendSx = { ...pillButtonSx, "&&": { ...pillButtonSx["&&"], px: "18px" } };

const tabSx = (theme: Theme, selected: boolean) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  px: "10px",
  py: "2px",
  borderRadius: "999px",
  border: 1,
  borderColor: selected ? alpha(theme.palette.primary.main, 0.6) : theme.palette.divider,
  bgcolor: selected ? accentSoft(theme) : "transparent",
  color: selected ? accentText(theme) : mutedText(theme),
  fontSize: 11.5,
  fontWeight: 700,
  lineHeight: 1.6,
  "&:hover": { bgcolor: selected ? accentSoft(theme) : theme.palette.action.hover },
  ...focusRing(theme),
});

/**
 * The open ask card (contract "The ask card") at the dock's foot, in the
 * composer's place. Several questions show one at a time under a row of tabs,
 * one per header, with Back and Next, and a last tab, Review, that lists every
 * answer above Send; picking a single choice option goes on to the next tab.
 * One question shows its options and Send at once. Nothing is picked in
 * advance: picking a catalog dataset is the person's consent to add it.
 *
 * Keys: 1 to 4 pick the option shown in that place on the question (outside
 * the free text field), Left and Right move between the tabs, Enter on a
 * question's tab goes on and on Review sends, and Esc hands the card to the composer.
 */
export default function AskPanel({
  card,
  busy,
  onSend,
  onReplyInText,
  autoFocus = false,
  onStop,
  focusRequest = 0,
}: AskPanelProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const id = useId();
  // Read at once (no first pass without it): a person who asked for less motion sees no slide.
  const stillMotion = useMediaQuery("(prefers-reduced-motion: reduce)", { noSsr: true });
  // Opened during the session (`autoFocus` at mount): it slides up; mounted again, it does not.
  // Kept from the mount, so the dock dropping `autoFocus` does not stop the slide under way.
  const [slides] = useState(autoFocus);
  // Restored after a remount (expanding or collapsing the dock); see `saveAskChoices`.
  const [choices, setChoices] = useState<Choice[]>(() => {
    const saved = getAskChoices(card.card_id);
    return saved?.length === card.questions.length ? saved : card.questions.map(() => emptyChoice());
  });
  useEffect(() => {
    saveAskChoices(card.card_id, choices);
  }, [card.card_id, choices]);
  const draft = toAnswer(card.card_id, choices);
  const canSend = !busy && hasAnswer(draft);
  const count = card.questions.length;
  const tabbed = count > 1;
  /** The tab shown: a question's index, or `count` for Review; kept with the choices. */
  const [tab, setTab] = useState(() => Math.min(getAskTab(card.card_id), count));
  useEffect(() => {
    saveAskTab(card.card_id, tab);
  }, [card.card_id, tab]);
  const review = tabbed && tab === count;
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const body = useRef<HTMLDivElement>(null);
  /** The key held down is an arrow: a radio it selects is browsed to, not picked to go on. */
  const arrowKey = useRef(false);

  // Opened with `autoFocus`: the focus goes to the tab shown, or to the first option of
  // a single question, unless the person is typing somewhere. Once, on the first pass.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (!autoFocus || isEditable(document.activeElement)) return;
    const first = tabbed ? tabs.current[tab] : body.current?.querySelector("input");
    first?.focus({ preventScroll: true });
  });

  // A request raised after the mount (the transcript's waiting line) moves the focus in.
  const focusHandled = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === focusHandled.current) return;
    focusHandled.current = focusRequest;
    const target = tabbed ? tabs.current[tab] : body.current?.querySelector("input");
    target?.focus({ preventScroll: true });
  });

  /** Shows tab `index` with the focus on it: the tabs, buttons and options it comes from are the panel's. */
  const show = (index: number) => {
    setTab(index);
    tabs.current[index]?.focus({ preventScroll: true });
  };
  const next = () => show(Math.min(tab + 1, count));
  const back = () => show(Math.max(tab - 1, 0));
  const send = () => {
    if (canSend) onSend(draft, answerText(card, draft));
  };
  /** Enter: on to the next tab while a question is shown, else Send. */
  const forward = () => (tabbed && !review ? next() : send());

  const change = (index: number) => (nextChoice: Choice) =>
    setChoices((list) => list.map((choice, position) => (position === index ? nextChoice : choice)));
  /** A single choice option was picked: on to the next tab, unless the arrow keys only browse the options. */
  const picked = () => {
    const browsing = arrowKey.current;
    arrowKey.current = false;
    if (tabbed && !browsing) next();
  };
  /** Number key `key` on the current question: ticks or unticks a multiple choice, picks a single one. */
  const pickNumber = (key: string): boolean => {
    const question = card.questions[tab];
    const index = displayOrder(question)[Number(key) - 1];
    if (index === undefined) return false;
    const choice = choices[tab];
    const multi = question.multi_select;
    change(tab)(chooseOption(choice, index, multi, !multi || !choice.options.includes(index)));
    if (!multi) picked();
    return true;
  };

  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement;
    arrowKey.current = event.key.startsWith("Arrow");
    // A key that composes text (an input method) is the field's.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // Kept from the dock around the panel: in fullscreen, Esc would close the dialog.
      event.preventDefault();
      event.stopPropagation();
      onReplyInText();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const onTab = tabs.current.indexOf(target as HTMLButtonElement);
    if (onTab >= 0) {
      // Selection follows the focus (WAI-ARIA tabs with automatic activation).
      const moves: Partial<Record<string, number>> = {
        ArrowRight: (onTab + 1) % (count + 1),
        ArrowLeft: (onTab + count) % (count + 1),
        Home: 0,
        End: count,
      };
      const move = moves[event.key];
      if (move !== undefined) {
        event.preventDefault();
        show(move);
        return;
      }
    }
    // Enter on a tab or in the free text field; a tab's own click would only select it.
    if (event.key === "Enter" && (onTab >= 0 || isEditable(target))) {
      event.preventDefault();
      forward();
      return;
    }
    if (/^[1-4]$/.test(event.key) && !review && !isEditable(target) && pickNumber(event.key)) {
      event.preventDefault();
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    forward();
  };

  const tabRow = tabbed && (
    <Stack
      role="tablist"
      aria-label={t("assistant_ask_tabs")}
      direction="row"
      flexWrap="wrap"
      gap="6px"
      sx={{ px: "12px", pt: "12px" }}>
      {Array.from({ length: count + 1 }, (_unused, index) => {
        const selected = index === tab;
        const done = index < count && isAnswered(draft.answers[index]);
        return (
          <ButtonBase
            key={index}
            ref={(element: HTMLButtonElement | null) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab${index}`}
            aria-selected={selected}
            aria-controls={`${id}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => setTab(index)}
            sx={tabSx(theme, selected)}>
            {index < count ? card.questions[index].header : t("assistant_ask_review")}
            {done && (
              <>
                <Icon iconName={ICON_NAME.CHECK} style={{ fontSize: 9, color: theme.palette.primary.main }} />
                <Box component="span" sx={visuallyHidden}>
                  {` ${t("assistant_ask_answered")}`}
                </Box>
              </>
            )}
          </ButtonBase>
        );
      })}
    </Stack>
  );

  // Each answer goes back to its question: a button that shows its tab, named with "Edit".
  const reviewList = (
    <Stack gap="4px">
      {card.questions.map((question, index) => {
        const parts = answerParts(question, answerItem(draft, index));
        return (
          <ButtonBase
            key={index}
            type="button"
            onClick={() => show(index)}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              width: "calc(100% + 16px)",
              px: "8px",
              py: "6px",
              mx: "-8px",
              borderRadius: "8px",
              textAlign: "left",
              "&:hover": { bgcolor: theme.palette.action.hover },
              ...focusRing(theme),
            }}>
            <Box
              component="span"
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: "3px",
                flex: 1,
                minWidth: 0,
              }}>
              <Box component="span" sx={askChipSx(theme)}>
                {question.header}
              </Box>
              <Typography
                component="span"
                sx={{
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: parts.length ? "text.primary" : mutedText,
                  overflowWrap: "anywhere",
                }}>
                {parts.length ? parts.join(", ") : t("assistant_ask_no_answer")}
                <Box component="span" sx={visuallyHidden}>
                  {`, ${t("assistant_ask_edit")}`}
                </Box>
              </Typography>
            </Box>
            <EditOutlined aria-hidden sx={{ flexShrink: 0, fontSize: 16, color: mutedText(theme) }} />
          </ButtonBase>
        );
      })}
    </Stack>
  );

  return (
    <Box
      component="form"
      noValidate
      aria-label={t("assistant_ask_label")}
      onSubmit={submit}
      onKeyDown={keyDown}
      onKeyUp={() => {
        arrowKey.current = false;
      }}
      sx={{
        animation: slides && !stillMotion ? `${slideUp} 180ms ease-out` : "none",
        display: "flex",
        flexDirection: "column",
        border: "1.5px solid",
        borderColor: alpha(theme.palette.primary.main, 0.6),
        borderRadius: CARD_RADIUS,
        bgcolor: "background.paper",
        boxShadow: surfaceShadows(theme).rest,
        overflow: "hidden",
        // The transcript above keeps the larger part of the dock; the docked and the
        // full-screen dock are about as tall as the window.
        maxHeight: "45vh",
      }}>
      {tabRow}
      <Box
        ref={body}
        role={tabbed ? "tabpanel" : undefined}
        id={`${id}-panel`}
        aria-labelledby={tabbed ? `${id}-tab${tab}` : undefined}
        // A long question scrolls here, between the tabs and the actions.
        sx={{ px: "12px", pt: "12px", pb: "10px", overflowY: "auto", flex: "1 1 auto", minHeight: 0 }}>
        {review ? (
          reviewList
        ) : (
          <QuestionField
            key={tab}
            question={card.questions[tab]}
            choice={choices[tab]}
            onChange={change(tab)}
            onOptionClick={tabbed ? () => picked() : undefined}
            shortcuts
            // The tab shows the header already.
            header={!tabbed}
            disabled={false}
            name={`${id}-q${tab}`}
          />
        )}
      </Box>
      <Stack
        direction="row"
        alignItems="center"
        flexWrap="wrap"
        gap="8px"
        sx={{ mx: "12px", pt: "10px", pb: "12px", borderTop: 1, borderColor: "divider" }}>
        <Button
          type="button"
          variant="outlined"
          color="inherit"
          size="small"
          onClick={onReplyInText}
          sx={{ ...neutralPillSx(theme), ...focusRing(theme) }}>
          {t("assistant_ask_reply_in_text")}
        </Button>
        <Stack direction="row" gap="8px" sx={{ ml: "auto" }}>
          {onStop && <StopButton onStop={onStop} neutral />}
          {tabbed && (
            // Hidden on the first question, keeping its room: Next stays where it is.
            <Button
              type="button"
              variant="outlined"
              color="inherit"
              size="small"
              disabled={tab === 0}
              onClick={back}
              sx={{ ...neutralPillSx(theme), visibility: tab === 0 ? "hidden" : undefined }}>
              {t("assistant_ask_back")}
            </Button>
          )}
          {/* Keyed apart: a Next that turned into a submit button in its own click would send. */}
          {tabbed && !review ? (
            <Button key="next" type="button" variant="contained" size="small" onClick={next} sx={sendSx}>
              {t("assistant_ask_next")}
            </Button>
          ) : (
            <Button key="send" type="submit" variant="contained" size="small" disabled={!canSend} sx={sendSx}>
              {t("assistant_ask_send")}
            </Button>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
