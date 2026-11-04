import { z } from "zod";

/**
 * How long a save of a workflow, report layout or dashboard may take. One
 * that has not answered by then fails like any other failed save: the
 * editor's saves go one at a time, so a request that hangs (a laptop waking
 * from sleep, a stalled proxy) would otherwise hold back every save after it.
 */
export const SAVE_TIMEOUT_MS = 30_000;

/** Who saved the document last, as core names them in a conflict. */
const changedBySchema = z.object({
  id: z.string(),
  firstname: z.string().nullable().optional(),
  lastname: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
});

export type ChangedBy = z.infer<typeof changedBySchema>;

const changedElsewhereSchema = z.object({
  detail: z.literal("changed_elsewhere"),
  revision: z.number().int(),
  updated_at: z.string().nullable().optional(),
  updated_by: changedBySchema.nullable().optional(),
});

/**
 * A save core refused because the document changed since the revision the
 * editor read: a workflow, a report layout or a project's dashboard.
 */
export class ChangedElsewhereError extends Error {
  constructor(
    /** The revision core holds now: "Keep mine" saves on top of it. */
    public readonly revision: number,
    /** When the stored document was last saved (ISO 8601). */
    public readonly updatedAt: string | null,
    /** Who saved it last; null when nobody is recorded. */
    public readonly updatedBy: ChangedBy | null
  ) {
    super("The document was changed elsewhere.");
    this.name = "ChangedElsewhereError";
  }
}

/**
 * The conflict a failed save's answer reports, if it is one. Core answers a
 * database error on the same routes with 409 too, so only a body with
 * `detail: "changed_elsewhere"` counts.
 */
export const changedElsewhere = async (response: Response): Promise<ChangedElsewhereError | undefined> => {
  if (response.status !== 409) return undefined;
  try {
    const parsed = changedElsewhereSchema.safeParse(JSON.parse(await response.text()));
    if (!parsed.success) return undefined;
    const { revision, updated_at, updated_by } = parsed.data;
    return new ChangedElsewhereError(revision, updated_at ?? null, updated_by ?? null);
  } catch {
    // Not JSON: an error page or plain text.
    return undefined;
  }
};
