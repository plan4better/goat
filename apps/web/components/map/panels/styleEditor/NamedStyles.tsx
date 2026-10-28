"use client";

// A project layer's named styles (spec 10), at the top of the style tab: the active style in a pill, the save state
// and undo/redo. The pill opens the styles beside the panel: a row per style to switch to, each with its own menu
// (rename, duplicate, move, make it the dataset's default, delete, never the last), a new style (at most ten), and
// copy or paste of the active style between layers of the same kind and geometry.
import {
  Box,
  Button,
  Divider,
  IconButton,
  InputBase,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { type KeyboardEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { createNamedStyle, deleteNamedStyle, setStyleAsDefault, updateNamedStyle } from "@/lib/api/map";
import { setStyleClipboard } from "@/lib/store/layer/slice";
import type { Geometry } from "@/lib/style/compile/types";
import type { EditorStore } from "@/lib/style/editor/store";

import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import PopperMenu, { type PopperMenuItem } from "@/components/common/PopperMenu";
import ToolPill from "@/components/dashboard/common/ToolPill";
import { useSaverState, useStatusText } from "@/components/map/panels/styleEditor/StatusLine";
import { type EditorLayer, HistoryButtons } from "@/components/map/panels/styleEditor/StyleEditor";
import {
  anchorTopOf,
  useIsOpener,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";

/** Named styles per project layer (spec 10). */
export const MAX_STYLES = 10;

export interface NamedStylesProps {
  projectId: string;
  layer: MapLayer;
  store: EditorStore | null;
  kind: EditorLayer["kind"];
  geometry?: Geometry;
  /** The dataset's editors may make a style its default. */
  canSetDefault: boolean;
  /** Makes another named style the active one (map state). */
  onSwitch: (styleId: string) => Promise<void>;
  /** The map request again, after a style was added, renamed, moved or deleted. */
  onChanged: () => Promise<unknown>;
}

/** The latest props for the popover, which renders apart from this component and must not show a stale list. */
interface Live {
  get(): NamedStylesProps;
  set(next: NamedStylesProps): void;
  subscribe(listener: () => void): () => void;
}

function createLive(initial: NamedStylesProps): Live {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      current = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Saved: a quiet check, the word on hover. Saving, retrying, offline or stopped: in words. */
function SaveState({ store }: { store: EditorStore }) {
  const { status } = useSaverState(store.saver);
  const { text, stopped } = useStatusText(store.saver);
  if (status === "saved")
    return (
      <Tooltip title={text}>
        <Box
          component="span"
          role="status"
          aria-label={text}
          sx={{ display: "inline-flex", color: "text.secondary", px: 1.5 }}>
          <Icon iconName={ICON_NAME.CIRCLECHECK} sx={{ fontSize: 14 }} />
        </Box>
      </Tooltip>
    );
  return (
    <Typography
      variant="caption"
      role="status"
      noWrap
      color={stopped ? "error" : "text.secondary"}
      sx={{ minWidth: 0 }}>
      {text}
    </Typography>
  );
}

interface ListedStyle {
  id: string;
  name: string;
  active: boolean;
}

/** One style as the panel's lists draw an item (the active one selected): a click switches to it, a double click
 * renames it in place; its menu is the secondary action. */
function StyleRow({
  style,
  renaming,
  onPick,
  onRename,
  onRenamed,
  menu,
}: {
  style: ListedStyle;
  renaming: boolean;
  onPick: () => void;
  onRename: () => void;
  onRenamed: (name: string | null) => void;
  /** Its actions, in the layer list's menu. */
  menu: PopperMenuItem[];
}) {
  const { t } = useTranslation("common");
  const [draft, setDraft] = useState(style.name);
  useEffect(() => setDraft(style.name), [style.name, renaming]);
  const done = useRef(false);
  useEffect(() => {
    done.current = false;
  }, [renaming]);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onRenamed(name);
  };
  if (renaming)
    return (
      <ListItem disablePadding sx={{ py: 0.5, px: 2 }}>
        <InputBase
          autoFocus
          fullWidth
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={() => finish(draft)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") finish(draft);
            if (event.key === "Escape") {
              // Escape cancels the rename; the popover stays open.
              event.stopPropagation();
              finish(null);
            }
          }}
          inputProps={{ "aria-label": t("name") }}
          sx={{
            height: 32,
            px: 2,
            fontSize: "0.875rem",
            borderRadius: 1,
            border: 1,
            borderColor: "primary.main",
          }}
        />
      </ListItem>
    );
  return (
    <ListItem
      disablePadding
      sx={{ "& .MuiListItemSecondaryAction-root": { right: 12 } }}
      secondaryAction={
        <PopperMenu
          menuItems={menu}
          disablePortal={false}
          menuButton={
            <Tooltip title={t("more_options")} placement="top">
              <IconButton
                edge="end"
                size="small"
                aria-label={t("style_editor.style_more", { name: style.name })}
                aria-haspopup="menu"
                sx={{ px: 0.5 }}>
                <Icon iconName={ICON_NAME.MORE_VERT} style={{ fontSize: "15px" }} />
              </IconButton>
            </Tooltip>
          }
        />
      }>
      <ListItemButton
        dense
        selected={style.active}
        aria-current={style.active ? "true" : undefined}
        onClick={onPick}
        onDoubleClick={onRename}
        // An item of the panel's menus (the Selector's): full width, its name in body2 bold in the secondary text
        // color, the selected one on the primary tint.
        sx={(theme) => ({
          py: 2,
          pl: 3,
          borderRadius: 0,
          color: "text.secondary",
          "& .MuiListItemText-root": { my: 0 },
          "& .MuiListItemText-primary": { ...theme.typography.body2, fontWeight: "bold", color: "inherit" },
          "&:hover": { bgcolor: "action.hover" },
          "&.Mui-selected": { bgcolor: alpha(theme.palette.primary.main, 0.08) },
          "&.Mui-selected:hover": { bgcolor: alpha(theme.palette.primary.main, 0.12) },
        })}>
        <ListItemText primary={style.name} primaryTypographyProps={{ noWrap: true }} />
      </ListItemButton>
    </ListItem>
  );
}

function StylesPopover({ live }: { live: Live }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const clipboard = useAppSelector((state) => state.layers.styleClipboard);
  const props = useSyncExternalStore(live.subscribe, live.get, live.get);
  const { projectId, layer, store, kind, geometry, canSetDefault, onSwitch, onChanged } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  // The style clicked, shown selected while the switch is on its way.
  const [pending, setPending] = useState<string | null>(null);
  const active = layer.style;
  useEffect(() => setPending(null), [active?.id]);
  if (!active) return null;

  const others = layer.otherStyles ?? [];
  const count = others.length + 1;
  const full = count >= MAX_STYLES;
  const canPaste = !!store && !!clipboard && clipboard.kind === kind && clipboard.geometry === geometry;
  const run = (action: () => Promise<unknown>) => void action().then(() => onChanged());
  // The styles in their order: the active one at its position among the others.
  const listed: ListedStyle[] = others.map((style) => ({ id: style.id, name: style.name, active: false }));
  listed.splice(Math.min(active.position, listed.length), 0, {
    id: active.id,
    name: active.name,
    active: true,
  });

  const pick = (id: string) => {
    setPending(id);
    void onSwitch(id);
  };

  const add = async () => {
    const created = await createNamedStyle(projectId, layer.id, {
      name: t("style_editor.new_style_name", { n: count + 1 }),
    });
    // The new style becomes the active one (the switch brings the list with it), its name ready to type.
    if (created?.id) {
      setRenaming(created.id);
      await onSwitch(created.id);
    } else await onChanged();
  };

  /** A style's actions, grouped as the layer list's menu groups them. */
  const menuItems = (index: number): PopperMenuItem[] => {
    const style = listed[index];
    const move = (to: number) => () =>
      run(() => updateNamedStyle(projectId, layer.id, style.id, { position: to }));
    return [
      {
        id: "rename",
        group: "edit",
        label: t("rename"),
        icon: ICON_NAME.EDIT,
        onClick: () => setRenaming(style.id),
      },
      {
        id: "duplicate",
        group: "edit",
        label: t("duplicate"),
        icon: ICON_NAME.CLONE,
        disabled: full,
        onClick: () =>
          run(() =>
            createNamedStyle(projectId, layer.id, {
              name: t("style_editor.copy_of", { name: style.name }),
              copy_from: style.id,
            })
          ),
      },
      {
        id: "up",
        group: "edit",
        label: t("style_editor.move_style_up"),
        icon: ICON_NAME.CHEVRON_UP,
        disabled: index <= 0,
        onClick: move(index - 1),
      },
      {
        id: "down",
        group: "edit",
        label: t("style_editor.move_style_down"),
        icon: ICON_NAME.CHEVRON_DOWN,
        disabled: index >= count - 1,
        onClick: move(index + 1),
      },
      ...(canSetDefault
        ? [
            {
              id: "default",
              group: "edit",
              label: t("style_editor.set_default_style"),
              icon: ICON_NAME.STAR,
              // A copy over the dataset's default, kept apart from this style: say that it happened.
              onClick: () =>
                void setStyleAsDefault(projectId, layer.id, style.id).then(
                  () => toast.success(t("style_editor.default_style_set", { name: style.name })),
                  () => toast.error(t("style_editor.default_style_failed"))
                ),
            },
          ]
        : []),
      {
        id: "delete",
        group: "delete",
        label: t("delete"),
        icon: ICON_NAME.TRASH,
        color: "error.main",
        disabled: count <= 1,
        onClick: () => run(() => deleteNamedStyle(projectId, layer.id, style.id)),
      },
    ];
  };

  return (
    <Box sx={{ px: 3, pb: 3 }}>
      {/* About six rows show; more scroll, so the actions under the list stay in view. */}
      <List
        dense
        disablePadding
        aria-label={t("style_editor.styles")}
        sx={{ mx: -3, maxHeight: 240, overflowY: "auto" }}>
        {listed.map((style, index) => (
          <StyleRow
            key={style.id}
            style={{ ...style, active: pending ? pending === style.id : style.active }}
            renaming={renaming === style.id}
            onPick={() => {
              if (!style.active && pending !== style.id) pick(style.id);
            }}
            onRename={() => setRenaming(style.id)}
            onRenamed={(name) => {
              setRenaming(null);
              const next = name?.trim();
              if (next && next !== style.name)
                run(() => updateNamedStyle(projectId, layer.id, style.id, { name: next }));
            }}
            menu={menuItems(index)}
          />
        ))}
      </List>
      {/* The prototype's ghost button: green text, no fill. */}
      <Button
        variant="text"
        size="small"
        disabled={full}
        startIcon={<Icon iconName={ICON_NAME.PLUS} sx={{ fontSize: "12px !important" }} />}
        onClick={() => void add()}
        sx={{
          mt: 3,
          height: 32,
          px: 2.5,
          borderRadius: 2,
          fontSize: 13,
          fontWeight: 700,
          textTransform: "none",
        }}>
        {t("style_editor.new_style")}
      </Button>
      {full && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ px: 2 }}>
          {t("style_editor.styles_full", { max: MAX_STYLES })}
        </Typography>
      )}
      <Divider sx={{ mx: -3, my: 3 }} />
      <Box sx={{ display: "flex", gap: 2 }}>
        <Button
          fullWidth
          size="small"
          variant="outlined"
          color="inherit"
          disabled={!store}
          startIcon={<Icon iconName={ICON_NAME.COPY} sx={{ fontSize: "13px !important" }} />}
          onClick={() => {
            if (store)
              dispatch(
                setStyleClipboard({ sourceLayerName: layer.name, document: store.document, kind, geometry })
              );
          }}
          sx={HALF}>
          {t("style_editor.copy_style")}
        </Button>
        <Button
          fullWidth
          size="small"
          variant="outlined"
          color="inherit"
          disabled={!canPaste}
          startIcon={<Icon iconName={ICON_NAME.PASTE} sx={{ fontSize: "13px !important" }} />}
          // One undo step: the whole copied document replaces this one.
          onClick={() => {
            if (canPaste && clipboard) store?.update(() => clipboard.document);
          }}
          sx={HALF}>
          {t("style_editor.paste_style")}
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ pt: 2 }}>
        {canPaste && clipboard
          ? t("style_editor.paste_note", { name: clipboard.sourceLayerName })
          : t("style_editor.copy_note")}
      </Typography>
    </Box>
  );
}

/** Copy and paste side by side: the prototype's outlined 32 px buttons with an 8 px radius. */
const HALF = {
  height: 32,
  borderRadius: 2,
  borderColor: "divider",
  fontSize: 13,
  fontWeight: 600,
  textTransform: "none",
  "&:hover": { borderColor: "text.disabled" },
} as const;

export function NamedStyles(props: NamedStylesProps) {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const [live] = useState(() => createLive(props));
  useEffect(() => live.set(props));
  const [pill, setPill] = useState<HTMLButtonElement | null>(null);
  const open = useIsOpener(pill);
  const { store, layer } = props;
  if (!layer.style) return null;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        px: 3,
        pt: 3,
        pb: 3,
        minWidth: 0,
        borderBottom: 1,
        borderColor: "divider",
      }}>
      {/* The panel's pill (the sections' scope chip is one too): the style's name beside a palette; it never takes more
          than most of the row, so the save state and undo stay in view. */}
      <Box sx={{ display: "flex", minWidth: 0, maxWidth: "70%" }}>
        <ToolPill
          ref={setPill}
          small
          flat
          chevron
          icon={ICON_NAME.STYLE}
          label={layer.style.name}
          ariaLabel={`${t("style_editor.styles")}: ${layer.style.name}`}
          popup={{ kind: "dialog", open }}
          active={open}
          onClick={() => {
            if (!pill) return;
            if (popover.current(1)?.key === "styles") return popover.close(1);
            popover.open(1, {
              key: "styles",
              title: t("style_editor.styles"),
              anchorTop: anchorTopOf(pill),
              render: () => <StylesPopover live={live} />,
            });
          }}
        />
      </Box>
      <Box sx={{ flex: 1 }} />
      {store && <SaveState store={store} />}
      {store && <HistoryButtons store={store} />}
    </Box>
  );
}
