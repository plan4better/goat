"use client";

import { useRef, useState } from "react";

import { RevisionedSaver, type RevisionedSaverOptions, type SaveConflict } from "@/lib/utils/revisionedSaver";

interface UseRevisionedSaverArgs<U> {
  send: RevisionedSaverOptions<U>["send"];
  isOpen: RevisionedSaverOptions<U>["isOpen"];
  /** Where the revisions are kept; the hook keeps its own when left out. */
  revisions?: { get: (id: string) => number | undefined; set: (id: string, revision: number) => void };
}

/**
 * One {@link RevisionedSaver} for the editor's lifetime, with its open
 * conflict as state. The arguments are read when a save goes out, so they may
 * change from render to render.
 */
export function useRevisionedSaver<U extends object>(
  args: UseRevisionedSaverArgs<U>
): { saver: RevisionedSaver<U>; conflict: SaveConflict | null } {
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  const latest = useRef(args);
  latest.current = args;
  const [saver] = useState(() => {
    const own = new Map<string, number>();
    return new RevisionedSaver<U>({
      send: (id, update, baseRevision) => latest.current.send(id, update, baseRevision),
      isOpen: (id) => latest.current.isOpen(id),
      getRevision: (id) => (latest.current.revisions ?? own).get(id),
      setRevision: (id, revision) => {
        (latest.current.revisions ?? own).set(id, revision);
      },
      onConflict: setConflict,
    });
  });
  return { saver, conflict };
}
