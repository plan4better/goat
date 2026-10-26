import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChangedElsewhereError, SAVE_TIMEOUT_MS } from "@/lib/api/changedElsewhere";
import { PROJECTS_API_BASE_URL, getProject, updateProject } from "@/lib/api/projects";

const { fetchMock, fetcherMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), fetcherMock: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock, fetcher: fetcherMock }));

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const builderConfig = { settings: {}, interface: [] };

const answer = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

describe("updateProject: the dashboard on a revision", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("sends the dashboard's revision and returns the one core holds now", async () => {
    fetchMock.mockResolvedValue(answer(200, { id: PROJECT_ID, builder_revision: 3 }));

    const updated = await updateProject(PROJECT_ID, {
      builder_config: builderConfig,
      builder_base_revision: 2,
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      builder_config: builderConfig,
      builder_base_revision: 2,
    });
    expect(updated.builder_revision).toBe(3);
  });

  it("turns core's conflict into who changed it, when, and the revision it holds now", async () => {
    fetchMock.mockResolvedValue(
      answer(409, {
        detail: "changed_elsewhere",
        revision: 4,
        updated_at: "2026-10-25T09:12:03+00:00",
        updated_by: { id: "user-2", firstname: "Ada", lastname: null, avatar: null },
      })
    );

    const refused = await updateProject(PROJECT_ID, {
      builder_config: builderConfig,
      builder_base_revision: 2,
    }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(ChangedElsewhereError);
    expect(refused).toMatchObject({ revision: 4, updatedBy: { firstname: "Ada" } });
  });

  it("keeps a database error's 409 a plain failure", async () => {
    fetchMock.mockResolvedValue(answer(409, { message: "Integrity error", detail: "duplicate key value" }));

    const failure = await updateProject(PROJECT_ID, { name: "Renamed" }).catch((e: unknown) => e);

    expect(failure).not.toBeInstanceOf(ChangedElsewhereError);
    expect((failure as Error).message).toBe("Failed to update project");
  });
});

describe("updateProject that does not answer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives up after SAVE_TIMEOUT_MS", async () => {
    const timer = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
    fetchMock.mockReset().mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
        })
    );

    const saving = updateProject(PROJECT_ID, { builder_config: builderConfig }).catch((e: unknown) => e);
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS);
    timer.abort(new DOMException("The save timed out.", "TimeoutError"));

    expect(((await saving) as DOMException).name).toBe("TimeoutError");
  });
});

describe("getProject", () => {
  it("reads the project under the key the read hook uses", async () => {
    fetcherMock.mockResolvedValue({ id: PROJECT_ID, builder_revision: 4 });
    expect(await getProject(PROJECT_ID)).toEqual({ id: PROJECT_ID, builder_revision: 4 });
    expect(fetcherMock).toHaveBeenCalledWith([`${PROJECTS_API_BASE_URL}/${PROJECT_ID}`]);
  });
});
