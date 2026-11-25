// The scene store of a project page: it starts from the map request's cached scene, a stored save goes into that
// cache, and a later revalidation does not replace the store being edited.
import { act, render, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import useSWR, { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";

import { projectMapUrl } from "@/lib/api/map";
import type { EditorStore } from "@/lib/style/editor/store";

import { SceneStoreProvider, useSceneDocument, useSceneStoreContext } from "@/hooks/map/useSceneStore";

const { put } = vi.hoisted(() => ({
  put: vi.fn(async (_projectId: string, scene: unknown) => ({ stored: true, scene, issues: [] })),
}));
vi.mock("@/lib/api/map", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  putScene: put,
}));

afterEach(() => put.mockClear());

const KEY = projectMapUrl("p");

/** The map request as the server answers it: always the scene of the first open. */
const fetcher = async () => ({ map: { scene: { light: { direction: 90 } } }, styles: {}, unpublished: [] });

let store: EditorStore | null = null;
const seen: string[] = [];

function Reader() {
  store = useSceneStoreContext();
  seen.push(JSON.stringify(useSceneDocument(store)));
  return null;
}

function Page() {
  const { data } = useSWR(KEY, fetcher, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    revalidateOnReconnect: false,
    revalidateOnMount: true,
  });
  if (!data) return null;
  return h(SceneStoreProvider, {
    projectId: "p",
    initial: data.map.scene as never,
    editable: true,
    children: h(Reader),
  });
}

describe("useSceneStore", () => {
  it("a second open in the same tab starts from the scene the last save stored", async () => {
    const cache = new Map();
    const tree = () => h(SWRConfig, { value: { provider: () => cache, dedupingInterval: 0 } }, h(Page));
    const first = render(tree());
    await waitFor(() => expect(seen.at(-1)).toContain("90"));
    act(() => store!.set("scene.light.direction", 270));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(put.mock.calls[0][1]).toEqual({ light: { direction: 270 } });
    // The stored scene is in the cache without asking the server again.
    await waitFor(() => expect(cache.get(KEY)?.data?.map.scene).toEqual({ light: { direction: 270 } }));
    first.unmount();

    seen.length = 0;
    render(tree());
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]).toContain("270");
    // The mount revalidation answers the older scene; the store being edited keeps its own.
    await waitFor(() => expect(cache.get(KEY)?.data?.map.scene).toEqual({ light: { direction: 90 } }));
    expect(seen.at(-1)).toContain("270");
  });
});
