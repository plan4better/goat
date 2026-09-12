import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadFileToS3 } from "@/lib/services/s3";

const presigned = {
  url: "http://s3.test/bucket/k?X-Amz-Signature=s",
  key: "k",
  headers: { "Content-Type": "application/geopackage+sqlite3" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadFileToS3", () => {
  it("puts the raw file to the presigned URL with the signed headers", async () => {
    const open = vi.fn();
    const setRequestHeader = vi.fn();
    const send = vi.fn();
    let onLoad: (() => void) | undefined;
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        status = 200;
        upload = { addEventListener: vi.fn() };
        open = open;
        setRequestHeader = setRequestHeader;
        send = send;
        addEventListener = (event: string, handler: () => void) => {
          if (event === "load") onLoad = handler;
        };
      }
    );

    const file = new File(["x"], "a.gpkg");
    const pending = uploadFileToS3(file, presigned);
    onLoad?.();
    await expect(pending).resolves.toBeUndefined();

    expect(open).toHaveBeenCalledWith("PUT", presigned.url);
    expect(setRequestHeader).toHaveBeenCalledWith("Content-Type", "application/geopackage+sqlite3");
    expect(send).toHaveBeenCalledWith(file);
  });

  it("refuses a signal that has already aborted, without opening a request", async () => {
    // The case that mattered: cancelling during the presign call leaves a signal that has
    // already fired, so waiting for another `abort` event would upload the whole file anyway.
    const open = vi.fn();
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        upload = { addEventListener: vi.fn() };
        open = open;
        setRequestHeader = vi.fn();
        send = vi.fn();
        addEventListener = vi.fn();
      }
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadFileToS3(new File(["x"], "a.gpkg"), presigned, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(open).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request when the signal fires", async () => {
    const abort = vi.fn();
    let onAbort: (() => void) | undefined;
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        status = 0;
        upload = { addEventListener: vi.fn() };
        open = vi.fn();
        setRequestHeader = vi.fn();
        send = vi.fn();
        abort = abort;
        addEventListener = (event: string, handler: () => void) => {
          if (event === "abort") onAbort = handler;
        };
      }
    );

    const controller = new AbortController();
    const pending = uploadFileToS3(new File(["x"], "a.gpkg"), presigned, {
      signal: controller.signal,
    });
    controller.abort();
    expect(abort).toHaveBeenCalled();
    onAbort?.();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
