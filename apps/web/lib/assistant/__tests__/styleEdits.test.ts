import type { DynamicToolUIPart } from "ai";
import { describe, expect, it } from "vitest";

import { answerStyleEdits, styleEdit, styleEdits } from "@/lib/assistant/styleEdits";
import type { AssistantMessage } from "@/lib/assistant/types";

const step = (
  toolName: string,
  output: unknown,
  state: DynamicToolUIPart["state"] = "output-available",
  toolCallId = "call-1"
): DynamicToolUIPart =>
  ({ type: "dynamic-tool", toolName, toolCallId, state, input: {}, output }) as DynamicToolUIPart;

const reply = (id: string, parts: DynamicToolUIPart[]): AssistantMessage => ({
  id,
  role: "assistant",
  parts,
});

const saved = {
  project_id: "p1",
  layer_project_id: 7,
  style_id: "s1",
  name: "Default",
  created: false,
  active: true,
  made_active: false,
  revision_before: 4,
  revision_after: 5,
  changed: ["/symbol/fill/color"],
};

describe("style edits of an answer", () => {
  it("reads a finished style_update whose revision moved", () => {
    expect(styleEdit(step("style_update", saved))).toEqual({
      projectId: "p1",
      layerProjectId: 7,
      styleId: "s1",
      revision: 5,
      listChanged: false,
    });
    expect(styleEdit(step("style_update", saved, "input-available"))).toBeNull();
    expect(styleEdit(step("style_get", saved))).toBeNull();
    expect(styleEdit(step("style_update", { ...saved, layer_project_id: "7" }))).toBeNull();
    expect(styleEdit(step("style_update", { ...saved, style_id: undefined }))).toBeNull();
  });

  it("ignores a refused edit: same revision, nothing created", () => {
    expect(styleEdit(step("style_update", { ...saved, revision_after: 4 }))).toBeNull();
    expect(styleEdit(step("style_update", { ...saved, revision_after: null }))).toBeNull();
    expect(styleEdit(step("style_update", { ...saved, revision_after: undefined }))).toBeNull();
    expect(styleEdit(step("style_update", undefined, "output-error"))).toBeNull();
  });

  it("marks a created style and a change of the active style as a list change", () => {
    const created = { ...saved, style_id: "s2", created: true, revision_before: null, revision_after: 1 };
    expect(styleEdit(step("style_update", created))).toEqual({
      projectId: "p1",
      layerProjectId: 7,
      styleId: "s2",
      revision: 1,
      listChanged: true,
    });
    const switched = { ...saved, made_active: true, revision_after: 4 };
    expect(styleEdit(step("style_update", switched))).toEqual({
      projectId: "p1",
      layerProjectId: 7,
      styleId: "s1",
      revision: 4,
      listChanged: true,
    });
    expect(styleEdit(step("style_update", { ...switched, revision_after: null }))?.revision).toBeNull();
  });

  it("marks a rename that kept the revision as a list change", () => {
    // A replace with the stored document and a new name: core keeps the revision.
    const renamed = { ...saved, name: "Parks", revision_after: 4, renamed: true };
    expect(styleEdit(step("style_update", renamed))).toEqual({
      projectId: "p1",
      layerProjectId: 7,
      styleId: "s1",
      revision: 4,
      listChanged: true,
    });
    // A result without the field renamed nothing.
    expect(styleEdit(step("style_update", { ...renamed, renamed: undefined }))).toBeNull();
    expect(styleEdit(step("style_update", { ...renamed, renamed: false }))).toBeNull();
  });

  it("are an answer's own steps, and none of a user's message", () => {
    const message = reply("a1", [
      step("style_get", { style_id: "s1" }),
      step("style_update", saved),
      step("style_update", { ...saved, revision_after: 4 }),
    ]);
    expect(answerStyleEdits(message).map((edit) => edit.revision)).toEqual([5]);
    expect(answerStyleEdits({ id: "u1", role: "user", parts: [{ type: "text", text: "x" }] })).toEqual([]);
  });

  it("are keyed by answer and step across a conversation", () => {
    const messages = [
      reply("a1", [step("style_update", saved, "output-available", "c1")]),
      reply("a2", [
        step("style_update", { ...saved, revision_before: 5, revision_after: 6 }, "output-available", "c2"),
      ]),
    ];
    expect(styleEdits(messages).map(({ key, revision }) => ({ key, revision }))).toEqual([
      { key: "a1:c1", revision: 5 },
      { key: "a2:c2", revision: 6 },
    ]);
  });
});
