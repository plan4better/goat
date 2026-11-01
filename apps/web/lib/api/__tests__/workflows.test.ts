import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROJECTS_API_BASE_URL } from "@/lib/api/projects";
import {
  WorkflowIssuesError,
  checkWorkflow,
  executeWorkflow,
  refreshWorkflow,
  updateWorkflow,
} from "@/lib/api/workflows";
import { PROCESSES_BASE_URL } from "@/lib/constants";

const { fetchMock, mutateMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), mutateMock: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock, fetcher: vi.fn() }));
vi.mock("swr", () => ({ default: vi.fn(() => ({})), mutate: mutateMock }));

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const WORKFLOW_ID = "22222222-2222-2222-2222-222222222222";
const itemKey = [`${PROJECTS_API_BASE_URL}/${PROJECT_ID}/workflow/${WORKFLOW_ID}`];

const config = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, variables: [] };

describe("workflows api cache invalidation", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    mutateMock.mockReset();
  });

  it("invalidates the workflow key after a successful update, so a saved config is never read stale", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: WORKFLOW_ID }) });

    const updated = await updateWorkflow(PROJECT_ID, WORKFLOW_ID, { config });

    expect(updated).toEqual({ id: WORKFLOW_ID });
    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith(itemKey);
  });

  it("does not invalidate when the update fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });

    await expect(updateWorkflow(PROJECT_ID, WORKFLOW_ID, { config })).rejects.toThrow(
      "Failed to update workflow"
    );
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("refreshWorkflow invalidates the array key the read hook uses", () => {
    refreshWorkflow(PROJECT_ID, WORKFLOW_ID);
    expect(mutateMock).toHaveBeenCalledWith(itemKey);
  });
});

describe("executeWorkflow refusals", () => {
  const request = { project_id: PROJECT_ID, nodes: [], edges: [] } as unknown as Parameters<
    typeof executeWorkflow
  >[1];

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("keeps any other failure as it was", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(executeWorkflow(WORKFLOW_ID, request)).rejects.toThrow(
      "Failed to execute workflow: Internal Server Error"
    );
  });
});


const ISSUE = {
  code: "input_not_connected",
  level: "error",
  node_ids: ["tool-1"],
  field: "input_layer_id",
  message: "Buffer: the input layer is not connected.",
  params: { step: "Buffer", label: "Input layer" },
  source: "check",
};

describe("checkWorkflow", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("sends the steps the editor holds to processes in the UI language and returns the issues", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ issues: [ISSUE] }) });
    const nodes = [
      { id: "tool-1", type: "tool", data: { type: "tool", processId: "buffer", label: "Buffer", config: {} } },
    ];
    const edges = [{ id: "e1", source: "dataset-1", target: "tool-1", targetHandle: "input_layer_id" }];
    const variables = [{ name: "distance", type: "number", defaultValue: 500 }];

    const issues = await checkWorkflow({ projectId: PROJECT_ID, nodes, edges, variables, language: "de" });

    expect(fetchMock).toHaveBeenCalledWith(`${PROCESSES_BASE_URL}/workflows/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "de" },
      body: JSON.stringify({ project_id: PROJECT_ID, nodes, edges, variables }),
    });
    expect(issues).toEqual([ISSUE]);
  });

  it("fails on an error answer, so the editor keeps the list it has", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });

    await expect(checkWorkflow({ projectId: PROJECT_ID, nodes: [], edges: [], variables: [] })).rejects.toThrow(
      "Failed to check workflow: 503"
    );
  });
});

describe("executeWorkflow request", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("sends the UI language, which a refusal's issues are named in", async () => {
    const request = { project_id: PROJECT_ID, folder_id: "f1", nodes: [], edges: [] };
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ job_id: "j1", workflow_id: WORKFLOW_ID, status: "accepted" }),
    });

    await executeWorkflow(WORKFLOW_ID, request, "de");

    expect(fetchMock).toHaveBeenCalledWith(`${PROCESSES_BASE_URL}/workflows/${WORKFLOW_ID}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "de" },
      body: JSON.stringify(request),
    });
  });
});

describe("executeWorkflow refused with issues", () => {
  const request = { project_id: PROJECT_ID, folder_id: "f1", nodes: [], edges: [] };

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("turns a 422 answer into the issues it lists", async () => {
    const body = { detail: { message: "The workflow has issues.", issues: [ISSUE] } };
    fetchMock.mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve(JSON.stringify(body)) });

    const refused = await executeWorkflow(WORKFLOW_ID, request).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(WorkflowIssuesError);
    expect((refused as WorkflowIssuesError).issues).toEqual([ISSUE]);
    expect((refused as WorkflowIssuesError).message).toBe("The workflow has issues.");
  });

  it("keeps a request validation error (422 with a list) as a plain failure", async () => {
    const body = { detail: [{ loc: ["body", "nodes"], msg: "Field required", type: "missing" }] };
    fetchMock.mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve(JSON.stringify(body)) });

    const failure = await executeWorkflow(WORKFLOW_ID, request).catch((e: unknown) => e);

    expect(failure).not.toBeInstanceOf(WorkflowIssuesError);
    expect((failure as Error).message).toBe(`Failed to execute workflow: ${JSON.stringify(body)}`);
  });
});
