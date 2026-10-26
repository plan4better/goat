import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChangedElsewhereError, SAVE_TIMEOUT_MS } from "@/lib/api/changedElsewhere";
import { PROJECTS_API_BASE_URL } from "@/lib/api/projects";
import { WorkflowIssuesError, getWorkflow, updateWorkflow } from "@/lib/api/workflows";

const { fetchMock, mutateMock, fetcherMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mutateMock: vi.fn(),
  fetcherMock: vi.fn(),
}));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock, fetcher: fetcherMock }));
vi.mock("swr", () => ({ default: vi.fn(() => ({})), mutate: mutateMock }));

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const WORKFLOW_ID = "22222222-2222-2222-2222-222222222222";
const config = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, variables: [] };

const DAMAGED = {
  code: "node_duplicate_id",
  level: "damaged",
  node_ids: ["tool-1"],
  field: null,
  message: "Two steps share the id tool-1.",
  params: { id: "tool-1" },
  source: "check",
};

const answer = (status: number, body: unknown) => ({
  ok: false,
  status,
  text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
});

describe("updateWorkflow refusals", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    mutateMock.mockReset();
  });

  it("turns core's refusal of a damaged config into the issues it lists", async () => {
    fetchMock.mockResolvedValue(
      answer(422, { detail: { message: "The workflow is damaged.", issues: [DAMAGED] } })
    );

    const refused = await updateWorkflow(PROJECT_ID, WORKFLOW_ID, { config }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(WorkflowIssuesError);
    expect((refused as WorkflowIssuesError).issues).toEqual([DAMAGED]);
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("keeps a request validation error (422 with a list) a plain failure", async () => {
    fetchMock.mockResolvedValue(answer(422, { detail: [{ loc: ["body", "name"], msg: "too long" }] }));

    const failure = await updateWorkflow(PROJECT_ID, WORKFLOW_ID, { config }).catch((e: unknown) => e);

    expect(failure).not.toBeInstanceOf(WorkflowIssuesError);
    expect((failure as Error).message).toBe("Failed to update workflow");
  });

  it("keeps any other failure a plain failure", async () => {
    fetchMock.mockResolvedValue(answer(500, "Internal Server Error"));

    await expect(updateWorkflow(PROJECT_ID, WORKFLOW_ID, { config })).rejects.toThrow(
      "Failed to update workflow"
    );
  });
});

/** Core's answer when the stored workflow changed since the revision a save read. */
const CHANGED_ELSEWHERE = {
  detail: "changed_elsewhere",
  revision: 5,
  updated_at: "2026-10-25T09:12:03.120000+00:00",
  updated_by: { id: "user-2", firstname: "Ada", lastname: "Lovelace", avatar: null },
};

describe("updateWorkflow on a revision", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    mutateMock.mockReset();
  });

  it("sends the revision it read and returns the one core holds now", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ revision: 5 }) });

    const updated = await updateWorkflow(PROJECT_ID, WORKFLOW_ID, { config, base_revision: 4 });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ config, base_revision: 4 });
    expect(updated.revision).toBe(5);
  });

  it("turns core's conflict into who changed it, when, and the revision it holds now", async () => {
    fetchMock.mockResolvedValue(answer(409, CHANGED_ELSEWHERE));

    const refused = await updateWorkflow(PROJECT_ID, WORKFLOW_ID, { config, base_revision: 4 }).catch(
      (e: unknown) => e
    );

    expect(refused).toBeInstanceOf(ChangedElsewhereError);
    expect(refused).toMatchObject({
      revision: 5,
      updatedAt: "2026-10-25T09:12:03.120000+00:00",
      updatedBy: { id: "user-2", firstname: "Ada", lastname: "Lovelace", avatar: null },
    });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("reads a conflict nobody is recorded for", async () => {
    fetchMock.mockResolvedValue(answer(409, { ...CHANGED_ELSEWHERE, updated_by: null }));

    const refused = await updateWorkflow(PROJECT_ID, WORKFLOW_ID, { config }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(ChangedElsewhereError);
    expect((refused as ChangedElsewhereError).updatedBy).toBeNull();
  });

  it("keeps a database error's 409 a plain failure", async () => {
    fetchMock.mockResolvedValue(answer(409, { message: "Integrity error", detail: "duplicate key value" }));

    const failure = await updateWorkflow(PROJECT_ID, WORKFLOW_ID, { config }).catch((e: unknown) => e);

    expect(failure).not.toBeInstanceOf(ChangedElsewhereError);
    expect((failure as Error).message).toBe("Failed to update workflow");
  });
});

/** A request that answers only when its signal aborts, as fetch does. */
const stalled = (_url: string, options: RequestInit) =>
  new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
  });

describe("updateWorkflow that does not answer", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    mutateMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives up after SAVE_TIMEOUT_MS, so the editor's next save is not stuck behind it", async () => {
    // Fake timers do not drive AbortSignal.timeout, so the test holds the signal.
    const timer = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
    fetchMock.mockImplementation(stalled);

    const saving = updateWorkflow(PROJECT_ID, WORKFLOW_ID, { config, base_revision: 4 }).catch(
      (e: unknown) => e
    );
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0][1].signal).toBe(timer.signal);

    timer.abort(new DOMException("The save timed out.", "TimeoutError"));
    expect(((await saving) as DOMException).name).toBe("TimeoutError");
    expect(mutateMock).not.toHaveBeenCalled();
  });
});

describe("getWorkflow", () => {
  it("reads the workflow under the key the read hook uses", async () => {
    fetcherMock.mockResolvedValue({ id: WORKFLOW_ID, revision: 5 });
    expect(await getWorkflow(PROJECT_ID, WORKFLOW_ID)).toEqual({ id: WORKFLOW_ID, revision: 5 });
    expect(fetcherMock).toHaveBeenCalledWith([
      `${PROJECTS_API_BASE_URL}/${PROJECT_ID}/workflow/${WORKFLOW_ID}`,
    ]);
  });
});
