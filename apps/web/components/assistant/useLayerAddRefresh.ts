"use client";

import { useEffect, useRef } from "react";

import { refreshProjectLayers } from "@/lib/assistant/addToProject";
import { layerAdds } from "@/lib/assistant/addedLayers";
import type { AssistantMessage } from "@/lib/assistant/types";

/**
 * Reads the project's layers, groups and project again when an answer adds a
 * dataset to it (catalog or the user's own), as the Add Layer dialogs do. The
 * adds of the conversation as this chat mounted with it are not read again.
 */
export function useLayerAddRefresh(messages: AssistantMessage[], initialMessages: AssistantMessage[]): void {
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) {
    seen.current = new Set(layerAdds(initialMessages).map((add) => add.key));
  }
  useEffect(() => {
    const known = seen.current;
    if (!known) return;
    for (const add of layerAdds(messages)) {
      if (known.has(add.key)) continue;
      known.add(add.key);
      void refreshProjectLayers(add.projectId);
    }
  }, [messages]);
}
