"use client";

import { Box, ButtonBase, Stack, Typography, alpha, useTheme } from "@mui/material";
import { type FocusEvent, type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { answerItem, answerParts, emptyChoice } from "@/lib/assistant/ask";
import type { AskAnswer, AskCardData } from "@/lib/assistant/types";

import { AnsweredQuestion, PassedQuestion, QuestionField } from "@/components/assistant/messages/AskQuestion";
import { CARD_RADIUS, accentText, focusRing, mutedText } from "@/components/assistant/styles";

export interface AskCardProps {
  card: AskCardData;
  /** The later user message's answer to this card: the card shows it. */
  answer: AskAnswer | null;
  /** A later user message did not answer the card: it can no longer be sent. */
  superseded: boolean;
  /**
   * A line holds the card's place: the panel at the dock's foot asks its
   * questions, or the running answer is still sending it (its ask step has not returned).
   */
  waiting: boolean;
  /** The composer holds the open card: its questions show here, for a reply typed to them. */
  held?: boolean;
  /** Shows the panel that asks the card (it takes the focus, or opens in the composer's place). */
  onShow?: () => void;
}

/**
 * "Waiting for your answer" and the questions' headers; a button that shows
 * the panel when the card can be answered there.
 */
function WaitingLine({ headers, onShow }: { headers: string[]; onShow?: () => void }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const content = (
    <>
      <Icon iconName={ICON_NAME.COMMENT} style={{ fontSize: 12, color: accentText(theme) }} />
      <Typography
        component="span"
        sx={{ minWidth: 0, fontSize: 12.5, lineHeight: 1.45, overflowWrap: "anywhere" }}>
        <Box component="span" sx={{ fontWeight: 600, color: accentText(theme) }}>
          {t("assistant_ask_waiting")}
        </Box>{" "}
        <Box component="span" sx={{ color: mutedText(theme) }}>{`· ${headers.join(", ")}`}</Box>
      </Typography>
    </>
  );
  const sx = { display: "flex", alignItems: "center", gap: "8px", textAlign: "left" } as const;
  return onShow ? (
    <ButtonBase
      type="button"
      onClick={onShow}
      sx={{ ...sx, justifyContent: "flex-start", borderRadius: "6px", ...focusRing(theme) }}>
      {content}
    </ButtonBase>
  ) : (
    <Box sx={sx}>{content}</Box>
  );
}

/**
 * Where the assistant's questions (contract "The ask card") stand in the
 * transcript. While the panel in the composer's place asks them, a line here
 * holds their place (it lists the headers, and moves the focus into the
 * panel); once answered, the card shows the chosen labels and free
 * text, live and after a reload alike. Passed over by a typed reply, it shows
 * its questions with what they offered, muted, and nothing to pick. Otherwise
 * the card shows its questions, disabled: while the composer holds the open
 * card (to read what a typed reply answers), its ask step not returned in a
 * stored answer, or in a read-only conversation.
 */
export default function AskCard({
  card,
  answer,
  superseded,
  waiting: placeHeld,
  held = false,
  onShow,
}: AskCardProps) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const id = useId();
  const waiting = placeHeld && !answer && !superseded;
  /** Its questions are shown and still asked, without Send. */
  const asks = !answer && !superseded && !waiting;
  /** The card holds the focus: Send in the panel hands it over, so it does not fall back to the page. */
  const [focused, setFocused] = useState(false);
  const focus = (event: FocusEvent<HTMLFormElement>) => {
    if (event.target === event.currentTarget) setFocused(true);
  };
  const blur = (event: FocusEvent<HTMLFormElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  const headers = card.questions.map((question) => question.header);
  let body: ReactNode;
  if (answer) {
    body = card.questions.map((question, index) => (
      <AnsweredQuestion
        key={index}
        question={question}
        parts={answerParts(question, answerItem(answer, index))}
      />
    ));
  } else if (waiting) {
    body = <WaitingLine headers={headers} onShow={onShow} />;
  } else if (superseded) {
    body = card.questions.map((question, index) => <PassedQuestion key={index} question={question} />);
  } else {
    body = [
      ...card.questions.map((question, index) => (
        <QuestionField
          key={index}
          question={question}
          choice={emptyChoice()}
          onChange={() => undefined}
          disabled
          name={`${id}-q${index}`}
        />
      )),
      // Held by the composer: the way to the panel, under the questions the reply answers.
      held && <WaitingLine key="waiting" headers={headers} onShow={onShow} />,
    ];
  }
  const notAnswered = superseded && !answer;
  const footer = notAnswered || !!answer;

  return (
    <Box
      component="form"
      noValidate
      data-ask-card={card.card_id}
      onFocus={focus}
      onBlur={blur}
      // Focusable from script only: Send in the panel hands it the focus.
      tabIndex={-1}
      // Named, and so a form landmark, while it shows questions it still asks; the line of an
      // open card and an answered or passed over card are transcript text. The focus keeps the
      // name, so the focused element has one.
      aria-label={asks || focused ? t("assistant_ask_label") : undefined}
      sx={{
        border: 1,
        borderStyle: waiting ? "dashed" : "solid",
        borderColor: waiting ? alpha(theme.palette.primary.main, 0.5) : "divider",
        borderRadius: CARD_RADIUS,
        bgcolor: "background.paper",
        overflow: "hidden",
      }}>
      <Stack
        gap="18px"
        sx={waiting ? { px: "12px", py: "9px" } : { px: "12px", pt: "12px", pb: footer ? "10px" : "12px" }}>
        {body}
      </Stack>
      <Box
        sx={
          footer ? { mx: "12px", pt: "10px", pb: "12px", borderTop: 1, borderColor: "divider" } : undefined
        }>
        {notAnswered && (
          <Typography sx={{ fontSize: 12, color: mutedText }}>{t("assistant_ask_not_answered")}</Typography>
        )}
        {/* One status for the card's whole life, empty until it is answered: a screen reader
            announces "Answered" when it comes in, also with the focus on the card after Send. */}
        <Stack direction="row" alignItems="center" gap="6px" role="status" sx={{ color: "primary.main" }}>
          {answer && (
            <>
              <Icon iconName={ICON_NAME.CHECK} style={{ fontSize: 10, color: "inherit" }} />
              <Typography sx={{ fontSize: 12, fontWeight: 600, color: "inherit" }}>
                {t("assistant_ask_answered")}
              </Typography>
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
