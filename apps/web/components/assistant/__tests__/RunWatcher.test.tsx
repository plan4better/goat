import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantRequestError } from "@/lib/assistant/errors";
import { addPendingRun, getDockState, resetAssistantStore, setDockState } from "@/lib/assistant/store";

import RunWatcher from "@/components/assistant/RunWatcher";

const { fetchMock, announceMock, refreshMock, tMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  announceMock: vi.fn(),
  refreshMock: vi.fn(),
  tMock: vi.fn((key: string) => key),
}));
vi.mock("@/lib/assistant/transport", () => ({ fetchConversation: fetchMock }));
vi.mock("@/lib/assistant/conversations", () => ({ refreshConversationLists: refreshMock }));
vi.mock("@/lib/assistant/announce", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  announceRunEnd: announceMock,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: tMock }) }));

const detail = (activeRunId: string | null, title = "Radwege") => ({
  conversation: { id: "c1", project_id: null, origin_surface: "catalog", title },
  messages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "?" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] },
  ],
  activeRunId,
  access: "ok",
  projectName: null,
});

const pend = (since = Date.now()) =>
  act(() => addPendingRun({ conversationId: "c1", title: "Frage", since }));

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  resetAssistantStore();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("RunWatcher", () => {
  it("announces a run whose chat view was closed once it has ended", async () => {
    fetchMock.mockResolvedValueOnce(detail("run-1")).mockResolvedValueOnce(detail(null));
    pend();
    render(<RunWatcher />);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(announceMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(announceMock).toHaveBeenCalledWith(
      { conversationId: "c1", messageId: "a1", title: "Radwege", status: "succeeded" },
      expect.any(Function)
    );
    expect(getDockState().pending).toEqual([]);
    // No chat view ended the run, so the history marker is cleared here.
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("announces only an answer newer than the one known when the run was sent", async () => {
    // A send refused (or never received) after the dock closed: the previous answer is still the last.
    fetchMock.mockResolvedValue(detail(null));
    act(() =>
      addPendingRun({ conversationId: "c1", title: "Frage", since: Date.now(), knownAnswerId: "a1" })
    );
    render(<RunWatcher />);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(announceMock).not.toHaveBeenCalled();
    expect(getDockState().pending).toEqual([]);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("announces the new answer when one came after the known one", async () => {
    fetchMock.mockResolvedValue(detail(null));
    act(() =>
      addPendingRun({ conversationId: "c1", title: "Frage", since: Date.now(), knownAnswerId: "a0" })
    );
    render(<RunWatcher />);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(announceMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "a1" }),
      expect.any(Function)
    );
  });

  it("hands the announcement a translator that does not escape the title", async () => {
    fetchMock.mockResolvedValue(detail(null));
    pend();
    render(<RunWatcher />);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    const translate = announceMock.mock.calls[0][1] as (key: string, options?: object) => string;
    translate("assistant_toast_answer_ready", { title: "A & B" });
    expect(tMock).toHaveBeenCalledWith("assistant_toast_answer_ready", {
      title: "A & B",
      interpolation: { escapeValue: false },
    });
  });

  it("leaves a run to the chat view that shows it", async () => {
    act(() => {
      setDockState({ open: true, conversationId: "c1" });
      addPendingRun({ conversationId: "c1", title: "Frage", since: Date.now() });
    });
    render(<RunWatcher />);
    await act(() => vi.advanceTimersByTimeAsync(8000));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls nothing when no run is pending, and stops once the last one ended", async () => {
    fetchMock.mockResolvedValue(detail(null));
    render(<RunWatcher />);
    await act(() => vi.advanceTimersByTimeAsync(12000));
    expect(fetchMock).not.toHaveBeenCalled();
    pend();
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(12000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears its poll timer on unmount", async () => {
    fetchMock.mockResolvedValue(detail("run-1"));
    pend();
    const before = vi.getTimerCount();
    const { unmount } = render(<RunWatcher />);
    expect(vi.getTimerCount()).toBeGreaterThan(before);
    unmount();
    expect(vi.getTimerCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps polling after a failed request, without an unhandled rejection", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(detail(null));
    pend();
    render(<RunWatcher />);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(getDockState().pending).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(getDockState().pending).toEqual([]);
  });

  it("gives up on a run after 30 minutes", async () => {
    fetchMock.mockResolvedValue(detail("run-1"));
    pend(Date.now() - 30 * 60 * 1000 - 1);
    render(<RunWatcher />);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDockState().pending).toEqual([]);
    expect(announceMock).not.toHaveBeenCalled();
    // The history may still mark it as running.
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "conversation_not_found"],
    [403, "forbidden"],
  ])("stops watching a conversation the server answers %i for", async (status, code) => {
    fetchMock.mockRejectedValue(new AssistantRequestError(status, code));
    pend();
    render(<RunWatcher />);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(getDockState().pending).toEqual([]);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(12000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("keeps watching through other refusals (a restart answers 503)", async () => {
    fetchMock
      .mockRejectedValueOnce(new AssistantRequestError(503, "request_failed"))
      .mockResolvedValueOnce(detail(null));
    pend();
    render(<RunWatcher />);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(getDockState().pending).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(announceMock).toHaveBeenCalledTimes(1);
  });
});
