"use client";

// The area's picker: whether the features are kept inside or outside the area, the pieces it is made of, each
// removable and a drawn polygon editable on the map, and "Add to area" (the map view, a shape drawn on the map, regions,
// features of another layer, as far as the host offers them). Its content does not know where it is shown: in the filter panel it is a popover and the
// lists of regions and features open beside it; a dialog shows it in place and opens the lists under it.
import { Box, IconButton, Typography } from "@mui/material";
import { memo, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { BUFFER_STEP_KM, MAX_BUFFER_KM, MIN_BUFFER_KM } from "@/lib/catalog/spatial";
import { type AreaPiece, type FilterArea, featureCount, shapeCount } from "@/lib/filter/area";

import SegmentedControl from "@/components/map/panels/common/SegmentedControl";
import SliderInput from "@/components/map/panels/common/SliderInput";
import { LayerFeatures, RegionFeatures } from "@/components/map/panels/filter/area/AreaFeatures";
import { AreaNoteText } from "@/components/map/panels/filter/area/AreaNote";
import { type AreaLayer, useAreaTools } from "@/components/map/panels/filter/area/AreaTools";
import {
  REGION_SOURCE,
  editable,
  pieceName,
  viewPiece,
  viewPieceOf,
  withPiece,
  withRadius,
  withoutPiece,
} from "@/components/map/panels/filter/area/pieces";
import type { DrawShape } from "@/components/map/panels/filter/area/useAreaDraw";
import { useMapView } from "@/components/map/panels/filter/area/useMapView";
import { type DropdownItem, DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import {
  LevelContext,
  anchorTopOf,
  useNextLevel,
  useOpenKey,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { AddButton, NavRow, Row } from "@/components/map/panels/styleEditor/rows";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Where the lists of features open, as the picker's host places them. */
export interface AreaLists {
  /** The source whose list is open; null while none is. */
  open: string | null;
  /** From the menu: opens the list at `anchor`, never closes it. */
  show: (source: string, anchor: HTMLElement) => void;
  /** From a piece's row: a second click closes the list again. */
  toggle: (source: string, anchor: HTMLElement) => void;
  /** Closes the list of `source` when it is the open one. */
  close: (source: string) => void;
}

/** What a list is titled: the regions, or the layer its features are of. */
export const listTitle = (source: string, layers: readonly AreaLayer[], t: Translate): string =>
  source === REGION_SOURCE
    ? t("filter_panel.area_add_regions")
    : (layers.find((layer) => layer.id === source)?.name ?? t("filter_panel.area_add_features"));

/** The list features of `source` are picked from. */
export const AreaList = ({ source }: { source: string }) =>
  source === REGION_SOURCE ? <RegionFeatures /> : <LayerFeatures layerId={source} />;

const pieceIcon = (piece: AreaPiece): ICON_NAME => {
  if (piece.kind === "view") return ICON_NAME.MAP;
  if (piece.kind === "shape") {
    if (piece.center) return ICON_NAME.CIRCLE_DOT;
    return piece.shape === "circle" ? ICON_NAME.CIRCLE_EMPTY : ICON_NAME.DRAW_POLYGON;
  }
  return piece.source === REGION_SOURCE ? ICON_NAME.GLOBE : ICON_NAME.POLYGON_FEATURE;
};

const HINT_SX = { display: "block", px: 3, pb: 1 } as const;

/** One piece of the area. Picked features open their list; a circle around a point has its radius under it and moves
 * with a click on the map; a drawn polygon can be edited on the map, its row saying Done meanwhile; a map view or
 * another shape is what it is. */
const PieceRow = memo(function PieceRow({
  piece,
  index,
  layerName,
  listOpen,
  editing,
  canEdit,
  onOpen,
  onRadius,
  onEdit,
  onFinish,
  onRemove,
}: {
  piece: AreaPiece;
  index: number;
  /** The layer the picked features are of. */
  layerName?: string;
  /** Whether the list of the picked features is open. */
  listOpen: boolean;
  /** Whether this piece is being edited on the map. */
  editing: boolean;
  /** Whether a piece can be edited now. */
  canEdit: boolean;
  onOpen: (source: string, anchor: HTMLElement) => void;
  onRadius: (index: number, km: number) => void;
  onEdit: (index: number) => void;
  onFinish: () => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation("common");
  const name = pieceName(piece, t);
  const glyph = (
    <Icon iconName={pieceIcon(piece)} sx={{ fontSize: 14, color: "text.secondary", flex: "none" }} />
  );
  const edit =
    editable(piece) &&
    (editing ? (
      <IconButton size="small" color="primary" aria-label={t("done")} onClick={onFinish}>
        <Icon iconName={ICON_NAME.CHECK} sx={{ fontSize: 12 }} />
      </IconButton>
    ) : (
      <IconButton
        size="small"
        aria-label={t(
          piece.kind === "shape" && piece.center
            ? "filter_panel.area_move_circle"
            : "filter_panel.area_edit_piece"
        )}
        disabled={!canEdit}
        onClick={() => onEdit(index)}>
        <Icon iconName={ICON_NAME.EDITPEN} sx={{ fontSize: 12 }} />
      </IconButton>
    ));
  const remove = (
    <>
      {edit}
      <IconButton
        size="small"
        aria-label={t("filter_panel.area_remove_piece")}
        onClick={() => onRemove(index)}>
        <Icon iconName={ICON_NAME.CLOSE} sx={{ fontSize: 12 }} />
      </IconButton>
    </>
  );
  if (piece.kind === "features")
    return (
      <NavRow
        dense
        value={name}
        glyph={glyph}
        note={layerName}
        active={listOpen}
        actions={remove}
        onOpen={(anchor) => onOpen(piece.source, anchor)}
      />
    );
  const row = (
    <Row dense active={editing} actions={remove}>
      {glyph}
      <Typography variant="body2" fontWeight="bold" noWrap>
        {name}
      </Typography>
    </Row>
  );
  if (piece.kind !== "shape" || piece.km === undefined) return row;
  return (
    <>
      {row}
      <Box sx={{ px: 3, pb: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {t("fetch_features_area_radius")}
        </Typography>
        <SliderInput
          value={piece.km}
          isRange={false}
          min={MIN_BUFFER_KM}
          max={MAX_BUFFER_KM}
          step={BUFFER_STEP_KM}
          onChange={(km) => onRadius(index, km as number)}
          rootSx={{ pl: 1 }}
        />
      </Box>
    </>
  );
});

export interface AreaPickerContentProps {
  lists: AreaLists;
  /** Said while there is no area. */
  emptyText: string;
  /** A shape is started or edited on the map. */
  onDraw?: () => void;
}

export function AreaPickerContent({ lists, emptyText, onDraw }: AreaPickerContentProps) {
  const { t } = useTranslation("common");
  const tools = useAreaTools();
  const { area, read, setArea, limits, ways, layers } = tools;
  const { read: readView } = useMapView(false, tools.map.id);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [layersAnchor, setLayersAnchor] = useState<HTMLElement | null>(null);

  const removePiece = useCallback(
    (index: number) => {
      const now = read();
      if (!now) return;
      const piece = now.pieces[index];
      // A list of features that are no longer in the area has nothing to show.
      if (piece?.kind === "features") lists.close(piece.source);
      setArea(withoutPiece(now, index));
    },
    [read, setArea, lists]
  );
  const setRadius = useCallback(
    (index: number, km: number) => {
      const now = read();
      if (now) setArea(withRadius(now, index, km));
    },
    [read, setArea]
  );
  const setOp = (op: FilterArea["op"]) => {
    const now = read();
    if (now && now.op !== op) setArea({ ...now, op });
  };
  const addView = () => {
    const bounds = readView();
    if (!bounds) return;
    tools.add(viewPieceOf(bounds).polygons, (polygons) => withPiece(read(), { kind: "view", polygons }));
  };
  const drawShape = (shape: DrawShape) => {
    tools.startDraw(shape);
    onDraw?.();
  };
  const { startEdit } = tools;
  const editPiece = useCallback(
    (index: number) => {
      const piece = read()?.pieces[index];
      if (!piece) return;
      startEdit(piece);
      onDraw?.();
    },
    [read, startEdit, onDraw]
  );

  const shapesFull = !!limits && !!area && shapeCount(area) >= limits.shapes;
  const featuresFull = !!limits && !!area && featureCount(area) >= limits.features;
  const shapesLimit = limits && t("filter_panel.area_limit_shapes", { limit: limits.shapes });
  const featuresLimit = limits && t("filter_panel.area_limit_features", { limit: limits.features });
  const drawItem = (shape: DrawShape, icon: ICON_NAME): DropdownItem => ({
    label: t(`filter_panel.area_add_${shape}`),
    icon,
    disabled: shapesFull || !tools.canDraw,
    sub: shapesFull ? shapesLimit : !tools.canDraw ? t("filter_panel.area_draw_busy") : undefined,
    onClick: () => drawShape(shape),
  });
  const items: Partial<Record<(typeof ways)[number], DropdownItem>> = {
    view: {
      label: t("filter_panel.area_add_view"),
      icon: ICON_NAME.MAP,
      disabled: !!viewPiece(area),
      onClick: addView,
    },
    polygon: drawItem("polygon", ICON_NAME.DRAW_POLYGON),
    circle: drawItem("circle", ICON_NAME.CIRCLE_EMPTY),
    point: drawItem("point", ICON_NAME.CIRCLE_DOT),
    regions: {
      label: t("filter_panel.area_add_regions"),
      icon: ICON_NAME.GLOBE,
      disabled: featuresFull,
      sub: featuresFull ? featuresLimit : undefined,
      onClick: () => addAnchor && lists.show(REGION_SOURCE, addAnchor),
    },
    features: {
      label: t("filter_panel.area_add_features"),
      icon: ICON_NAME.POLYGON_FEATURE,
      disabled: featuresFull || layers.length === 0,
      sub: featuresFull ? featuresLimit : layers.length === 0 ? t("filter_panel.area_no_layers") : undefined,
      // The layers open where this menu was.
      onClick: () => setLayersAnchor(addAnchor),
    },
  };
  const addItems = ORDER.filter((way) => ways.includes(way)).flatMap((way) => items[way] ?? []);
  const layerItems = useMemo<DropdownItem[]>(
    () =>
      layers.map((layer) => ({
        label: layer.name,
        // The layer's legend, as the layer list and a popup show it.
        icon: layer.icon ?? ICON_NAME.POLYGON_FEATURE,
      })),
    [layers]
  );
  const layerNames = useMemo(() => new Map(layers.map((layer) => [layer.id, layer.name])), [layers]);
  const ops = useMemo(
    () => [
      { value: "inside", label: t("filter_panel.area_inside") },
      { value: "outside", label: t("filter_panel.area_outside") },
    ],
    [t]
  );

  return (
    <Box sx={{ pt: 1 }}>
      {area ? (
        <>
          {tools.ops && (
            <Box sx={{ px: 3, pb: 1.5 }}>
              <SegmentedControl
                ariaLabel={t("filter_panel.area_keep")}
                value={area.op}
                items={ops}
                onChange={(op) => setOp(op as FilterArea["op"])}
              />
            </Box>
          )}
          {area.pieces.map((piece, index) => (
            <PieceRow
              key={index}
              piece={piece}
              index={index}
              layerName={piece.kind === "features" ? layerNames.get(piece.source) : undefined}
              listOpen={piece.kind === "features" && lists.open === piece.source}
              editing={piece === tools.editing}
              canEdit={tools.canDraw}
              onOpen={lists.toggle}
              onRadius={setRadius}
              onEdit={editPiece}
              onFinish={tools.finishEdit}
              onRemove={removePiece}
            />
          ))}
        </>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={HINT_SX}>
          {emptyText}
        </Typography>
      )}
      {shapesFull && (
        <Typography variant="caption" color="text.secondary" sx={HINT_SX}>
          {shapesLimit}
        </Typography>
      )}
      {featuresFull && (
        <Typography variant="caption" color="text.secondary" sx={HINT_SX}>
          {featuresLimit}
        </Typography>
      )}
      <AreaNoteText />
      <Box sx={{ px: 3, pt: 1 }}>
        <AddButton
          onClick={(event) => setAddAnchor(addAnchor ? null : event.currentTarget)}
          sx={{ ml: -2.5 }}>
          {t("filter_panel.area_add")}
        </AddButton>
      </Box>
      <DropdownMenu
        anchorEl={addAnchor}
        role="menu"
        width={260}
        placement="bottom-start"
        items={addItems}
        onClose={() => setAddAnchor(null)}
      />
      <DropdownMenu
        anchorEl={layersAnchor}
        role="listbox"
        width={260}
        title={t("filter_panel.area_add_features")}
        items={layerItems.map((item, i) => ({
          ...item,
          onClick: () => layersAnchor && lists.show(layers[i].id, layersAnchor),
        }))}
        onClose={() => setLayersAnchor(null)}
      />
    </Box>
  );
}

/** The order "Add to area" lists the ways in. */
const ORDER = ["view", "polygon", "circle", "point", "regions", "features"] as const;

/** The key of a source's list of features among the panel's popovers. */
const listKey = (source: string) => `filter-area:${source}`;
const LIST_PREFIX = listKey("");

/** The picker as a popover of the filter panel: the lists open beside it, and it gets out of the way while a shape
 * is drawn on the map. */
export function AreaPicker() {
  const { t } = useTranslation("common");
  const { layers } = useAreaTools();
  const popover = usePopover();
  const own = useContext(LevelContext);
  const next = useNextLevel();
  const openKey = useOpenKey(next);

  const lists = useMemo<AreaLists>(() => {
    const entry = (source: string, anchor: HTMLElement) => ({
      key: listKey(source),
      title: listTitle(source, layers, t),
      anchorTop: anchorTopOf(anchor),
      render: () => <AreaList source={source} />,
    });
    return {
      open: openKey?.startsWith(LIST_PREFIX) ? openKey.slice(LIST_PREFIX.length) : null,
      show: (source, anchor) => {
        if (popover.current(next)?.key !== listKey(source)) popover.open(next, entry(source, anchor));
      },
      toggle: (source, anchor) => popover.open(next, entry(source, anchor)),
      close: (source) => {
        if (popover.current(next)?.key === listKey(source)) popover.close(next);
      },
    };
  }, [openKey, layers, t, popover, next]);
  const onDraw = useCallback(() => {
    if (own !== 0) popover.close(own);
  }, [own, popover]);

  return <AreaPickerContent lists={lists} emptyText={t("filter_panel.area_empty")} onDraw={onDraw} />;
}
