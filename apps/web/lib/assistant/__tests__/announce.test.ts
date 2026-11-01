import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HIDDEN_TAB_DELAY_MS, announceRunEnd, runEndOf } from "@/lib/assistant/announce";
import { getDockState, resetAssistantStore, setDockState } from "@/lib/assistant/store";

const { claimMock, toastMock } = vi.hoisted(() => ({
  claimMock: vi.fn(),
  toastMock: { info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/utils/jobAnnouncement", () => ({ claimJobAnnouncement: claimMock }));
vi.mock("react-toastify", () => ({ toast: toastMock }));

const t = (key: string) => key;
const end = (status: "succeeded" | "failed" | "cancelled" | "interrupted" = "succeeded") => ({
  conversationId: "c1",
  messageId: "a1",
  title: "Radwege",
  status,
});

const setVisibility = (value: "visible" | "hidden") =>
  Object.defineProperty(document, "visibilityState", { value, configurable: true });

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  vi.clearAllMocks();
  claimMock.mockResolvedValue(true);
  setVisibility("visible");
});
afterEach(() => vi.useRealTimers());

describe("announceRunEnd", () => {
  it("toasts once when the conversation is not on screen, and opens it on click", async () => {
    await announceRunEnd(end(), t);
    expect(claimMock).toHaveBeenCalledWith("assistant:a1");
    expect(toastMock.info).toHaveBeenCalledWith(
      "assistant_toast_answer_ready",
      expect.objectContaining({ onClick: expect.any(Function) })
    );
    (toastMock.info.mock.calls[0][1] as { onClick: () => void }).onClick();
    expect(getDockState()).toMatchObject({ open: true, conversationId: "c1" });
  });

  it("passes the title to the translation as a value, never as markup", async () => {
    const translate = vi.fn((key: string) => key);
    await announceRunEnd({ ...end(), title: "A & <b>B</b>" }, translate);
    expect(translate).toHaveBeenCalledWith("assistant_toast_answer_ready", { title: "A & <b>B</b>" });
  });

  it("claims without a toast where the conversation is showing", async () => {
    setDockState({ enabled: true, open: true, conversationId: "c1" });
    await announceRunEnd(end(), t);
    expect(claimMock).toHaveBeenCalled();
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it("stays quiet in the tabs that did not win the claim", async () => {
    claimMock.mockResolvedValueOnce(false);
    await announceRunEnd(end(), t);
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("shows nothing for a run that was stopped, even when claimed", async () => {
    await announceRunEnd(end("cancelled"), t);
    expect(claimMock).toHaveBeenCalled();
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("warns when the answer failed", async () => {
    await announceRunEnd(end("failed"), t);
    expect(toastMock.warning).toHaveBeenCalledWith(
      "assistant_toast_answer_failed",
      expect.objectContaining({ onClick: expect.any(Function) })
    );
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it("lets a visible tab claim first by waiting in a hidden one", async () => {
    vi.useFakeTimers();
    setVisibility("hidden");
    const pending = announceRunEnd(end(), t);
    await vi.advanceTimersByTimeAsync(HIDDEN_TAB_DELAY_MS - 1);
    expect(claimMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(claimMock).toHaveBeenCalled();
  });

  it("reads how a run ended from its message", () => {
    expect(runEndOf({ id: "a", role: "assistant", parts: [{ type: "text", text: "ok" }] })).toBe("succeeded");
    expect(
      runEndOf({
        id: "a",
        role: "assistant",
        parts: [{ type: "data-run-status", data: { status: "failed", error: null, code: null } }],
      })
    ).toBe("failed");
  });
});
