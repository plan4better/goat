"use client";

// What the area's row, its picker and their lists share: the area as its host keeps it, the map's draw tool, the
// polygon layers features can be picked from and how a new outline joins the area. Mounted above the picker and its
// lists: a shape is drawn or edited on the map with the picker closed.
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type AreaPiece,
  type FilterArea,
  type PolygonCoords,
  pointCount,
  shapeCount,
} from "@/lib/filter/area";
import { simplifyToFit } from "@/lib/filter/simplify";
import type { JsonObject } from "@/lib/style/json";

import type { AreaHost } from "@/components/map/panels/filter/area/host";
import { circlePiece, editable, withPiece, withReplaced } from "@/components/map/panels/filter/area/pieces";
import { type DrawShape, useAreaDraw } from "@/components/map/panels/filter/area/useAreaDraw";

/** A polygon layer of the project whose features can be picked: its dataset's id, the layer's name, its legend icon
 * (`layerSwatchIcon`) when it has a style, and the CQL the map draws its features with (its saved filter), so the
 * list offers what the map shows; none when the map shows them all. */
export interface AreaLayer {
  id: string;
  name: string;
  icon?: ReactNode;
  filter?: JsonObject;
}

/** What became of the last outline: left out, as even simplified it does not fit into the filter, or waiting for the
 * person to agree to add it simplified (its points, the points it keeps and how far its edges move, in meters). `from`
 * is the list it was picked in, where the note is shown; none for a shape or the map view. */
export type AreaNote = { from?: string } & (
  | { kind: "refused" }
  | { kind: "ask"; points: number; kept: number; shift: number }
);

/** Makes the area with the new outline's polygons in it. */
export type ComposeArea = (polygons: PolygonCoords[]) => FilterArea;

export interface AreaTools extends AreaHost {
  /** Whether a shape can be drawn or edited now: not while one is edited. */
  canDraw: boolean;
  /** The shape being drawn on the map, null when none is. */
  drawing: DrawShape | null;
  /** The piece being edited on the map, null when none is. */
  editing: AreaPiece | null;
  /** The area as its outline is drawn: the piece being edited without its old polygons, as the draw tool shows it. */
  outline: FilterArea | undefined;
  /** Starts a shape on the map; finished, it joins the area. */
  startDraw: (shape: DrawShape) => void;
  /** Loads a drawn polygon into the map's draw tool, or a circle around a point as its centre and radius; finished,
   * the new shape takes the piece's place, within the host's limits as a new shape is. */
  startEdit: (piece: AreaPiece) => void;
  /** Gives the circle at `index` another radius around the same centre, within the host's limits as an edit is. */
  resize: (index: number, km: number) => void;
  /** Finishes the piece being edited. */
  finishEdit: () => void;
  /** Gives up the shape being drawn or edited; an edited piece stays as it was. */
  cancelDraw: () => void;
  layers: readonly AreaLayer[];
  note: AreaNote | null;
  /** Adds an outline to the area as `compose` makes it: at once when it fits into the host's limits, simplified only
   * once the person agrees to the note's question, not at all when even simplified it does not fit. */
  add: (polygons: PolygonCoords[], compose: ComposeArea, from?: string) => void;
  /** Adds the simplified outline the note asks about. */
  confirm: () => void;
  /** Forgets the note and its outline. */
  dismiss: () => void;
  /** Forgets the note of the list `from`: the list closed. */
  dismissFrom: (from: string) => void;
}

const AreaToolsContext = createContext<AreaTools | null>(null);

export function useAreaTools(): AreaTools {
  const tools = useContext(AreaToolsContext);
  if (!tools) throw new Error("useAreaTools needs an AreaToolsProvider");
  return tools;
}

const NO_LAYERS: readonly AreaLayer[] = [];

export function AreaToolsProvider({
  host,
  layers = NO_LAYERS,
  children,
}: {
  host: AreaHost;
  layers?: readonly AreaLayer[];
  children: ReactNode;
}) {
  const { area, read, setArea, limits } = host;
  const {
    available,
    drawing,
    editing: editingNow,
    start,
    edit,
    editCircle,
    finish,
    cancel,
  } = useAreaDraw(host.map);
  // The piece last loaded into the draw tool: the one being edited while the tool edits.
  const [edited, setEdited] = useState<AreaPiece | null>(null);
  const editing = editingNow ? edited : null;
  const [note, setNote] = useState<AreaNote | null>(null);
  // The simplified outline the note asks about.
  const asked = useRef<{ polygons: PolygonCoords[]; compose: ComposeArea; from?: string } | null>(null);
  // The note is about an outline of the area: it goes with the area.
  useEffect(() => {
    if (area) return;
    asked.current = null;
    setNote(null);
  }, [area]);

  /** Whether the area `compose` makes fits into the host's limits as it is now. */
  const fitsWith = useCallback(
    (compose: ComposeArea) => (polygons: PolygonCoords[]) => !limits || limits.fits(compose(polygons)),
    [limits]
  );

  const add = useCallback(
    (polygons: PolygonCoords[], compose: ComposeArea, from?: string) => {
      asked.current = null;
      const fits = fitsWith(compose);
      if (fits(polygons)) {
        setNote(null);
        setArea(compose(polygons));
        return;
      }
      const simplified = simplifyToFit(polygons, fits);
      if (!simplified) {
        setNote({ kind: "refused", from });
        return;
      }
      asked.current = { polygons: simplified.polygons, compose, from };
      const kept = pointCount(simplified.polygons);
      setNote({ kind: "ask", points: pointCount(polygons), kept, shift: simplified.shift, from });
    },
    [fitsWith, setArea]
  );

  const confirm = useCallback(() => {
    const outline = asked.current;
    asked.current = null;
    if (!outline) return;
    // The area can have changed while the question was open.
    if (!fitsWith(outline.compose)(outline.polygons)) {
      setNote({ kind: "refused", from: outline.from });
      return;
    }
    setNote(null);
    setArea(outline.compose(outline.polygons));
  }, [fitsWith, setArea]);

  const dismiss = useCallback(() => {
    asked.current = null;
    setNote(null);
  }, []);

  const dismissFrom = useCallback((from: string) => {
    if (asked.current?.from === from) asked.current = null;
    setNote((now) => (now?.from === from ? null : now));
  }, []);

  const startDraw = useCallback(
    (shape: DrawShape) =>
      start(shape, (drawn) => {
        // The area as it is when the shape is finished: it can have changed while drawing.
        const now = read();
        if (limits && now && shapeCount(now) >= limits.shapes) return;
        // A circle keeps its centre and radius, which its row and the map then change; a point is the centre of a
        // circle at the default radius.
        if (drawn.shape !== "polygon") {
          const piece = drawn.shape === "point" ? circlePiece(drawn.at) : circlePiece(drawn.center, drawn.km);
          add(piece.polygons, (polygons) => withPiece(read(), { ...piece, polygons }));
          return;
        }
        add(drawn.polygons, (polygons) => withPiece(read(), { kind: "shape", shape: "polygon", polygons }));
      }),
    [start, read, limits, add]
  );

  /** Puts `next` where `piece` is, as long as it still is (the area can have changed meanwhile), within the limits.
   * A circle simplified to fit keeps its centre and radius: its ring is still the circle's, with fewer points. */
  const replace = useCallback(
    (piece: AreaPiece, next: AreaPiece) => {
      const now = read();
      if (!now?.pieces.includes(piece)) return;
      add(next.polygons, (polygons) => withReplaced(read() ?? now, piece, { ...next, polygons }));
    },
    [read, add]
  );

  const startEdit = useCallback(
    (piece: AreaPiece) => {
      if (piece.kind !== "shape" || !editable(piece)) return;
      setEdited(piece);
      // A circle around a point: its centre is dragged to move it, its ring to change its radius.
      if (piece.center && piece.km !== undefined) {
        editCircle({ center: piece.center, km: piece.km }, ({ center, km }) =>
          replace(piece, circlePiece(center, km, piece.label))
        );
        return;
      }
      edit(piece.polygons, (polygons) => replace(piece, { ...piece, polygons }));
    },
    [edit, editCircle, replace]
  );

  const resize = useCallback(
    (index: number, km: number) => {
      const piece = read()?.pieces[index];
      if (piece?.kind !== "shape" || !piece.center) return;
      replace(piece, circlePiece(piece.center, km, piece.label));
    },
    [read, replace]
  );
  // A piece that left the area (removed, or the area replaced from outside) has nothing to take the place of.
  useEffect(() => {
    if (editing && !area?.pieces.includes(editing)) cancel();
  }, [editing, area, cancel]);
  const outline = useMemo(() => {
    if (!area || !editing) return area;
    // The draw tool shows the piece being edited: its old outline, and a circle's old centre, are left out.
    const hidden = (p: AreaPiece): AreaPiece => {
      if (p.kind !== "shape") return { ...p, polygons: [] };
      const { center: _center, ...rest } = p;
      return { ...rest, polygons: [] };
    };
    return { ...area, pieces: area.pieces.map((p) => (p === editing ? hidden(p) : p)) };
  }, [area, editing]);

  const tools = useMemo<AreaTools>(
    () => ({
      area,
      read,
      setArea,
      limits,
      ops: host.ops,
      ways: host.ways,
      map: host.map,
      canDraw: available && !editingNow,
      drawing,
      editing,
      outline,
      startDraw,
      startEdit,
      resize,
      finishEdit: finish,
      cancelDraw: cancel,
      layers,
      note,
      add,
      confirm,
      dismiss,
      dismissFrom,
    }),
    [
      area,
      read,
      setArea,
      limits,
      host.ops,
      host.ways,
      host.map,
      available,
      editingNow,
      drawing,
      editing,
      outline,
      startDraw,
      startEdit,
      resize,
      finish,
      cancel,
      layers,
      note,
      add,
      confirm,
      dismiss,
      dismissFrom,
    ]
  );
  return <AreaToolsContext.Provider value={tools}>{children}</AreaToolsContext.Provider>;
}
