import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import FeedbackButtons from "@/components/assistant/messages/FeedbackButtons";

const { saveFeedback } = vi.hoisted(() => ({ saveFeedback: vi.fn() }));

vi.mock("@/lib/assistant/transport", () => ({ saveFeedback }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

beforeEach(() => {
  saveFeedback.mockReset();
  saveFeedback.mockResolvedValue({});
});

const up = () => screen.getByRole("button", { name: "assistant_feedback_good" });
const down = () => screen.getByRole("button", { name: "assistant_feedback_bad" });

describe("feedback buttons", () => {
  it("rates an answer up and removes the rating on a second click", async () => {
    render(<FeedbackButtons conversationId="c1" messageId="m1" />);
    fireEvent.click(up());
    expect(saveFeedback).toHaveBeenLastCalledWith("c1", "m1", "up", null);
    expect(up().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(up());
    expect(saveFeedback).toHaveBeenLastCalledWith("c1", "m1", null, null);
    expect(up().getAttribute("aria-pressed")).toBe("false");
  });

  it("asks for an optional comment after thumbs down and sends it", async () => {
    render(<FeedbackButtons conversationId="c1" messageId="m1" />);
    fireEvent.click(down());
    expect(saveFeedback).toHaveBeenLastCalledWith("c1", "m1", "down", null);
    const field = await screen.findByRole("textbox", { name: "assistant_feedback_comment_title" });
    fireEvent.change(field, { target: { value: "  Die MVV-Haltestellen fehlen.  " } });
    fireEvent.click(screen.getByRole("button", { name: "assistant_feedback_send" }));
    expect(saveFeedback).toHaveBeenLastCalledWith("c1", "m1", "down", "Die MVV-Haltestellen fehlen.");
  });

  it("shows the stored rating and goes back to it when saving fails", async () => {
    saveFeedback.mockRejectedValue(new Error("offline"));
    render(<FeedbackButtons conversationId="c1" messageId="m1" initial={{ rating: "up", comment: null }} />);
    expect(up().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(down());
    // The comment popover is open now and hides the page from role queries.
    const hidden = (name: string) => screen.getByRole("button", { name, hidden: true });
    await waitFor(() => expect(hidden("assistant_feedback_good").getAttribute("aria-pressed")).toBe("true"));
    expect(hidden("assistant_feedback_bad").getAttribute("aria-pressed")).toBe("false");
  });
});
