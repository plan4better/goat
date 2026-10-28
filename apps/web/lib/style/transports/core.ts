// The style transport over core's style routes (spec 13.1): a save is the whole document with the revision it is
// based on; core merges, checks and stores it, and its error codes (`detail.code`) steer the save loop.
import { apiRequestAuth } from "@/lib/api/fetcher";
import { PROJECTS_API_BASE_URL } from "@/lib/api/projects";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { SaveResult, StyleIssue, StyleTransport } from "@/lib/style/save";

interface StyleReply {
  revision: number;
  document: LayerStyle;
  issues?: StyleIssue[];
  stale?: boolean;
}

/** The error code core answers with (`{"detail": {"code": ...}}`), when the body has one. */
async function codeOf(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json();
    return typeof body?.detail?.code === "string" ? body.detail.code : undefined;
  } catch {
    return undefined;
  }
}

export function createCoreTransport(opts: {
  projectId: string;
  layerProjectId: number;
  styleId: string;
}): StyleTransport {
  const url = `${PROJECTS_API_BASE_URL}/${opts.projectId}/layer/${opts.layerProjectId}/style/${opts.styleId}`;
  return {
    async save(body, { keepalive }): Promise<SaveResult> {
      let response: Response;
      try {
        response = await apiRequestAuth(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive,
        });
      } catch {
        return { ok: false, status: 0 };
      }
      if (!response.ok) {
        const code = await codeOf(response);
        return code ? { ok: false, status: response.status, code } : { ok: false, status: response.status };
      }
      const stored = (await response.json()) as StyleReply;
      return { ok: true, document: stored.document, revision: stored.revision, issues: stored.issues ?? [] };
    },
    async load() {
      // The panel opening: core recomputes a style whose data changed, and answers the style's issues.
      const response = await apiRequestAuth(`${url}?check=true`);
      if (!response.ok) throw new Error(`Loading the style failed (${response.status})`);
      const stored = (await response.json()) as StyleReply;
      return {
        document: stored.document,
        revision: stored.revision,
        issues: stored.issues ?? [],
        stale: stored.stale ?? false,
      };
    },
  };
}
