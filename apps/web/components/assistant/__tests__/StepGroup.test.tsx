import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DynamicToolUIPart } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessage } from "@/lib/assistant/types";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import MessageList from "@/components/assistant/messages/MessageList";
import StepGroup from "@/components/assistant/messages/StepGroup";

vi.mock("react-i18next", async () => {
  const { enTranslate: t } = await import("@/lib/assistant/__tests__/enTranslate");
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, never>) => t(key, options),
      i18n: { language: "en" },
    }),
  };
});

// An answer's details ask whether billing is on; nothing here depends on it.
vi.mock("@/lib/api/users", () => ({ useFeatures: () => ({ features: undefined }) }));

let counter = 0;
const call = (
  toolName: string,
  input: unknown,
  state: "output-available" | "output-error" | "input-available",
  output?: unknown
): DynamicToolUIPart =>
  ({
    type: "dynamic-tool",
    toolName,
    toolCallId: `g${(counter += 1)}`,
    state,
    input,
    ...(state === "output-available" ? { output } : {}),
    ...(state === "output-error" ? { errorText: "Internal English detail" } : {}),
  }) as DynamicToolUIPart;

const search = (q: string) => call("catalog_search", { q }, "output-available", { numberMatched: 3 });
const record = (id: string) => call("catalog_get_record", { item_id: id }, "output-available", { title: id });
const summaryButton = () => screen.getByRole("button", { expanded: false, name: /^Searched the catalog/ });

/** The reduced-motion setting of the viewer's system, as `useMediaQuery` reads it. */
const reduceMotion = () =>
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      }) as unknown as MediaQueryList
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StepGroup", () => {
  it("closes a finished group into one summary line, with its steps behind it", () => {
    render(<StepGroup steps={[search("a"), search("b"), record("Radwege")]} open={false} running={false} />);
    const summary = summaryButton();
    expect(summary.textContent).toBe("Searched the catalog 2 times, read a catalog record");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    const list = document.getElementById(summary.getAttribute("aria-controls") ?? "");
    expect(list).not.toBeNull();
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    const rows = within(list!).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Searched the catalog for “a” · 3 datasets",
      "Searched the catalog for “b” · 3 datasets",
      "Read the catalog record “Radwege”",
    ]);
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Searched the catalog for “a”")).toBeNull();
  });

  it("opens and closes from the keyboard", async () => {
    const user = userEvent.setup();
    render(<StepGroup steps={[search("a"), search("b")]} open={false} running={false} />);
    await user.tab();
    const summary = summaryButton();
    await expect(summary).toHaveFocus();
    await user.keyboard("{Enter}");
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Searched the catalog for “b”")).toBeTruthy();
    await user.keyboard(" ");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps writes and failures visible next to the summary, and marks the failures", () => {
    const broken = call("core_find", { query: "rad" }, "output-error");
    const created = call("workflow_create", { draft: {} }, "output-available", {
      workflow: { name: "Schulen" },
    });
    render(<StepGroup steps={[search("a"), broken, search("b"), created]} open={false} running={false} />);
    const summary = summaryButton();
    expect(summary.textContent).toBe("Searched the catalog 2 times · 1 failed");
    const lines = () => screen.getAllByRole("button").map((button) => button.textContent);
    expect(lines()).toEqual([
      "Searched the catalog 2 times · 1 failed",
      "Searched your content for “rad” · Failed",
      "Created the workflow “Schulen”",
    ]);
    // Open, the group lists every step in the order the answer took them, each once.
    fireEvent.click(summary);
    expect(lines()).toEqual([
      "Searched the catalog 2 times · 1 failed",
      "Searched the catalog for “a” · 3 datasets",
      "Searched your content for “rad” · Failed",
      "Searched the catalog for “b” · 3 datasets",
      "Created the workflow “Schulen”",
    ]);
  });

  it("shows a group of one step, or with one step to fold, as its lines with nothing to expand", () => {
    const { rerender } = render(<StepGroup steps={[search("a")]} open={false} running={false} />);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Searched the catalog for “a” · 3 datasets",
    ]);
    const created = call("workflow_create", { draft: {} }, "output-available", { workflow: { name: "W" } });
    rerender(<StepGroup steps={[search("a"), created]} open={false} running={false} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("button", { expanded: false, name: /^Searched the catalog$/ })).toBeNull();
  });

  it("shows the group still receiving steps open, step by step", () => {
    const running = call("catalog_search", { q: "Schule" }, "input-available");
    render(<StepGroup steps={[search("a"), search("b"), running]} open running />);
    expect(screen.queryByRole("button", { name: /^Searched the catalog \d/ })).toBeNull();
    const label = screen.getByText("Searching the catalog for “Schule”…");
    // The running step shimmers as the Answering line does; the finished ones keep their past tense.
    expect(getComputedStyle(label).animation).toMatch(/1\.8s/);
    expect(getComputedStyle(screen.getByText("Searched the catalog for “a”")).animation).not.toMatch(/1\.8s/);
  });

  it("lets the summary of a closed group whose steps still run shimmer", () => {
    const running = call("catalog_get_record", { item_id: "x" }, "input-available");
    render(<StepGroup steps={[search("a"), running]} open={false} running />);
    const summary = summaryButton();
    expect(summary.textContent).toBe("Searched the catalog, read a catalog record");
    expect(getComputedStyle(within(summary).getByText(/^Searched/)).animation).toMatch(/1\.8s/);
  });

  it("lets the summary shimmer only for a folded step under way, and not while the group is open", () => {
    const shimmers = (element: HTMLElement) => /1\.8s/.test(getComputedStyle(element).animation);
    const write = call("project_add_catalog_layer", { catalog_id: "c1" }, "input-available");
    const { unmount } = render(<StepGroup steps={[search("a"), search("b"), write]} open={false} running />);
    // A write under way shimmers in its own line, and only there.
    expect(shimmers(within(summaryButton()).getByText(/^Searched/))).toBe(false);
    expect(shimmers(screen.getByText("Adding a catalog dataset to the project…"))).toBe(true);
    unmount();

    const running = call("catalog_get_record", { item_id: "x" }, "input-available");
    render(<StepGroup steps={[search("a"), search("b"), running]} open={false} running />);
    const summary = summaryButton();
    expect(shimmers(within(summary).getByText(/^Searched/))).toBe(true);
    // Open, the step's own line shimmers instead.
    fireEvent.click(summary);
    expect(shimmers(within(summary).getByText(/^Searched/))).toBe(false);
    expect(shimmers(screen.getByText("Reading the catalog record “x”…"))).toBe(true);
  });

  it("keeps a step a stopped answer left unreturned out of the fold, marked as stopped", () => {
    const unreturned = call("catalog_search", { q: "c" }, "input-available");
    render(<StepGroup steps={[search("a"), search("b"), unreturned]} open={false} running={false} />);
    const summary = summaryButton();
    const lines = () => screen.getAllByRole("button").map((button) => button.textContent);
    expect(lines()).toEqual(["Searched the catalog 2 times", "Searching the catalog for “c”… · Stopped"]);
    fireEvent.click(summary);
    expect(lines()).toEqual([
      "Searched the catalog 2 times",
      "Searched the catalog for “a” · 3 datasets",
      "Searched the catalog for “b” · 3 datasets",
      "Searching the catalog for “c”… · Stopped",
    ]);
  });

  it("shows a small spinner instead of the shimmer when the system reduces motion", () => {
    reduceMotion();
    const running = call("catalog_search", { q: "Schule" }, "input-available");
    const { unmount } = render(<StepGroup steps={[search("a"), running]} open running />);
    const label = screen.getByText("Searching the catalog for “Schule”…");
    expect(getComputedStyle(label).animation).not.toMatch(/1\.8s/);
    expect(screen.getAllByRole("progressbar", { hidden: true })).toHaveLength(1);
    unmount();
    render(<StepGroup steps={[search("a"), running]} open={false} running />);
    const summary = summaryButton();
    expect(getComputedStyle(within(summary).getByText(/^Searched/)).animation).not.toMatch(/1\.8s/);
    expect(within(summary).getAllByRole("progressbar", { hidden: true })).toHaveLength(1);
  });
});

describe("repeated writes in a group", () => {
  const styleChange = (input: unknown = { layer_project_id: 1, operations: [] }) =>
    call("style_update", input, "output-available", {
      project_id: "p1",
      layer_project_id: 1,
      style_id: "s1",
      created: false,
      revision_before: 1,
      revision_after: 2,
    });
  const lines = () => screen.getAllByRole("button").map((button) => button.textContent);

  it("shows adjacent finished writes with the same label as one line with their count", () => {
    const steps = [styleChange(), styleChange(), styleChange(), styleChange(), styleChange()];
    render(<StepGroup steps={steps} open={false} running={false} />);
    expect(lines()).toEqual(["Changed the style · 5 times"]);
  });

  it("shows a single write as before, without a count", () => {
    render(<StepGroup steps={[search("a"), styleChange(), search("b")]} open={false} running={false} />);
    expect(lines()).toEqual(["Searched the catalog 2 times", "Changed the style"]);
  });

  it("keeps writes with different labels apart", () => {
    const created = call("style_update", { layer_project_id: 1, operations: [] }, "output-available", {
      style_id: "s2",
      created: true,
      name: "Bunt",
    });
    render(<StepGroup steps={[created, styleChange(), styleChange()]} open={false} running={false} />);
    expect(lines()).toEqual(["Created the style “Bunt”", "Changed the style · 2 times"]);
  });

  it("shows a failed or running step on its own, and folds the writes of a label around a failure", () => {
    const broken = call("map_update", { operations: [] }, "output-error");
    const { unmount } = render(
      <StepGroup steps={[styleChange(), styleChange(), broken, styleChange()]} open={false} running={false} />
    );
    expect(lines()).toEqual(["Changed the style · 3 times", "Changed the map · Failed"]);
    unmount();
    const busy = call("style_update", { layer_project_id: 1, operations: [] }, "input-available");
    render(<StepGroup steps={[styleChange(), styleChange(), busy]} open running />);
    expect(lines()).toEqual(["Changed the style · 2 times", "Changing the style…"]);
  });

  it("counts writes as repeated when the read steps between them fold into the summary", () => {
    render(
      <StepGroup
        steps={[styleChange(), search("a"), search("b"), styleChange()]}
        open={false}
        running={false}
      />
    );
    expect(lines()).toEqual(["Searched the catalog 2 times", "Changed the style · 2 times"]);
    // Open, the list shows every step in the answer's order: the reads between the writes end the run.
    fireEvent.click(summaryButton());
    expect(lines()).toEqual([
      "Searched the catalog 2 times",
      "Changed the style",
      "Searched the catalog for “a” · 3 datasets",
      "Searched the catalog for “b” · 3 datasets",
      "Changed the style",
    ]);
  });

  it("folds the writes of a label across a visible failed step, which keeps its place", () => {
    const steps = [
      styleChange(),
      call("style_get", { layer_project_id: 1 }, "output-available", { style_id: "s1" }),
      styleChange(),
      call("project_field_statistics", { layer_project_id: 1, field: "type" }, "output-error"),
      call("style_get", { layer_project_id: 1 }, "output-available", { style_id: "s1" }),
      styleChange(),
      ...Array.from({ length: 6 }, (_, index) =>
        call("project_count_features", { layer_project_id: index + 1 }, "output-available", { count: 3 })
      ),
      call("style_catalog", { kind: "palettes" }, "output-available", {}),
      ...Array.from({ length: 5 }, (_, index) =>
        call(
          "project_group_statistics",
          { layer_project_id: 1, group_by: `f${index}` },
          "output-available",
          {}
        )
      ),
      styleChange(),
      call("project_get_layers", {}, "output-available", { layers: [] }),
      call("style_get", { layer_project_id: 1 }, "output-available", { style_id: "s1" }),
      styleChange(),
    ];
    render(<StepGroup steps={steps} open={false} running={false} />);
    const [summary, ...rest] = lines();
    expect(summary).toMatch(/^Read a style, counted features 6 times/);
    expect(rest).toHaveLength(2);
    expect(rest[0]).toBe("Changed the style · 5 times");
    expect(rest[1]).toMatch(/ · Failed$/);
  });

  it("shows the reads between writes one by one while the group is open, and folds the writes when it closes", () => {
    const steps = [styleChange(), search("a"), search("b"), styleChange()];
    const { rerender } = render(<StepGroup steps={steps} open running />);
    expect(lines()).toEqual([
      "Changed the style",
      "Searched the catalog for “a” · 3 datasets",
      "Searched the catalog for “b” · 3 datasets",
      "Changed the style",
    ]);
    rerender(<StepGroup steps={steps} open={false} running />);
    expect(lines()).toEqual(["Searched the catalog 2 times", "Changed the style · 2 times"]);
  });

  it("opens the details of every call the line stands for, in their order", () => {
    const steps = [
      styleChange({ layer_project_id: 1, operations: [{ color: "red" }] }),
      styleChange({ layer_project_id: 1, operations: [{ color: "blue" }] }),
    ];
    const { container } = render(<StepGroup steps={steps} open={false} running={false} />);
    fireEvent.click(screen.getByRole("button", { name: /^Changed the style/ }));
    const details = container.querySelector("pre")?.textContent ?? "";
    expect(details.match(/style_update/g)).toHaveLength(1);
    expect(details.match(/^Input$/gm)).toHaveLength(2);
    expect(details.match(/^Result$/gm)).toHaveLength(2);
    expect(details.indexOf("red")).toBeGreaterThan(-1);
    expect(details.indexOf("blue")).toBeGreaterThan(details.indexOf("red"));
  });
});

describe("corrected attempts in a group", () => {
  let attempt = 0;
  /** A map change that landed, and one the tool refused; each with its own input to find in the details. */
  const mapChange = () =>
    call("map_update", { operations: [], attempt: (attempt += 1) }, "output-available", {
      applied: [{ op: "set_layer" }],
    });
  const mapRefused = () => call("map_update", { operations: [], attempt: (attempt += 1) }, "output-error");
  const layers = () => call("project_get_layers", {}, "output-available", { layers: [] });
  const count = (id: number) =>
    call("project_count_features", { layer_project_id: id }, "output-available", { count: 3 });
  const lines = () => screen.getAllByRole("button").map((button) => button.textContent);

  /** The tester's answer: refused, read, corrected and done, done again, counted, corrected and done. */
  const testersAnswer = () => [
    mapRefused(),
    layers(),
    mapRefused(),
    mapChange(),
    mapChange(),
    count(1),
    count(2),
    mapRefused(),
    mapChange(),
  ];

  it("shows the writes of one label as one line with the count of changes, and no failure", () => {
    render(<StepGroup steps={testersAnswer()} open={false} running={false} />);
    expect(lines()).toEqual([
      "Read the layers of a project, counted features 2 times",
      "Changed the map · 3 times",
    ]);
  });

  it("shows refused, refused, a read, invalid, done and done as the read and one line for the map", () => {
    const steps = [mapRefused(), mapRefused(), layers(), mapRefused(), mapChange(), mapChange()];
    render(<StepGroup steps={steps} open={false} running={false} />);
    expect(lines()).toEqual(["Read the project layers · nothing found", "Changed the map · 2 times"]);
  });

  it("opens the line on every call it stands for, the corrected attempts included, in the answer's order", () => {
    const steps = testersAnswer();
    const { container } = render(<StepGroup steps={steps} open={false} running={false} />);
    fireEvent.click(screen.getByRole("button", { name: /^Changed the map/ }));
    const details = container.querySelector("pre")?.textContent ?? "";
    expect(details.match(/^Rejected attempt$/gm)).toHaveLength(3);
    expect(details.match(/^Result$/gm)).toHaveLength(3);
    const attempts = [...details.matchAll(/"attempt": (\d+)/g)].map((match) => Number(match[1]));
    const own = steps.filter((step) => step.toolName === "map_update");
    expect(attempts).toEqual(own.map((step) => (step.input as { attempt: number }).attempt));
    // The attempts come before their retries: rejected, then a change, and so on.
    const blocks = details.split("\n\n").filter((block) => /^(Rejected attempt|Input)$/m.test(block));
    expect(blocks.map((block) => block.split("\n")[0])).toEqual([
      "Rejected attempt",
      "Rejected attempt",
      "Input",
      "Input",
      "Rejected attempt",
      "Input",
    ]);
  });

  it("says that the input was corrected on a line without a count, and in the details only on one with a count", () => {
    const { unmount } = render(
      <StepGroup steps={[mapRefused(), layers(), count(1), mapChange()]} open={false} running={false} />
    );
    expect(lines()).toEqual([
      "Read the layers of a project, counted features",
      "Changed the map · Corrected input and retried",
    ]);
    unmount();
    render(<StepGroup steps={testersAnswer()} open={false} running={false} />);
    expect(screen.queryByText(/Corrected input and retried/)).toBeNull();
  });

  it("keeps a write whose last call failed as a failed line, counted as failed", () => {
    render(
      <StepGroup
        steps={[mapRefused(), mapChange(), layers(), count(1), mapRefused()]}
        open={false}
        running={false}
      />
    );
    expect(lines()).toEqual([
      "Read the layers of a project, counted features · 1 failed",
      "Changed the map · Corrected input and retried",
      "Changed the map · Failed",
    ]);
  });

  it("keeps two labels apart, each on one line", () => {
    const style = () =>
      call("style_update", { layer_project_id: 1, operations: [] }, "output-available", { created: false });
    render(
      <StepGroup
        steps={[style(), mapChange(), layers(), count(1), style(), mapRefused(), mapChange()]}
        open={false}
        running={false}
      />
    );
    expect(lines()).toEqual([
      "Read the layers of a project, counted features",
      "Changed the style · 2 times",
      "Changed the map · 2 times",
    ]);
  });

  it("shows a failed attempt as failed while the answer runs, until a success of its tool takes it in", () => {
    const refused = mapRefused();
    const read = layers();
    const retrying = call("map_update", { operations: [] }, "input-available");
    const { rerender } = render(<StepGroup steps={[refused, read]} open running />);
    expect(lines()).toEqual(["Changed the map · Failed", "Read the project layers · nothing found"]);
    rerender(<StepGroup steps={[refused, read, retrying]} open running />);
    expect(lines()).toEqual([
      "Changed the map · Failed",
      "Read the project layers · nothing found",
      "Changing the map…",
    ]);
    const done = { ...retrying, state: "output-available", output: { applied: [{ op: "set_layer" }] } };
    rerender(<StepGroup steps={[refused, read, done as DynamicToolUIPart]} open running />);
    expect(lines()).toEqual([
      "Read the project layers · nothing found",
      "Changed the map · Corrected input and retried",
    ]);
  });

  it("shows nothing for a group that holds only attempts the answer corrected later", () => {
    const refused = mapRefused();
    const answer = [refused, layers(), mapChange()];
    const { container } = render(
      <StepGroup steps={[refused]} answerSteps={answer} open={false} running={false} />
    );
    expect(container.textContent).toBe("");
  });

  it("takes in an attempt the answer made before text, and counts no failure", () => {
    const messages: AssistantMessage[] = [
      { id: "u", role: "user", parts: [{ type: "text", text: "Filter the layer." }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          mapRefused(),
          { type: "text", text: "That did not fit; I try a smaller change." },
          layers(),
          count(1),
          mapChange(),
          { type: "text", text: "Done." },
        ],
      },
    ];
    render(
      <DockActionsContext.Provider value={dockActions()}>
        <MessageList
          messages={messages}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.queryByText(/Failed|failed/)).toBeNull();
    expect(screen.getByRole("button", { name: /^Changed the map/ }).textContent).toBe(
      "Changed the map · Corrected input and retried"
    );
  });
});

describe("StepGroup in the transcript", () => {
  it("counts a call that names the open project of the question as the open project", () => {
    const project = "3731e570-0000-4000-8000-000000000001";
    const layers = (input: Record<string, unknown>) =>
      call("project_get_layers", input, "output-available", {
        project_id: project,
        name: "Bonn",
        layers: [],
      });
    const messages: AssistantMessage[] = [
      {
        id: "u",
        role: "user",
        parts: [
          { type: "text", text: "Welche Layer hat das Projekt?" },
          { type: "data-context", data: { surface: "project.map", project_id: project } },
        ],
      },
      {
        id: "a",
        role: "assistant",
        parts: [layers({}), layers({ project_id: project }), { type: "text", text: "Keine." }],
      },
    ];
    render(
      <DockActionsContext.Provider value={dockActions()}>
        <MessageList
          messages={messages}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName="Bonn"
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.getByRole("button", { expanded: false, name: /^Read the layers/ }).textContent).toBe(
      "Read the layers of a project"
    );
  });
});
