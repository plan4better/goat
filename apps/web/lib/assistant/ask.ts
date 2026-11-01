import { z } from "zod";

import type {
  AskAnswer,
  AskAnswerItem,
  AskCardData,
  AskQuestion,
  AssistantMessage,
} from "@/lib/assistant/types";

/**
 * The ask card (contract "The ask card"): reading the `data-ask` part, the
 * choices a person makes in it, and the answer the next message carries.
 */

const optionSchema = z.object({
  label: z.string().min(1),
  description: z.string().nullish(),
  recommended: z.boolean().nullish(),
});
const questionSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1),
  multi_select: z.boolean().nullish(),
  options: z.array(optionSchema).min(1),
});
const cardSchema = z.object({
  card_id: z.string().min(1),
  questions: z.array(questionSchema).min(1),
});

/** The card a `data-ask` part carries, or null for one the dock cannot show (it then shows nothing). */
export function askCardOf(data: unknown): AskCardData | null {
  const parsed = cardSchema.safeParse(data);
  if (!parsed.success) return null;
  return {
    card_id: parsed.data.card_id,
    questions: parsed.data.questions.map((question) => ({
      question: question.question,
      header: question.header,
      multi_select: question.multi_select === true,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description ?? "",
        recommended: option.recommended === true,
      })),
    })),
  };
}

/**
 * The option indexes in the order the card shows them: the recommended option
 * first, the others in the part's order. The indexes stay those of the part's
 * `options`, because the answer names options by them. The server already
 * lists the recommended option first, so its cards keep their order.
 */
export function displayOrder(question: AskQuestion): number[] {
  const indexes = question.options.map((_option, index) => index);
  return [
    ...indexes.filter((index) => question.options[index].recommended),
    ...indexes.filter((index) => !question.options[index].recommended),
  ];
}

/** What one question holds while the card is filled in. */
export interface Choice {
  options: number[];
  /** "Other" is picked; its text counts only then. */
  other: boolean;
  text: string;
}

export const emptyChoice = (): Choice => ({ options: [], other: false, text: "" });

/** Ticks or unticks option `index`. A single choice question keeps only that option and drops "Other". */
export function chooseOption(choice: Choice, index: number, multi: boolean, checked: boolean): Choice {
  if (!multi) return { ...choice, options: [index], other: false };
  const options = checked
    ? [...new Set([...choice.options, index])]
    : choice.options.filter((picked) => picked !== index);
  return { ...choice, options: options.sort((a, b) => a - b) };
}

/** Ticks or unticks "Other". On a single choice question it replaces the option picked. */
export function chooseOther(choice: Choice, multi: boolean, checked: boolean): Choice {
  return multi ? { ...choice, other: checked } : { ...choice, options: [], other: true };
}

/** Typing in the "Other" field picks "Other" (on a single choice question in place of an option). */
export function typeOther(choice: Choice, multi: boolean, text: string): Choice {
  return multi ? { ...choice, other: true, text } : { options: [], other: true, text };
}

/** The answer to the card: one entry per question, in order (contract). */
export function toAnswer(cardId: string, choices: Choice[]): AskAnswer {
  return {
    card_id: cardId,
    answers: choices.map((choice, question) => {
      const other = choice.other ? choice.text.trim() : "";
      return { question, options: [...choice.options], other: other || null };
    }),
  };
}

/** The entry names an option or a free text. */
export const isAnswered = (item: AskAnswerItem): boolean => item.options.length > 0 || item.other !== null;

/** At least one question has an option or a free text: Send has something to send. */
export const hasAnswer = (answer: AskAnswer): boolean => answer.answers.some(isAnswered);

/** The entry of question `index` in an answer, if it has one. */
export function answerItem(answer: AskAnswer, index: number): AskAnswerItem | undefined {
  return Array.isArray(answer.answers) ? answer.answers.find((item) => item.question === index) : undefined;
}

/** The labels an entry picked, then its free text: what the answered card and the message text list. */
export function answerParts(question: AskQuestion, item: AskAnswerItem | undefined): string[] {
  if (!item) return [];
  const labels = (Array.isArray(item.options) ? item.options : [])
    .map((index) => question.options[index]?.label)
    .filter((label): label is string => !!label);
  return item.other ? [...labels, item.other] : labels;
}

/**
 * The text of the answer message (contract): "<header>: <labels and other>"
 * per answered question, joined with ". "; a question left empty is skipped.
 */
export function answerText(card: AskCardData, answer: AskAnswer): string {
  return card.questions
    .map((question, index) => {
      const parts = answerParts(question, answerItem(answer, index));
      return parts.length ? `${question.header}: ${parts.join(", ")}` : null;
    })
    .filter((line): line is string => line !== null)
    .join(". ");
}

/** The tool that shows a card (contract "Tool wire names"). */
const ASK_TOOL = "ask_user";

/**
 * Whether the `ask_user` step of `message` returned the card: the server
 * records a card from that step's result, which names its `card_id`, and
 * refuses an answer to a card it did not record. The card goes out while the
 * step runs, so a run stopped in between leaves a card that cannot be answered.
 */
export const askStepReturned = (message: AssistantMessage, cardId: string): boolean =>
  message.parts.some(
    (part) =>
      part.type === "dynamic-tool" &&
      part.toolName === ASK_TOOL &&
      part.state === "output-available" &&
      typeof part.output === "object" &&
      part.output !== null &&
      (part.output as { card_id?: unknown }).card_id === cardId
  );

/** The answer a user message carries to this card, if it does. */
const answerIn = (message: AssistantMessage, cardId: string): AskAnswer | null =>
  message.role === "user" && message.metadata?.answer?.card_id === cardId ? message.metadata.answer : null;

/** Whether a user message of `messages` answers the card (another tab may have sent it). */
export const answersCard = (messages: AssistantMessage[], cardId: string): boolean =>
  messages.some((message) => answerIn(message, cardId) !== null);

export interface AskCardState {
  /** The later user message's answer: the card shows it and sends nothing more. */
  answer: AskAnswer | null;
  /** A later user message did not answer the card (a typed reply): it stays unanswered and inactive. */
  superseded: boolean;
}

/** How the card shown in `messages[index]` stands, from the user messages after it. */
export function askCardState(messages: AssistantMessage[], index: number, cardId: string): AskCardState {
  let later = false;
  for (let position = index + 1; position < messages.length; position += 1) {
    const message = messages[position];
    if (message.role !== "user") continue;
    later = true;
    const answer = answerIn(message, cardId);
    if (answer) return { answer, superseded: false };
  }
  return { answer: null, superseded: later };
}

/**
 * The card the dock asks with at its foot, in the composer's place: the newest
 * card no user message followed (so neither answered nor passed over) whose
 * ask step returned, since only that one can be answered. Null when there is none.
 */
export function openAskCard(messages: AssistantMessage[]): AskCardData | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // Every card before a user message is answered or passed over.
    if (message.role === "user") return null;
    if (message.role !== "assistant") continue;
    for (let position = message.parts.length - 1; position >= 0; position -= 1) {
      const part = message.parts[position];
      if (part.type !== "data-ask") continue;
      const card = askCardOf(part.data);
      if (card && askStepReturned(message, card.card_id)) return card;
    }
  }
  return null;
}
