import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantRequestError } from "@/lib/assistant/errors";
import {
  cancelAssistantRun,
  createAssistantTransport,
  fetchConversation,
  lastUserMessage,
  undoAnswer,
} from "@/lib/assistant/transport";
import type { AssistantMessage } from "@/lib/assistant/types";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock("@/lib/api/fetcher", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  fetcher: vi.fn(),
  apiRequestAuth: vi.fn(),
}));
vi.mock("@/lib/constants", () => ({ ASSISTANT_BASE_URL: "http://assistant.test" }));
vi.mock("next-auth/react", () => ({ getSession: getSessionMock }));

const user = (id: string, text: string): AssistantMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
const answer = (id: string): AssistantMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: "ok" }],
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  getSessionMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const sent = () => {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
};

async function send(
  transport: ReturnType<typeof createAssistantTransport>,
  messages: AssistantMessage[],
  body?: object,
  trigger: "submit-message" | "regenerate-message" = "submit-message"
): Promise<unknown> {
  return transport
    .sendMessages({ trigger, chatId: "c1", messageId: undefined, messages, abortSignal: undefined, body })
    .catch((error: unknown) => error); // a 204 is not a stream; only the request matters here
}

describe("assistant transport", () => {
  it("posts the newest user message, the page context, the language and the refresh token", async () => {
    getSessionMock.mockResolvedValue({ refresh_token: "refresh-1" });
    const transport = createAssistantTransport("c1", { getLocale: () => "de" });
    await send(transport, [user("m1", "old"), answer("a1"), user("m2", "find bike data")], {
      context: { surface: "catalog", q: "rad" },
    });
    const { url, init, body } = sent();
    expect(url).toBe("http://assistant.test/conversations/c1/runs");
    expect(body).toEqual({
      message: { id: "m2", text: "find bike data" },
      context: { surface: "catalog", q: "rad" },
      locale: "de",
      refresh_token: "refresh-1",
    });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("sends no refresh token without a session and no context when the page has none", async () => {
    getSessionMock.mockResolvedValue(null);
    await send(createAssistantTransport("c1"), [user("m1", "hi")]);
    expect(sent().body).toEqual({ message: { id: "m1", text: "hi" }, context: null, locale: "en" });
  });

  it("refuses to regenerate and to send without a user message", async () => {
    const regenerated = await send(
      createAssistantTransport("c1"),
      [user("m1", "hi")],
      undefined,
      "regenerate-message"
    );
    expect(regenerated).toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => lastUserMessage([])).toThrow("There is no message to send.");
    expect(() => lastUserMessage([answer("a1")])).toThrow("There is no message to send.");
    expect(lastUserMessage([user("u1", "a"), answer("a1")])).toEqual({ id: "u1", text: "a" });
  });

  it("reads the active run id at reconnect time, not when the transport is built", async () => {
    let current: string | null = null;
    const transport = createAssistantTransport("c1", { getActiveRunId: () => current });
    current = "run-7";
    expect(await transport.reconnectToStream({ chatId: "c1" })).toBeNull(); // 204 = no active run
    current = null;
    await transport.reconnectToStream({ chatId: "c1" });
    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls).toEqual([
      "http://assistant.test/conversations/c1/stream?run_id=run-7",
      "http://assistant.test/conversations/c1/stream",
    ]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("maps the transcript, its access and the active run", async () => {
    const payload = {
      conversation: { id: "c1", project_id: "p1" },
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      active_run_id: "run-7",
      access: "lost",
      project_name: null,
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    expect(await fetchConversation("c1")).toEqual({
      conversation: payload.conversation,
      messages: payload.messages,
      activeRunId: "run-7",
      access: "lost",
      projectName: null,
      // No ratings in the response: none.
      feedback: {},
    });
  });

  it("cancels server side and throws when the server refuses", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await expect(cancelAssistantRun("c1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://assistant.test/conversations/c1/cancel");
    expect(init.method).toBe("POST");

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { code: "conversation_not_found", message: "gone" } }), {
        status: 404,
      })
    );
    const refused = await cancelAssistantRun("c1").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AssistantRequestError);
    expect((refused as AssistantRequestError).code).toBe("conversation_not_found");
  });
});

describe("assistant transport answers", () => {
  it("sends an ask card's answer with the message it belongs to", async () => {
    getSessionMock.mockResolvedValue(null);
    const reply = {
      card_id: "ask-call-7",
      answers: [
        { question: 0, options: [0, 1], other: null },
        { question: 1, options: [], other: "e-scooter" },
      ],
    };
    const answering: AssistantMessage = {
      id: "m2",
      role: "user",
      metadata: { answer: reply },
      parts: [{ type: "text", text: "Destinations: Supermarkets, Schools. Mode: e-scooter" }],
    };
    await send(createAssistantTransport("c1"), [
      user("m1", "15 minute workflow in Munich"),
      answer("a1"),
      answering,
    ]);
    expect(sent().body).toEqual({
      message: { id: "m2", text: "Destinations: Supermarkets, Schools. Mode: e-scooter", answer: reply },
      context: null,
      locale: "en",
    });
  });
});

describe("the Undo of an answer's edits", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const restored = { workflow_id: "wf-1", project_id: "p1", revision: 6 };
  const ada = { id: "u7", firstname: "Ada", lastname: "Lovelace", avatar: null };
  const nothing = { workflows: [], styles: [], map: null, notRestored: [] };
  const style = { project_id: "p1", layer_project_id: 12, style_id: "s1", revision: 6, removed: false };
  const map = { project_id: "p1", layers: [12], tree: false, groups: true, basemap: false, scene: false };

  it("posts to the answer's run and tells the workflows it wrote back", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { workflows: [restored] }));
    const outcome = await undoAnswer("c1", "r1");
    expect(sent().url).toBe("http://assistant.test/conversations/c1/runs/r1/undo");
    expect(sent().init.method).toBe("POST");
    expect(sent().body).toEqual({ force: false });
    expect(outcome).toEqual({
      kind: "undone",
      restored: { ...nothing, workflows: [{ workflowId: "wf-1", projectId: "p1", revision: 6 }] },
    });
  });

  it("tells the workflows changed since, and those it wrote back already", async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, {
        detail: {
          code: "changed_since",
          message: "The workflow was changed after this answer edited it.",
          workflows: [
            {
              workflow_id: "wf-2",
              project_id: "p1",
              revision: 3,
              updated_at: "2026-10-25T09:12:03+00:00",
              updated_by: ada,
              between: false,
            },
            {
              workflow_id: "wf-3",
              project_id: "p1",
              revision: null,
              updated_at: null,
              updated_by: null,
              between: true,
            },
          ],
          undone: [restored],
        },
      })
    );
    const outcome = await undoAnswer("c1", "r1", true);
    expect(sent().body).toEqual({ force: true });
    expect(outcome).toEqual({
      kind: "changed",
      restored: { ...nothing, workflows: [{ workflowId: "wf-1", projectId: "p1", revision: 6 }] },
      changed: {
        workflows: [
          { id: "wf-2", revision: 3, updatedAt: "2026-10-25T09:12:03+00:00", updatedBy: ada, between: false },
          { id: "wf-3", revision: null, updatedAt: null, updatedBy: null, between: true },
        ],
        styles: [],
        map: [],
      },
    });
  });

  it("keeps a workflow written back whose revision core did not name", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { workflows: [{ ...restored, revision: null }] }));
    expect(await undoAnswer("c1", "r1")).toEqual({
      kind: "undone",
      restored: { ...nothing, workflows: [{ workflowId: "wf-1", projectId: "p1", revision: null }] },
    });
  });

  it("reads styles and the map from the undo reply and tolerates a reply without them", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        workflows: [restored],
        styles: [
          style,
          { ...style, style_id: "s2", revision: null, removed: true },
          { ...style, style_id: "s3", partial: true },
          { ...style, layer_project_id: "12" },
          { project_id: "p1", style_id: "s4" },
          "s5",
        ],
        map,
        not_restored: ["layer_removed", 7, "style"],
      })
    );
    expect(await undoAnswer("c1", "r1")).toEqual({
      kind: "undone",
      restored: {
        workflows: [{ workflowId: "wf-1", projectId: "p1", revision: 6 }],
        styles: [
          { projectId: "p1", layerProjectId: 12, styleId: "s1", revision: 6, removed: false, partial: false },
          {
            projectId: "p1",
            layerProjectId: 12,
            styleId: "s2",
            revision: null,
            removed: true,
            partial: false,
          },
          { projectId: "p1", layerProjectId: 12, styleId: "s3", revision: 6, removed: false, partial: true },
        ],
        map: { projectId: "p1", layers: [12], tree: false, groups: true, basemap: false, scene: false },
        notRestored: ["layer_removed", "style"],
      },
    });

    // An assistant of the release before answers workflows only.
    fetchMock.mockResolvedValueOnce(json(200, { workflows: [restored] }));
    expect(await undoAnswer("c1", "r1")).toEqual({
      kind: "undone",
      restored: { ...nothing, workflows: [{ workflowId: "wf-1", projectId: "p1", revision: 6 }] },
    });
    fetchMock.mockResolvedValueOnce(json(200, { styles: "s1", map: [map], not_restored: "style" }));
    expect(await undoAnswer("c1", "r1")).toEqual({ kind: "undone", restored: nothing });
    fetchMock.mockResolvedValueOnce(json(200, { map: { ...map, project_id: 3, layers: [12, "x", 1.5] } }));
    expect(await undoAnswer("c1", "r1")).toEqual({ kind: "undone", restored: nothing });
    fetchMock.mockResolvedValueOnce(json(200, { map: { project_id: "p1", layers: [12, "x", 1.5] } }));
    expect((await undoAnswer("c1", "r1")).restored.map).toEqual({
      projectId: "p1",
      layers: [12],
      tree: false,
      groups: false,
      basemap: false,
      scene: false,
    });
  });

  it("reads changed_since with styles, with between and too_old", async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, {
        detail: {
          code: "changed_since",
          message: "changed",
          workflows: [],
          styles: [
            { ...style, revision: 9, between: false, too_old: false },
            { ...style, style_id: "s2", revision: 9, between: true, too_old: false },
            { ...style, style_id: "s3", revision: 9, between: false, too_old: true },
            { project_id: "p1", layer_project_id: 12 },
          ],
          map: [
            { object: "filter", layer_project_id: 12 },
            { object: "group_name", group_id: 7 },
            { object: "basemap" },
            { layer_project_id: 12 },
          ],
          undone: [restored],
          undone_styles: [style],
          undone_map: map,
        },
      })
    );
    expect(await undoAnswer("c1", "r1")).toEqual({
      kind: "changed",
      restored: {
        workflows: [{ workflowId: "wf-1", projectId: "p1", revision: 6 }],
        styles: [
          { projectId: "p1", layerProjectId: 12, styleId: "s1", revision: 6, removed: false, partial: false },
        ],
        map: { projectId: "p1", layers: [12], tree: false, groups: true, basemap: false, scene: false },
        notRestored: [],
      },
      changed: {
        workflows: [],
        styles: [
          { projectId: "p1", layerProjectId: 12, styleId: "s1", between: false, tooOld: false },
          { projectId: "p1", layerProjectId: 12, styleId: "s2", between: true, tooOld: false },
          { projectId: "p1", layerProjectId: 12, styleId: "s3", between: false, tooOld: true },
        ],
        map: [
          { object: "filter", layerProjectId: 12 },
          { object: "group_name", groupId: 7 },
          { object: "basemap" },
        ],
      },
    });
  });

  it("throws any other refusal with its code", async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, { detail: { code: "already_undone", message: "undone already" } })
    );
    const error = await undoAnswer("c1", "r1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AssistantRequestError);
    expect((error as AssistantRequestError).code).toBe("already_undone");
  });
});
