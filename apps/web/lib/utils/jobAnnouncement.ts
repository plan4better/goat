const STORAGE_KEY = "goat:announced-jobs";
const LOCK_NAME = "goat:job-announce";
const MARK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Marks = Record<string, number>;

const readMarks = (): Marks => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Marks) : {};
  } catch {
    return {};
  }
};

const claim = (jobId: string): boolean => {
  const now = Date.now();
  const marks = readMarks();
  if (marks[jobId] !== undefined && now - marks[jobId] < MARK_TTL_MS) return false;

  const kept: Marks = { [jobId]: now };
  for (const [id, at] of Object.entries(marks)) {
    if (now - at < MARK_TTL_MS) kept[id] = at;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  return true;
};

/**
 * Whether this tab is the one to tell the user that a job finished.
 *
 * Every open tab polls the same job list, so each one sees the job finish and
 * would toast it, and download an export or print once more. The first tab to
 * ask gets `true`; the others get `false` and only update their own views. The
 * Web Lock makes check-and-mark one step across tabs, and the mark lives in
 * localStorage so a tab that looks later also skips the job.
 *
 * Where storage cannot be used there is nothing to share, so the tab announces.
 */
export async function claimJobAnnouncement(jobId: string): Promise<boolean> {
  const run = () => {
    try {
      return claim(jobId);
    } catch {
      return true;
    }
  };
  if (typeof navigator === "undefined" || !navigator.locks) return run();
  try {
    return await navigator.locks.request(LOCK_NAME, run);
  } catch {
    return run();
  }
}
