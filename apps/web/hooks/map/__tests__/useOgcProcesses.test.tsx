import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, i18n } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  i18n: { language: "de" },
}));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n }) }));

import { useProcessExecution } from "@/hooks/map/useOgcProcesses";

describe("useProcessExecution", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ jobID: "job-1" }) });
  });

  it("sends the language the user sees the app in, so the run writes its legend titles in it", async () => {
    i18n.language = "de";
    const { result } = renderHook(() => useProcessExecution());

    await act(async () => {
      await result.current.execute("buffer", { input_layer_id: "layer" });
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/processes\/buffer\/execution$/);
    expect(init.headers).toEqual({ "Content-Type": "application/json", "Accept-Language": "de" });
    expect(JSON.parse(init.body)).toEqual({ inputs: { input_layer_id: "layer" } });
  });

  it("reads the app language when the run starts", async () => {
    i18n.language = "de";
    const { result } = renderHook(() => useProcessExecution());
    i18n.language = "en";

    await act(async () => {
      await result.current.execute("buffer", {});
    });

    expect(fetchMock.mock.calls[0][1].headers["Accept-Language"]).toBe("en");
  });
});
