"use client";

import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  type SxProps,
  type Theme,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { format, formatDistanceToNowStrict } from "date-fns";
import { type MouseEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { useProjectLayers } from "@/lib/api/projects";
import type { AddedToProject } from "@/lib/assistant/addToProject";
import { type CardBehaviour, type ItemActionContext, cardBehaviour } from "@/lib/assistant/itemActions";
import { type CardGroup, type ResultItem, itemKey, uniqueGroups } from "@/lib/assistant/items";
import { useActiveSurface } from "@/lib/assistant/store";

import { type ItemDetails, useItemDetails } from "@/hooks/assistant/useItemDetails";

import { useDockActions } from "@/components/assistant/DockActions";
import ItemPreview from "@/components/assistant/messages/ItemPreview";
import ProjectPickerMenu from "@/components/assistant/messages/ProjectPickerMenu";
import {
  CARD_RADIUS,
  accentSoft,
  accentText,
  focusRing,
  mutedText,
  neutralPillSx,
  pillButtonSx,
} from "@/components/assistant/styles";

const THUMB = 72;

const clamp = (lines: number) => ({
  display: "-webkit-box",
  WebkitLineClamp: lines,
  WebkitBoxOrient: "vertical" as const,
  overflow: "hidden",
});

/** Whether a text element is cut (clamped or ellipsed), measured as the pointer
 * arrives: a tooltip that only repeats the words already on the card adds nothing. */
function useCut<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [cut, setCut] = useState(false);
  const measure = () => {
    const element = ref.current;
    if (!element) return;
    setCut(element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1);
  };
  return { ref, cut, measure };
}

/** A card's title or note: its full text on hover only when it is cut. */
function CutText({ text, sx }: { text: string; sx: SxProps<Theme> }) {
  const { ref, cut, measure } = useCut<HTMLSpanElement>();
  return (
    <Tooltip title={cut ? text : ""} placement="top" disableInteractive>
      <Typography ref={ref} onMouseEnter={measure} sx={sx}>
        {text}
      </Typography>
    </Tooltip>
  );
}

const KIND_ICON: Record<ResultItem["kind"], ICON_NAME> = {
  project: ICON_NAME.MAP,
  layer: ICON_NAME.LAYERS,
  dataset: ICON_NAME.DATABASE,
  catalog: ICON_NAME.BOOK,
  bundle: ICON_NAME.CUBE,
  workflow: ICON_NAME.WORKFLOW,
  layout: ICON_NAME.PRINT,
};

const GEOMETRY_ICON: Record<string, ICON_NAME> = {
  point: ICON_NAME.POINT_FEATURE,
  line: ICON_NAME.LINE_FEATURE,
  polygon: ICON_NAME.POLYGON_FEATURE,
  table: ICON_NAME.TABLE,
};

/** One item of the meta line: kept whole, wrapping to the next row. Its tooltip
 * shows when it adds to the words on the card (a label, a full date) or when
 * those words are cut. */
function Meta({
  icon,
  title,
  accent,
  children,
}: {
  icon: ICON_NAME;
  title: string;
  accent?: boolean;
  children: string;
}) {
  const theme = useTheme();
  const { ref, cut, measure } = useCut<HTMLSpanElement>();
  return (
    <Tooltip title={title !== children || cut ? title : ""} placement="top" disableInteractive>
      <Stack
        direction="row"
        alignItems="center"
        gap="4px"
        onMouseEnter={measure}
        sx={{ minWidth: 0, maxWidth: "100%", color: accent ? accentText(theme) : mutedText(theme) }}>
        <Icon iconName={icon} style={{ fontSize: 10, flexShrink: 0, color: "inherit" }} />
        <Typography ref={ref} noWrap sx={{ fontSize: 11.5, color: "inherit" }}>
          {children}
        </Typography>
      </Stack>
    </Tooltip>
  );
}

/** The kind, the data, who owns it and when it last changed. */
function MetaLine({
  item,
  details,
  inProject,
}: {
  item: ResultItem;
  details: ItemDetails;
  inProject: boolean;
}) {
  const { t } = useTranslation("common");
  const dateLocale = useDateFnsLocale();
  const items: ReactNode[] = [];
  const kind = (() => {
    switch (item.kind) {
      case "project":
        return [
          t("project"),
          details.layerCount !== undefined
            ? t("assistant_result_layers", { count: details.layerCount })
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
      case "layer":
        if (inProject) return t("assistant_item_layer_in_this_project");
        return item.projectName ? t("assistant_item_layer_in", { project: item.projectName }) : t("layer");
      case "dataset":
        return inProject ? t("assistant_item_layer_in_this_project") : t("dataset");
      case "catalog":
        return t("catalog");
      case "workflow":
        return item.projectName
          ? t("assistant_item_workflow_in", { project: item.projectName })
          : t("workflow");
      case "layout":
        return item.projectName ? t("assistant_item_layout_in", { project: item.projectName }) : t("layout");
      case "bundle":
        return [t("bundle"), item.detail ? t(item.detail, { defaultValue: item.detail }) : null]
          .filter(Boolean)
          .join(" · ");
    }
  })();
  items.push(
    <Meta key="kind" icon={KIND_ICON[item.kind]} title={kind} accent>
      {kind}
    </Meta>
  );
  if (item.locked) {
    items.push(
      <Meta key="locked" icon={ICON_NAME.LOCK} title={t("assistant_item_locked")}>
        {t("assistant_item_locked")}
      </Meta>
    );
  }
  if (details.geometry) {
    const label = [
      t(details.geometry, { defaultValue: details.geometry }),
      details.featureCount !== undefined
        ? t("assistant_result_features", { count: details.featureCount })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    items.push(
      <Meta
        key="geometry"
        icon={GEOMETRY_ICON[details.geometry] ?? ICON_NAME.LAYERS}
        title={`${t("geometry_type")}: ${label}`}>
        {label}
      </Meta>
    );
  }
  if (details.members) {
    const tables = details.members.total - details.members.drawable;
    const parts = [
      t("assistant_item_map_layers", { count: details.members.drawable }),
      tables ? t("assistant_item_tables", { count: tables }) : null,
    ]
      .filter(Boolean)
      .join(", ");
    items.push(
      <Meta key="members" icon={ICON_NAME.LAYERS} title={parts}>
        {parts}
      </Meta>
    );
  }
  if (item.kind === "catalog") {
    if (item.publisher) {
      items.push(
        <Meta
          key="publisher"
          icon={ICON_NAME.ORGANIZATION}
          title={`${t("assistant_item_publisher")}: ${item.publisher}`}>
          {item.publisher}
        </Meta>
      );
    }
    if (item.license) {
      items.push(
        <Meta key="license" icon={ICON_NAME.FILE} title={`${t("assistant_item_license")}: ${item.license}`}>
          {item.license}
        </Meta>
      );
    }
  }
  if (details.owner) {
    const owner = details.owner.kind === "you" ? t("you") : details.owner.name;
    const icon =
      details.owner.kind === "team"
        ? ICON_NAME.USERS
        : details.owner.kind === "organization"
          ? ICON_NAME.ORGANIZATION
          : ICON_NAME.USER;
    items.push(
      <Meta key="owner" icon={icon} title={`${t("owner")}: ${owner}`}>
        {owner}
      </Meta>
    );
  }
  if (details.updatedAt) {
    const date = new Date(details.updatedAt);
    if (!Number.isNaN(date.getTime())) {
      items.push(
        <Meta
          key="updated"
          icon={ICON_NAME.CLOCK}
          title={`${t("last_updated")}: ${format(date, "PPp", { locale: dateLocale })}`}>
          {formatDistanceToNowStrict(date, { addSuffix: true, roundingMethod: "floor", locale: dateLocale })}
        </Meta>
      );
    }
  }
  return (
    <Stack direction="row" flexWrap="wrap" columnGap="10px" rowGap="2px" sx={{ mt: "4px", minWidth: 0 }}>
      {items}
    </Stack>
  );
}

/** The thumbnail, or the kind's icon when there is none; a catalog record carries the catalog's mark. */
function Thumbnail({
  item,
  src,
  onClick,
  title,
}: {
  item: ResultItem;
  src?: string;
  onClick?: () => void;
  title?: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation("common");
  // The image shows only once it has loaded: a slow or failed one never flashes
  // the browser's broken-image mark, the kind's icon stays until then.
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  // A fresh link (the old one expired) gets another try; a loaded image stays while it swaps.
  const [triedSrc, setTriedSrc] = useState(src);
  if (src !== triedSrc) {
    setTriedSrc(src);
    if (state === "failed") setState("loading");
  }
  const picture = (
    <>
      {state !== "loaded" && (
        <Icon iconName={KIND_ICON[item.kind]} style={{ fontSize: 22, color: accentText(theme) }} />
      )}
      {src && state !== "failed" && (
        // eslint-disable-next-line @next/next/no-img-element -- a presigned link of any host, not a static asset
        <img
          src={src}
          alt=""
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
            opacity: state === "loaded" ? 1 : 0,
          }}
        />
      )}
    </>
  );
  const box = (
    <Box
      sx={{
        position: "relative",
        width: THUMB,
        height: THUMB,
        flexShrink: 0,
        borderRadius: "10px",
        overflow: "hidden",
        border: 1,
        borderColor: "divider",
        bgcolor: accentSoft(theme),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
      {picture}
      {item.kind === "catalog" && (
        <Box
          title={t("assistant_item_from_catalog")}
          sx={{
            position: "absolute",
            right: 4,
            bottom: 4,
            width: 18,
            height: 18,
            borderRadius: "50%",
            bgcolor: "background.paper",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
          <Icon iconName={ICON_NAME.BOOK} style={{ fontSize: 9, color: accentText(theme) }} />
        </Box>
      )}
    </Box>
  );
  if (!onClick) return box;
  return (
    <Tooltip title={title} placement="top" disableInteractive>
      <Box
        component="button"
        type="button"
        onClick={onClick}
        // A mouse shortcut for the eye or Zoom button beside it, which keyboard and
        // screen reader users reach instead: kept out of the tab order and the tree.
        tabIndex={-1}
        aria-hidden
        sx={{
          p: 0,
          border: 0,
          background: "none",
          cursor: "pointer",
          borderRadius: "10px",
          ...focusRing(theme),
        }}>
        {box}
      </Box>
    </Tooltip>
  );
}

function ResultCard({
  item,
  context,
  open,
  onToggle,
}: {
  item: ResultItem;
  context: ItemActionContext;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dock = useDockActions();
  const details = useItemDetails(item);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<AddedToProject | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const base = cardBehaviour(item, context);
  // Once added to the open project it is in it: Zoom instead of Add, and no
  // preview. Added elsewhere it stays as it was, marked, and may go to another.
  const behaviour: CardBehaviour =
    added && base.action?.id === "add_to_project"
      ? added.layers.length
        ? {
            action: {
              id: "zoom_to_layer",
              labelKey: "assistant_item_zoom",
              titleKey: "assistant_item_zoom_to_layer",
            },
            preview: false,
            layer: added.layers[0],
          }
        : { action: null, preview: false }
      : base;
  const inProject = behaviour.layer !== undefined;

  /** Adds to the open project, or to `target` picked from the menu. */
  const add = async (target?: { id: string; name: string }) => {
    setAdding(true);
    try {
      const result = await dock.addToProject(item, target?.id);
      setAdded(result);
      const undo = async () => {
        try {
          await result.undo();
          setAdded(null);
        } catch {
          toast.error(t("assistant_item_undo_failed"));
        }
      };
      // A render function: react-toastify passes its own props to an element given as content.
      toast.success(() => (
        <Stack direction="row" alignItems="center" gap="8px" flexWrap="wrap">
          <span>
            {target
              ? t("assistant_item_added_to_named_project", { name: item.title, project: target.name })
              : t("assistant_item_added_to_project", { name: item.title })}
          </span>
          <Button size="small" color="inherit" onClick={undo}>
            {t("undo")}
          </Button>
          {target && (
            <Button size="small" color="inherit" onClick={() => dock.openProject(target.id)}>
              {t("assistant_item_open_project")}
            </Button>
          )}
        </Stack>
      ));
    } catch {
      toast.error(t("assistant_item_add_failed"));
    } finally {
      setAdding(false);
    }
  };

  const run = (event?: MouseEvent<HTMLElement>) => {
    switch (behaviour.action?.id) {
      case "add_to_other_project":
        setPickerAnchor(event?.currentTarget ?? null);
        return;
      case "open_project":
        dock.openProject(item.id);
        return;
      case "open_workflow":
        if (item.projectId) dock.openInProjectMode(item.projectId, "workflows", item.id);
        return;
      case "open_layout":
        if (item.projectId) dock.openInProjectMode(item.projectId, "reports", item.id);
        return;
      case "zoom_to_layer":
        if (behaviour.layer !== undefined) dock.zoomToLayer(behaviour.layer);
        return;
      case "add_to_project":
        void add();
        return;
    }
  };

  const action = behaviour.action;
  const thumbClick = behaviour.preview ? onToggle : action?.id === "zoom_to_layer" ? run : undefined;
  const thumbTitle = behaviour.preview
    ? t(open ? "assistant_item_hide_preview" : "assistant_item_preview")
    : thumbClick
      ? t("assistant_item_zoom_to_layer")
      : undefined;

  return (
    <Box
      sx={{
        p: "10px",
        border: 1,
        borderColor: "divider",
        borderRadius: CARD_RADIUS,
        bgcolor: "background.paper",
      }}>
      <Stack direction="row" gap="12px" alignItems="flex-start">
        <Thumbnail item={item} src={details.thumbnail} onClick={thumbClick} title={thumbTitle} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="flex-start" gap="6px">
            <CutText
              text={item.title}
              sx={{
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                fontWeight: 700,
                lineHeight: 1.35,
                overflowWrap: "anywhere",
                ...clamp(2),
              }}
            />
            {/* Centred on one line with each other; the group stays at the top of a two-line title. */}
            <Stack direction="row" alignItems="center" gap="6px" sx={{ flexShrink: 0 }}>
              {added && (
                <Stack direction="row" alignItems="center" gap="3px" sx={{ color: "primary.main" }}>
                  <Icon iconName={ICON_NAME.CHECK} style={{ fontSize: 10, color: "inherit" }} />
                  <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: "inherit" }}>
                    {t("assistant_item_added")}
                  </Typography>
                </Stack>
              )}
              {behaviour.preview && (
                <Tooltip
                  title={t(open ? "assistant_item_hide_preview" : "assistant_item_preview")}
                  disableInteractive>
                  <IconButton
                    size="small"
                    aria-label={t(open ? "assistant_item_hide_preview" : "assistant_item_preview")}
                    aria-expanded={open}
                    onClick={onToggle}
                    sx={{
                      width: 26,
                      height: 26,
                      flexShrink: 0,
                      color: open ? accentText(theme) : mutedText(theme),
                    }}>
                    <Icon
                      iconName={open ? ICON_NAME.EYE_SLASH : ICON_NAME.EYE}
                      style={{ fontSize: 12, color: "inherit" }}
                    />
                  </IconButton>
                </Tooltip>
              )}
              {action && (
                <Tooltip title={t(action.titleKey)} disableInteractive>
                  <span style={{ display: "inline-flex" }}>
                    <Button
                      size="small"
                      variant={action.id === "add_to_project" ? "contained" : "outlined"}
                      color={action.id === "add_to_project" ? "primary" : "inherit"}
                      aria-label={t(action.titleKey)}
                      disabled={adding}
                      onClick={(event) => run(event)}
                      startIcon={
                        adding ? (
                          <CircularProgress size={10} color="inherit" />
                        ) : action.id === "add_to_project" ? (
                          <Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 9, color: "inherit" }} />
                        ) : undefined
                      }
                      sx={{
                        ...(action.id === "add_to_project" ? pillButtonSx : neutralPillSx(theme)),
                        "&&": {
                          ...pillButtonSx["&&"],
                          px: "11px",
                          py: "3px",
                          flexShrink: 0,
                          whiteSpace: "nowrap",
                        },
                      }}>
                      {adding ? t("assistant_item_adding") : t(action.labelKey)}
                    </Button>
                  </span>
                </Tooltip>
              )}
            </Stack>
          </Stack>
          {item.note && (
            <CutText
              text={item.note}
              sx={{
                fontSize: 12.5,
                mt: "2px",
                color: "text.primary",
                overflowWrap: "anywhere",
                ...clamp(2),
              }}
            />
          )}
          <MetaLine item={item} details={details} inProject={inProject} />
        </Box>
      </Stack>
      {open && behaviour.preview && <ItemPreview item={item} />}
      {/* Mounted only while open: it reads the user's projects and spaces. */}
      {pickerAnchor && (
        <ProjectPickerMenu
          anchor={pickerAnchor}
          onClose={() => setPickerAnchor(null)}
          onPick={(project) => {
            setPickerAnchor(null);
            void add({ id: project.id, name: project.name });
          }}
        />
      )}
    </Box>
  );
}

/**
 * Result cards (spec §10): what an answer points to, from the catalog or the
 * user's own content. One button per card and a preview behind the eye, both
 * decided by `cardBehaviour` from the item's kind and the page; one preview is
 * open at a time and none opens by itself.
 */
export default function ResultCards({ groups }: { groups: CardGroup[] }) {
  const surface = useActiveSurface();
  const projectId = surface?.project?.id ?? null;
  const { layers } = useProjectLayers(projectId ?? undefined);
  const context = useMemo<ItemActionContext>(() => {
    const byDataset = new Map((layers ?? []).map((layer) => [layer.layer_id, layer.id]));
    return {
      projectId,
      canAddToProject: !!surface?.uploadTo?.projectId,
      layerOfDataset: (datasetId) => byDataset.get(datasetId) ?? null,
    };
  }, [layers, projectId, surface?.uploadTo?.projectId]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Stack gap="14px">
      {uniqueGroups(groups).map((group, index) => (
        <Stack key={`${index}-${itemKey(group.items[0])}`} gap="8px">
          {group.title && (
            <Typography
              component="h4"
              sx={{ fontSize: 12, fontWeight: 700, color: mutedText, letterSpacing: "0.02em" }}>
              {`${group.title} · ${group.items.length}`}
            </Typography>
          )}
          {group.items.map((item) => {
            const key = itemKey(item);
            return (
              <ResultCard
                key={key}
                item={item}
                context={context}
                open={open === key}
                onToggle={() => setOpen((current) => (current === key ? null : key))}
              />
            );
          })}
        </Stack>
      ))}
    </Stack>
  );
}
