import { fireEvent, render, screen } from "@testing-library/react";
import type { DynamicToolUIPart } from "ai";
import { describe, expect, it, vi } from "vitest";

import StepList from "@/components/assistant/messages/StepList";

vi.mock("react-i18next", async () => {
  const { enTranslate: t } = await import("@/lib/assistant/__tests__/enTranslate");
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, never>) => t(key, options),
      i18n: { language: "en" },
    }),
  };
});

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
    toolCallId: `c${(counter += 1)}`,
    state,
    input,
    ...(state === "output-available" ? { output } : {}),
    ...(state === "output-error" ? { errorText: "Internal English detail" } : {}),
  }) as DynamicToolUIPart;

const rowTexts = () => screen.getAllByRole("button").map((button) => button.textContent ?? "");

describe("StepList", () => {
  it("tells three searches and two counts apart by their arguments", () => {
    const find = (query: string) => call("core_find", { query }, "output-available", { projects: [] });
    const count = (layer: string) =>
      call("project_count_features", { layer_project_id: 1 }, "output-available", { layer, count: 1 });
    render(<StepList steps={[find("bike"), find("cycl"), find("rad"), count("Radwege"), count("Parks")]} />);
    for (const text of [
      "Searched your content for “bike”",
      "Searched your content for “cycl”",
      "Searched your content for “rad”",
      "Counted features in “Radwege”",
      "Counted features in “Parks”",
    ]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    // What each found follows its label; the tool's own name only shows in a row's details.
    expect(rowTexts()[0]).toContain("Searched your content for “bike” · nothing found");
    expect(rowTexts()[3]).toContain("Counted features in “Radwege” · 1 feature");
    expect(screen.queryByText("core_find")).toBeNull();
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(document.querySelector("pre")?.textContent?.startsWith("core_find")).toBe(true);
  });

  it("shows a rejected attempt and its retry as one row with the note, and keeps the attempt in the details", () => {
    const rejected = call(
      "project_count_features",
      { layer_project_id: 7, filter: { match: "bad" } },
      "output-error"
    );
    const retry = call("project_count_features", { layer_project_id: 7 }, "output-available", {
      layer: "Radwege",
      count: 12,
    });
    render(<StepList steps={[rejected, retry]} />);
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("Counted features in “Radwege”");
    expect(row.textContent).toContain("Corrected input and retried");
    expect(row.textContent).not.toContain("Failed");
    fireEvent.click(row);
    const details = document.querySelector("pre")?.textContent ?? "";
    expect(details).toContain("Rejected attempt");
    expect(details).toContain('"match": "bad"');
    expect(details).toContain("Failed");
    // The successful call's own input and result follow the attempt.
    expect(details.indexOf("Rejected attempt")).toBeLessThan(details.indexOf("Input\n"));
    expect(details).toContain('"count": 12');
    expect(details).not.toContain("Internal English detail");
  });

  it("keeps a failure without a successful retry as a row of its own, marked as failed", () => {
    const failed = call("catalog_search", { q: "rad" }, "output-error");
    const other = call("core_whoami", {}, "output-available", { name: "A" });
    render(<StepList steps={[failed, other]} />);
    const [first, second] = rowTexts();
    expect(first).toContain("Searched the catalog for “rad”");
    expect(first).toContain("Failed");
    expect(first).not.toContain("Corrected input and retried");
    expect(second).not.toContain("Failed");
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(document.querySelector("pre")?.textContent).toContain('"q": "rad"');
    expect(screen.queryByText(/Internal English detail/)).toBeNull();
  });

  it("renders a search word with & and < as the text it is", () => {
    const step = call("core_find", { query: "A & B <i>" }, "output-available", {});
    render(<StepList steps={[step]} />);
    expect(screen.getByText("Searched your content for “A & B <i>”")).toBeTruthy();
    expect(document.querySelector("i")).toBeNull();
  });

  it("keeps a long argument on the label's one line", () => {
    const step = call("core_find", { query: `${"very ".repeat(30)}long` }, "output-available", {});
    render(<StepList steps={[step]} />);
    const label = screen.getByText(/^Searched your content for “very/);
    expect(label.textContent?.endsWith("…”")).toBe(true);
    expect(Array.from(label.textContent ?? "").length).toBeLessThan(80);
  });

  it("says in a few words what each step found", () => {
    const steps = [
      call("catalog_search", { q: "Spielplatz" }, "output-available", { numberMatched: 47, results: [] }),
      call("catalog_find_region", { name: "München" }, "output-available", {
        regions: [{ nuts_id: "DE212", name: "München, Kreisfreie Stadt", level: 3 }],
      }),
      call("core_find_layers", { query: "rad" }, "output-available", {
        layers: [
          { project_id: "p1", layer_project_id: 1 },
          { project_id: "p1", layer_project_id: 2 },
          { project_id: "p2", layer_project_id: 3 },
        ],
        total: 3,
      }),
      call("project_count_features", { layer_project_id: 1 }, "output-available", {
        layer: "R",
        count: null,
      }),
      call("project_get_workflows", {}, "output-available", { workflows: [{ id: "w" }, { id: "x" }] }),
      // Every group of what core_find returns counts, not only projects and datasets.
      call("core_find", { query: "Anna", kind: "workflow" }, "output-available", {
        projects: [],
        datasets: [],
        workflows: [{ id: "a" }, { id: "b" }, { id: "c" }],
        layouts: [],
        templates: [{ id: "t" }],
      }),
    ];
    render(<StepList steps={steps} />);
    const [search, region, layers, withheld, workflows, found] = rowTexts();
    expect(found).toContain("Searched workflows for “Anna” · 4 found");
    expect(workflows).toContain("· 2 workflows");
    expect(search).toContain("· 47 datasets");
    expect(region).toContain("· DE212 München, Kreisfreie Stadt");
    expect(layers).toContain("· 3 layers · 2 projects");
    expect(withheld).toContain("· withheld");
  });

  it("lists every row it is given: the group around it does the folding", () => {
    const find = (query: string) => call("core_find", { query }, "output-available", { projects: [] });
    render(<StepList steps={["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"].map(find)} />);
    expect(rowTexts()).toHaveLength(8);
  });

  it("says what a running step is doing while the answer runs, and marks it stopped after", () => {
    const running = call("catalog_search", { q: "Schule" }, "input-available");
    const { rerender } = render(<StepList steps={[running]} running />);
    expect(rowTexts()).toEqual(["Searching the catalog for “Schule”…"]);
    expect(document.querySelector("[data-status]")?.getAttribute("data-status")).toBe("running");
    // A step the run left without a result (stopped, failed) is no longer under way, and not done.
    rerender(<StepList steps={[running]} />);
    expect(rowTexts()).toEqual(["Searching the catalog for “Schule”… · Stopped"]);
    expect(document.querySelector("[data-status]")?.getAttribute("data-status")).toBe("stopped");
    expect(getComputedStyle(screen.getByText("Searching the catalog for “Schule”…")).animation).not.toMatch(
      /1\.8s/
    );
  });

  it("never claims a write the run left unreturned was made", () => {
    render(<StepList steps={[call("workflow_create", { draft: {} }, "input-available")]} />);
    expect(rowTexts()).toEqual(["Creating a workflow… · Stopped"]);
  });
});
