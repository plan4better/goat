"use client";

// Keeps one layer of the map in step with the style being edited: compiles it on the next animation frame after a
// change (only the latest change of a frame counts) and applies the difference.
import type { Map as MaplibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput, CompiledLayer } from "@/lib/style/compile/types";
import { type PreviewMap, applyCompiled, removeCompiled, withTileParams } from "@/lib/style/render/apply";

export function useLivePreview(
  map: MaplibreMap | null,
  input: CompileInput | null,
  opts: { beforeId?: string } = {}
): CompiledLayer | null {
  const [compiled, setCompiled] = useState<CompiledLayer | null>(null);
  const applied = useRef<CompiledLayer | null>(null);
  const latest = useRef<CompileInput | null>(input);
  const frame = useRef<number | null>(null);
  const beforeId = opts.beforeId;
  latest.current = input;

  useEffect(() => {
    if (!map || !input || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const current = latest.current;
      if (!current) return;
      const next = withTileParams(compileLayer(current));
      applyCompiled(map as unknown as PreviewMap, applied.current, next, { beforeId });
      applied.current = next;
      setCompiled(next);
    });
  }, [map, input, beforeId]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      if (map && applied.current) removeCompiled(map as unknown as PreviewMap, applied.current);
      applied.current = null;
    },
    [map]
  );

  return compiled;
}
