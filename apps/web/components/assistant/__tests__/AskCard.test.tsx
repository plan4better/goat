import { createTheme } from "@mui/material/styles";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AskAnswer, AskCardData } from "@/lib/assistant/types";

import AskCard, { type AskCardProps } from "@/components/assistant/messages/AskCard";

vi.mock("react-i18next", async () => {
  const { commonT } = await import("@/i18n/__tests__/commonI18n");
  const t = commonT("en");
  return { useTranslation: () => ({ t, i18n: { language: "en" } }) };
});

/**
 * A card as the assistant asks it for "15 minute workflow in Munich". The server
 * sends a question's recommended option first; Mode lists it second here, so
 * the card's own ordering (`displayOrder`) is checked defensively. The panel at
 * the dock's foot asks it (AskPanel.test.tsx); the transcript holds its place.
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
        { label: "Pharmacies", description: "", recommended: false },
      ],
    },
    {
      question: "How do people get there?",
      header: "Mode",
      multi_select: false,
      options: [
        { label: "Walking", description: "At walking speed", recommended: false },
        { label: "Cycling", description: "At cycling speed", recommended: true },
      ],
    },
  ],
};

const hexToRgb = (hex: string) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

const renderCard = (props: Partial<AskCardProps> = {}) =>
  render(<AskCard card={CARD} answer={null} superseded={false} waiting={false} {...props} />);
const ANSWER: AskAnswer = {
  card_id: "ask-call-7",
  answers: [
    { question: 0, options: [0, 2], other: "Bakeries" },
    { question: 1, options: [], other: null },
  ],
};

describe("AskCard in the transcript", () => {
  it("holds the place of a card the panel at the dock's foot asks with a line, no fields", () => {
    renderCard({ waiting: true });
    expect(screen.getByText("Waiting for your answer")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    // Not a form landmark: it holds no fields.
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("lists the question headers in the waiting line, a button that shows the panel", () => {
    const onShow = vi.fn();
    renderCard({ waiting: true, onShow });
    const line = screen.getByRole("button", { name: "Waiting for your answer · Destinations, Mode" });
    fireEvent.click(line);
    expect(onShow).toHaveBeenCalledTimes(1);
    // Still on its way (no panel to show yet): the line only.
    cleanup();
    renderCard({ waiting: true });
    expect(screen.getByText("· Destinations, Mode")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the questions of a card the composer holds, with the line that opens the panel at their foot", async () => {
    const onShow = vi.fn();
    renderCard({ held: true, onShow });
    await expect(screen.getByRole("radio", { name: "Walking" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Waiting for your answer · Destinations, Mode" }));
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("shows the answer of a later message, with no fields and no Send", () => {
    renderCard({ answer: ANSWER, waiting: false });
    // The picked options and the own answer, each in a row of its own as the panel showed them.
    for (const text of ["Supermarkets", "Pharmacies", "Bakeries"])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText("Schools")).toBeNull();
    expect(screen.getByText("No answer")).toBeTruthy();
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.queryByText("Waiting for your answer")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
  });

  it("marks an answered card in the theme's primary colour, GOAT's green", () => {
    renderCard({ answer: ANSWER, waiting: false });
    const { r, g, b } = hexToRgb(createTheme().palette.primary.main);
    expect(getComputedStyle(screen.getByRole("status")).color).toBe(`rgb(${r}, ${g}, ${b})`);
  });

  it("says it was answered in a status that is there while it waits, and keeps the focused card named", async () => {
    const { container, rerender } = renderCard({ waiting: true });
    // A status present from the first render: a screen reader announces the text put into it.
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    // Send in the panel hands the card the focus.
    const card = container.querySelector('[data-ask-card="ask-call-7"]') as HTMLElement;
    act(() => card.focus());
    rerender(<AskCard card={CARD} answer={ANSWER} superseded={false} waiting={false} />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("Answered");
    // It keeps its name while it holds the focus.
    const form = screen.getByRole("form", { name: "Questions from the assistant" });
    expect(form).toBe(card);
    await expect(form).toHaveFocus();
    // Once the focus moves on, the answered card is transcript text.
    act(() => form.blur());
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("shows its questions without Send once a typed reply passed it over, or where it is not open", async () => {
    renderCard({ superseded: true });
    expect(screen.getByText("Not answered")).toBeTruthy();
    await expect(screen.getByRole("radio", { name: "Walking" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
    cleanup();

    // A read-only conversation, or a card its ask step did not return.
    renderCard();
    await expect(screen.getByRole("checkbox", { name: "Schools" })).toBeDisabled();
    const radios = within(
      screen.getByRole("radiogroup", { name: "Mode How do people get there?" })
    ).getAllByRole("radio");
    const names = ["Cycling Recommended", "Walking", "Type your own answer"];
    for (const [place, radio] of radios.entries()) await expect(radio).toHaveAccessibleName(names[place]);
    // No numbers in the transcript: nothing picks there.
    expect(screen.queryByText(/^\d$/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
    expect(screen.queryByText("Waiting for your answer")).toBeNull();
  });

  it("mutes the rows of questions it shows without asking", () => {
    renderCard();
    const label = screen.getByRole("radio", { name: "Walking" }).closest("label") as HTMLElement;
    expect(getComputedStyle(label).opacity).toBe("0.6");
  });

  it("is a form landmark only while it shows questions it still asks", () => {
    // A read-only conversation still shows the questions, disabled.
    renderCard();
    expect(screen.getByRole("form", { name: "Questions from the assistant" })).toBeTruthy();
    cleanup();

    renderCard({ waiting: true });
    expect(screen.queryByRole("form")).toBeNull();
    cleanup();

    renderCard({
      answer: {
        card_id: "ask-call-7",
        answers: [
          { question: 0, options: [0], other: null },
          { question: 1, options: [1], other: null },
        ],
      },
    });
    expect(screen.queryByRole("form")).toBeNull();
    cleanup();

    renderCard({ superseded: true });
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("wraps long unbroken text in its questions, options and descriptions", () => {
    const long = "x".repeat(120);
    const card: AskCardData = {
      card_id: "ask-call-8",
      questions: [
        {
          question: `${long}?`,
          header: "Layer",
          multi_select: false,
          options: [
            { label: `label${long}`, description: `description${long}`, recommended: false },
            { label: "Leave it open", description: "", recommended: false },
          ],
        },
      ],
    };
    renderCard({ card });
    const wrap = (text: string) => getComputedStyle(screen.getByText(text)).overflowWrap;
    expect([`${long}?`, `label${long}`, `description${long}`].map(wrap)).toEqual([
      "anywhere",
      "anywhere",
      "anywhere",
    ]);
  });
});
