import { describe, expect, it, vi } from "vitest";

import { AssetUploadError, uploadAsset } from "@/lib/api/assets";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock, fetcher: vi.fn() }));
vi.mock("swr", () => ({ default: vi.fn(() => ({})) }));

const refused = (status: number, text: string) => ({ ok: false, status, text: async () => text });
const upload = () =>
  uploadAsset(new File(["x"], "a.png", { type: "image/png" }), "icon", { displayName: "a" });

describe("uploadAsset", () => {
  it("a refused upload carries core's status and reason", async () => {
    fetchMock.mockResolvedValueOnce(
      refused(400, JSON.stringify({ detail: "File too large. Maximum allowed size is 4 MB." }))
    );
    const error = await upload().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssetUploadError);
    expect(error).toMatchObject({ status: 400, detail: "File too large. Maximum allowed size is 4 MB." });
  });

  it("a refusal that is not JSON keeps its text as the reason", async () => {
    fetchMock.mockResolvedValueOnce(refused(413, "<html>Request Entity Too Large</html>"));
    await expect(upload()).rejects.toMatchObject({
      status: 413,
      detail: "<html>Request Entity Too Large</html>",
    });
  });
});
