/** A refused API request: its HTTP status and, when core sent one as text, its `detail`. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail?: string
  ) {
    super(detail ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

/** The error of a response that is not ok, for `throw await apiErrorOf(response)`. */
export const apiErrorOf = async (response: Response): Promise<ApiError> => {
  let detail: string | undefined;
  try {
    const body = await response.json();
    if (typeof body?.detail === "string") detail = body.detail;
  } catch {
    // No JSON body (a proxy's 502 page): the status says enough.
  }
  return new ApiError(response.status, detail);
};

type Loose = { status?: unknown; detail?: unknown; info?: { detail?: unknown } };

/** The HTTP status of an ApiError or of an SWR fetcher error (`lib/api/fetcher.ts`). */
export const statusOf = (error: unknown): number | undefined => {
  const status = (error as Loose | null)?.status;
  return typeof status === "number" ? status : undefined;
};

/** Core's `detail` text of an ApiError, a fetcher error or a thrown JSON body. */
export const detailOf = (error: unknown): string | undefined => {
  const loose = error as Loose | null;
  const detail = loose?.detail ?? loose?.info?.detail;
  return typeof detail === "string" ? detail : undefined;
};
