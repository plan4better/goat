"use client";

import { Box, Stack, Typography } from "@mui/material";
import type { DynamicToolUIPart, TextUIPart } from "ai";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { GOATLogoIconOnlyGreen } from "@p4b/ui/assets/svg/GOATLogoIconOnlyGreen";

import { type AskCardState, askCardOf, askCardState, askStepReturned } from "@/lib/assistant/ask";
import { contextChips, plainTranslate } from "@/lib/assistant/chips";
import { CREATE_WORKFLOW_TOOLS, SHOW_TOOLS, itemKey, shownGroups, uniqueGroups } from "@/lib/assistant/items";
import { messageTime } from "@/lib/assistant/messageTimes";
import { stepNames, stepRunning } from "@/lib/assistant/stepLabels";
import type { AnswerFeedback, AssistantMessage, PageContext } from "@/lib/assistant/types";
import { answerEdits } from "@/lib/assistant/workflowEdits";

import AnswerDetails from "@/components/assistant/messages/AnswerDetails";
import AskCard from "@/components/assistant/messages/AskCard";
import CaveatNote from "@/components/assistant/messages/CaveatNote";
import ContextChips from "@/components/assistant/messages/ContextChips";
import CopyAnswer from "@/components/assistant/messages/CopyAnswer";
import FeedbackButtons from "@/components/assistant/messages/FeedbackButtons";
import MessageTime from "@/components/assistant/messages/MessageTime";
import ProposalCard from "@/components/assistant/messages/ProposalCard";
import ResultCards from "@/components/assistant/messages/ResultCards";
import RunStatusNote from "@/components/assistant/messages/RunStatusNote";
import SafeMarkdown from "@/components/assistant/messages/SafeMarkdown";
import StepGroup from "@/components/assistant/messages/StepGroup";
import UndoAnswer from "@/components/assistant/messages/UndoAnswer";
import WorkflowRunNote from "@/components/assistant/messages/WorkflowRunNote";
import { accentSoft, shimmerSx } from "@/components/assistant/styles";

export interface MessageListProps {
  messages: AssistantMessage[];
  busy: boolean;
  conversationId: string;
  conversationProjectId: string | null;
  projectName: string | null;
  readOnly: boolean;
  /** The user's ratings, by answer id (from the loaded conversation). */
  feedback?: Record<string, AnswerFeedback>;
  /**
   * The ask card the panel at the dock's foot asks: its place here shows a
   * line. Null or absent: no panel (an open card the composer holds shows its questions here).
   */
  panelAskId?: string | null;
  /** The open ask card the composer holds: its questions show here, with the line that opens the panel. */
  heldAskId?: string | null;
  /** The waiting line of the open card: shows its panel (focus into it, or open it in the composer's place). */
  onShowAsk?: (cardId: string) => void;
}

const lastProposalId = (messages: AssistantMessage[]): string | null => {
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const parts = messages[m].parts;
    for (let p = parts.length - 1; p >= 0; p -= 1) {
      const part = parts[p];
      if (part.type === "data-proposal") return part.id ?? `${messages[m].id}:${p}`;
    }
  }
  return null;
};

/** The space between messages; a question's time sits in the space below it. */
const MESSAGE_GAP = "20px";

/** The tools that create a workflow: each one an answer created gets its card, not only the last. */
const CREATES: ReadonlySet<string> = new Set<string>(CREATE_WORKFLOW_TOOLS);

/**
 * The project the answer at `index` read when a call named none: the one of
 * the page its question was sent from (the question's context).
 */
const openProjectOf = (messages: AssistantMessage[], index: number): string | null => {
  const question = messages.findLast((message, at) => at < index && message.role === "user");
  const context = question?.parts.find((part) => part.type === "data-context")?.data as
    | PageContext
    | undefined;
  return context && "project_id" in context ? context.project_id : null;
};

function UserMessage({
  message,
  projectName,
  time,
}: {
  message: AssistantMessage;
  projectName: string | null;
  time: number | null;
}) {
  const { t } = useTranslation("common");
  const text = message.parts
    .filter((part): part is TextUIPart => part.type === "text")
    .map((part) => part.text)
    .join("");
  const context = message.parts.find((part) => part.type === "data-context")?.data as PageContext | undefined;
  const chips = contextChips(context ?? null, projectName ?? undefined, plainTranslate(t));
  return (
    <Stack
      gap="6px"
      alignItems="flex-end"
      sx={{
        position: "relative",
        // The time shows on hover or keyboard focus of the message, and always without a
        // hover (touch), as the answers' actions do.
        "& .message-time": { opacity: 0, transition: "opacity 120ms" },
        "&:hover .message-time, &:focus-within .message-time": { opacity: 1 },
        "@media (hover: none)": { "& .message-time": { opacity: 1 } },
      }}>
      <Box
        sx={(theme) => ({
          maxWidth: "85%",
          px: "14px",
          py: "9px",
          borderRadius: "14px 14px 4px 14px",
          bgcolor: accentSoft(theme),
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        })}>
        {/* The colour goes on the text itself: the theme's body variants carry their own. */}
        <Typography sx={{ fontSize: 13.5, fontWeight: 400, lineHeight: 1.45, color: "text.primary" }}>
          {text}
        </Typography>
      </Box>
      {chips.length > 0 && (
        <Stack direction="row" flexWrap="wrap" gap="6px">
          <ContextChips chips={chips} />
        </Stack>
      )}
      {/* Out of the flow, in the gap below the message: it reserves no space. */}
      {time !== null && (
        <Box className="message-time" sx={{ position: "absolute", top: "100%", right: 0, mt: "2px" }}>
          <MessageTime time={time} />
        </Box>
      )}
    </Stack>
  );
}

/**
 * The answer is still coming. `quiet` while a step runs, whose line shimmers
 * instead: the line keeps its place and stays mounted, so the transcript does
 * not jump at every step and a screen reader does not announce it again.
 */
function AnsweringLine({ quiet = false }: { quiet?: boolean }) {
  const { t } = useTranslation("common");
  return (
    <Stack
      direction="row"
      gap="8px"
      alignItems="center"
      role="status"
      data-quiet={quiet || undefined}
      sx={{ opacity: quiet ? 0 : 1 }}>
      <GOATLogoIconOnlyGreen style={{ width: 14, height: 14 }} />
      <Typography sx={(theme) => ({ fontSize: 12.5, ...(quiet ? {} : shimmerSx(theme)) })}>
        {t("assistant_running")}
      </Typography>
    </Stack>
  );
}

function Answer({
  message,
  time,
  running,
  openProject,
  latest,
  newestProposal,
  conversationId,
  conversationProjectId,
  readOnly,
  feedback,
  askState,
  panelAskId,
  heldAskId,
  onShowAsk,
}: {
  message: AssistantMessage;
  /** When the answer was given, if known. */
  time: number | null;
  running: boolean;
  /** The project the answer's tools read when a call names none. */
  openProject: string | null;
  /** The newest answer of the conversation. */
  latest: boolean;
  newestProposal: string | null;
  conversationId: string;
  conversationProjectId: string | null;
  readOnly: boolean;
  feedback?: AnswerFeedback;
  /** How an ask card of this answer stands, from the user messages after it. */
  askState: (cardId: string) => AskCardState;
  panelAskId: string | null;
  heldAskId: string | null;
  onShowAsk?: (cardId: string) => void;
}) {
  const blocks: ReactNode[] = [];
  let tools: DynamicToolUIPart[] = [];
  // What the answer's steps named, for every group: a change names the workflow an earlier group read.
  const names = stepNames(
    message.parts.filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool")
  );
  // Only the answer's last list of each show tool becomes cards: a model that
  // names them more than once has refined what it points to. Every workflow
  // the answer created gets its card.
  const lastShown = SHOW_TOOLS.filter((name) => !CREATES.has(name))
    .map((name) =>
      message.parts.findLast(
        (part): part is DynamicToolUIPart =>
          part.type === "dynamic-tool" && part.toolName === name && shownGroups(part).length > 0
      )
    )
    .filter((part): part is DynamicToolUIPart => part !== undefined);
  const showsCards = (part: DynamicToolUIPart) => lastShown.includes(part) || CREATES.has(part.toolName);
  // The items the answer shows a card of (each result's first cards only): a workflow's card
  // opens it, its run's line need not.
  const carded = new Set(
    message.parts
      .filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool" && showsCards(part))
      .flatMap((part) => uniqueGroups(shownGroups(part)).flatMap((group) => group.items.map(itemKey)))
  );
  // Each item once in the answer: a repeated create, or a workflow that
  // core_show_items names again, draws no second card.
  const seen = new Set<string>();
  const flush = (key: string) => {
    if (!tools.length) return;
    const group = tools;
    tools = [];
    // The answer's last group is still receiving steps while the answer runs; any other part closed it.
    blocks.push(
      <StepGroup
        key={`steps-${key}`}
        steps={group}
        open={running && key === "end"}
        running={running}
        openProject={openProject}
        names={names}
      />
    );
    // In the answer's order, when it shows several kinds of cards.
    group.filter(showsCards).forEach((part) => {
      const groups = uniqueGroups(shownGroups(part), seen);
      if (groups.length) {
        blocks.push(<ResultCards key={`results-${key}-${part.toolCallId}`} groups={groups} />);
      }
    });
  };
  message.parts.forEach((part, index) => {
    if (part.type === "dynamic-tool") {
      tools.push(part);
      return;
    }
    if (part.type === "step-start") return;
    flush(String(index));
    if (part.type === "text") {
      blocks.push(<SafeMarkdown key={index}>{part.text}</SafeMarkdown>);
    } else if (part.type === "data-proposal") {
      const partId = part.id ?? `${message.id}:${index}`;
      blocks.push(
        <ProposalCard
          key={partId}
          proposal={part.data}
          partId={partId}
          conversationId={conversationId}
          conversationProjectId={conversationProjectId}
          readOnly={readOnly}
          isLatest={partId === newestProposal}
        />
      );
    } else if (part.type === "data-ask") {
      // A part the dock cannot read shows nothing; the rest of the answer stays.
      const card = askCardOf(part.data);
      if (card) {
        const state = askState(card.card_id);
        // Still coming: the running answer sent the card, its ask step has not returned. The line
        // shows at once, so the card does not change its shape when the panel takes it.
        const coming = running && !readOnly && !askStepReturned(message, card.card_id);
        const open = card.card_id === panelAskId || card.card_id === heldAskId;
        blocks.push(
          <AskCard
            key={card.card_id}
            card={card}
            answer={state.answer}
            superseded={state.superseded}
            waiting={card.card_id === panelAskId || coming}
            held={card.card_id === heldAskId}
            onShow={open && onShowAsk ? () => onShowAsk(card.card_id) : undefined}
          />
        );
      }
    } else if (part.type === "data-caveat") {
      blocks.push(<CaveatNote key={index} data={part.data} />);
    } else if (part.type === "data-run-status") {
      blocks.push(<RunStatusNote key={index} data={part.data} />);
    } else if (part.type === "data-workflow-run") {
      const card = itemKey({
        kind: "workflow",
        id: part.data.workflow_id,
        projectId: part.data.project_id,
        title: "",
      });
      blocks.push(
        <WorkflowRunNote key={part.id ?? index} data={part.data} live={running} open={!carded.has(card)} />
      );
    }
  });
  flush("end");
  const text = message.parts
    .filter((part): part is TextUIPart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  // A stopped or failed answer keeps Copy for what it said, but has no details to show.
  const ended = message.parts.some((part) => part.type === "data-run-status");
  // A step under way shimmers in its line or its group's summary: one shimmer at a time.
  const stepUnderWay =
    running && message.parts.some((part) => part.type === "dynamic-tool" && stepRunning(part));
  // An answer that saved workflow edits offers Undo, also when it then failed without a word.
  const runId = message.metadata?.run_id;
  const edits = answerEdits(message);
  const undoable = !running && !readOnly && !!runId && edits.length > 0;
  const actions = !running && (text.trim() || !ended || undoable);
  return (
    <Stack
      gap="14px"
      sx={{
        // The newest answer shows its actions; older ones on hover or keyboard focus, and
        // always without a hover (touch), so a long transcript is not full of icons.
        "& .answer-actions": { opacity: latest ? 1 : 0, transition: "opacity 120ms" },
        "&:hover .answer-actions, &:focus-within .answer-actions": { opacity: 1 },
        "@media (hover: none)": { "& .answer-actions": { opacity: 1 } },
      }}>
      {blocks}
      {/* Below whatever came so far, between steps (the model decides what to do next) and
          while text streams in; a step under way says what it does instead. */}
      {running && <AnsweringLine quiet={stepUnderWay} />}
      {actions && (
        // The 28px buttons sit 6px out, so their icons start where the answer's text does.
        <Stack
          className="answer-actions"
          direction="row"
          gap="4px"
          alignItems="center"
          sx={{ mt: "-8px", ml: "-6px" }}>
          {undoable && runId && (
            <UndoAnswer
              conversationId={conversationId}
              runId={runId}
              workflowIds={[...new Set(edits.map((edit) => edit.workflowId))]}
              undone={message.metadata?.undone}
            />
          )}
          <CopyAnswer text={text} />
          {!ended && <AnswerDetails usage={message.metadata?.usage} />}
          {!ended && (
            <FeedbackButtons conversationId={conversationId} messageId={message.id} initial={feedback} />
          )}
          {time !== null && <MessageTime time={time} />}
        </Stack>
      )}
    </Stack>
  );
}

/** The transcript: user messages with their context chips, answers part by part (spec §10). */
export default function MessageList(props: MessageListProps) {
  // The messages shown at mount: one of them without a stored time is not dated
  // (see `messageTime`); a later one arrived through the live stream.
  const [atMount] = useState(() => new Set(props.messages.map((message) => message.id)));
  const timeOf = (message: AssistantMessage, running: boolean): number | null =>
    messageTime(message, { mounted: atMount.has(message.id), running });
  /** The newest answer while the chat is busy: it is still being written. */
  const runs = (index: number) => props.busy && index === props.messages.length - 1;
  const newestProposal = lastProposalId(props.messages);
  const latestAnswer = props.messages.findLast((message) => message.role === "assistant")?.id;
  // A question's time reserves no space in the flow. Last in the list, with no
  // Answering line after it, the question keeps that space below it in the
  // list, so what follows the list (an alert) does not cover its time.
  const lastQuestion = !props.busy && props.messages.at(-1)?.role === "user";
  return (
    <Stack gap={MESSAGE_GAP} sx={lastQuestion ? { pb: MESSAGE_GAP } : undefined}>
      {props.messages.map((message, index) =>
        message.role === "user" ? (
          <UserMessage
            key={message.id}
            message={message}
            projectName={props.projectName}
            time={timeOf(message, false)}
          />
        ) : message.role === "assistant" ? (
          <Answer
            key={message.id}
            message={message}
            time={timeOf(message, runs(index))}
            running={runs(index)}
            openProject={openProjectOf(props.messages, index)}
            latest={message.id === latestAnswer}
            newestProposal={newestProposal}
            conversationId={props.conversationId}
            conversationProjectId={props.conversationProjectId}
            readOnly={props.readOnly}
            feedback={props.feedback?.[message.id]}
            askState={(cardId) => askCardState(props.messages, index, cardId)}
            panelAskId={props.panelAskId ?? null}
            heldAskId={props.heldAskId ?? null}
            onShowAsk={props.onShowAsk}
          />
        ) : null
      )}
      {/* Sent, and the answer has not started yet. */}
      {props.busy && props.messages.at(-1)?.role === "user" && <AnsweringLine />}
    </Stack>
  );
}
