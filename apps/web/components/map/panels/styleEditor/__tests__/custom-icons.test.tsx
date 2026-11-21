import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "react-toastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssetUploadError, deleteAsset, uploadAsset } from "@/lib/api/assets";
import type { UploadedAsset } from "@/lib/validations/assets";

import { CustomIconPane } from "@/components/map/panels/styleEditor/pickers/CustomIconPane";
import { IconGlyph } from "@/components/map/panels/styleEditor/pickers/IconGlyph";

import { renderPanel } from "./renderPanel";

const mutate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/api/assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/assets")>()),
  uploadAsset: vi.fn(),
  deleteAsset: vi.fn(async () => undefined),
  updateAsset: vi.fn(),
  useAssets: () => ({ mutate }),
}));
vi.mock("react-toastify", () => ({ toast: { error: vi.fn() } }));

const asset = (id: string, name: string): UploadedAsset => ({
  id,
  file_name: `${name}.png`,
  display_name: name,
  user_id: "00000000-0000-4000-8000-000000000000",
  url: `https://example.com/${id}.png`,
  mime_type: "image/png",
  file_size: 100,
  asset_type: "icon",
});
const BENCH = asset("11111111-1111-4111-8111-111111111111", "Bench");
const TREE = asset("22222222-2222-4222-8222-222222222222", "Tree");

const png = (name = "Park bench.png") => new File(["x"], name, { type: "image/png" });

function renderPane(uploads: UploadedAsset[] = [], value?: string) {
  const onPick = vi.fn();
  const result = renderPanel(<CustomIconPane value={value} onPick={onPick} />, { data: { uploads } });
  const input = result.container.querySelector("input[type=file]") as HTMLInputElement;
  return { ...result, onPick, input };
}

/** An upload that answers when `finish` is called. */
function pendingUpload() {
  let finish: (asset: UploadedAsset) => void = () => undefined;
  vi.mocked(uploadAsset).mockReturnValue(new Promise((resolve) => (finish = resolve)));
  return (done: UploadedAsset) => act(async () => finish(done));
}

beforeEach(() => {
  vi.mocked(uploadAsset).mockReset();
  vi.mocked(deleteAsset).mockClear();
  vi.mocked(toast.error).mockClear();
  mutate.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("custom icons", () => {
  it("a chosen file uploads at once under its name, the Upload button busy meanwhile, and is picked", async () => {
    const finish = pendingUpload();
    const { input, onPick } = renderPane([TREE]);
    fireEvent.change(input, { target: { files: [png()] } });
    expect(uploadAsset).toHaveBeenCalledWith(expect.any(File), "icon", { displayName: "Park bench" });
    // No name field to fill: the search is the pane's only text box, and the upload has started.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    const busy = screen.getByRole("button", { name: "style_editor.icon_uploading" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(within(busy).getByRole("progressbar")).toBeDefined();
    // No tile for the upload: the grid holds the icons only.
    expect(
      [...document.querySelectorAll(".goat-icon-tile")].map((tile) => tile.getAttribute("aria-label"))
    ).toEqual(["Tree"]);
    await finish(BENCH);
    expect(mutate).toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledWith(`asset:${BENCH.id}`);
    expect(screen.queryByRole("button", { name: "style_editor.icon_uploading" })).toBeNull();
    expect((screen.getByRole("button", { name: "upload" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("without icons the drop zone shows; with icons an Upload button beside Manage, no upload tile", async () => {
    const empty = renderPane([]);
    expect(screen.getByRole("button", { name: /style_editor.icon_upload_drop/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: "upload" })).toBeNull();
    empty.unmount();

    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    renderPane([BENCH, TREE]);
    expect(screen.queryByText("style_editor.icon_upload_drop")).toBeNull();
    const tiles = document.querySelectorAll(".goat-icon-tile");
    expect([...tiles].map((tile) => tile.getAttribute("aria-label"))).toEqual(["Bench", "Tree"]);
    const upload = screen.getByRole("button", { name: "upload" });
    // In the heading's row, before Manage.
    const manage = screen.getByRole("button", { name: "style_editor.icon_manage" });
    expect(upload.compareDocumentPosition(manage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(upload);
    expect(click).toHaveBeenCalledTimes(1);

    // While managing too.
    await userEvent.click(manage);
    await userEvent.click(screen.getByRole("button", { name: "upload" }));
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("a file dropped anywhere on the pane uploads, the pane marked while dragging", async () => {
    const finish = pendingUpload();
    const { container } = renderPane([BENCH]);
    const pane = container.querySelector("[data-drop-target]") as HTMLElement;
    const tile = screen.getByRole("button", { name: "Bench" });
    fireEvent.dragOver(tile, { dataTransfer: { types: ["Files"] } });
    expect(pane.getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(tile, { dataTransfer: { files: [png("Bin.svg")], types: ["Files"] } });
    expect(pane.getAttribute("data-dragging")).toBeNull();
    expect(uploadAsset).toHaveBeenCalledWith(expect.any(File), "icon", { displayName: "Bin" });
    await finish(TREE);
  });

  it("a file dropped while managing uploads too and stays in Manage", async () => {
    const finish = pendingUpload();
    const { container, onPick } = renderPane([BENCH]);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.icon_manage" }));
    const pane = container.querySelector("[data-drop-target]") as HTMLElement;
    fireEvent.drop(pane, { dataTransfer: { files: [png("Bin.svg")], types: ["Files"] } });
    expect(uploadAsset).toHaveBeenCalledWith(expect.any(File), "icon", { displayName: "Bin" });
    expect(screen.getAllByRole("textbox", { name: "rename" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "style_editor.icon_uploading" })).toBeDefined();
    await finish(TREE);
    expect(mutate).toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledWith(`asset:${TREE.id}`);
    // Still the list, where the new icon's row comes with the refreshed icons.
    expect(screen.getByRole("textbox", { name: "rename" })).toBeDefined();
    expect(document.querySelector(".goat-icon-tile")).toBeNull();
  });

  it("deleting asks first, in place, and says layers using the icon show none", async () => {
    renderPane([BENCH]);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.icon_manage" }));
    await userEvent.click(screen.getByRole("button", { name: "style_editor.icon_delete" }));
    expect(deleteAsset).not.toHaveBeenCalled();
    const ask = screen.getByRole("alert");
    expect(within(ask).getByText("style_editor.icon_delete_confirm")).toBeDefined();
    await userEvent.click(within(ask).getByRole("button", { name: "cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(deleteAsset).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "style_editor.icon_delete" }));
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "delete" }));
    expect(deleteAsset).toHaveBeenCalledWith(BENCH.id);
    expect(mutate).toHaveBeenCalled();
  });

  it("the file input takes only the types core takes for icons", () => {
    const { input } = renderPane([]);
    const accept = input.getAttribute("accept")?.split(",") ?? [];
    expect(accept).not.toContain("image/*");
    for (const type of [
      "image/svg+xml",
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/bmp",
      "image/x-icon",
    ])
      expect(accept).toContain(type);
    for (const ext of [".svg", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".ico"])
      expect(accept).toContain(ext);
  });

  it("a file of another type or too large is refused before upload, saying why", () => {
    const { input } = renderPane([]);
    fireEvent.change(input, { target: { files: [new File(["x"], "cat.gif", { type: "image/gif" })] } });
    fireEvent.change(input, { target: { files: [new File(["x"], "photo.heic", { type: "" })] } });
    expect(toast.error).toHaveBeenNthCalledWith(1, "style_editor.icon_upload_type");
    expect(toast.error).toHaveBeenNthCalledWith(2, "style_editor.icon_upload_type");
    const big = png();
    Object.defineProperty(big, "size", { value: 5 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(toast.error).toHaveBeenLastCalledWith("style_editor.icon_upload_size");
    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it("an upload the server refuses shows its reason, not the generic message", async () => {
    const { input } = renderPane([]);
    vi.mocked(uploadAsset).mockRejectedValueOnce(
      new AssetUploadError(
        400,
        "Invalid file type for asset_type 'icon'. Allowed types: image/png. Received: x"
      )
    );
    await act(async () => void fireEvent.change(input, { target: { files: [png()] } }));
    expect(toast.error).toHaveBeenLastCalledWith("style_editor.icon_upload_type");
    vi.mocked(uploadAsset).mockRejectedValueOnce(
      new AssetUploadError(400, "File too large. Maximum allowed size is 2 MB.")
    );
    await act(async () => void fireEvent.change(input, { target: { files: [png()] } }));
    expect(toast.error).toHaveBeenLastCalledWith("style_editor.icon_upload_size");
    // A proxy in front of core refusing the body itself.
    vi.mocked(uploadAsset).mockRejectedValueOnce(new AssetUploadError(413, "<html>Too large</html>"));
    await act(async () => void fireEvent.change(input, { target: { files: [png()] } }));
    expect(toast.error).toHaveBeenLastCalledWith("style_editor.icon_upload_size");
    vi.mocked(toast.error).mockClear();
    vi.mocked(uploadAsset).mockRejectedValueOnce(new Error("offline"));
    await act(async () => void fireEvent.change(input, { target: { files: [png()] } }));
    expect(toast.error).toHaveBeenLastCalledWith("icon_upload_failed");
  });

  it("an icon whose image does not load shows a placeholder, keeping its name", async () => {
    renderPane([BENCH]);
    const tile = screen.getByRole("button", { name: "Bench" });
    fireEvent.error(tile.querySelector("img") as HTMLImageElement);
    expect(tile.querySelector("img")).toBeNull();
    expect(tile.querySelector("[data-icon-failed]")).not.toBeNull();
    expect(tile.getAttribute("title")).toBe("Bench");

    await userEvent.click(screen.getByRole("button", { name: "style_editor.icon_manage" }));
    const row = screen.getByRole("textbox", { name: "rename" }).parentElement?.parentElement as HTMLElement;
    fireEvent.error(row.querySelector("img") as HTMLImageElement);
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("[data-icon-failed]")).not.toBeNull();
  });

  it("the picked upload's glyph falls back to the placeholder when its image does not load", () => {
    const { container } = renderPanel(<IconGlyph iconRef={`asset:${BENCH.id}`} size={16} />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-icon-failed]")).not.toBeNull();
  });

  it("an upload's glyph loads as a CORS request, as the map loads it", () => {
    // The map draws icons onto a canvas, so it loads them with crossorigin; the picker loads the same URL the same way,
    // so the two share what the browser caches for it.
    const { container } = renderPanel(<IconGlyph iconRef={`asset:${BENCH.id}`} size={16} />);
    expect(container.querySelector("img")?.getAttribute("crossorigin")).toBe("anonymous");
  });
});
