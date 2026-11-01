import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChangedElsewhereError } from "@/lib/api/changedElsewhere";

import { useDashboardSaves } from "@/hooks/dashboard/useDashboardSaves";

const { updateMock, getMock, toastErrorMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  getMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));
vi.mock("@/lib/api/projects", () => ({ updateProject: updateMock, getProject: getMock }));
vi.mock("react-toastify", () => ({ toast: { error: toastErrorMock } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const PROJECT_ID = "p1";
const ada = { id: "user-2", firstname: "Ada", lastname: "Lovelace", avatar: null };
const dashboard = (title: string) => ({ settings: { title }, interface: [] });

const setup = (builderRevision: number | null = 2) => {
  const mutateProject = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(
    ({ revision }: { revision: number | null }) =>
      useDashboardSaves({ projectId: PROJECT_ID, builderRevision: revision, mutateProject }),
    { initialProps: { revision: builderRevision } }
  );
  return { hook, mutateProject };
};

const sentBase = (call: number) => updateMock.mock.calls[call][1].builder_base_revision;

describe("useDashboardSaves", () => {
  beforeEach(() => {
    updateMock.mockReset();
    getMock.mockReset();
    toastErrorMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("saves the dashboard on the revision the page read, the next on the one core returned", async () => {
    updateMock.mockResolvedValueOnce({ builder_revision: 3 }).mockResolvedValue({ builder_revision: 4 });
    const { hook } = setup();

    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("A") });
    });
    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("B") });
    });

    expect(updateMock).toHaveBeenNthCalledWith(1, PROJECT_ID, {
      builder_config: dashboard("A"),
      builder_base_revision: 2,
    });
    expect(sentBase(1)).toBe(3);
  });

  it("keeps the revision a save returned over an older one the page still shows, and takes a newer read", async () => {
    updateMock.mockResolvedValue({ builder_revision: 3 });
    const { hook } = setup();

    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("A") });
    });
    hook.rerender({ revision: 2 });
    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("B") });
    });
    expect(sentBase(1)).toBe(3);

    hook.rerender({ revision: 7 });
    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("C") });
    });
    expect(sentBase(2)).toBe(7);
  });

  it("reads the project again once the save is in, when asked", async () => {
    const order: string[] = [];
    updateMock.mockImplementation(async () => {
      order.push("save");
      return { builder_revision: 3 };
    });
    const { hook, mutateProject } = setup();
    mutateProject.mockImplementation(async (...args: unknown[]) => {
      if (args.length === 0) order.push("refresh");
    });

    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("A") }, true);
    });

    expect(order).toEqual(["save", "refresh"]);
  });

  it("holds a refused save and the later ones, and reads nothing over them", async () => {
    updateMock.mockRejectedValueOnce(new ChangedElsewhereError(4, "2026-10-25T09:12:03+00:00", ada));
    const { hook, mutateProject } = setup();

    let outcome: string | undefined;
    await act(async () => {
      outcome = await hook.result.current.save({ builder_config: dashboard("A") }, true);
    });
    expect(outcome).toBe("held");
    expect(hook.result.current.conflict).toMatchObject({ id: PROJECT_ID, revision: 4, updatedBy: ada });
    expect(mutateProject).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("B") });
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("Keep mine sends the held dashboard on the revision core holds, then reads the project again", async () => {
    updateMock
      .mockRejectedValueOnce(new ChangedElsewhereError(4, "2026-10-25T09:12:03+00:00", ada))
      .mockResolvedValue({ builder_revision: 5 });
    const { hook, mutateProject } = setup();

    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("A") });
    });
    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("B") });
    });
    await act(async () => {
      await hook.result.current.keepMine();
    });

    expect(updateMock).toHaveBeenLastCalledWith(PROJECT_ID, {
      builder_config: dashboard("B"),
      builder_base_revision: 4,
    });
    expect(hook.result.current.conflict).toBeNull();
    expect(mutateProject).toHaveBeenCalledWith();
  });

  it("Reload shows the stored project and saves on from its revision", async () => {
    updateMock
      .mockRejectedValueOnce(new ChangedElsewhereError(4, "2026-10-25T09:12:03+00:00", ada))
      .mockResolvedValue({ builder_revision: 5 });
    const stored = { id: PROJECT_ID, builder_revision: 4, builder_config: dashboard("theirs") };
    getMock.mockResolvedValue(stored);
    const { hook, mutateProject } = setup();

    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("A") });
    });
    await act(async () => {
      await hook.result.current.reload();
    });

    expect(getMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(mutateProject).toHaveBeenCalledWith(stored, { revalidate: false });
    expect(hook.result.current.conflict).toBeNull();

    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("after") });
    });
    expect(sentBase(1)).toBe(4);
  });

  it("keeps the conflict when the stored project cannot be read", async () => {
    updateMock.mockRejectedValueOnce(new ChangedElsewhereError(4, null, null));
    getMock.mockRejectedValue(new Error("offline"));
    const { hook } = setup();

    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("A") });
    });
    await act(async () => {
      await hook.result.current.reload();
    });

    expect(hook.result.current.conflict?.revision).toBe(4);
  });

  it("says so when Keep mine cannot save, and shows the stored project", async () => {
    updateMock
      .mockRejectedValueOnce(new ChangedElsewhereError(4, null, null))
      .mockRejectedValueOnce(new Error("offline"));
    const { hook, mutateProject } = setup();

    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("A") });
    });
    await act(async () => {
      await hook.result.current.keepMine();
    });

    expect(toastErrorMock).toHaveBeenCalledWith("error_updating_project");
    expect(mutateProject).toHaveBeenCalledWith();
    expect(hook.result.current.conflict).toBeNull();
  });

  it("writes the revision a save returned into the project the page shows", async () => {
    updateMock.mockResolvedValue({ builder_revision: 3 });
    const { hook, mutateProject } = setup();

    await act(async () => {
      await hook.result.current.save({ builder_config: dashboard("A") });
    });

    const [update, options] = mutateProject.mock.calls[0];
    expect(options).toEqual({ revalidate: false });
    expect(update({ id: PROJECT_ID, builder_revision: 2, name: "P" })).toEqual({
      id: PROJECT_ID,
      builder_revision: 3,
      name: "P",
    });
    // A newer read of the project is consistent in itself and stays.
    const newer = { id: PROJECT_ID, builder_revision: 7, name: "P" };
    expect(update(newer)).toBe(newer);
  });
});
