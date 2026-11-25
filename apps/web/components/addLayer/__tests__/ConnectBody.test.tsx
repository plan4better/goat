import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { detectDirectService } from "@/lib/utils/externalService";

import type { ConnectFlow } from "@/hooks/addLayer/useConnectFlow";

import ConnectBody from "@/components/addLayer/ConnectBody";

/**
 * The preview of a COG address: the browser reads the file's details first, and draws only a file it can draw,
 * fitted to it; any other file says so in place of the map, and the layer can still be added.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

const cog = vi.hoisted(() => ({ getCogMetadata: vi.fn() }));
vi.mock("@geomatico/maplibre-cog-protocol", () => ({
  getCogMetadata: cog.getCogMetadata,
  cogProtocol: vi.fn(),
}));

/** The views the preview map was rendered with: a map reads its first view once, when it is created. */
const map = vi.hoisted(() => ({ opened: [] as unknown[] }));
vi.mock("react-map-gl/maplibre", () => ({
  Map: function MapMock({
    initialViewState,
    children,
  }: {
    initialViewState?: unknown;
    children?: React.ReactNode;
  }) {
    map.opened.push(initialViewState);
    return <div data-testid="preview-map">{children}</div>;
  },
  Source: ({ url }: { url?: string }) => <i data-testid="preview-source" data-url={url} />,
  Layer: () => null,
}));
vi.mock("@/hooks/catalog/useCatalogBasemapStyle", () => ({ useCatalogBasemapStyle: () => undefined }));
vi.mock("@/components/dashboard/common/DetailMapAttribution", () => ({ default: () => null }));

const URL =
  "https://data.example.org/dem/Copernicus_DSM_COG_10_N52_00_E013_00_DEM/Copernicus_DSM_COG_10_N52_00_E013_00_DEM.tif";

/** The flow once an address is connected: each Connect reads the address into a new service. */
const controller = (url = URL): ConnectFlow =>
  ({
    action: { label: "add_layer", disabled: false, run: vi.fn() },
    isBusy: false,
    reset: vi.fn(),
    connect: {
      address: url,
      setAddress: vi.fn(),
      connect: vi.fn(),
      status: "connected",
      service: detectDirectService(url)!,
      selected: [],
      toggleLayer: vi.fn(),
      focusedId: null,
      name: "Copernicus_DSM_COG_10_N52_00_E013_00_DEM",
      setName: vi.fn(),
      folders: [],
      selectedFolder: null,
      setSelectedFolder: vi.fn(),
    },
  }) as unknown as ConnectFlow;

const details = (bbox: number[]) => ({
  offset: 0,
  scale: 1,
  bbox,
  images: [{ zoom: 12, isOverview: false, isMask: false }],
});

/** The layer can still be added: the address, its Connect button, the name and where it is saved stay. */
const expectAddable = () => {
  expect(
    (screen.getByRole("button", { name: "connect_service_connect" }) as HTMLButtonElement).disabled
  ).toBe(false);
  expect((screen.getByLabelText("layer_name") as HTMLInputElement).value).toBe(
    "Copernicus_DSM_COG_10_N52_00_E013_00_DEM"
  );
  expect(screen.getByText("connect_service_save_to")).toBeInTheDocument();
};

/** A read of the file's details that answers when the test says. */
const deferred = () => {
  let answer!: (value: unknown) => void;
  let refuse!: (reason: unknown) => void;
  const promise = new Promise((resolve, reject) => {
    answer = resolve;
    refuse = reject;
  });
  return { promise, answer, refuse };
};

beforeEach(() => {
  cog.getCogMetadata.mockReset();
  map.opened = [];
});

describe("ConnectBody: the preview of a COG", () => {
  it("says a file the browser cannot read cannot be previewed, in place of the map", async () => {
    cog.getCogMetadata.mockRejectedValue(new AggregateError([], "Request failed"));
    render(<ConnectBody controller={controller()} />);

    expect(await screen.findByText("connect_service_cog_no_preview")).toBeInTheDocument();
    // The address itself, with a key of its own after it that no request carries.
    expect(String(cog.getCogMetadata.mock.calls[0][0]).startsWith(`${URL}#`)).toBe(true);
    expect(screen.queryByTestId("preview-map")).toBeNull();
    expectAddable();
  });

  it("says a file in degrees cannot be previewed", async () => {
    cog.getCogMetadata.mockResolvedValue(details([0.000117, 0.000467, 0.000126, 0.000476]));
    render(<ConnectBody controller={controller()} />);

    expect(await screen.findByText("connect_service_cog_no_preview")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-source")).toBeNull();
    expectAddable();
  });

  it("draws a web mercator file on a map that opens on the file", async () => {
    cog.getCogMetadata.mockResolvedValue(details([13, 52, 14, 53]));
    render(<ConnectBody controller={controller()} />);

    const source = await screen.findByTestId("preview-source");
    expect(source.getAttribute("data-url")).toBe(`cog://${URL}`);
    expect(map.opened[0]).toEqual(expect.objectContaining({ bounds: [13, 52, 14, 53] }));
    expect(screen.queryByText("connect_service_cog_no_preview")).toBeNull();
    expectAddable();
  });

  it("shows the loading indicator while the file is read, then the map", async () => {
    const read = deferred();
    cog.getCogMetadata.mockReturnValue(read.promise);
    render(<ConnectBody controller={controller()} />);

    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-map")).toBeNull();
    expect(screen.queryByText("connect_service_pick_to_preview")).toBeNull();
    expect(screen.queryByText("connect_service_cog_no_preview")).toBeNull();

    await act(async () => read.answer(details([13, 52, 14, 53])));
    expect(screen.getByTestId("preview-source")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows the loading indicator while the file is read, then the note", async () => {
    const read = deferred();
    cog.getCogMetadata.mockReturnValue(read.promise);
    render(<ConnectBody controller={controller()} />);

    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    await act(async () => read.refuse(new AggregateError([], "Request failed")));
    expect(screen.getByText("connect_service_cog_no_preview")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("reads the file again when the same address is connected again after a failed read", async () => {
    cog.getCogMetadata.mockRejectedValueOnce(new AggregateError([], "Request failed"));
    const view = render(<ConnectBody controller={controller()} />);
    expect(await screen.findByText("connect_service_cog_no_preview")).toBeInTheDocument();

    const read = deferred();
    cog.getCogMetadata.mockReturnValueOnce(read.promise);
    view.rerender(<ConnectBody controller={controller()} />);
    // The earlier answer is not shown while the new read runs.
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText("connect_service_cog_no_preview")).toBeNull();

    await act(async () => read.answer(details([13, 52, 14, 53])));
    expect(screen.getByTestId("preview-source").getAttribute("data-url")).toBe(`cog://${URL}`);
    // Each read has a key of its own: the reader keeps a failed read by its address.
    const [first, second] = cog.getCogMetadata.mock.calls.map(([key]) => key);
    expect(cog.getCogMetadata).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it("never shows the answer for an address that has since changed", async () => {
    const OTHER = "https://data.example.org/dem/other.tif";
    const first = deferred();
    const second = deferred();
    cog.getCogMetadata.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<ConnectBody controller={controller()} />);
    view.rerender(<ConnectBody controller={controller(OTHER)} />);

    await act(async () => first.answer(details([13, 52, 14, 53])));
    expect(screen.queryByTestId("preview-map")).toBeNull();
    expect(screen.queryByText("connect_service_cog_no_preview")).toBeNull();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    await act(async () => second.answer(details([0.000117, 0.000467, 0.000126, 0.000476])));
    expect(screen.getByText("connect_service_cog_no_preview")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-map")).toBeNull();
  });
});
