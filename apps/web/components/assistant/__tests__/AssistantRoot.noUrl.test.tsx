import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDockState, resetAssistantStore, setDockState } from "@/lib/assistant/store";

import AskAiButton from "@/components/assistant/AskAiButton";
import AssistantRoot from "@/components/assistant/AssistantRoot";

const { fetcherMock, loadedModules } = vi.hoisted(() => ({
  fetcherMock: vi.fn(async () => ({})),
  loadedModules: [] as string[],
}));

// No assistant service configured (NEXT_PUBLIC_ASSISTANT_URL unset).
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ASSISTANT_BASE_URL: undefined,
}));
vi.mock("@/lib/api/fetcher", () => ({ fetcher: fetcherMock }));
vi.mock("next/navigation", () => ({ usePathname: () => "/home", useRouter: () => ({ push: vi.fn() }) }));
// A module factory runs when the module is imported: the dock must not be.
vi.mock("@/components/assistant/AssistantDock", () => {
  loadedModules.push("AssistantDock");
  return { default: () => <div data-testid="dock" /> };
});
vi.mock("@/components/assistant/RunWatcher", () => {
  loadedModules.push("RunWatcher");
  return { default: () => <div data-testid="run-watcher" /> };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  fetcherMock.mockClear();
});

describe("AssistantRoot without an assistant service", () => {
  it("makes no request and shows neither the dock nor the button", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setDockState({ open: true });
    render(
      <AssistantRoot>
        <AskAiButton />
      </AssistantRoot>
    );
    // Let SWR run whatever it would have scheduled.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("dock")).toBeNull();
    expect(screen.queryByTestId("run-watcher")).toBeNull();
    expect(screen.queryByRole("button", { name: "assistant_ask_ai" })).toBeNull();
    expect(getDockState().enabled).toBe(false);
    expect(fetcherMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // The root layout carries AssistantRoot on every page; the dock loads only where it can show.
    expect(loadedModules).toEqual([]);
    fetchSpy.mockRestore();
  });
});
