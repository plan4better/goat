import { Box, Divider, Stack, Typography } from "@mui/material";
import type { Theme } from "@mui/material";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import Link from "@tiptap/extension-link";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMap } from "react-map-gl/maplibre";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useProjectLayerAggregationStats } from "@/lib/api/projects";
import InfoChip from "@/lib/extensions/info-chip";
import VariableChip from "@/lib/extensions/variable-chip";
import FontSize from "@/lib/extensions/font-size";
import LineHeight from "@/lib/extensions/line-height";
import { formatNumber } from "@/lib/utils/format-number";
import { getMapExtentCQL } from "@/lib/utils/map/navigate";
import { keepEmptyParagraphs } from "@/lib/utils/richTextHtml";
import type { AggregationStatsQueryParams, ProjectLayer } from "@/lib/validations/project";
import type { RichTextDataSchema, RichTextVariableSchema } from "@/lib/validations/widget";

import { useTemporaryFilters } from "@/hooks/map/DashboardBuilderHooks";
import { useAppSelector } from "@/hooks/store/ContextHooks";


import { AlignSelect } from "@/components/builder/widgets/elements/text/AlignSelect";
import LineHeightSelect from "@/components/builder/widgets/elements/text/LineHeightSelect";
import MenuButton from "@/components/builder/widgets/elements/text/MenuButton";
import { InfoChipViewPopover } from "@/components/builder/widgets/common/InfoChipPopover";
import RichTextFontSizeSelect from "@/components/builder/widgets/data/RichTextFontSizeSelect";
import VariableInsertMenu from "@/components/builder/widgets/data/VariableInsertMenu";
import RichTextEditor from "@/components/builder/widgets/common/RichTextEditor";
import {
  emitPopupOpen,
  onPopupOpenElsewhere,
} from "@/components/builder/widgets/common/popupCoordinator";

const richTextExtensions = [
  StarterKit,
  Subscript,
  Superscript,
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  LineHeight,
  TextAlign.configure({
    types: ["heading", "paragraph"],
  }),
  Link.configure({
    openOnClick: false,
    HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
  }),
  VariableChip,
  InfoChip,
];

interface RichTextSelectorState {
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isLink: boolean;
  isStrike: boolean;
  isBulletList: boolean;
  isOrderedList: boolean;
  isChipSelected: boolean;
  isInfoChipSelected: boolean;
}

const richTextSelector = ({ editor }: { editor: Editor }): RichTextSelectorState => {
  const node = editor.state.doc.nodeAt(editor.state.selection.from);
  const isChipSelected = node?.type.name === "variableChip";
  return {
    isBold: isChipSelected ? !!node?.attrs.bold : editor.isActive("bold"),
    isItalic: isChipSelected ? !!node?.attrs.italic : editor.isActive("italic"),
    isUnderline: editor.isActive("underline"),
    isStrike: editor.isActive("strike"),
    isBulletList: editor.isActive("bulletList"),
    isOrderedList: editor.isActive("orderedList"),
    isLink: editor.isActive("link"),
    isChipSelected,
    isInfoChipSelected: node?.type.name === "infoChip",
  };
};

/**
 * Theme-aware sx for the editor content area — styles variable chips, info
 * chips, and links inside the ProseMirror DOM in edit mode.
 */
const richTextEditorSx = (theme: Theme) => ({
  height: "100%",
  width: "100%",
  "& .ProseMirror .variable-chip": {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: theme.palette.action.selected,
    color: theme.palette.primary.main,
    borderRadius: `${theme.shape.borderRadius}px`,
    padding: "0 6px",
    fontFamily: "monospace",
    fontSize: "0.85em",
    fontWeight: "normal",
    fontStyle: "normal",
    lineHeight: 1.6,
    whiteSpace: "nowrap",
    userSelect: "none",
    cursor: "default",
  },
  "& .ProseMirror .info-chip": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 14,
    height: 14,
    borderRadius: "50%",
    border: `1.5px solid ${theme.palette.grey[500]}`,
    backgroundColor: "transparent",
    color: theme.palette.grey[500],
    fontSize: 9,
    fontWeight: 700,
    fontStyle: "normal",
    fontFamily: "serif",
    lineHeight: 1,
    cursor: "pointer",
    userSelect: "none",
    verticalAlign: "middle",
    marginInline: "2px",
    boxSizing: "border-box",
  },
  "& .ProseMirror a": {
    color: theme.palette.primary.main,
    textDecoration: "underline",
    cursor: "pointer",
  },
});

/**
 * Replace variable chip spans with styled resolved values.
 * Style attributes (bold, italic, font-size) are read from the chip's data attributes
 * which are set directly in the TipTap editor via the toolbar.
 */
function resolveVariablesInHtml(
  html: string,
  variables: RichTextVariableSchema[],
  resolvedValues: Record<string, string | number | null>
): string {
  return html.replace(
    /<span[^>]*data-variable="([^"]*)"[^>]*>[\s\S]*?<\/span>/g,
    (match, variableName: string) => {
      const variable = variables.find((v) => v.name === variableName);
      const value = resolvedValues[variableName];
      const text = value !== undefined && value !== null ? String(value) : variable ? "..." : "???";

      // Extract style attributes from the chip's HTML
      const styles: string[] = [];
      if (match.includes('data-bold="true"')) styles.push("font-weight:700");
      if (match.includes('data-italic="true"')) styles.push("font-style:italic");
      const fontSizeMatch = match.match(/data-font-size="([^"]*)"/);
      if (fontSizeMatch) styles.push(`font-size:${fontSizeMatch[1]}`);
      // Carry over any existing inline style from the chip
      const styleMatch = match.match(/style="([^"]*)"/);
      if (styleMatch) styles.push(styleMatch[1]);

      if (styles.length === 0) return text;
      return `<span style="${styles.join(";")}">${text}</span>`;
    }
  );
}

/**
 * Preview renderer that makes info chips and links interactive.
 */
const RichTextPreview = ({ html }: { html: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewPopover, setViewPopover] = useState<{
    openId: number;
    chipId: string;
    anchorEl: HTMLElement;
    text: string;
    url?: string;
    title?: string;
    popup_type: "tooltip" | "popover" | "dialog";
    placement: "top" | "bottom" | "left" | "right" | "auto";
    size: "sm" | "md" | "lg";
  } | null>(null);

  // Listen for other popup-open events; close ours if a different one opened.
  useEffect(() => {
    return onPopupOpenElsewhere(
      () => viewPopover?.openId ?? null,
      () => setViewPopover(null)
    );
  }, [viewPopover?.openId]);

  const handleContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const chip = target.closest(".info-chip") as HTMLElement | null;
    if (chip) {
      e.preventDefault();
      e.stopPropagation();
      const text = chip.getAttribute("data-info-text") || "";
      const url = chip.getAttribute("data-info-url") || undefined;
      const title = chip.getAttribute("data-info-title") || undefined;
      const popup_type = (chip.getAttribute("data-popup-type") || "popover") as
        | "tooltip"
        | "popover"
        | "dialog";
      const placement = (chip.getAttribute("data-placement") || "auto") as
        | "top"
        | "bottom"
        | "left"
        | "right"
        | "auto";
      const size = (chip.getAttribute("data-popup-size") || "md") as "sm" | "md" | "lg";
      // Use a virtual anchor that looks up the chip each time MUI Popper
      // measures it. dangerouslySetInnerHTML can re-create the DOM when the
      // resolved html prop changes, leaving any stored element reference
      // detached → popup snaps to the top-left corner. Prefer matching by
      // data-info-id, fall back to the originally-clicked element.
      const chipId = chip.getAttribute("data-info-id") || "";
      const virtualAnchor = {
        getBoundingClientRect: () => {
          const liveChip = chipId
            ? (containerRef.current?.querySelector(
                `[data-info-id="${chipId}"]`
              ) as HTMLElement | null)
            : null;
          return (liveChip ?? chip).getBoundingClientRect();
        },
      } as unknown as HTMLElement;
      const openId = Date.now();
      setViewPopover({
        openId,
        chipId,
        anchorEl: virtualAnchor,
        text,
        url,
        title,
        popup_type,
        placement,
        size,
      });
      emitPopupOpen(openId);
      return;
    }
    const link = target.closest("a") as HTMLAnchorElement | null;
    if (link?.href) {
      e.preventDefault();
      e.stopPropagation();
      window.open(link.href, "_blank", "noopener,noreferrer");
    }
  }, []);

  return (
    <>
      <Box
        ref={containerRef}
        onClick={handleContainerClick}
        sx={{
          height: "100%",
          fontFamily: "inherit",
          "& p, & h1, & h2, & h3, & h4, & h5, & h6": { margin: 0 },
          "& a": { color: "primary.main", textDecoration: "underline" },
          "& .info-chip": {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: "1.5px solid",
            borderColor: "grey.500",
            backgroundColor: "transparent",
            color: "grey.500",
            fontSize: 9,
            fontWeight: 700,
            fontStyle: "normal",
            fontFamily: "serif",
            lineHeight: 1,
            cursor: "pointer",
            verticalAlign: "middle",
            mx: "2px",
            boxSizing: "border-box",
          },
        }}
        dangerouslySetInnerHTML={{ __html: keepEmptyParagraphs(html) || "<p><br></p>" }}
      />
      {viewPopover && (
        <InfoChipViewPopover
          key={viewPopover.openId}
          anchorEl={viewPopover.anchorEl}
          text={viewPopover.text}
          url={viewPopover.url}
          title={viewPopover.title}
          popup_type={viewPopover.popup_type}
          placement={viewPopover.placement}
          size={viewPopover.size}
          onClose={() => setViewPopover(null)}
        />
      )}
    </>
  );
};

/**
 * Wrapper that resolves variables then renders via RichTextPreview (with interactive info chips/links).
 */
const RichTextPreviewResolved = ({
  config,
  resolvedValues,
}: {
  config: RichTextDataSchema;
  resolvedValues: Record<string, string | number | null>;
}) => {
  const variables = config.setup?.variables ?? [];
  const resolvedHtml = useMemo(
    () => resolveVariablesInHtml(config.setup?.text || "", variables, resolvedValues),
    [config.setup?.text, variables, resolvedValues]
  );
  return <RichTextPreview html={resolvedHtml} />;
};

interface RichTextDataWidgetProps {
  config: RichTextDataSchema;
  projectLayers: ProjectLayer[];
  viewOnly?: boolean;
  onConfigChange?: (nextConfig: RichTextDataSchema) => void;
}


/* ------------------------------------------------------------------ */
/*  Editable rich-text editor                                          */
/* ------------------------------------------------------------------ */

const RichTextEditable = ({
  config,
  onConfigChange,
  resolvedValues,
}: {
  config: RichTextDataSchema;
  onConfigChange?: (nextConfig: RichTextDataSchema) => void;
  resolvedValues: Record<string, string | number | null>;
}) => {
  const variables: RichTextVariableSchema[] = config.setup?.variables ?? [];
  const resolvedHtml = useMemo(
    () => resolveVariablesInHtml(config.setup?.text || "", variables, resolvedValues),
    [config.setup?.text, variables, resolvedValues]
  );

  // Toolbar dropdown coordination: when a dropdown (font size, align, etc.) is
  // open, the editor must stay in edit mode even if it loses focus.
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const shouldKeepEditingRef = useRef(false);
  const updateActiveDropdown = useCallback((value: string | null) => {
    setActiveDropdown(value);
    shouldKeepEditingRef.current = !!value;
  }, []);

  // The InfoChipEditDialog (and chip click handler) live inside RichTextEditor
  // now — we don't render our own copy here. The chip insert button below
  // dispatches a click on the freshly-inserted chip so the editor's own handler
  // opens the dialog.

  const handleTextChange = useCallback(
    (html: string) => {
      if (!onConfigChange) return;
      onConfigChange({
        ...config,
        setup: { ...config.setup, text: html },
      });
    },
    [config, onConfigChange]
  );

  const renderToolbar = useCallback(
    (editor: Editor, state: RichTextSelectorState) => (
      <Stack direction="row" spacing={1} alignItems="center">
        <RichTextFontSizeSelect
          editor={editor}
          onOpen={() => updateActiveDropdown("fontSize")}
          onClose={() => updateActiveDropdown(null)}
          forceClose={activeDropdown !== "fontSize" && activeDropdown !== null}
        />
        <Divider flexItem orientation="vertical" />
        <Stack direction="row" spacing={0.5} alignItems="center">
          <MenuButton
            value="bold"
            iconName={ICON_NAME.BOLD}
            selected={state.isBold}
            onClick={() => {
              if (state.isChipSelected) {
                editor.chain().focus().toggleVariableChipBold().run();
              } else {
                editor.chain().focus().toggleBold().run();
              }
            }}
          />
          <MenuButton
            value="italic"
            iconName={ICON_NAME.ITALIC}
            selected={state.isItalic}
            onClick={() => {
              if (state.isChipSelected) {
                editor.chain().focus().toggleVariableChipItalic().run();
              } else {
                editor.chain().focus().toggleItalic().run();
              }
            }}
          />
          <MenuButton
            value="underline"
            iconName={ICON_NAME.UNDERLINE}
            selected={state.isUnderline}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          />
          <MenuButton
            value="strike"
            iconName={ICON_NAME.STRIKETHROUGH}
            selected={state.isStrike}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
        </Stack>
        <Divider flexItem orientation="vertical" />
        <Stack direction="row" spacing={0.5} alignItems="center">
          <MenuButton
            value="bulletList"
            iconName={ICON_NAME.BULLET_LIST}
            selected={state.isBulletList}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          />
          <MenuButton
            value="orderedList"
            iconName={ICON_NAME.NUMBERED_LIST}
            selected={state.isOrderedList}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          />
        </Stack>
        <Divider flexItem orientation="vertical" />
        <AlignSelect
          editor={editor}
          onOpen={() => updateActiveDropdown("align")}
          onClose={() => updateActiveDropdown(null)}
          forceClose={activeDropdown !== "align" && activeDropdown !== null}
        />
        <LineHeightSelect
          editor={editor}
          onOpen={() => updateActiveDropdown("lineHeight")}
          onClose={() => updateActiveDropdown(null)}
          forceClose={activeDropdown !== "lineHeight" && activeDropdown !== null}
        />
        <Divider flexItem orientation="vertical" />
        <Stack direction="row" spacing={0.5} alignItems="center">
          <MenuButton
            value="link"
            iconName={ICON_NAME.LINK}
            selected={state.isLink}
            onClick={() => {
              if (state.isLink) {
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
              } else {
                // Use the editor's setLink command directly with a simple prompt
                // — keeps this toolbar self-contained.
                const url = window.prompt("URL", editor.getAttributes("link").href ?? "");
                if (url) {
                  editor.chain().focus().extendMarkRange("link").setLink({ href: url, target: "_blank" }).run();
                }
              }
            }}
          />
          <MenuButton
            value="infoChip"
            iconName={ICON_NAME.INFO}
            selected={false}
            onClick={() => {
              editor.chain().focus().insertInfoChip().run();
              // After insert the cursor sits just past the chip, so the chip
              // is at cursor - 1. Select the chip node so RichTextEditor's
              // selectionUpdate listener opens the edit dialog.
              const chipPos = editor.state.selection.from - 1;
              const inserted = editor.state.doc.nodeAt(chipPos);
              if (inserted?.type.name !== "infoChip") return;
              editor.chain().focus().setNodeSelection(chipPos).run();
            }}
          />
        </Stack>
        <Divider flexItem orientation="vertical" />
        <VariableInsertMenu
          editor={editor}
          variables={variables}
          onOpen={() => updateActiveDropdown("variable")}
          onClose={() => updateActiveDropdown(null)}
          forceClose={activeDropdown !== "variable" && activeDropdown !== null}
        />
      </Stack>
    ),
    [activeDropdown, updateActiveDropdown, variables]
  );

  return (
    <RichTextEditor<RichTextSelectorState>
      value={config.setup?.text || ""}
      onChange={handleTextChange}
      extensions={richTextExtensions}
      selector={richTextSelector}
      renderToolbarButtons={renderToolbar}
      renderPreview={() => <RichTextPreview html={resolvedHtml} />}
      changeDebounceMs={300}
      shouldKeepEditingRef={shouldKeepEditingRef}
      sx={richTextEditorSx}
    />
  );
};

/* ------------------------------------------------------------------ */
/*  Headless variable resolver                                         */
/* ------------------------------------------------------------------ */

/**
 * Headless component that resolves a single variable value via the aggregation API.
 * Renders nothing — just fires the onResolved callback when the value is ready.
 * Applies cross-filter, viewport filter, and layer base filter — same as chart widgets.
 */
const VariableResolver: React.FC<{
  variable: RichTextVariableSchema;
  projectLayers: ProjectLayer[];
  filterByViewport?: boolean;
  crossFilter?: boolean;
  onResolved: (name: string, value: string | number) => void;
}> = ({ variable, projectLayers, filterByViewport, crossFilter = true, onResolved }) => {
  const { i18n } = useTranslation("common");
  const { map } = useMap();

  // Resolve layer_project_id (numeric) to layer_id (UUID) and get layer object
  const layer = useMemo(() => {
    if (!variable.layer_project_id) return undefined;
    return projectLayers.find((l) => l.id === variable.layer_project_id);
  }, [variable.layer_project_id, projectLayers]);

  const layerId = layer?.layer_id;

  // Get layer's base filter and temporary (cross) filters
  const layerBaseFilter = useMemo(() => {
    return layer?.query?.cql as Record<string, unknown> | undefined;
  }, [layer?.query?.cql]);

  const tempFilters = useTemporaryFilters({ layerId: variable.layer_project_id });

  // Build CQL filter combining base filter, cross-filter, and viewport filter
  const buildFilter = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cqlQuery: any = layerBaseFilter ? JSON.parse(JSON.stringify(layerBaseFilter)) : undefined;

    if (crossFilter && tempFilters) {
      const cf = JSON.parse(JSON.stringify(tempFilters));
      cqlQuery = cqlQuery ? { op: "and", args: [cqlQuery, cf] } : cf;
    }

    if (filterByViewport && map) {
      const extentRaw = getMapExtentCQL(map);
      if (extentRaw) {
        const extent = JSON.parse(extentRaw);
        if (cqlQuery) {
          if (cqlQuery.op === "and" && cqlQuery.args) {
            cqlQuery.args.push(extent);
          } else {
            cqlQuery = { op: "and", args: [cqlQuery, extent] };
          }
        } else {
          cqlQuery = extent;
        }
      }
    }

    return cqlQuery ? JSON.stringify(cqlQuery) : undefined;
  }, [layerBaseFilter, crossFilter, tempFilters, filterByViewport, map]);

  const [filter, setFilter] = useState(() => buildFilter());

  useEffect(() => {
    setFilter(buildFilter());
  }, [buildFilter]);

  // Update on map moves if viewport filtering is enabled
  useEffect(() => {
    if (!map || !filterByViewport) return;
    const onMoveEnd = () => setFilter(buildFilter());
    map.on("moveend", onMoveEnd);
    return () => { map.off("moveend", onMoveEnd); };
  }, [map, filterByViewport, buildFilter]);

  const queryParams = useMemo((): AggregationStatsQueryParams | undefined => {
    if (!variable.layer_project_id || !variable.operation_type) return undefined;
    // operation_value is required for all operations except count
    if (variable.operation_type !== "count" && !variable.operation_value) return undefined;
    return {
      operation_type: variable.operation_type,
      operation_value: variable.operation_value,
      query: filter,
    } as AggregationStatsQueryParams;
  }, [variable.layer_project_id, variable.operation_type, variable.operation_value, filter]);

  const { aggregationStats } = useProjectLayerAggregationStats(layerId, queryParams);

  useEffect(() => {
    if (aggregationStats?.items?.[0]) {
      const raw = aggregationStats.items[0].operation_value;
      const formatted = typeof raw === "string" ? raw : formatNumber(raw, variable.format, i18n.language);
      onResolved(variable.name, formatted);
    }
  }, [aggregationStats, variable.format, variable.name, i18n.language, onResolved]);

  return null;
};

/* ------------------------------------------------------------------ */
/*  Public component                                                   */
/* ------------------------------------------------------------------ */

export const RichTextDataWidget = ({
  config: rawConfig,
  projectLayers,
  viewOnly,
  onConfigChange,
}: RichTextDataWidgetProps) => {
  const { t } = useTranslation("common");
  const [resolvedValues, setResolvedValues] = useState<Record<string, string | number | null>>({});
  const variables = rawConfig.setup?.variables ?? [];
  const options = rawConfig.options ?? {};

  // Check if any variable's layer has active cross-filters
  const { temporaryFilters } = useAppSelector((state) => state.map);
  const variableLayerIds = useMemo(
    () => variables.map((v) => v.layer_project_id).filter(Boolean),
    [variables]
  );
  const hasActiveFilters = useMemo(() => {
    if (variableLayerIds.length === 0) return false;
    return temporaryFilters.some(
      (f) =>
        variableLayerIds.includes(f.layer_id) ||
        f.additional_targets?.some((t) => variableLayerIds.includes(t.layer_id))
    );
  }, [temporaryFilters, variableLayerIds]);

  const handleVariableResolved = useCallback(
    (name: string, value: string | number) => {
      setResolvedValues((prev) => {
        if (prev[name] === value) return prev;
        return { ...prev, [name]: value };
      });
    },
    []
  );

  // Determine what to show when no filter is active
  const showNoFilterState = !hasActiveFilters && variables.length > 0;
  const shouldHide = showNoFilterState && !!options.hide_when_no_filter;
  const fallbackText = showNoFilterState && !shouldHide ? options.no_filter_text : undefined;

  // In public view, the WidgetWrapper handles hiding entirely.
  // In builder, show a placeholder so the widget is still visible and configurable.
  if (shouldHide) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          p: 1,
          opacity: 0.5,
          border: "1px dashed",
          borderColor: "divider",
          borderRadius: 1,
        }}>
        <Typography variant="body2" color="text.secondary" fontStyle="italic">
          {t("hidden_when_no_filter", { defaultValue: "Hidden until a filter is applied" })}
        </Typography>
      </Box>
    );
  }

  return (
    <>
      {/* Headless variable resolvers */}
      {variables.map((v) => (
        <VariableResolver
          key={v.id}
          variable={v}
          projectLayers={projectLayers}
          filterByViewport={options.filter_by_viewport}
          crossFilter={options.cross_filter}
          onResolved={handleVariableResolved}
        />
      ))}

      {fallbackText ? (
        <Box sx={{ height: "100%", display: "flex", alignItems: "center", p: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {fallbackText}
          </Typography>
        </Box>
      ) : viewOnly ? (
        <RichTextPreviewResolved config={rawConfig} resolvedValues={resolvedValues} />
      ) : (
        <RichTextEditable config={rawConfig} onConfigChange={onConfigChange} resolvedValues={resolvedValues} />
      )}
    </>
  );
};
