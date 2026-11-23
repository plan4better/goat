import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AddressedOrigin } from "@/lib/utils/layerOrigin";

import LayerAddress from "@/components/common/LayerAddress";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

const file = (url: string): AddressedOrigin => ({ kind: "remote_file", format: "cog", url });

const SIGNED = "https://example.org/b.tif?sig=x";
const WMS_TEMPLATE = "https://example.org/geoserver/ows?SERVICE=WMS&BBOX={bbox-epsg-3857}";
const WFS_URL =
  "https://www.wfs.nrw.de/geobasis/wfs_nw_alkis_vereinfacht?SERVICE=WFS&REQUEST=GetCapabilities";

const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
};

describe("LayerAddress", () => {
  it("shows someone who may not edit the layer the address without its query string", () => {
    const { container } = render(<LayerAddress origin={file(SIGNED)} canEdit={false} />);

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("example.org/b.tif");
    expect(link.getAttribute("href")).toBe("https://example.org/b.tif");
    expect(container.innerHTML).not.toContain("sig=x");
  });

  it("shows an editor the whole address", () => {
    render(<LayerAddress origin={file(SIGNED)} canEdit />);

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("example.org/b.tif?sig=x");
    expect(link.getAttribute("href")).toBe(SIGNED);
  });

  it("opens a file's address in a new tab, without handing it this page", () => {
    render(<LayerAddress origin={file(SIGNED)} canEdit={false} />);

    const link = screen.getByRole("link");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")?.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  });

  it("shows the full address on hover", async () => {
    render(<LayerAddress origin={file(SIGNED)} canEdit={false} />);

    fireEvent.mouseOver(screen.getByRole("link"));
    expect((await screen.findByRole("tooltip")).textContent).toBe("https://example.org/b.tif");
  });

  it("shows the host and the file name in full, the folders between left out, wrapping where it must", () => {
    render(
      <LayerAddress
        origin={file("https://maplibre.org/maplibre-gl-js/docs/assets/cog.tif?sig=x")}
        canEdit={false}
      />
    );

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("maplibre.org/…/cog.tif");
    expect(link.getAttribute("href")).toBe("https://maplibre.org/maplibre-gl-js/docs/assets/cog.tif");
    // No ellipsis cuts it: a long host or file name wraps onto further lines, in whatever row holds it.
    expect(getComputedStyle(link.parentElement as HTMLElement).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(link).textOverflow).not.toBe("ellipsis");
  });

  it.each([
    [false, "https://example.org/geoserver/ows"],
    [true, WMS_TEMPLATE],
  ])(
    "shows a map service's address as text, not a link, without its query (editor: %s)",
    async (canEdit, full) => {
      const writeText = stubClipboard();
      render(
        <LayerAddress origin={{ kind: "map_service", service: "wms", url: WMS_TEMPLATE }} canEdit={canEdit} />
      );

      // A tile template or a GetMap request opens no useful page.
      expect(screen.queryByRole("link")).toBeNull();
      const text = screen.getByText("example.org/…/ows");
      // Reachable by keyboard, so its tooltip opens there too.
      expect(text.getAttribute("tabindex")).toBe("0");
      // The whole address it may see is on hover and in the copy.
      fireEvent.mouseOver(text);
      expect((await screen.findByRole("tooltip")).textContent).toBe(full);
      fireEvent.click(screen.getByRole("button", { name: "metadata.copy_address" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(full));
    }
  );

  it.each([
    [false, "https://www.wfs.nrw.de/geobasis/wfs_nw_alkis_vereinfacht"],
    [true, WFS_URL],
  ])("shows the host and path of the WFS a copy came from, as text (editor: %s)", async (canEdit, full) => {
    const writeText = stubClipboard();
    render(<LayerAddress origin={{ kind: "wfs_copy", url: WFS_URL }} canEdit={canEdit} />);

    // A WFS address opens a capabilities document or a download, not a page.
    expect(screen.queryByRole("link")).toBeNull();
    const text = screen.getByText("www.wfs.nrw.de/…/wfs_nw_alkis_vereinfacht");
    fireEvent.mouseOver(text);
    expect((await screen.findByRole("tooltip")).textContent).toBe(full);
    fireEvent.click(screen.getByRole("button", { name: "metadata.copy_address" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(full));
  });

  it("shows a percent-encoded file name as it reads; the link and the copy keep the real address", async () => {
    const writeText = stubClipboard();
    render(<LayerAddress origin={file("https://example.org/data/My%20File.tif")} canEdit={false} />);

    const link = screen.getByRole("link");
    expect(link.textContent).toBe("example.org/…/My File.tif");
    expect(link.getAttribute("href")).toBe("https://example.org/data/My%20File.tif");
    fireEvent.click(screen.getByRole("button", { name: "metadata.copy_address" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://example.org/data/My%20File.tif"));
  });

  it("never shows someone who may not edit the layer a user and password in the address", () => {
    const { container } = render(
      <LayerAddress origin={file("https://reader:secret@example.org/b.tif")} canEdit={false} />
    );

    expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.org/b.tif");
    expect(container.innerHTML).not.toContain("secret");
  });

  it("puts the copy button after the address, in the same line of text", () => {
    render(<LayerAddress origin={file(SIGNED)} canEdit={false} />);

    const link = screen.getByRole("link");
    const copy = screen.getByRole("button", { name: "metadata.copy_address" });
    expect(link.parentElement?.contains(copy)).toBe(true);
    expect(link.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    [false, "https://example.org/b.tif"],
    [true, SIGNED],
  ])("copies the address that person is shown (editor: %s)", async (canEdit, copied) => {
    const writeText = stubClipboard();
    render(<LayerAddress origin={file(SIGNED)} canEdit={canEdit} />);

    fireEvent.click(screen.getByRole("button", { name: "metadata.copy_address" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(copied));
  });
});
