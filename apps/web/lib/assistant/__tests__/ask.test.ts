import { describe, expect, it } from "vitest";

import {
  answerText,
  answersCard,
  askCardOf,
  askCardState,
  askStepReturned,
  chooseOption,
  chooseOther,
  displayOrder,
  emptyChoice,
  hasAnswer,
  openAskCard,
  toAnswer,
  typeOther,
} from "@/lib/assistant/ask";
import type { AskAnswer, AskCardData, AssistantMessage } from "@/lib/assistant/types";

/**
 * The contract's example card, with a second question. The server sends a
 * question's recommended option first; Mode lists it second here, so
 * `displayOrder` is checked defensively.
 */
const CARD: AskCardData = {
  card_id: "ask-call-7",
  questions: [
    {
      question: "What should be within 15 minutes?",
      header: "Destinations",
      multi_select: true,
      options: [
        {
          label: "Supermarkets",
          description: "OpenStreetMap supermarkets, added to the project",
          recommended: true,
        },
        { label: "Schools", description: "Schools in Munich, added to the project", recommended: false },
      ],
    },
    {
      question: "How do people get there?",
      header: "Mode",
      multi_select: false,
      options: [
        { label: "Walking", description: "", recommended: false },
        { label: "Cycling", description: "", recommended: true },
      ],
    },
  ],
};

describe("ask card part", () => {
  it("reads a card as the server sends it, filling in what it leaves out", () => {
    expect(
      askCardOf({
        card_id: "ask-1",
        questions: [
          {
            question: "Which layer holds the schools?",
            header: "Schools",
            options: [{ label: "Schools" }, { label: "Leave it open", description: "Build without it" }],
          },
        ],
      })
    ).toEqual({
      card_id: "ask-1",
      questions: [
        {
          question: "Which layer holds the schools?",
          header: "Schools",
          multi_select: false,
          options: [
            { label: "Schools", description: "", recommended: false },
            { label: "Leave it open", description: "Build without it", recommended: false },
          ],
        },
      ],
    });
  });

  it("refuses a part it cannot show", () => {
    const broken: unknown[] = [
      null,
      "card",
      {},
      { card_id: "ask-1", questions: [] },
      { card_id: "", questions: CARD.questions },
      { card_id: "ask-1", questions: [{ question: "Which?", header: "Layer", options: "Schools" }] },
    ];
    for (const data of broken) expect(askCardOf(data)).toBeNull();
  });
});

describe("ask card choices", () => {
  it("shows the recommended option first and keeps the part's indexes", () => {
    expect(displayOrder(CARD.questions[1])).toEqual([1, 0]);
    expect(displayOrder(CARD.questions[0])).toEqual([0, 1]);
  });

  it("keeps one option on a single choice question, where Other replaces it", () => {
    const walking = chooseOption(emptyChoice(), 0, false, true);
    expect(walking).toEqual({ options: [0], other: false, text: "" });
    expect(chooseOption(walking, 1, false, true).options).toEqual([1]);
    expect(chooseOther(walking, false, true)).toEqual({ options: [], other: true, text: "" });
    const typed = typeOther(walking, false, "By tram");
    expect(typed).toEqual({ options: [], other: true, text: "By tram" });
    expect(chooseOption(typed, 0, false, true)).toEqual({ options: [0], other: false, text: "By tram" });
  });

  it("ticks several options on a multiple choice question, next to Other", () => {
    const both = chooseOption(chooseOption(emptyChoice(), 1, true, true), 0, true, true);
    expect(both.options).toEqual([0, 1]);
    const typed = typeOther(both, true, "Bakeries");
    expect(typed).toEqual({ options: [0, 1], other: true, text: "Bakeries" });
    expect(chooseOption(typed, 1, true, false).options).toEqual([0]);
    expect(chooseOther(typed, true, false).other).toBe(false);
  });
});

describe("ask card answer", () => {
  it("has one entry per question, in order, and the contract's text", () => {
    const answer = toAnswer(CARD.card_id, [
      { options: [0, 1], other: false, text: "" },
      { options: [], other: true, text: "  e-scooter " },
    ]);
    expect(answer).toEqual({
      card_id: "ask-call-7",
      answers: [
        { question: 0, options: [0, 1], other: null },
        { question: 1, options: [], other: "e-scooter" },
      ],
    });
    expect(answerText(CARD, answer)).toBe("Destinations: Supermarkets, Schools. Mode: e-scooter");
  });

  it("skips a question left empty, and counts Other only when it is picked and filled", () => {
    const answer = toAnswer(CARD.card_id, [
      { options: [], other: false, text: "Bakeries" },
      { options: [1], other: false, text: "" },
    ]);
    expect(answer.answers[0]).toEqual({ question: 0, options: [], other: null });
    expect(answerText(CARD, answer)).toBe("Mode: Cycling");
    expect(hasAnswer(answer)).toBe(true);
    expect(hasAnswer(toAnswer(CARD.card_id, [emptyChoice(), { options: [], other: true, text: " " }]))).toBe(
      false
    );
  });
});

describe("ask card state", () => {
  const ANSWER: AskAnswer = {
    card_id: "ask-call-7",
    answers: [
      { question: 0, options: [1], other: null },
      { question: 1, options: [0], other: null },
    ],
  };
  const asked: AssistantMessage = {
    id: "a1",
    role: "assistant",
    parts: [{ type: "data-ask", id: "ask-call-7", data: CARD }],
  };
  const user = (id: string, answer?: AskAnswer): AssistantMessage => ({
    id,
    role: "user",
    parts: [{ type: "text", text: "Schools" }],
    ...(answer ? { metadata: { answer } } : {}),
  });

  it("is open while no user message follows it", () => {
    expect(askCardState([asked], 0, "ask-call-7")).toEqual({ answer: null, superseded: false });
  });

  it("is answered by a later user message that carries its card id", () => {
    expect(askCardState([asked, user("u2", ANSWER)], 0, "ask-call-7")).toEqual({
      answer: ANSWER,
      superseded: false,
    });
    expect(answersCard([asked, user("u2", ANSWER)], "ask-call-7")).toBe(true);
  });

  it("is passed over by a typed reply or another card's answer", () => {
    const other = { ...ANSWER, card_id: "ask-call-9" };
    expect(askCardState([asked, user("u2")], 0, "ask-call-7")).toEqual({ answer: null, superseded: true });
    expect(askCardState([asked, user("u2", other)], 0, "ask-call-7")).toEqual({
      answer: null,
      superseded: true,
    });
    expect(answersCard([asked, user("u2", other)], "ask-call-7")).toBe(false);
  });

  it("is known to the server only once its ask step in the same answer returned the card's id", () => {
    const step = (state: "input-available" | "output-available", output?: unknown) =>
      ({
        type: "dynamic-tool",
        toolName: "ask_user",
        toolCallId: "t1",
        state,
        input: {},
        ...(state === "output-available" ? { output } : {}),
      }) as AssistantMessage["parts"][number];
    const answer = (...parts: AssistantMessage["parts"]): AssistantMessage => ({
      ...asked,
      parts: [...parts, ...asked.parts],
    });
    expect(
      askStepReturned(
        answer(step("output-available", { card_id: "ask-call-7", status: "asked" })),
        "ask-call-7"
      )
    ).toBe(true);
    expect(askStepReturned(asked, "ask-call-7")).toBe(false);
    expect(askStepReturned(answer(step("input-available")), "ask-call-7")).toBe(false);
    expect(askStepReturned(answer(step("output-available", { card_id: "ask-call-9" })), "ask-call-7")).toBe(
      false
    );
    expect(askStepReturned(answer(step("output-available", "ask-call-7")), "ask-call-7")).toBe(false);
    const otherTool = {
      type: "dynamic-tool",
      toolName: "core_show_items",
      toolCallId: "t2",
      state: "output-available",
      input: {},
      output: { card_id: "ask-call-7" },
    } as AssistantMessage["parts"][number];
    expect(askStepReturned(answer(otherTool), "ask-call-7")).toBe(false);
  });

  it("counts only the messages after the card", () => {
    expect(askCardState([user("u0", ANSWER), asked], 1, "ask-call-7")).toEqual({
      answer: null,
      superseded: false,
    });
  });
});

describe("the open ask card", () => {
  const returned = (cardId: string, toolCallId = "t1") =>
    ({
      type: "dynamic-tool",
      toolName: "ask_user",
      toolCallId,
      state: "output-available",
      input: {},
      output: { card_id: cardId, status: "asked" },
    }) as AssistantMessage["parts"][number];
  const running = {
    type: "dynamic-tool",
    toolName: "ask_user",
    toolCallId: "t9",
    state: "input-available",
    input: {},
  } as AssistantMessage["parts"][number];
  const card = (cardId: string): AskCardData => ({ ...CARD, card_id: cardId });
  const answer = (id: string, ...parts: AssistantMessage["parts"]): AssistantMessage => ({
    id,
    role: "assistant",
    parts,
  });
  const ask = (cardId: string) =>
    ({ type: "data-ask", id: cardId, data: card(cardId) }) as AssistantMessage["parts"][number];
  const user = (id: string, answered?: string): AssistantMessage => ({
    id,
    role: "user",
    parts: [{ type: "text", text: "Schools" }],
    ...(answered ? { metadata: { answer: { card_id: answered, answers: [] } } } : {}),
  });

  it("is the newest card no user message followed, once its ask step returned", () => {
    expect(openAskCard([user("u1"), answer("a1", returned("ask-1"), ask("ask-1"))])).toEqual(card("ask-1"));
    // A later answer without a card leaves it open.
    expect(
      openAskCard([answer("a1", returned("ask-1"), ask("ask-1")), answer("a2", { type: "text", text: "x" })])
    ).toEqual(card("ask-1"));
  });

  it("is none once a user message followed, an answer or a typed reply", () => {
    const asked = answer("a1", returned("ask-1"), ask("ask-1"));
    expect(openAskCard([asked, user("u2", "ask-1")])).toBeNull();
    expect(openAskCard([asked, user("u2")])).toBeNull();
    expect(openAskCard([])).toBeNull();
  });

  it("is none for a card its ask step did not return, or one the dock cannot read", () => {
    expect(openAskCard([answer("a1", running, ask("ask-1"))])).toBeNull();
    expect(openAskCard([answer("a1", ask("ask-1"))])).toBeNull();
    expect(openAskCard([answer("a1", returned("ask-2"), ask("ask-1"))])).toBeNull();
    const broken = { type: "data-ask", id: "ask-x", data: { card_id: "ask-x", questions: "x" } };
    expect(
      openAskCard([answer("a1", returned("ask-x"), broken as AssistantMessage["parts"][number])])
    ).toBeNull();
  });

  it("is the last answerable one when an answer holds two cards", () => {
    const two = answer("a1", returned("ask-1"), ask("ask-1"), returned("ask-2", "t2"), ask("ask-2"));
    expect(openAskCard([two])?.card_id).toBe("ask-2");
    const lastNotReturned = answer("a1", returned("ask-1"), ask("ask-1"), running, ask("ask-2"));
    expect(openAskCard([lastNotReturned])?.card_id).toBe("ask-1");
  });
});
