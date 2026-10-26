import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChangedElsewhereError, SAVE_TIMEOUT_MS } from "@/lib/api/changedElsewhere";
import { PROJECTS_API_BASE_URL } from "@/lib/api/projects";
import { getReportLayout, refreshReportLayout, updateReportLayout } from "@/lib/api/reportLayouts";

const { fetchMock, mutateMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), mutateMock: vi.fn() }));
const { fetcherMock } = vi.hoisted(() => ({ fetcherMock: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock, fetcher: fetcherMock }));
vi.mock("swr", () => ({ default: vi.fn(() => ({})), mutate: mutateMock }));

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const LAYOUT_ID = "33333333-3333-3333-3333-333333333333";
const itemKey = [`${PROJECTS_API_BASE_URL}/${PROJECT_ID}/report-layout/${LAYOUT_ID}`];

describe("report layouts api cache invalidation", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    mutateMock.mockReset();
  });

  it("invalidates the layout key after a successful update, so a saved config is never read stale", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: LAYOUT_ID }) });

    const updated = await updateReportLayout(PROJECT_ID, LAYOUT_ID, { name: "Atlas" });

    expect(updated).toEqual({ id: LAYOUT_ID });
    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith(itemKey);
  });

  it("does not invalidate when the update fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });

    await expect(updateReportLayout(PROJECT_ID, LAYOUT_ID, { name: "Atlas" })).rejects.toThrow(
      "Failed to update report layout"
    );
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("refreshReportLayout invalidates the array key the read hook uses", () => {
    refreshReportLayout(PROJECT_ID, LAYOUT_ID);
    expect(mutateMock).toHaveBeenCalledWith(itemKey);
  });
});

describe("updateReportLayout on a revision", () => {
  const conflictAnswer = (body: unknown) => ({
    ok: false,
    status: 409,
    text: () => Promise.resolve(JSON.stringify(body)),
  });

  beforeEach(() => {
    fetchMock.mockReset();
    mutateMock.mockReset();
  });

  it("sends the revision it read", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ revision: 3 }) });

    const updated = await updateReportLayout(PROJECT_ID, LAYOUT_ID, { name: "Atlas", base_revision: 2 });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "Atlas", base_revision: 2 });
    expect(updated.revision).toBe(3);
  });

  it("turns core's conflict into who changed it, when, and the revision it holds now", async () => {
    fetchMock.mockResolvedValue(
      conflictAnswer({
        detail: "changed_elsewhere",
        revision: 7,
        updated_at: "2026-10-25T09:12:03+00:00",
        updated_by: null,
      })
    );

    const refused = await updateReportLayout(PROJECT_ID, LAYOUT_ID, {
      name: "Atlas",
      base_revision: 2,
    }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(ChangedElsewhereError);
    expect(refused).toMatchObject({ revision: 7, updatedAt: "2026-10-25T09:12:03+00:00", updatedBy: null });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("keeps a database error's 409 a plain failure", async () => {
    fetchMock.mockResolvedValue(
      conflictAnswer({ message: "Integrity error", detail: "duplicate key value" })
    );

    const failure = await updateReportLayout(PROJECT_ID, LAYOUT_ID, { name: "Atlas" }).catch(
      (e: unknown) => e
    );

    expect(failure).not.toBeInstanceOf(ChangedElsewhereError);
    expect((failure as Error).message).toBe("Failed to update report layout");
  });
});

describe("updateReportLayout that does not answer", () => {
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

    const saving = updateReportLayout(PROJECT_ID, LAYOUT_ID, { name: "Atlas" }).catch((e: unknown) => e);
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS);
    timer.abort(new DOMException("The save timed out.", "TimeoutError"));

    expect(((await saving) as DOMException).name).toBe("TimeoutError");
  });
});

describe("getReportLayout", () => {
  it("reads the layout under the key the read hook uses", async () => {
    fetcherMock.mockResolvedValue({ id: LAYOUT_ID, revision: 6 });
    expect(await getReportLayout(PROJECT_ID, LAYOUT_ID)).toEqual({ id: LAYOUT_ID, revision: 6 });
    expect(fetcherMock).toHaveBeenCalledWith(itemKey);
  });
});
