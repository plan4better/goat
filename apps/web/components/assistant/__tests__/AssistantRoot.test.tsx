import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDockState, registerSurface, resetAssistantStore, setDockState } from "@/lib/assistant/store";

import AskAiButton from "@/components/assistant/AskAiButton";
import AssistantRoot from "@/components/assistant/AssistantRoot";
import { resetDockLoader } from "@/components/assistant/dockLoader";

const { statusMock, pathnameMock } = vi.hoisted(() => ({ statusMock: vi.fn(), pathnameMock: vi.fn() }));

vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ASSISTANT_BASE_URL: "http://assistant.test",
}));
vi.mock("@/lib/api/assistant", () => ({
  useAssistantStatus: statusMock,
  AssistantApiError: class extends Error {},
}));
// The signed-in user the dock state is claimed for; the real hook would fetch the profile.
vi.mock("@/lib/api/users", () => ({ useUserProfile: () => ({ userProfile: { id: "user-1" } }) }));
vi.mock("next/navigation", () => ({ usePathname: pathnameMock, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/assistant/AssistantDock", () => ({
  default: ({ variant }: { variant: string }) => <div data-testid="dock" data-variant={variant} />,
}));
vi.mock("@/components/assistant/RunWatcher", () => ({ default: () => <div data-testid="run-watcher" /> }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

/** Lets a lazily loaded dock land, so an absent one is really absent. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const available = {
  available: true,
  reason: null,
  is_admin: false,
  provider: "test",
  model: "test",
  data_policy: "standard",
};

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  resetAssistantStore();
  resetDockLoader();
  pathnameMock.mockReturnValue("/home");
  statusMock.mockReturnValue({ status: available, isLoading: false, isError: undefined });
});

describe("AssistantRoot", () => {
  it("docks the panel beside the page when AI is available and the dock is open", async () => {
    setDockState({ open: true });
    render(
      <AssistantRoot>
        <p>page</p>
      </AssistantRoot>
    );
    expect(screen.getByText("page")).toBeTruthy();
    // Loaded on demand (dockLoader): it lands a tick after the first render.
    expect((await screen.findByTestId("dock")).getAttribute("data-variant")).toBe("docked");
    expect(getDockState().enabled).toBe(true);
  });

  it("makes the page column, not the window, the box the page's floating controls sit in", async () => {
    // Map controls and the attribution are absolutely positioned against their nearest
    // positioned ancestor: that must be the column the docked dock shrinks.
    setDockState({ open: true });
    render(
      <AssistantRoot>
        <p>page</p>
      </AssistantRoot>
    );
    const dock = await screen.findByTestId("dock");
    const column = screen.getByText("page").parentElement as HTMLElement;
    expect(getComputedStyle(column).position).toBe("relative");
    expect(getComputedStyle(column).minWidth).toBe("0px");
    // The dock sits beside that column, not inside it.
    expect(column.contains(dock)).toBe(false);
    expect(column.parentElement?.contains(dock)).toBe(true);
  });

  it("watches background runs only while AI is available", async () => {
    const { unmount } = render(<AssistantRoot>page</AssistantRoot>);
    expect(await screen.findByTestId("run-watcher")).toBeTruthy();
    unmount();
    statusMock.mockReturnValue({
      status: { ...available, available: false },
      isLoading: false,
      isError: undefined,
    });
    render(<AssistantRoot>page</AssistantRoot>);
    await settle();
    expect(screen.queryByTestId("run-watcher")).toBeNull();
  });

  it("expands to the full-screen variant", async () => {
    setDockState({ open: true, expanded: true });
    render(<AssistantRoot>page</AssistantRoot>);
    expect((await screen.findByTestId("dock")).getAttribute("data-variant")).toBe("fullscreen");
  });

  it("hides the dock and the button when AI is off for the organization", async () => {
    statusMock.mockReturnValue({
      status: { ...available, available: false, reason: "disabled" },
      isLoading: false,
    });
    setDockState({ open: true });
    render(
      <AssistantRoot>
        <AskAiButton />
      </AssistantRoot>
    );
    await settle();
    expect(screen.queryByTestId("dock")).toBeNull();
    expect(screen.queryByRole("button", { name: "assistant_ask_ai" })).toBeNull();
    expect(getDockState().enabled).toBe(false);
  });

  it("hides the dock on a surface that is switched off", async () => {
    statusMock.mockReturnValue({
      status: { ...available, disabled_surfaces: ["catalog"] },
      isLoading: false,
    });
    registerSurface({ surface: "catalog", getContext: () => ({ surface: "catalog" }) });
    setDockState({ open: true });
    render(<AssistantRoot>page</AssistantRoot>);
    await settle();
    expect(screen.queryByTestId("dock")).toBeNull();
  });

  it("leaves pages outside the app alone", () => {
    pathnameMock.mockReturnValue("/map/public/p1");
    setDockState({ open: true });
    const { container } = render(
      <AssistantRoot>
        <p>public</p>
      </AssistantRoot>
    );
    expect(container.innerHTML).toBe("<p>public</p>");
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("toggles the dock from the Ask AI button", () => {
    render(
      <AssistantRoot>
        <AskAiButton />
      </AssistantRoot>
    );
    screen.getByRole("button", { name: "assistant_ask_ai" }).click();
    expect(getDockState().open).toBe(true);
  });

  it("switches the dock off when the page leaves the app", () => {
    const { rerender } = render(<AssistantRoot>page</AssistantRoot>);
    expect(getDockState().enabled).toBe(true);
    pathnameMock.mockReturnValue("/map/public/p1");
    rerender(<AssistantRoot>page</AssistantRoot>);
    expect(getDockState().enabled).toBe(false);
  });

  it("toggles the dock from the compact Ask AI button of the project header", () => {
    render(
      <AssistantRoot>
        <AskAiButton compact />
      </AssistantRoot>
    );
    const button = screen.getByRole("button", { name: "assistant_ask_ai" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    act(() => button.click());
    expect(getDockState().open).toBe(true);
    expect(screen.getByRole("button", { name: "assistant_ask_ai" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
  });

  it("keeps one button variant when the dock opens, so the header does not shift", () => {
    render(
      <AssistantRoot>
        <AskAiButton />
      </AssistantRoot>
    );
    const before = screen.getByRole("button", { name: "assistant_ask_ai" });
    expect(before.className).toContain("MuiButton-text");
    act(() => before.click());
    const after = screen.getByRole("button", { name: "assistant_ask_ai" });
    expect(after.getAttribute("aria-pressed")).toBe("true");
    expect(after.className).toContain("MuiButton-text");
    expect(after.className).not.toContain("MuiButton-outlined");
  });
});
