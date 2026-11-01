import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import { useAssistantConnections, useAssistantSettings, useAssistantStatus } from "@/lib/api/assistant";
import { useConversations } from "@/lib/assistant/conversations";

/** Every request the assistant's hooks make, by path. */
const { requests } = vi.hoisted(() => ({ requests: [] as string[] }));
const answer = (url: string) => {
  const path = new URL(url).pathname;
  requests.push(path);
  if (path === "/status") return { available: true, goat_ai: true, is_admin: false };
  return [];
};
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  ASSISTANT_BASE_URL: "http://assistant.test",
}));
vi.mock("@/lib/api/fetcher", () => ({
  fetcher: vi.fn(async (key: string | [string]) => answer(Array.isArray(key) ? key[0] : key)),
  getAccessToken: vi.fn(),
  apiRequestAuth: vi.fn(),
}));
vi.mock("@/lib/assistant/http", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assistantFetch: vi.fn(async (path: string) => answer(`http://assistant.test${path}`)),
}));

// A cache of its own, with SWR's focus handling and its focus throttle as they ship.
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const count = (path: string) => requests.filter((request) => request === path).length;

describe("the assistant's status", () => {
  it("is read again when the tab gets the focus back, and nothing else of the assistant is", async () => {
    const { result } = renderHook(
      () => ({
        status: useAssistantStatus().status,
        settings: useAssistantSettings().settings,
        connections: useAssistantConnections().connections,
        conversations: useConversations({}).conversations,
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.status).toBeDefined());
    await waitFor(() => expect(requests).toHaveLength(4));
    const first = result.current.status;
    // Past the dedupe of the first read.
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 10)));

    // A dock in another tab learns that an admin switched to an own connection.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(count("/status")).toBe(2));
    // Throttled: focus right after focus reads nothing again.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 10)));
    expect(count("/status")).toBe(2);
    expect([count("/settings"), count("/connections"), count("/conversations")]).toEqual([1, 1, 1]);
    // The same status: its readers do not render again.
    expect(result.current.status).toBe(first);
  });
});
