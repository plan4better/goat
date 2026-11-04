import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteConversation,
  listConversations,
  updateConversation,
  warmConversations,
} from "@/lib/assistant/conversations";

vi.mock("@/lib/api/fetcher", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  fetcher: vi.fn(),
  apiRequestAuth: vi.fn(),
}));
vi.mock("@/lib/constants", () => ({ ASSISTANT_BASE_URL: "http://assistant.test" }));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("conversation requests", () => {
  it("lists one project's conversations or all, with the search", async () => {
    await listConversations({ projectId: "p1", q: " rad " });
    await listConversations({});
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://assistant.test/conversations?project_id=p1&q=rad&limit=100",
      "http://assistant.test/conversations?limit=100",
    ]);
  });

  it("reads the full history ahead, or one project's conversations", async () => {
    warmConversations();
    warmConversations("p1");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://assistant.test/conversations?limit=100",
      "http://assistant.test/conversations?project_id=p1&limit=100",
    ]);
  });

  it("renames, binds and deletes", async () => {
    // A new Response per call: a body can be read once.
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    await updateConversation("c1", { title: "Radwege" });
    await updateConversation("c1", { project_id: "p1" });
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    await deleteConversation("c1");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method, init.body ?? null])).toEqual([
      ["http://assistant.test/conversations/c1", "PATCH", JSON.stringify({ title: "Radwege" })],
      ["http://assistant.test/conversations/c1", "PATCH", JSON.stringify({ project_id: "p1" })],
      ["http://assistant.test/conversations/c1", "DELETE", null],
    ]);
    expect(new Headers(calls[0][1].headers).get("Content-Type")).toBe("application/json");
  });
});
