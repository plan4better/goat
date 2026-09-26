import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "@/lib/api/processes";
import { claimJobAnnouncement } from "@/lib/utils/jobAnnouncement";

import JobsPopper from "@/components/jobs/JobsPopper";

const { useJobsMock, toastMock } = vi.hoisted(() => ({
  useJobsMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-toastify", () => ({ toast: toastMock }));
vi.mock("@/lib/api/processes", () => ({
  useJobs: () => useJobsMock(),
  dismissJob: vi.fn(),
}));

const exportJob = (status: Job["status"]): Job =>
  ({
    jobID: "job-1",
    processID: "layer_export",
    status,
    result:
      status === "successful"
        ? { download_url: "https://s3.example/export.zip", file_name: "export.zip" }
        : undefined,
  }) as unknown as Job;

const setJobs = (jobs: Job[]) => useJobsMock.mockReturnValue({ jobs: { jobs }, mutate: vi.fn() });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("JobsPopper auto-download", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(["zip"]) });
    vi.stubGlobal("fetch", fetchMock);
    URL.createObjectURL = vi.fn(() => "blob:export");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("downloads an export that finishes while the tab is open", async () => {
    setJobs([exportJob("running")]);
    const { rerender } = render(<JobsPopper />);

    setJobs([exportJob("successful")]);
    rerender(<JobsPopper />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://s3.example/export.zip"));
    expect(toastMock.success).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when another tab already announced the export", async () => {
    setJobs([exportJob("running")]);
    const { rerender } = render(<JobsPopper />);

    await claimJobAnnouncement("job-1");
    setJobs([exportJob("successful")]);
    rerender(<JobsPopper />);
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
