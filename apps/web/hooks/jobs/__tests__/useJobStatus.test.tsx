import { configureStore } from "@reduxjs/toolkit";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "@/lib/api/processes";
import { jobsReduces } from "@/lib/store/jobs/slice";
import { claimJobAnnouncement } from "@/lib/utils/jobAnnouncement";

import { useJobStatus } from "@/hooks/jobs/JobStatus";

const { useJobsMock, toastMock } = vi.hoisted(() => ({
  useJobsMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-toastify", () => ({ toast: toastMock }));
vi.mock("@/lib/api/processes", () => ({
  useJobs: () => useJobsMock(),
  getJobResult: vi.fn(),
}));

const finished = (processID: string, status: Job["status"]): Job =>
  ({ jobID: "job-1", processID, status }) as unknown as Job;

const renderStatus = (job: Job, onSuccess = vi.fn(), onFailed = vi.fn()) => {
  useJobsMock.mockReturnValue({ jobs: { jobs: [job] }, mutate: vi.fn() });
  const store = configureStore({
    reducer: { jobs: jobsReduces },
    preloadedState: { jobs: { runningJobIds: [job.jobID] } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  renderHook(() => useJobStatus(onSuccess, onFailed), { wrapper });
  return { onSuccess, onFailed };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useJobStatus announcements", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("toasts a tool job that finished", async () => {
    const { onSuccess } = renderStatus(finished("buffer", "successful"));

    expect(onSuccess).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
  });

  it("refreshes without a toast when another tab announced the job", async () => {
    await claimJobAnnouncement("job-1");
    const { onSuccess } = renderStatus(finished("buffer", "successful"));
    await flush();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("refreshes without a toast when another tab announced the failure", async () => {
    await claimJobAnnouncement("job-1");
    const { onFailed } = renderStatus(finished("buffer", "failed"));
    await flush();

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("leaves a project export to the download tray", async () => {
    const { onSuccess } = renderStatus(finished("project_export", "successful"));
    await flush();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
