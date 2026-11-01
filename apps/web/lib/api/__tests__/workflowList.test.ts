import { renderHook } from "@testing-library/react";
import { mutate } from "swr";
import { describe, expect, it, vi } from "vitest";

import { PROJECTS_API_BASE_URL } from "@/lib/api/projects";
import { refreshWorkflowList, useWorkflows } from "@/lib/api/workflows";

const { fetcherMock } = vi.hoisted(() => ({ fetcherMock: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: vi.fn(), fetcher: fetcherMock }));

const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
const listKey = [`${PROJECTS_API_BASE_URL}/${PROJECT_ID}/workflow`];
const EARLIER = { id: "w-old", name: "Earlier" };
const CREATED = { id: "w-new", name: "Schools: 15-minute walk" };

describe("refreshWorkflowList", () => {
  it("reads the list again while no list is on screen, so the next page reads the new workflow at once", async () => {
    // The list as the page read it before the assistant created a workflow; no hook shows it now.
    await mutate(listKey, [EARLIER], { revalidate: false });
    fetcherMock.mockResolvedValue([EARLIER, CREATED]);

    await expect(refreshWorkflowList(PROJECT_ID)).resolves.toEqual([EARLIER, CREATED]);
    expect(fetcherMock).toHaveBeenCalledWith(listKey);

    // The first render of a list mounted now (the map page's URL intent) already carries it.
    const { result } = renderHook(() => useWorkflows(PROJECT_ID));
    expect(result.current.workflows?.map((workflow) => workflow.id)).toEqual(["w-old", "w-new"]);
  });

  it("rejects when the list cannot be read", async () => {
    fetcherMock.mockRejectedValueOnce(new Error("offline"));
    await expect(refreshWorkflowList("44444444-4444-4444-4444-444444444444")).rejects.toThrow("offline");
  });
});
