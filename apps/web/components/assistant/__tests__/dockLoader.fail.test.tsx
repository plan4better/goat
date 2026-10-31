import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDockState, resetAssistantStore, setDockState } from "@/lib/assistant/store";

import AssistantRoot from "@/components/assistant/AssistantRoot";
import { resetDockLoader } from "@/components/assistant/dockLoader";

const { statusMock, dockLoads, reloadMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  dockLoads: { count: 0, failing: 0 },
  reloadMock: vi.fn(),
}));

vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ASSISTANT_BASE_URL: "http://assistant.test",
}));
vi.mock("@/lib/api/assistant", () => ({
  useAssistantStatus: statusMock,
  AssistantApiError: class extends Error {},
}));
vi.mock("@/lib/api/users", () => ({ useUserProfile: () => ({ userProfile: { id: "user-1" } }) }));
vi.mock("@/lib/assistant/conversations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  warmConversations: vi.fn(),
}));
vi.mock("@/lib/utils/reloadPage", () => ({ reloadPage: reloadMock }));
vi.mock("next/navigation", () => ({ usePathname: () => "/home", useRouter: () => ({ push: vi.fn() }) }));
// The next `failing` loads fail, as a chunk does offline or after a deploy; then one works.
vi.mock("@/components/assistant/AssistantDock", () => {
  dockLoads.count += 1;
  if (dockLoads.failing > 0) {
    dockLoads.failing -= 1;
    throw new Error("Failed to load chunk");
  }
  return { default: () => <div data-testid="dock" /> };
});
vi.mock("@/components/assistant/RunWatcher", () => ({ default: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  dockLoads.count = 0;
  window.sessionStorage.clear();
  resetAssistantStore();
  resetDockLoader();
  statusMock.mockReturnValue({
    status: { available: true, reason: null, is_admin: false, provider: "test", model: "test" },
    isLoading: false,
  });
});

describe("the dock's code failing to load", () => {
  // First: a module that loaded once stays loaded for the rest of the file.
  it("offers a reload after a second failure in a row", async () => {
    dockLoads.failing = 2;
    render(<AssistantRoot>page</AssistantRoot>);
    act(() => setDockState({ open: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("assistant_load_failed");
    // The docked frame is busy only while it loads.
    expect(
      screen.getByRole("complementary", { name: "assistant_ask_ai" }).getAttribute("aria-busy")
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "assistant_retry" }));
    expect(await screen.findByRole("button", { name: "assistant_reload_page" })).toBeTruthy();
    expect(dockLoads.count).toBe(2);
    expect(screen.queryByRole("button", { name: "assistant_retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "assistant_reload_page" }));
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("says so in the dock's frame and loads the dock on Try again", async () => {
    dockLoads.failing = 1;
    render(<AssistantRoot>page</AssistantRoot>);
    act(() => setDockState({ open: true }));
    expect(screen.getByRole("complementary", { name: "assistant_ask_ai" }).getAttribute("aria-busy")).toBe(
      "true"
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("assistant_load_failed");
    expect(dockLoads.count).toBe(1);
    // The frame stays closable.
    expect(screen.getByRole("button", { name: "close" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "assistant_retry" }));
    expect(await screen.findByTestId("dock")).toBeTruthy();
    expect(dockLoads.count).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getDockState().open).toBe(true);
  });
});
