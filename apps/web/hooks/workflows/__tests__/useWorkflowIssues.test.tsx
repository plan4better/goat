import { act, renderHook } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkWorkflow } from "@/lib/api/workflows";
import type { WorkflowVariable } from "@/lib/validations/workflow";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import { CHECK_DEBOUNCE_MS, useWorkflowIssues } from "@/hooks/workflows/useWorkflowIssues";

const { t, i18n } = vi.hoisted(() => ({
  // Stable across renders: `t` is a dependency of the hook's memo.
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  i18n: { language: "en" },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t, i18n }) }));
vi.mock("@/lib/api/workflows", () => ({ checkWorkflow: vi.fn() }));

const buffer = (config: Record<string, unknown> = {}, position = { x: 0, y: 0 }): Node => ({
  id: "tool-1",
  type: "tool",
  position,
  data: { type: "tool", processId: "buffer", label: "Buffer", config },
});

const issue = (code: string): WorkflowIssue => ({
  code,
  level: "error",
  node_ids: ["tool-1"],
  field: null,
  message: `${code} message`,
  params: {},
  source: "check",
});

const NO_EDGES: Edge[] = [];
const NO_VARIABLES: WorkflowVariable[] = [];
const NO_ERRORS: Record<string, string> = {};

type Props = Parameters<typeof useWorkflowIssues>[0];

const props = (overrides: Partial<Props> = {}): Props => ({
  projectId: "p1",
  workflowId: "w1",
  nodes: [buffer()],
  edges: NO_EDGES,
  variables: NO_VARIABLES,
  nodeErrors: NO_ERRORS,
  enabled: true,
  ...overrides,
});

const renderIssues = (initial: Props) =>
  renderHook((p: Props) => useWorkflowIssues(p), { initialProps: initial });

const codes = (issues: WorkflowIssue[]) => issues.map((i) => i.code);

describe("useWorkflowIssues", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(checkWorkflow).mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("checks a workflow at once when it opens, with its steps and the UI language", async () => {
    vi.mocked(checkWorkflow).mockResolvedValue([issue("input_not_connected")]);
    const { result } = renderIssues(props());

    expect(checkWorkflow).toHaveBeenCalledTimes(1);
    expect(checkWorkflow).toHaveBeenCalledWith({
      projectId: "p1",
      language: "en",
      nodes: [
        {
          id: "tool-1",
          type: "tool",
          data: { type: "tool", processId: "buffer", label: "Buffer", config: {} },
        },
      ],
      edges: [],
      variables: [],
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(codes(result.current.issues)).toEqual(["input_not_connected"]);
  });

  it("checks again 500 ms after the last edit, with the latest steps", async () => {
    const { rerender } = renderIssues(props());
    await act(() => vi.advanceTimersByTimeAsync(0));
    vi.mocked(checkWorkflow).mockClear();

    rerender(props({ nodes: [buffer({ distance: 100 })] }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    rerender(props({ nodes: [buffer({ distance: 200 })] }));
    await act(() => vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS - 1));
    expect(checkWorkflow).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(checkWorkflow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkWorkflow).mock.calls[0][0].nodes).toEqual([
      { id: "tool-1", type: "tool", data: expect.objectContaining({ config: { distance: 200 } }) },
    ]);
  });

  it("does not check again when a step is only moved", async () => {
    const { rerender } = renderIssues(props());
    await act(() => vi.advanceTimersByTimeAsync(0));
    vi.mocked(checkWorkflow).mockClear();

    rerender(props({ nodes: [buffer({}, { x: 240, y: 80 })] }));
    await act(() => vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS));
    expect(checkWorkflow).not.toHaveBeenCalled();
  });

  it("checks another workflow at once and drops the issues of the one before", async () => {
    vi.mocked(checkWorkflow)
      .mockResolvedValueOnce([issue("tool_missing")])
      .mockReturnValueOnce(new Promise<WorkflowIssue[]>(() => undefined));
    const { result, rerender } = renderIssues(props());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(codes(result.current.issues)).toEqual(["tool_missing"]);

    rerender(props({ workflowId: "w2", nodes: [] }));
    expect(checkWorkflow).toHaveBeenCalledTimes(2);
    expect(result.current.issues).toEqual([]);
  });

  it("drops an answer to an older state of the steps", async () => {
    let answerFirst: (issues: WorkflowIssue[]) => void = () => undefined;
    vi.mocked(checkWorkflow)
      .mockReturnValueOnce(
        new Promise<WorkflowIssue[]>((resolve) => {
          answerFirst = resolve;
        })
      )
      .mockResolvedValueOnce([issue("setting_required")]);
    const { result, rerender } = renderIssues(props());

    rerender(props({ nodes: [buffer({ distance: 5 })] }));
    await act(() => vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS));
    expect(codes(result.current.issues)).toEqual(["setting_required"]);

    await act(async () => {
      answerFirst([issue("input_not_connected")]);
    });
    expect(codes(result.current.issues)).toEqual(["setting_required"]);
    expect(result.current.isChecking).toBe(false);
  });

  it("keeps the list it has when a check fails, and never shows a false all-clear", async () => {
    vi.mocked(checkWorkflow)
      .mockResolvedValueOnce([issue("input_not_connected")])
      .mockRejectedValueOnce(new Error("network down"));
    const { result, rerender } = renderIssues(props());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(codes(result.current.issues)).toEqual(["input_not_connected"]);

    rerender(props({ nodes: [buffer({ distance: 5 })] }));
    await act(() => vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS));
    expect(codes(result.current.issues)).toEqual(["input_not_connected"]);
    expect(result.current.isChecking).toBe(false);
    expect(result.current.checkFailed).toBe(true);
  });

  it("says the steps are not checked when the check of a workflow just opened fails", async () => {
    vi.mocked(checkWorkflow).mockRejectedValueOnce(new Error("network down"));
    const { result } = renderIssues(props());
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(result.current.issues).toEqual([]);
    expect(result.current.checkFailed).toBe(true);
  });

  it("checks again at once on request after a failed check", async () => {
    vi.mocked(checkWorkflow)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce([issue("input_not_connected")]);
    const { result } = renderIssues(props());
    await act(() => vi.advanceTimersByTimeAsync(0));

    act(() => result.current.recheck());
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(checkWorkflow).toHaveBeenCalledTimes(2);
    expect(codes(result.current.issues)).toEqual(["input_not_connected"]);
    expect(result.current.checkFailed).toBe(false);
  });

  it("adds a failed step's run error, keeps it when the step moves and drops it once the step is edited", async () => {
    const errors = { "tool-1": "Column population not found" };
    const { result, rerender } = renderIssues(props({ nodeErrors: errors }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.issues).toEqual([
      {
        code: "run_failed",
        level: "error",
        node_ids: ["tool-1"],
        field: null,
        message: "Column population not found",
        params: { step: "Buffer", error: "Column population not found" },
        source: "run",
      },
    ]);

    rerender(props({ nodeErrors: errors, nodes: [buffer({}, { x: 80, y: 40 })] }));
    expect(codes(result.current.issues)).toEqual(["run_failed"]);

    rerender(props({ nodeErrors: errors, nodes: [buffer({ distance: 300 })] }));
    expect(result.current.issues).toEqual([]);
  });

  it("drops run errors when a new run starts", async () => {
    const { result, rerender } = renderIssues(props({ nodeErrors: { "tool-1": "boom" } }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(codes(result.current.issues)).toEqual(["run_failed"]);

    rerender(props({ nodeErrors: {} }));
    expect(result.current.issues).toEqual([]);
  });

  it("replaces the list on request and ignores a check answer still on its way", async () => {
    let answer: (issues: WorkflowIssue[]) => void = () => undefined;
    vi.mocked(checkWorkflow).mockReturnValueOnce(
      new Promise<WorkflowIssue[]>((resolve) => {
        answer = resolve;
      })
    );
    const { result } = renderIssues(props());

    act(() => result.current.replaceIssues([issue("layer_not_chosen")]));
    await act(async () => {
      answer([issue("tool_missing")]);
    });
    expect(codes(result.current.issues)).toEqual(["layer_not_chosen"]);
    expect(result.current.isChecking).toBe(false);
  });

  it("neither checks nor lists anything while disabled", async () => {
    const { result } = renderIssues(props({ enabled: false, nodeErrors: { "tool-1": "boom" } }));
    await act(() => vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS));
    expect(checkWorkflow).not.toHaveBeenCalled();
    expect(result.current.issues).toEqual([]);
  });
});
