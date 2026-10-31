import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerSurface, resetAssistantStore, setDockState } from "@/lib/assistant/store";

import AskAiButton from "@/components/assistant/AskAiButton";
import AssistantRoot from "@/components/assistant/AssistantRoot";
import { loadAssistantDock, resetDockLoader } from "@/components/assistant/dockLoader";

const { statusMock, warmMock, loadedModules } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  warmMock: vi.fn(),
  loadedModules: [] as string[],
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
  warmConversations: warmMock,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/home", useRouter: () => ({ push: vi.fn() }) }));
// A module factory runs when the module is first imported: it records the dock's code being loaded.
vi.mock("@/components/assistant/AssistantDock", () => {
  loadedModules.push("AssistantDock");
  return {
    default: ({ variant, framed }: { variant: string; framed?: boolean }) => (
      <div data-testid="dock" data-variant={variant} data-framed={String(!!framed)} />
    ),
  };
});
vi.mock("@/components/assistant/RunWatcher", () => ({ default: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const available = {
  available: true,
  reason: null,
  is_admin: false,
  provider: "test",
  model: "test",
  data_policy: "standard",
};

/** The page's idle callbacks, run when a test says the page is idle. */
let idle: Array<() => void> = [];
const pageIdle = () =>
  act(async () => {
    idle.splice(0).forEach((callback) => callback());
    await loadAssistantDock();
  });

const page = () => (
  <AssistantRoot>
    <AskAiButton />
  </AssistantRoot>
);

const askAi = () => screen.getByRole("button", { name: "assistant_ask_ai" });

/** Media queries that all match (a window as narrow as a phone) or none. */
const mediaQueries = (matches: boolean) => (query: string) =>
  ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList;
const phone = () => {
  window.matchMedia = vi.fn(mediaQueries(true));
};
const { matchMedia } = window;

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  resetAssistantStore();
  resetDockLoader();
  idle = [];
  window.requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
    idle.push(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
    return idle.length;
  });
  window.cancelIdleCallback = vi.fn();
  window.matchMedia = vi.fn(mediaQueries(false));
  statusMock.mockReturnValue({ status: available, isLoading: false, isError: undefined });
});

afterEach(() => {
  window.matchMedia = matchMedia;
});

describe("the dock's prefetch", () => {
  it("loads the dock's code and the history once the page is idle, once", async () => {
    const { rerender } = render(page());
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(1);
    // Nothing before the page is idle.
    expect(loadedModules).toEqual([]);
    expect(warmMock).not.toHaveBeenCalled();
    await pageIdle();
    expect(loadedModules).toEqual(["AssistantDock"]);
    expect(warmMock).toHaveBeenCalledTimes(1);
    // Pointing at the button, focusing it, rendering again or AI coming back reads nothing again.
    fireEvent.pointerEnter(askAi());
    fireEvent.focus(askAi());
    rerender(page());
    statusMock.mockReturnValue({ status: { ...available, available: false }, isLoading: false });
    rerender(page());
    statusMock.mockReturnValue({ status: available, isLoading: false });
    rerender(page());
    await pageIdle();
    expect(warmMock).toHaveBeenCalledTimes(1);
  });

  it("reads the project's conversations ahead too on a project page, once", async () => {
    // The start page lists the project's latest conversations: they must not arrive after it.
    const project = (surface: "project.map" | "project.workflows") =>
      registerSurface({
        surface,
        project: { id: "p1", name: "Radnetz" },
        getContext: () => ({ surface, project_id: "p1" }),
      });
    project("project.map");
    render(page());
    await pageIdle();
    expect(warmMock.mock.calls).toEqual([[], ["p1"]]);
    fireEvent.pointerEnter(askAi());
    act(() => {
      project("project.workflows");
    });
    await pageIdle();
    expect(warmMock).toHaveBeenCalledTimes(2);
  });

  it("reads a project's conversations ahead once it registers after the page went idle", async () => {
    render(page());
    await pageIdle();
    expect(warmMock.mock.calls).toEqual([[]]);
    act(() => {
      registerSurface({
        surface: "project.map",
        project: { id: "p2", name: "Gehwege" },
        getContext: () => ({ surface: "project.map", project_id: "p2" }),
      });
    });
    await pageIdle();
    expect(warmMock.mock.calls).toEqual([[], ["p2"]]);
  });

  it("opens a prefetched dock at once, without its loading frame", async () => {
    render(page());
    await pageIdle();
    act(() => setDockState({ open: true }));
    const dock = screen.getByTestId("dock");
    expect(dock.getAttribute("data-framed")).toBe("false");
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("shows the dock's frame until its code is in, then the dock in its place", async () => {
    render(page());
    act(() => setDockState({ open: true }));
    expect(screen.queryByTestId("dock")).toBeNull();
    // The docked panel's frame: its resize handle and a close button.
    expect(screen.getByRole("separator", { name: "assistant_resize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "close" })).toBeTruthy();
    const dock = await screen.findByTestId("dock");
    expect(dock.getAttribute("data-framed")).toBe("true");
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("closes the dock from its loading frame", () => {
    render(page());
    act(() => setDockState({ open: true }));
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("prefetches nothing while AI is not available", async () => {
    statusMock.mockReturnValue({ status: { ...available, available: false }, isLoading: false });
    const { unmount } = render(page());
    await pageIdle();
    unmount();
    // Nor on a surface where it is switched off.
    statusMock.mockReturnValue({
      status: { ...available, disabled_surfaces: ["catalog"] },
      isLoading: false,
    });
    registerSurface({ surface: "catalog", getContext: () => ({ surface: "catalog" }) });
    render(page());
    await pageIdle();
    expect(window.requestIdleCallback).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "assistant_ask_ai" })).toBeNull();
    expect(warmMock).not.toHaveBeenCalled();
  });

  it("waits on a phone until the button is touched or focused", async () => {
    phone();
    render(page());
    expect(window.requestIdleCallback).not.toHaveBeenCalled();
    expect(warmMock).not.toHaveBeenCalled();
    fireEvent.pointerEnter(askAi());
    expect(warmMock).toHaveBeenCalledTimes(1);
    fireEvent.focus(askAi());
    expect(warmMock).toHaveBeenCalledTimes(1);
  });

  it("reads the history ahead on focus alone, from the keyboard", () => {
    phone();
    render(page());
    fireEvent.focus(askAi());
    expect(warmMock).toHaveBeenCalledTimes(1);
  });
});
