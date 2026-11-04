/**
 * The layout editor saves every change on the revision the layout was opened
 * at, one save at a time; a save core refuses because the layout changed
 * elsewhere shows the conflict banner, and Reload or Keep mine resolve it.
 * The canvas and panels are stubbed: the suite drives the callbacks they get.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChangedElsewhereError } from "@/lib/api/changedElsewhere";
import type { Project } from "@/lib/validations/project";
import type { ReportElement, ReportLayout, ReportLayoutUpdate } from "@/lib/validations/reportLayout";

import ReportsLayout from "@/components/reports/ReportsLayout";

type PanelProps = {
  selectedReport: ReportLayout | null;
  onSelectReport: (report: ReportLayout | null) => void;
  onSaveLayout: (id: string, update: ReportLayoutUpdate, listRevision?: number) => Promise<unknown>;
  reloads?: number;
};
type CanvasProps = {
  reportConfig?: ReportLayout["config"];
  onElementUpdate: (id: string, updates: Partial<ReportElement>) => void;
};

const { updateMock, getMock, mutateLayoutsMock, toastErrorMock, stubs } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  getMock: vi.fn(),
  mutateLayoutsMock: vi.fn(),
  toastErrorMock: vi.fn(),
  stubs: { panel: null as PanelProps | null, canvas: null as CanvasProps | null },
}));

vi.mock("react-i18next", async () => {
  const { commonI18n } = await import("@/i18n/__tests__/commonI18n");
  const i18n = commonI18n("en");
  const t = i18n.getFixedT("en", "common");
  return { useTranslation: () => ({ t, i18n }) };
});

vi.mock("react-toastify", () => ({ toast: { error: toastErrorMock } }));

vi.mock("@/lib/api/reportLayouts", () => ({
  useReportLayouts: () => ({ mutate: mutateLayoutsMock }),
  updateReportLayout: updateMock,
  getReportLayout: getMock,
}));
vi.mock("@/lib/api/projects", () => ({ useProjectInitialViewState: () => ({ initialView: undefined }) }));
vi.mock("@/hooks/map/MapHooks", () => ({ useBasemap: () => ({ mapStyle: undefined }) }));

vi.mock("@/components/reports/panels/ReportsConfigPanel", () => ({
  default: (props: PanelProps) => {
    stubs.panel = props;
    return null;
  },
}));
vi.mock("@/components/reports/canvas/ReportsCanvas", () => ({
  default: (props: CanvasProps) => {
    stubs.canvas = props;
    return null;
  },
}));
vi.mock("@/components/reports/panels/ReportsElementsPanel", () => ({ default: () => null }));

const project = { id: "p1" } as Project;
const ada = { id: "user-2", firstname: "Ada", lastname: "Lovelace", avatar: null };

const text = (id: string, x = 10): ReportElement =>
  ({
    id,
    type: "text",
    position: { x, y: 10, width: 60, height: 30, z_index: 1 },
    config: {},
    style: {},
  }) as ReportElement;

const layout = (id: string, revision: number, elements: ReportElement[]): ReportLayout =>
  ({
    id,
    project_id: "p1",
    name: id,
    revision,
    config: { page: { size: "A4", orientation: "portrait" }, layout: {}, elements },
  }) as unknown as ReportLayout;

const sent = (call: number) => updateMock.mock.calls[call][2] as ReportLayoutUpdate;
const elementIds = () => stubs.canvas?.reportConfig?.elements?.map((element) => element.id);

/** Lets the queued saves and their answers run. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const open = async (report: ReportLayout) => {
  act(() => stubs.panel?.onSelectReport(report));
  await settle();
};

const move = async (id: string, x: number) => {
  act(() => stubs.canvas?.onElementUpdate(id, { position: { x, y: 10, width: 60, height: 30, z_index: 1 } }));
  await settle();
};

const refuse = () => new ChangedElsewhereError(6, new Date().toISOString(), ada);

beforeEach(() => {
  updateMock.mockReset();
  getMock.mockReset();
  mutateLayoutsMock.mockReset();
  toastErrorMock.mockReset();
  stubs.panel = null;
  stubs.canvas = null;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("ReportsLayout saves", () => {
  it("saves an edit on the revision the layout was opened at, the next on the one core returned", async () => {
    updateMock.mockResolvedValueOnce({ revision: 4 }).mockResolvedValue({ revision: 5 });
    render(<ReportsLayout project={project} />);
    await open(layout("layout-a", 3, [text("el-1")]));

    await move("el-1", 20);
    await move("el-1", 30);

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock.mock.calls[0][0]).toBe("p1");
    expect(sent(0)).toMatchObject({ base_revision: 3 });
    expect(sent(1)).toMatchObject({ base_revision: 4 });
    expect(sent(1).config?.elements?.[0].position.x).toBe(30);
  });

  it("saves the settings panel's changes in turn, on the same revisions", async () => {
    let finish: (value: unknown) => void = () => undefined;
    updateMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue({ revision: 5 });
    render(<ReportsLayout project={project} />);
    await open(layout("layout-a", 3, [text("el-1")]));

    await move("el-1", 20);
    let renamed: Promise<unknown> = Promise.resolve();
    act(() => {
      renamed = stubs.panel!.onSaveLayout("layout-a", { name: "Atlas" });
    });
    await settle();
    expect(updateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ revision: 4 });
      await renamed;
    });
    expect(sent(1)).toEqual({ name: "Atlas", base_revision: 4 });
  });

  it("shows the conflict and holds later edits until Keep mine saves the layout as it is now", async () => {
    updateMock.mockRejectedValueOnce(refuse()).mockResolvedValue({ revision: 7 });
    const user = userEvent.setup();
    render(<ReportsLayout project={project} />);
    await open(layout("layout-a", 3, [text("el-1")]));

    await move("el-1", 20);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This layout was changed elsewhere (by Ada Lovelace,"
    );

    await move("el-1", 40);
    expect(updateMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    await settle();
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(sent(1)).toMatchObject({ base_revision: 6 });
    expect(sent(1).config?.elements?.[0].position.x).toBe(40);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Reload shows the stored layout, has the settings panel read it again, and saves on from its revision", async () => {
    updateMock.mockRejectedValueOnce(refuse()).mockResolvedValue({ revision: 7 });
    getMock.mockResolvedValue(layout("layout-a", 6, [text("theirs")]));
    const user = userEvent.setup();
    render(<ReportsLayout project={project} />);
    await open(layout("layout-a", 3, [text("el-1")]));
    expect(stubs.panel?.reloads ?? 0).toBe(0);

    await move("el-1", 20);
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await settle();

    expect(getMock).toHaveBeenCalledWith("p1", "layout-a");
    expect(elementIds()).toEqual(["theirs"]);
    expect(stubs.panel?.reloads).toBe(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await move("theirs", 50);
    expect(sent(1)).toMatchObject({ base_revision: 6 });
  });

  it("drops the conflict when another layout is opened", async () => {
    updateMock.mockRejectedValueOnce(refuse()).mockResolvedValue({ revision: 2 });
    render(<ReportsLayout project={project} />);
    await open(layout("layout-a", 3, [text("el-1")]));
    await move("el-1", 20);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await open(layout("layout-b", 1, [text("el-b")]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await move("el-b", 20);
    expect(updateMock.mock.calls[1][1]).toBe("layout-b");
    expect(sent(1)).toMatchObject({ base_revision: 1 });
  });

  it("renames a layout that is not open on the revision the list read", async () => {
    updateMock.mockResolvedValue({ revision: 8 });
    render(<ReportsLayout project={project} />);
    await open(layout("layout-a", 3, [text("el-1")]));

    await act(async () => {
      await stubs.panel!.onSaveLayout("layout-b", { name: "Atlas" }, 7);
    });

    expect(updateMock).toHaveBeenCalledWith("p1", "layout-b", { name: "Atlas", base_revision: 7 });
  });

  it("renames the open layout on the revision it was opened at, whatever a newer list read says", async () => {
    // The list may carry another person's newer version; the open layout's
    // next save must still name the revision its own content is based on.
    updateMock.mockResolvedValue({ revision: 4 });
    render(<ReportsLayout project={project} />);
    await open(layout("layout-a", 3, [text("el-1")]));

    await act(async () => {
      await stubs.panel!.onSaveLayout("layout-a", { name: "Atlas" }, 9);
    });

    expect(sent(0)).toEqual({ name: "Atlas", base_revision: 3 });
  });

  it("keeps the revision a save returned on the open layout and in the cached list", async () => {
    let cache: ReportLayout[] = [layout("layout-a", 3, [text("el-1")])];
    mutateLayoutsMock.mockImplementation((update: unknown) => {
      cache =
        typeof update === "function"
          ? (update as (list: ReportLayout[]) => ReportLayout[])(cache)
          : (update as ReportLayout[]);
    });
    updateMock.mockResolvedValue({ revision: 4 });
    render(<ReportsLayout project={project} />);
    await open(cache[0]);

    await move("el-1", 20);

    expect(stubs.panel?.selectedReport?.revision).toBe(4);
    expect(cache[0].revision).toBe(4);
    expect(cache[0].config.elements?.[0].position.x).toBe(20);
  });

  it("saves on from the returned revision after leaving the layouts and coming back", async () => {
    // Reports mode unmounts the editor; the next mount opens the layout from
    // the cached list, which must carry the revision of the last save.
    let cache: ReportLayout[] = [layout("layout-a", 3, [text("el-1")])];
    mutateLayoutsMock.mockImplementation((update: unknown) => {
      cache =
        typeof update === "function"
          ? (update as (list: ReportLayout[]) => ReportLayout[])(cache)
          : (update as ReportLayout[]);
    });
    updateMock.mockResolvedValueOnce({ revision: 4 }).mockResolvedValue({ revision: 5 });
    const first = render(<ReportsLayout project={project} />);
    await open(cache[0]);
    await move("el-1", 20);
    first.unmount();

    render(<ReportsLayout project={project} />);
    await open(cache[0]);
    await move("el-1", 30);

    expect(sent(1)).toMatchObject({ base_revision: 4 });
  });

  it("never tags the open layout's content with the revision of another person's version the list read", async () => {
    // A list read (window focus) brings another person's version 6 while the
    // open layout's content is based on 3. Written back into the list, this
    // content keeps 3: opened from the list after a remount, its next save is
    // refused instead of overwriting version 6.
    let cache: ReportLayout[] = [layout("layout-a", 3, [text("el-1")])];
    mutateLayoutsMock.mockImplementation((update: unknown) => {
      cache =
        typeof update === "function"
          ? (update as (list: ReportLayout[]) => ReportLayout[])(cache)
          : (update as ReportLayout[]);
    });
    updateMock.mockRejectedValue(refuse());
    const first = render(<ReportsLayout project={project} />);
    await open(cache[0]);
    cache = [layout("layout-a", 6, [text("theirs")])];

    await move("el-1", 20);
    expect(cache[0].revision).toBe(3);
    expect(cache[0].config.elements?.[0].id).toBe("el-1");
    first.unmount();

    render(<ReportsLayout project={project} />);
    await open(cache[0]);
    await move("el-1", 30);
    expect(sent(1)).toMatchObject({ base_revision: 3 });
  });

  it("writes a settings change of the open layout into the list, with the layout's own revision", async () => {
    let cache: ReportLayout[] = [layout("layout-a", 3, [text("el-1")])];
    mutateLayoutsMock.mockImplementation((update: unknown) => {
      cache =
        typeof update === "function"
          ? (update as (list: ReportLayout[]) => ReportLayout[])(cache)
          : (update as ReportLayout[]);
    });
    render(<ReportsLayout project={project} />);
    await open(cache[0]);
    cache = [layout("layout-a", 6, [text("theirs")])];

    const a3 = layout("layout-a", 3, [text("el-1")]);
    a3.config.page = { ...a3.config.page, size: "A3" };
    act(() => stubs.panel?.onSelectReport(a3));

    expect(cache[0].config.page.size).toBe("A3");
    expect(cache[0].revision).toBe(3);
  });

  it("says so when Keep mine cannot save, and saves the layout with the next change", async () => {
    updateMock
      .mockRejectedValueOnce(refuse())
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ revision: 7 });
    const user = userEvent.setup();
    render(<ReportsLayout project={project} />);
    await open(layout("layout-a", 3, [text("el-1")]));
    await move("el-1", 20);

    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    await settle();
    expect(toastErrorMock).toHaveBeenCalledWith("Error saving changes");

    await move("el-1", 40);
    expect(sent(2)).toMatchObject({ base_revision: 6 });
    expect(sent(2).config?.elements?.[0].position.x).toBe(40);
  });

  it("keeps the kept version in the list after Keep mine, also when a list read brought the other one", async () => {
    // A save is refused; a list read (window focus) then brings the other
    // person's version at the conflict's revision. Keep mine stores this
    // layout on top; opened again from the list, it must be this layout on
    // the answer's revision, or the next edit overwrites it without a banner.
    let cache: ReportLayout[] = [layout("layout-a", 3, [text("el-1")])];
    mutateLayoutsMock.mockImplementation((update: unknown) => {
      cache =
        typeof update === "function"
          ? (update as (list: ReportLayout[]) => ReportLayout[])(cache)
          : (update as ReportLayout[]);
    });
    updateMock
      .mockRejectedValueOnce(refuse())
      .mockResolvedValueOnce({ revision: 7 })
      .mockResolvedValue({ revision: 8 });
    const user = userEvent.setup();
    const first = render(<ReportsLayout project={project} />);
    await open(cache[0]);
    await move("el-1", 20);
    cache = [layout("layout-a", 6, [text("theirs")])];

    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    await settle();
    expect(sent(1)).toMatchObject({ base_revision: 6 });
    expect(cache[0].revision).toBe(7);
    expect(cache[0].config.elements?.map((element) => element.id)).toEqual(["el-1"]);
    first.unmount();

    render(<ReportsLayout project={project} />);
    await open(cache[0]);
    await move("el-1", 30);
    expect(sent(2)).toMatchObject({ base_revision: 7 });
    expect(sent(2).config?.elements?.map((element) => element.id)).toEqual(["el-1"]);
  });

  it("keeps the list's name of the open layout when a canvas change is written into the list", async () => {
    let cache: ReportLayout[] = [layout("layout-a", 3, [text("el-1")])];
    mutateLayoutsMock.mockImplementation((update: unknown) => {
      cache =
        typeof update === "function"
          ? (update as (list: ReportLayout[]) => ReportLayout[])(cache)
          : (update as ReportLayout[]);
    });
    updateMock.mockResolvedValue({ revision: 4 });
    render(<ReportsLayout project={project} />);
    await open(cache[0]);
    // The settings panel renames the open layout in the list.
    cache = [{ ...cache[0], name: "Atlas" }];

    await move("el-1", 20);

    expect(cache[0].name).toBe("Atlas");
    expect(cache[0].config.elements?.[0].position.x).toBe(20);
  });
});
