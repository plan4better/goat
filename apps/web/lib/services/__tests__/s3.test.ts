import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadFileToS3 } from "@/lib/services/s3";

const file = new File(["abc"], "data.csv", { type: "text/csv" });

function mockFetch(ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadFileToS3", () => {
  it("puts the raw file to the presigned URL with the signed headers", async () => {
    const fetchMock = mockFetch();

    await uploadFileToS3(file, {
      url: "https://s3.example.org/goat/uploads/data.csv?X-Amz-Signature=s",
      key: "uploads/data.csv",
      headers: { "Content-Type": "text/csv" },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://s3.example.org/goat/uploads/data.csv?X-Amz-Signature=s");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "text/csv" });
    expect(init.body).toBe(file);
  });

  it("throws with the status when the provider rejects the upload", async () => {
    mockFetch(false, 403);

    await expect(
      uploadFileToS3(file, { url: "https://s3.example.org/goat/k", key: "k", headers: {} })
    ).rejects.toThrow("403");
  });
});
