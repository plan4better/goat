// A style transport without core (until the style endpoints exist, and in the development route): the document lives
// in memory, and every save is checked and computed by the processes service's style-check, as core will do (spec
// 13.1 steps 2 to 4).
import { apiRequestAuth } from "@/lib/api/fetcher";
import { PROCESSES_API_BASE_URL } from "@/lib/api/processes";
import type { Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { StyleIssue, StyleTransport } from "@/lib/style/save";

type Check = (doc: LayerStyle) => Promise<{ document: LayerStyle; issues: StyleIssue[] }>;

export function createMemoryTransport(opts: {
  document: LayerStyle;
  revision?: number;
  check: Check;
}): StyleTransport {
  let document = opts.document;
  let revision = opts.revision ?? 1;
  return {
    async save(body) {
      try {
        const checked = await opts.check(body.document);
        document = checked.document;
        revision += 1;
        return { ok: true, document, revision, issues: checked.issues };
      } catch {
        return { ok: false, status: 503 };
      }
    },
    load: async () => ({ document, revision }),
  };
}

/** The style-check process of `layerId`: validates a document against the layer's data and fills its computed values. */
export function styleCheck(opts: { layerId: string; geometry?: Geometry }): Check {
  return async (doc) => {
    const response = await apiRequestAuth(`${PROCESSES_API_BASE_URL}/style-check/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: { collection: opts.layerId, document: doc, geometry: opts.geometry, compute: true },
      }),
    });
    if (!response.ok) throw new Error(`style-check answered ${response.status}`);
    const result = await response.json();
    return { document: result.document as LayerStyle, issues: (result.issues ?? []) as StyleIssue[] };
  };
}
