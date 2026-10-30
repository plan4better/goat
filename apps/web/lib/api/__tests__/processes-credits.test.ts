import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequestAuth } from "@/lib/api/fetcher";
import { executeProcessAsync } from "@/lib/api/processes";
import { OutOfCreditsError } from "@/lib/utils/credits";

vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: vi.fn(), fetcher: vi.fn() }));

const reply = (status: number, body: unknown) =>
  vi.mocked(apiRequestAuth).mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  } as Response);

describe("executeProcessAsync", () => {
  beforeEach(() => vi.mocked(apiRequestAuth).mockReset());

  it("raises OutOfCreditsError on a 402, even without a JSON body", async () => {
    vi.mocked(apiRequestAuth).mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => {
        throw new Error("no body");
      },
    } as unknown as Response);
    await expect(executeProcessAsync("layer_import", {})).rejects.toBeInstanceOf(OutOfCreditsError);
  });

  it("keeps the server's message for other failures", async () => {
    reply(500, { detail: "Disk full" });
    await expect(executeProcessAsync("layer_import", {})).rejects.toThrow("Disk full");
  });
});
