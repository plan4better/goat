import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetAssistantStore } from "@/lib/assistant/store";
import type { AskCardData } from "@/lib/assistant/types";

import AskPanel, { type AskPanelProps } from "@/components/assistant/AskPanel";

vi.mock("react-i18next", async () => {
  const { commonT } = await import("@/i18n/__tests__/commonI18n");
  const t = commonT("en");
  return { useTranslation: () => ({ t, i18n: { language: "en" } }) };
});

/**
 * A card as the assistant asks it for "15 minute workflow in Munich". The server
 * sends a question's recommended option first; Mode lists it second here, so
 * the panel's own ordering (`displayOrder`) is checked defensively.
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
/** Three questions: a single choice question in the middle goes on to another question. */
const THREE: AskCardData = {
  card_id: "ask-call-8",
  questions: [
    ...CARD.questions,
    {
      question: "Should the workflow count the residents?",
      header: "Residents",
      multi_select: false,
      options: [
        { label: "Count them", description: "", recommended: true },
        { label: "Leave them out", description: "", recommended: false },
      ],
    },
  ],
};
/** One question: no tabs. */
const ONE: AskCardData = { card_id: "ask-call-9", questions: [CARD.questions[1]] };

const renderPanel = (props: Partial<AskPanelProps> = {}) => {
  const onSend = vi.fn();
  const onReplyInText = vi.fn();
  // `autoFocus`: the panel opened during the session (a card that came, or the way back to it).
  const view = render(
    <AskPanel card={CARD} busy={false} onSend={onSend} onReplyInText={onReplyInText} autoFocus {...props} />
  );
  return { onSend, onReplyInText, ...view };
};
const sendButton = () => screen.getByRole("button", { name: "Send answer" });
/** The last row of every question: a free text answer, its field open only while the row is picked. */
const OWN = "Type your own answer";
const HINT = "Type an answer, or this choice is not sent.";
const tab = (name: string | RegExp) => screen.getByRole("tab", { name });
const selectedTab = () =>
  screen.getAllByRole("tab").find((element) => element.getAttribute("aria-selected") === "true");
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));

// The choices of a card not sent yet live in the assistant store, by card id.
beforeEach(() => resetAssistantStore());

describe("AskPanel with one question", () => {
  it("offers Reply in text instead as the dock's outlined pill", () => {
    renderPanel({ card: ONE });
    const reply = screen.getByRole("button", { name: "Reply in text instead" });
    expect(reply.className).toContain("MuiButton-outlined");
    expect(getComputedStyle(reply).borderRadius).toBe("999px");
  });

  it("shows the options and Send answer at once, without tabs, Review, Back or Next", async () => {
    const { onSend } = renderPanel({ card: ONE });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    const mode = screen.getByRole("radiogroup", { name: "Mode How do people get there?" });
    // In the order shown, each with the number of its place before its label; Other has none.
    const radios = within(mode).getAllByRole("radio");
    const names = ["Cycling Recommended", "Walking", OWN];
    for (const [place, radio] of radios.entries()) {
      await expect(radio).toHaveAccessibleName(names[place]);
      const row = within(radio.closest("label") as HTMLElement);
      if (place < 2) expect(row.getByText(String(place + 1))).toBeTruthy();
      else expect(row.queryByText(/^\d$/)).toBeNull();
    }
    await expect(sendButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Walking" }));
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith(
      { card_id: "ask-call-9", answers: [{ question: 0, options: [0], other: null }] },
      "Mode: Walking"
    );
  });

  it("is a form named for the assistant's questions", () => {
    renderPanel({ card: ONE });
    expect(screen.getByRole("form", { name: "Questions from the assistant" })).toBeTruthy();
  });

  it("takes the focus on its first option when it opens", async () => {
    renderPanel({ card: ONE });
    await expect(screen.getByRole("radio", { name: "Cycling Recommended" })).toHaveFocus();
  });

  it("sends with Enter in the Other field", () => {
    const { onSend } = renderPanel({ card: ONE });
    fireEvent.click(screen.getByRole("radio", { name: OWN }));
    const field = screen.getByRole("textbox", { name: "Your own answer to Mode" });
    fireEvent.change(field, { target: { value: "By tram" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith(
      { card_id: "ask-call-9", answers: [{ question: 0, options: [], other: "By tram" }] },
      "Mode: By tram"
    );
  });

  it("sends nothing while an answer runs", async () => {
    const { onSend } = renderPanel({ card: ONE, busy: true });
    fireEvent.click(screen.getByRole("radio", { name: "Cycling Recommended" }));
    await expect(sendButton()).toBeDisabled();
    fireEvent.submit(sendButton().closest("form") as HTMLFormElement);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("counts Other without text as not picked", async () => {
    renderPanel({ card: ONE });
    fireEvent.click(screen.getByRole("radio", { name: OWN }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your own answer to Mode" }), {
      target: { value: "   " },
    });
    await expect(sendButton()).toBeDisabled();
  });
});

describe("AskPanel with several questions", () => {
  it("shows one question at a time under a row of tabs, one per header, and Review last", async () => {
    renderPanel();
    const tabs = within(screen.getByRole("tablist", { name: "Questions" })).getAllByRole("tab");
    expect(tabs.map((element) => element.textContent)).toEqual(["Destinations", "Mode", "Review"]);
    expect(tabs.map((element) => element.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    // Roving tabindex: only the selected tab is on the Tab key's path.
    expect(tabs.map((element) => element.tabIndex)).toEqual([0, -1, -1]);
    const panel = screen.getByRole("tabpanel", { name: "Destinations" });
    expect(tabs[0].getAttribute("aria-controls")).toBe(panel.id);
    // The tab names the question: no second header chip above it.
    expect(within(panel).getByRole("group", { name: "What should be within 15 minutes?" })).toBeTruthy();
    expect(within(panel).queryByText("Destinations")).toBeNull();
    await expect(
      within(panel).getByRole("checkbox", { name: "Supermarkets Recommended" })
    ).toHaveAccessibleDescription("OpenStreetMap supermarkets, added to the project");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    // No Back on the first question; it keeps its room, so Next does not move.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(getComputedStyle(screen.getByText("Back").closest("button") as HTMLElement).visibility).toBe(
      "hidden"
    );
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
  });

  it("goes through the questions with Next and Back", () => {
    renderPanel();
    next();
    expect(selectedTab()?.textContent).toBe("Mode");
    expect(screen.getByRole("radiogroup", { name: "How do people get there?" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: /within 15 minutes/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    next();
    expect(selectedTab()?.textContent).toBe("Review");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(sendButton()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(selectedTab()?.textContent).toBe("Destinations");
    // A tab opens its question as well.
    fireEvent.click(tab("Mode"));
    expect(selectedTab()?.textContent).toBe("Mode");
  });

  it("marks the tab of a question that has an answer", () => {
    renderPanel();
    expect(tab("Destinations")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Supermarkets Recommended" }));
    expect(tab("Destinations Answered")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Supermarkets Recommended" }));
    expect(tab("Destinations")).toBeTruthy();
    // Other without text is no answer.
    fireEvent.click(screen.getByRole("checkbox", { name: OWN }));
    expect(tab("Destinations")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Your own answer to Destinations" }), {
      target: { value: "Bakeries" },
    });
    expect(tab("Destinations Answered")).toBeTruthy();
    expect(tab("Mode")).toBeTruthy();
  });

  it("goes on to the next tab when a single choice option is picked, not on Other or a multiple choice", () => {
    renderPanel({ card: THREE });
    fireEvent.click(screen.getByRole("checkbox", { name: "Supermarkets Recommended" }));
    expect(selectedTab()?.textContent).toMatch(/^Destinations/);
    next();
    // Other waits for its text.
    fireEvent.click(screen.getByRole("radio", { name: OWN }));
    expect(selectedTab()?.textContent).toBe("Mode");
    fireEvent.click(screen.getByRole("radio", { name: "Walking" }));
    expect(selectedTab()?.textContent).toBe("Residents");
    fireEvent.click(screen.getByRole("radio", { name: "Leave them out" }));
    expect(selectedTab()?.textContent).toBe("Review");
  });

  it("lists every answer on Review, and sends them all at once", async () => {
    const { onSend } = renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "Supermarkets Recommended" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Pharmacies" }));
    fireEvent.click(screen.getByRole("checkbox", { name: OWN }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your own answer to Destinations" }), {
      target: { value: "Bakeries" },
    });
    next();
    next();
    const review = screen.getByRole("tabpanel", { name: "Review" });
    expect(within(review).getByText("Destinations")).toBeTruthy();
    expect(within(review).getByText("Supermarkets, Pharmacies, Bakeries")).toBeTruthy();
    expect(within(review).getByText("Mode")).toBeTruthy();
    expect(within(review).getByText("No answer")).toBeTruthy();
    await expect(sendButton()).toBeEnabled();
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(
      {
        card_id: "ask-call-7",
        answers: [
          { question: 0, options: [0, 2], other: "Bakeries" },
          { question: 1, options: [], other: null },
        ],
      },
      "Destinations: Supermarkets, Pharmacies, Bakeries"
    );
  });

  it("keeps Send off on Review while no question has an answer", async () => {
    const { onSend } = renderPanel();
    // Other without text counts as no answer.
    fireEvent.click(screen.getByRole("checkbox", { name: OWN }));
    fireEvent.click(tab("Review"));
    await expect(sendButton()).toBeDisabled();
    fireEvent.submit(sendButton().closest("form") as HTMLFormElement);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("takes the focus on its first tab when it opens", async () => {
    renderPanel();
    await expect(tab("Destinations")).toHaveFocus();
  });

  it("leaves the focus in a field the person types in when it opens", async () => {
    render(<input aria-label="Search the map" />);
    const field = screen.getByRole("textbox", { name: "Search the map" });
    act(() => field.focus());
    renderPanel();
    await expect(field).toHaveFocus();
    cleanup();

    render(<textarea aria-label="Notes" />);
    const notes = screen.getByRole("textbox", { name: "Notes" });
    act(() => notes.focus());
    renderPanel({ card: ONE });
    await expect(notes).toHaveFocus();
  });

  it("picks with the number keys on the current question, in the order shown", async () => {
    const user = userEvent.setup();
    const { onSend } = renderPanel({ card: THREE });
    await expect(tab("Destinations")).toHaveFocus();
    // A multiple choice question toggles.
    await user.keyboard("1");
    await expect(screen.getByRole("checkbox", { name: "Supermarkets Recommended" })).toBeChecked();
    await user.keyboard("3");
    await expect(screen.getByRole("checkbox", { name: "Pharmacies" })).toBeChecked();
    await user.keyboard("1");
    await expect(screen.getByRole("checkbox", { name: "Supermarkets Recommended" })).not.toBeChecked();
    // No option 4 on this question; a key with Ctrl is the browser's.
    await user.keyboard("4{Control>}2{/Control}");
    await expect(screen.getByRole("checkbox", { name: "Schools" })).not.toBeChecked();
    next();
    // Shown first: Cycling, the part's option 1. A single choice goes on to the next tab.
    await user.keyboard("1");
    expect(selectedTab()?.textContent).toBe("Residents");
    await expect(tab("Residents")).toHaveFocus();
    await user.keyboard("2");
    expect(selectedTab()?.textContent).toBe("Review");
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith(
      {
        card_id: "ask-call-8",
        answers: [
          { question: 0, options: [2], other: null },
          { question: 1, options: [1], other: null },
          { question: 2, options: [1], other: null },
        ],
      },
      "Destinations: Pharmacies. Mode: Cycling. Residents: Leave them out"
    );
  });

  it("types numbers in the Other field instead of picking", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("checkbox", { name: OWN }));
    await user.click(screen.getByRole("textbox", { name: "Your own answer to Destinations" }));
    await user.keyboard("2 bakeries");
    await expect(screen.getByRole("textbox", { name: "Your own answer to Destinations" })).toHaveValue(
      "2 bakeries"
    );
    await expect(screen.getByRole("checkbox", { name: "Schools" })).not.toBeChecked();
  });

  it("moves between the tabs with the arrow keys, Home and End", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.keyboard("{ArrowRight}");
    await expect(tab("Mode")).toHaveFocus();
    expect(selectedTab()?.textContent).toBe("Mode");
    expect(tab("Mode").tabIndex).toBe(0);
    expect(tab("Destinations").tabIndex).toBe(-1);
    await user.keyboard("{ArrowRight}{ArrowRight}");
    await expect(tab("Destinations")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    await expect(tab("Review")).toHaveFocus();
    expect(selectedTab()?.textContent).toBe("Review");
    await user.keyboard("{Home}");
    await expect(tab("Destinations")).toHaveFocus();
    await user.keyboard("{End}");
    await expect(tab("Review")).toHaveFocus();
  });

  it("takes Enter on a question's tab as Next, and on Review as Send", async () => {
    const user = userEvent.setup();
    const { onSend } = renderPanel();
    await user.keyboard("1{Enter}");
    await expect(tab("Mode")).toHaveFocus();
    await user.keyboard("{Enter}");
    await expect(tab("Review")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith(
      {
        card_id: "ask-call-7",
        answers: [
          { question: 0, options: [0], other: null },
          { question: 1, options: [], other: null },
        ],
      },
      "Destinations: Supermarkets"
    );
  });

  it("goes to the next question with Enter in the Other field", () => {
    const { onSend } = renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: OWN }));
    const field = screen.getByRole("textbox", { name: "Your own answer to Destinations" });
    fireEvent.change(field, { target: { value: "Bakeries" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(selectedTab()?.textContent).toBe("Mode");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("stays on the question while the arrow keys move through its options", async () => {
    const user = userEvent.setup();
    renderPanel();
    next();
    act(() => screen.getByRole("radio", { name: "Cycling Recommended" }).focus());
    await user.keyboard("{ArrowDown}");
    await expect(screen.getByRole("radio", { name: "Walking" })).toBeChecked();
    expect(selectedTab()?.textContent).toBe("Mode Answered");
    // Space picks the option the arrows reached, and goes on.
    await user.keyboard(" ");
    expect(selectedTab()?.textContent).toBe("Review");
    await expect(tab("Review")).toHaveFocus();
  });

  it("hands the card to the composer with Reply in text instead or Esc", async () => {
    const user = userEvent.setup();
    const outside = vi.fn();
    const onReplyInText = vi.fn();
    render(
      // The fullscreen dock is a dialog that closes on Esc: the panel keeps the key.
      <div onKeyDown={outside}>
        <AskPanel card={CARD} busy={false} onSend={vi.fn()} onReplyInText={onReplyInText} />
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply in text instead" }));
    expect(onReplyInText).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("checkbox", { name: OWN }));
    await user.click(screen.getByRole("textbox", { name: "Your own answer to Destinations" }));
    await user.keyboard("{Escape}");
    expect(onReplyInText).toHaveBeenCalledTimes(2);
    expect(outside).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
  });

  it("keeps its picks and free text when it mounts again", async () => {
    const first = renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pharmacies" }));
    fireEvent.click(screen.getByRole("checkbox", { name: OWN }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your own answer to Destinations" }), {
      target: { value: "Bakeries" },
    });
    next();
    fireEvent.click(screen.getByRole("radio", { name: "Walking" }));
    // Expanding or collapsing the dock mounts the panel again, on the tab it showed: Review.
    first.unmount();
    const { onSend } = renderPanel();
    expect(selectedTab()?.textContent).toBe("Review");
    await expect(tab("Review")).toHaveFocus();
    fireEvent.click(tab(/^Destinations/));
    await expect(screen.getByRole("checkbox", { name: "Pharmacies" })).toBeChecked();
    await expect(screen.getByRole("checkbox", { name: OWN })).toBeChecked();
    await expect(screen.getByRole("textbox", { name: "Your own answer to Destinations" })).toHaveValue(
      "Bakeries"
    );
    fireEvent.click(tab(/^Mode/));
    await expect(screen.getByRole("radio", { name: "Walking" })).toBeChecked();
    fireEvent.click(tab("Review"));
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith(
      {
        card_id: "ask-call-7",
        answers: [
          { question: 0, options: [2], other: "Bakeries" },
          { question: 1, options: [0], other: null },
        ],
      },
      "Destinations: Pharmacies, Bakeries. Mode: Walking"
    );
  });

  it("asks for a text under Other while Other is picked and its field is empty", async () => {
    renderPanel();
    expect(screen.queryByText(HINT)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: OWN }));
    const field = screen.getByRole("textbox", { name: "Your own answer to Destinations" });
    await expect(field).toHaveAccessibleDescription(HINT);
    fireEvent.change(field, { target: { value: "Bakeries" } });
    expect(screen.queryByText(HINT)).toBeNull();
    next();
    fireEvent.click(screen.getByRole("radio", { name: OWN }));
    await expect(
      screen.getByRole("textbox", { name: "Your own answer to Mode" })
    ).toHaveAccessibleDescription(HINT);
  });

  it("takes the focus only when it opens during the session", async () => {
    // Mounted again (a reload, expanding the dock): the focus stays where it was.
    renderPanel({ autoFocus: false });
    await expect(document.body).toHaveFocus();
    cleanup();
    renderPanel({ card: ONE, autoFocus: false });
    await expect(document.body).toHaveFocus();
  });

  it("shows the numbers that pick the options, outside their names", async () => {
    renderPanel();
    const boxes = screen.getAllByRole("checkbox");
    const names = ["Supermarkets Recommended", "Schools", "Pharmacies", OWN];
    for (const [place, box] of boxes.entries()) {
      await expect(box).toHaveAccessibleName(names[place]);
      const row = within(box.closest("label") as HTMLElement);
      if (place < 3) expect(row.getByText(String(place + 1))).toBeTruthy();
      else expect(row.queryByText(/^\d$/)).toBeNull();
    }
    expect(screen.getByText("1").getAttribute("aria-hidden")).toBe("true");
    await expect(screen.getByRole("checkbox", { name: "Supermarkets Recommended" })).toHaveAttribute(
      "aria-keyshortcuts",
      "1"
    );
  });

  it("keeps the header chip of a single question", () => {
    renderPanel({ card: ONE });
    expect(within(screen.getByRole("form")).getByText("Mode")).toBeTruthy();
  });

  it("shows Stop while an answer runs, as the composer does", () => {
    const onStop = vi.fn();
    renderPanel({ busy: true, onStop });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    cleanup();
    renderPanel();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("takes the free text instead of the picked option, and stays on the question while it is typed", async () => {
    const { onSend } = renderPanel();
    next();
    fireEvent.click(screen.getByRole("radio", { name: "Walking" }));
    expect(selectedTab()?.textContent).toBe("Review");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    // Picking the own answer row: it takes the option's place, and waits for its text.
    fireEvent.click(screen.getByRole("radio", { name: OWN }));
    await expect(screen.getByRole("radio", { name: "Walking" })).not.toBeChecked();
    expect(selectedTab()?.textContent).toBe("Mode");
    fireEvent.change(screen.getByRole("textbox", { name: "Your own answer to Mode" }), {
      target: { value: "By tram" },
    });
    await expect(screen.getByRole("radio", { name: OWN })).toBeChecked();
    expect(selectedTab()?.textContent).toBe("Mode Answered");
    fireEvent.click(tab("Review"));
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith(
      {
        card_id: "ask-call-7",
        answers: [
          { question: 0, options: [], other: null },
          { question: 1, options: [], other: "By tram" },
        ],
      },
      "Mode: By tram"
    );
  });

  it("keeps each description below its option's text, however the label wraps", async () => {
    const long = "Points of interest from OpenStreetMap, shops and services";
    const card: AskCardData = {
      card_id: "ask-call-10",
      questions: [
        {
          question: "Which layer holds the destinations?",
          header: "Layer",
          multi_select: false,
          options: [
            { label: long, description: "Added to the project", recommended: true },
            { label: `${long}, without a badge`, description: "Also added", recommended: false },
          ],
        },
      ],
    };
    renderPanel({ card });
    for (const [name, description] of [
      [`${long} Recommended`, "Added to the project"],
      [`${long}, without a badge`, "Also added"],
    ]) {
      const radio = screen.getByRole("radio", { name });
      await expect(radio).toHaveAccessibleDescription(description);
      const text = screen.getByText(description);
      // In the option's own column, under its text: it follows the text whatever wraps,
      // with no negative margin pulling it up into the label.
      expect(text.closest("label")).toBe(radio.closest("label"));
      expect(getComputedStyle(text).marginTop).not.toMatch(/^-/);
    }
    // The badge wraps with the label's text, never under the number in front of it.
    const label = screen.getByText(long);
    expect(label.parentElement?.contains(screen.getByText("Recommended"))).toBe(true);
    expect(label.parentElement?.contains(screen.getByText("1"))).toBe(false);
  });

  it("makes each option a whole row: the input hidden but focusable, the choice shown on the row", async () => {
    const user = userEvent.setup();
    renderPanel({ card: ONE, autoFocus: false });
    const walking = screen.getByRole("radio", { name: "Walking" });
    const row = walking.closest("label") as HTMLElement;
    // A row that asks is not muted.
    expect(getComputedStyle(row).opacity).not.toBe("0.6");
    // The native input stays for its role and the keyboard, out of sight.
    expect(getComputedStyle(walking).position).toBe("absolute");
    expect(getComputedStyle(walking).width).toBe("1px");
    // The whole row picks.
    const before = getComputedStyle(row.parentElement as HTMLElement).borderColor;
    fireEvent.click(row);
    await expect(walking).toBeChecked();
    expect(getComputedStyle(row.parentElement as HTMLElement).borderColor).not.toBe(before);
    expect(within(row).getByTestId("RadioButtonCheckedRoundedIcon")).toBeTruthy();
    expect(
      within(
        screen.getByRole("radio", { name: "Cycling Recommended" }).closest("label") as HTMLElement
      ).getByTestId("RadioButtonUncheckedRoundedIcon")
    ).toBeTruthy();
    // The input stays on the Tab key's path.
    await user.tab();
    expect((document.activeElement as HTMLElement).getAttribute("type")).toBe("radio");
  });

  it("rings a row while an input in it has the keyboard focus, a rule of the row's own", () => {
    renderPanel({ card: ONE, autoFocus: false });
    const frame = screen.getByRole("radio", { name: "Walking" }).closest("label")
      ?.parentElement as HTMLElement;
    // The browser decides (jsdom matches no :focus-visible): the rule must sit on the frame's class.
    const css = [...document.querySelectorAll("style")].map((style) => style.textContent).join("\n");
    const rule = [...frame.classList]
      .filter((name) => name.startsWith("css-"))
      .map((name) => new RegExp(`\\.${name}:has\\(input:focus-visible\\)\\{[^}]*outline:2px solid`))
      .some((pattern) => pattern.test(css));
    expect(rule).toBe(true);
  });

  it("shows a check at the right of a picked row of a multiple choice question", () => {
    renderPanel();
    const row = screen.getByRole("checkbox", { name: "Schools" }).closest("label") as HTMLElement;
    expect(within(row).getByTestId("CheckBoxOutlineBlankRoundedIcon")).toBeTruthy();
    fireEvent.click(row);
    expect(within(row).getByTestId("CheckBoxRoundedIcon")).toBeTruthy();
  });

  it("opens the own answer's field only while its row is picked, keeping the text", async () => {
    renderPanel();
    next();
    const names = within(screen.getByRole("radiogroup")).getAllByRole("radio");
    await expect(names.at(-1) as HTMLElement).toHaveAccessibleName(OWN);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: OWN }));
    const field = screen.getByRole("textbox", { name: "Your own answer to Mode" });
    await expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "By tram" } });
    // Another option closes it; picking the row again shows the text.
    fireEvent.click(tab(/^Mode/));
    fireEvent.click(screen.getByRole("radio", { name: "Walking" }));
    fireEvent.click(tab(/^Mode/));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: OWN }));
    await expect(screen.getByRole("textbox", { name: "Your own answer to Mode" })).toHaveValue("By tram");
  });

  it("opens and closes the own answer's field with its tick on a multiple choice question", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: OWN }));
    expect(screen.getByRole("textbox", { name: "Your own answer to Destinations" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: OWN }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("leaves the focus on the radios while the arrow keys reach the own answer", async () => {
    const user = userEvent.setup();
    renderPanel({ card: ONE, autoFocus: false });
    act(() => screen.getByRole("radio", { name: "Walking" }).focus());
    await user.keyboard("{ArrowDown}");
    await expect(screen.getByRole("radio", { name: OWN })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Your own answer to Mode" })).toBeTruthy();
    await expect(screen.getByRole("radio", { name: OWN })).toHaveFocus();
  });

  it("clamps a description to two lines, with more and less only when the text is cut", async () => {
    renderPanel({ card: ONE });
    const description = screen.getByText("At walking speed");
    expect(getComputedStyle(description).getPropertyValue("-webkit-line-clamp")).toBe("2");
    // Nothing measured as cut (jsdom lays nothing out): no toggle.
    expect(screen.queryByRole("button", { name: "more" })).toBeNull();
    cleanup();

    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 60 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 34 });
    try {
      renderPanel({ card: ONE });
      const [more] = screen.getAllByRole("button", { name: "more" });
      expect(more.getAttribute("aria-expanded")).toBe("false");
      // Below the row's label, in its frame: a label holds one control.
      expect(more.closest("label")).toBeNull();
      expect(more.parentElement?.contains(screen.getByRole("radio", { name: "Cycling Recommended" }))).toBe(
        true
      );
      fireEvent.click(more);
      const less = screen.getByRole("button", { name: "less" });
      expect(less.getAttribute("aria-expanded")).toBe("true");
      expect(
        getComputedStyle(screen.getByText("At cycling speed")).getPropertyValue("-webkit-line-clamp")
      ).not.toBe("2");
      // The toggle is not a pick.
      await expect(screen.getByRole("radio", { name: "Cycling Recommended" })).not.toBeChecked();
    } finally {
      for (const [name, descriptor] of [
        ["scrollHeight", scroll],
        ["clientHeight", client],
      ] as const) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });

  it("puts Recommended at the right end of the title line", () => {
    renderPanel({ card: ONE });
    const badge = screen.getByText("Recommended");
    expect(badge.parentElement?.contains(screen.getByText("Cycling"))).toBe(true);
    expect(getComputedStyle(badge).marginLeft).toBe("auto");
  });

  it("goes back to a question from its answer on Review", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "Schools" }));
    fireEvent.click(tab("Review"));
    await expect(screen.getByRole("button", { name: /^Destinations/ })).toHaveAccessibleName(
      /^Destinations\s*Schools, Edit$/
    );
    await expect(screen.getByRole("button", { name: /^Mode/ })).toHaveAccessibleName(
      /^Mode\s*No answer, Edit$/
    );
    fireEvent.click(screen.getByRole("button", { name: /Mode/ }));
    expect(selectedTab()?.textContent).toBe("Mode");
    await expect(tab("Mode")).toHaveFocus();
    fireEvent.click(tab("Review"));
    fireEvent.click(screen.getByRole("button", { name: /Destinations.*Schools/ }));
    expect(selectedTab()?.textContent).toBe("Destinations Answered");
  });

  it("slides up as it opens, and stays still where motion is reduced", () => {
    const { rerender, onSend, onReplyInText } = renderPanel();
    expect(getComputedStyle(screen.getByRole("form")).animation).toMatch(/180ms/);
    // The dock drops `autoFocus` once the panel took it: the slide under way goes on.
    rerender(<AskPanel card={CARD} busy={false} onSend={onSend} onReplyInText={onReplyInText} />);
    expect(getComputedStyle(screen.getByRole("form")).animation).toMatch(/180ms/);
    cleanup();
    // Mounted again (expanding or collapsing the dock): no slide.
    renderPanel({ autoFocus: false });
    expect(getComputedStyle(screen.getByRole("form")).animation).not.toMatch(/180ms/);
    cleanup();
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
        }) as unknown as MediaQueryList
    );
    try {
      renderPanel();
      expect(getComputedStyle(screen.getByRole("form")).animation).not.toMatch(/180ms/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("scrolls a long question inside itself, the panel kept under half the dock's height", () => {
    renderPanel();
    const body = getComputedStyle(screen.getByRole("tabpanel"));
    expect(body.overflowY).toBe("auto");
    expect(body.minHeight).toBe("0px");
    expect(getComputedStyle(screen.getByRole("form")).maxHeight).toBe("45vh");
  });
});
