import { Box, Divider, Paper, Portal, Stack, styled } from "@mui/material";
import { debounce } from "@mui/material/utils";
import type { SxProps, Theme } from "@mui/material";
import type { AnyExtension, Editor } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { NodeSelection } from "@tiptap/pm/state";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import FontSize from "@/lib/extensions/font-size";
import InfoChipExtension from "@/lib/extensions/info-chip";
import LineHeight from "@/lib/extensions/line-height";

import { AlignSelect } from "@/components/builder/widgets/elements/text/AlignSelect";
import LineHeightSelect from "@/components/builder/widgets/elements/text/LineHeightSelect";
import MenuButton from "@/components/builder/widgets/elements/text/MenuButton";
import { InfoChipEditDialog } from "@/components/builder/widgets/common/InfoChipPopover";
import LinkPopover from "@/components/builder/widgets/data/LinkPopover";
import RichTextFontSizeSelect from "@/components/builder/widgets/data/RichTextFontSizeSelect";

/** Same shell as the RichText widget — keeps the two editors visually identical. */
export const ToolbarContainer = styled(Paper)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  padding: theme.spacing(2),
  borderRadius: theme.shape.borderRadius * 2,
  boxShadow: theme.shadows[4],
  backgroundColor: theme.palette.background.paper,
}));

export interface BaseToolbarState {
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isStrike: boolean;
  isBulletList: boolean;
  isOrderedList: boolean;
  isLink: boolean;
}

export interface RichTextEditorProps<TState extends BaseToolbarState = BaseToolbarState> {
  /** Current HTML content. */
  value: string;
  /** Called with new HTML on every change (optionally debounced). */
  onChange?: (html: string) => void;
  /** When true, renders a read-only preview without the editor or toolbar. */
  viewOnly?: boolean;
  placeholder?: string;
  /** Disables Enter (no paragraph breaks) — used for the title. */
  singleLine?: boolean;
  /**
   * Full TipTap extensions list. If omitted, falls back to the minimal set
   * (StarterKit configured for inline use + Underline + Link).
   * Callers needing more (font size, color, chips, etc.) pass their own list.
   */
  extensions?: AnyExtension[];
  /**
   * Custom selector for editor state used by the toolbar. Defaults to bold/italic/underline/link.
   * Provide one to expose more keys (e.g., bullet list, strike) to your custom toolbar.
   */
  selector?: (params: { editor: Editor }) => TState;
  /** Renders the toolbar buttons inside the shared `ToolbarContainer`. Defaults to a minimal bold/italic/underline/link set. */
  renderToolbarButtons?: (editor: Editor, state: TState) => ReactNode;
  /** Renders the read-only preview when not in edit mode. Defaults to `dangerouslySetInnerHTML`. */
  renderPreview?: (html: string) => ReactNode;
  /** Lifecycle hook called when the editor is ready and editor mode changes. Return cleanup. */
  onEditor?: (editor: Editor, isEditMode: boolean) => void | (() => void);
  /** Debounce ms for `onChange` calls. Default = 0 (synchronous). */
  changeDebounceMs?: number;
  /** Container styling (passed to the outer Box). */
  sx?: SxProps<Theme>;
  /** Additional condition: when true, the editor stays in edit mode despite blur (e.g., a sidebar dropdown is open). */
  shouldKeepEditingRef?: React.RefObject<boolean>;
  /**
   * Always render the editor in edit mode (no click-to-edit, no preview).
   * Use this in sidebar form fields where the editor IS the input.
   */
  alwaysEdit?: boolean;
}

const defaultSelector = ({ editor }: { editor: Editor }): BaseToolbarState => ({
  isBold: editor.isActive("bold"),
  isItalic: editor.isActive("italic"),
  isUnderline: editor.isActive("underline"),
  isStrike: editor.isActive("strike"),
  isBulletList: editor.isActive("bulletList"),
  isOrderedList: editor.isActive("orderedList"),
  isLink: editor.isActive("link"),
});

/**
 * Shared rich-text editor used by:
 *   - The RichText widget (full toolbar with variables, info chips, font size…)
 *   - WidgetTitle and widget descriptions (minimal toolbar)
 *
 * Caller controls extensions, toolbar contents, and preview rendering via props.
 * The shell — click-to-edit, blur-to-commit, Portal toolbar positioning, edit
 * mode toggling — is shared.
 */
function RichTextEditor<TState extends BaseToolbarState = BaseToolbarState>({
  value,
  onChange,
  viewOnly,
  placeholder = "",
  singleLine = false,
  extensions: extensionsProp,
  selector,
  renderToolbarButtons,
  renderPreview,
  onEditor,
  changeDebounceMs = 0,
  sx,
  shouldKeepEditingRef,
  alwaysEdit = false,
}: RichTextEditorProps<TState>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null);
  const setToolbarRef = useCallback((node: HTMLDivElement | null) => {
    toolbarRef.current = node;
    setToolbarEl(node);
  }, []);
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const [isEditMode, setIsEditMode] = useState(alwaysEdit);
  // In alwaysEdit mode the editor is always rendered, but the toolbar should
  // only appear when the editor itself is focused (otherwise it floats with
  // no visual anchor).
  const [hasFocus, setHasFocus] = useState(false);
  const [linkAnchorEl, setLinkAnchorEl] = useState<HTMLElement | null>(null);

  // Dropdown coordination for the default toolbar (font size / alignment /
  // line height). Tracks which dropdown is currently open so the others can
  // close themselves and the editor stays in edit mode while one is open.
  const [defaultActiveDropdown, setDefaultActiveDropdown] = useState<string | null>(null);
  const defaultDropdownRef = useRef(false);
  const defaultUpdateDropdown = useCallback((value: string | null) => {
    setDefaultActiveDropdown(value);
    defaultDropdownRef.current = !!value;
  }, []);

  // Info chip edit dialog — opens when an info chip is clicked in edit mode
  // or when a fresh chip is inserted via the toolbar.
  const [infoChipDialogOpen, setInfoChipDialogOpen] = useState(false);

  const extensions = useMemo<AnyExtension[]>(() => {
    if (extensionsProp) return extensionsProp;
    return [
      StarterKit.configure({
        heading: false,
        bulletList: singleLine ? false : undefined,
        orderedList: singleLine ? false : undefined,
        listItem: singleLine ? false : undefined,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      Underline,
      TextStyle,
      FontSize,
      LineHeight,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      }),
      InfoChipExtension,
    ];
  }, [extensionsProp, singleLine]);

  const editor = useEditor({
    extensions,
    content: value || "",
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editable: isEditMode,
  });

  // Keep editable state in sync
  useEffect(() => {
    if (editor) editor.setEditable(isEditMode);
  }, [editor, isEditMode]);

  // Sync external value changes when not editing. alwaysEdit fields (sidebar
  // inputs) are always in edit mode, so they sync unless focused, otherwise
  // they keep showing the previous widget's text after the selection changes.
  useEffect(() => {
    if (!editor || (isEditMode && (!alwaysEdit || editor.isFocused))) return;
    const currentHtml = editor.getHTML();
    if (currentHtml !== (value || "")) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [editor, value, isEditMode, alwaysEdit]);

  // Persist on each change (optionally debounced)
  useEffect(() => {
    if (!editor || !onChange) return;
    const persist = () => onChange(editor.getHTML());
    const handler = changeDebounceMs > 0 ? debounce(persist, changeDebounceMs) : persist;
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor, onChange, changeDebounceMs]);

  // Single-line: swallow Enter
  useEffect(() => {
    if (!editor || !singleLine) return;
    const dom = editor.view.dom;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        editor.commands.blur();
      }
    };
    dom.addEventListener("keydown", handler);
    return () => dom.removeEventListener("keydown", handler);
  }, [editor, singleLine]);

  // Subscribe to active marks for toolbar state
  const editorStateRaw = useEditorState({
    editor,
    selector: selector ?? (defaultSelector as unknown as (params: { editor: Editor }) => TState),
  });
  const editorState = editorStateRaw as TState | null;

  // Click vs drag detection on the rendered container.
  // React events bubble through Portals, so a click inside a portal'd child
  // (e.g., a dialog opened from this editor) reaches these handlers even
  // though the click DOM is outside the container. Ignore those.
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!containerRef.current?.contains(e.target as Node)) return;
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!mouseDownPos.current) return;
    if (!containerRef.current?.contains(e.target as Node)) {
      mouseDownPos.current = null;
      return;
    }
    const dx = e.clientX - mouseDownPos.current.x;
    const dy = e.clientY - mouseDownPos.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    mouseDownPos.current = null;
    if (alwaysEdit) return;
    // If the click landed on an interactive preview element (info chip or
    // link), let the preview handle it instead of switching to edit mode —
    // otherwise the preview unmounts before its click handler can show the
    // popup.
    if ((e.target as HTMLElement).closest?.(".info-chip, a")) return;
    if (distance < 5 && !isEditMode && !viewOnly && onChange) {
      setIsEditMode(true);
      setTimeout(() => editor?.commands.focus(), 0);
    }
  };

  // Blur to exit edit mode (unless focus moved into the toolbar or a dropdown is open)
  useEffect(() => {
    if (!editor) return;
    const handleFocus = () => setHasFocus(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleBlur = ({ event }: any) => {
      const next = event?.relatedTarget as HTMLElement | null;
      if (next && (next.closest(".tiptap-toolbar") || toolbarRef.current?.contains(next))) return;
      if (shouldKeepEditingRef?.current) return;
      if (defaultDropdownRef.current) return;
      setHasFocus(false);
      if (alwaysEdit) {
        setLinkAnchorEl(null);
        return;
      }
      // Flush any pending edits BEFORE flipping isEditMode false.
      // The persist callback (editor.on("update", ...)) is debounced, so
      // value (the prop) lags behind editor.getHTML() between the last
      // change and the debounce timeout. If we let isEditMode flip first,
      // the external-value-sync effect below sees value !== currentHtml
      // and overwrites the editor's content with the stale value — which
      // wipes out chips that were just inserted, etc.
      if (onChange) {
        const html = editor.getHTML();
        if (html !== (value || "")) onChange(html);
      }
      setIsEditMode(false);
      setLinkAnchorEl(null);
    };
    editor.on("focus", handleFocus);
    editor.on("blur", handleBlur);
    return () => {
      editor.off("focus", handleFocus);
      editor.off("blur", handleBlur);
    };
  }, [editor, shouldKeepEditingRef, alwaysEdit, onChange, value]);

  // Lifecycle hook for widget-specific behavior (e.g., extra event listeners)
  useEffect(() => {
    if (!editor || !onEditor) return;
    const cleanup = onEditor(editor, isEditMode);
    return cleanup ?? undefined;
  }, [editor, isEditMode, onEditor]);

  // Info chip handling. Two paths funnel into one place:
  //   - Toolbar [i] insert: caller runs insertInfoChip + setNodeSelection on the
  //     new chip.
  //   - User click on an existing chip: a click handler on editor.view.dom
  //     finds the chip's pos (via data-info-id or posAtCoords) and calls
  //     setNodeSelection.
  // Both cause selection to become a NodeSelection on the infoChip; the
  // selectionUpdate listener below opens the dialog. Going through the editor
  // state (not a DOM dispatch) avoids races with React rerenders, ProseMirror's
  // own click handling, and synthetic-event quirks.
  useEffect(() => {
    if (!editor || !isEditMode) return;
    const hasInfoChip = !!editor.extensionManager.extensions.find(
      (ext) => ext.name === "infoChip"
    );
    if (!hasInfoChip) return;

    const handleSelectionUpdate = () => {
      const { selection } = editor.state;
      if (selection instanceof NodeSelection && selection.node.type.name === "infoChip") {
        setInfoChipDialogOpen(true);
      }
    };
    editor.on("selectionUpdate", handleSelectionUpdate);

    const findChipPos = (chipEl: HTMLElement, event: MouseEvent): number | null => {
      const infoId = chipEl.getAttribute("data-info-id");
      if (infoId) {
        let found: number | null = null;
        editor.state.doc.descendants((node, pos) => {
          if (found !== null) return false;
          if (node.type.name === "infoChip" && node.attrs.infoId === infoId) {
            found = pos;
            return false;
          }
          return true;
        });
        if (found !== null) return found;
      }
      const coords = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (coords) {
        for (const p of [coords.pos, coords.pos - 1]) {
          if (p < 0) continue;
          const node = editor.state.doc.nodeAt(p);
          if (node?.type.name === "infoChip") return p;
        }
      }
      return null;
    };
    const editorEl = editor.view.dom;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const chipEl = target.closest(".info-chip") as HTMLElement | null;
      if (!chipEl) return;
      event.preventDefault();
      event.stopPropagation();
      const chipPos = findChipPos(chipEl, event);
      if (chipPos === null) return;
      // setNodeSelection triggers selectionUpdate → handler opens the dialog.
      // If the selection happens to already match (clicking the same chip
      // that's already selected), force-open as a fallback.
      const before = editor.state.selection;
      editor.chain().focus().setNodeSelection(chipPos).run();
      const after = editor.state.selection;
      if (
        before instanceof NodeSelection &&
        after instanceof NodeSelection &&
        before.from === after.from
      ) {
        setInfoChipDialogOpen(true);
      }
    };
    editorEl.addEventListener("click", handleClick);

    return () => {
      editor.off("selectionUpdate", handleSelectionUpdate);
      editorEl.removeEventListener("click", handleClick);
    };
  }, [editor, isEditMode]);

  // Track toolbar position above the editor — only update when the container
  // moves/resizes, the toolbar mounts/resizes, or the viewport changes.
  const [toolbarPos, setToolbarPos] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (!isEditMode || !containerRef.current) return;
    const container = containerRef.current;
    let frame = 0;
    const update = () => {
      const rect = container.getBoundingClientRect();
      const toolbarWidth = toolbarEl?.offsetWidth ?? 0;
      const halfToolbar = toolbarWidth / 2;
      const padding = 8;
      const centeredLeft = rect.left + rect.width / 2;
      // Clamp so the toolbar stays fully on-screen. If the toolbar is wider
      // than the viewport, pin it to the left edge instead of overflowing.
      let clampedLeft = centeredLeft;
      if (halfToolbar > 0) {
        const minLeft = halfToolbar + padding;
        const maxLeft = window.innerWidth - halfToolbar - padding;
        clampedLeft =
          maxLeft < minLeft ? minLeft : Math.max(minLeft, Math.min(centeredLeft, maxLeft));
      }
      setToolbarPos((prev) => {
        const nextTop = rect.top - 8;
        if (prev.top === nextTop && prev.left === clampedLeft) return prev;
        return { top: nextTop, left: clampedLeft };
      });
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    if (toolbarEl) ro.observe(toolbarEl);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [isEditMode, toolbarEl]);

  const handleLinkClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (!editor) return;
      if (editor.isActive("link")) {
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
      } else {
        setLinkAnchorEl(e.currentTarget);
      }
    },
    [editor]
  );

  // Default toolbar — visually mirrors the RichText widget's toolbar (minus
  // the widget-specific variable insert and info-chip insert buttons).
  const defaultToolbar = useCallback(
    (e: Editor, state: BaseToolbarState) => (
      <Stack direction="row" spacing={1} alignItems="center">
        <RichTextFontSizeSelect
          editor={e}
          onOpen={() => defaultUpdateDropdown("fontSize")}
          onClose={() => defaultUpdateDropdown(null)}
          forceClose={defaultActiveDropdown !== "fontSize" && defaultActiveDropdown !== null}
        />
        <Divider flexItem orientation="vertical" />
        <Stack direction="row" spacing={0.5} alignItems="center">
          <MenuButton
            value="bold"
            iconName={ICON_NAME.BOLD}
            selected={state.isBold}
            onClick={() => e.chain().focus().toggleBold().run()}
          />
          <MenuButton
            value="italic"
            iconName={ICON_NAME.ITALIC}
            selected={state.isItalic}
            onClick={() => e.chain().focus().toggleItalic().run()}
          />
          <MenuButton
            value="underline"
            iconName={ICON_NAME.UNDERLINE}
            selected={state.isUnderline}
            onClick={() => e.chain().focus().toggleUnderline().run()}
          />
          <MenuButton
            value="strike"
            iconName={ICON_NAME.STRIKETHROUGH}
            selected={state.isStrike}
            onClick={() => e.chain().focus().toggleStrike().run()}
          />
        </Stack>
        {!singleLine && (
          <>
            <Divider flexItem orientation="vertical" />
            <Stack direction="row" spacing={0.5} alignItems="center">
              <MenuButton
                value="bulletList"
                iconName={ICON_NAME.BULLET_LIST}
                selected={state.isBulletList}
                onClick={() => e.chain().focus().toggleBulletList().run()}
              />
              <MenuButton
                value="orderedList"
                iconName={ICON_NAME.NUMBERED_LIST}
                selected={state.isOrderedList}
                onClick={() => e.chain().focus().toggleOrderedList().run()}
              />
            </Stack>
          </>
        )}
        <Divider flexItem orientation="vertical" />
        <AlignSelect
          editor={e}
          onOpen={() => defaultUpdateDropdown("align")}
          onClose={() => defaultUpdateDropdown(null)}
          forceClose={defaultActiveDropdown !== "align" && defaultActiveDropdown !== null}
        />
        <LineHeightSelect
          editor={e}
          onOpen={() => defaultUpdateDropdown("lineHeight")}
          onClose={() => defaultUpdateDropdown(null)}
          forceClose={defaultActiveDropdown !== "lineHeight" && defaultActiveDropdown !== null}
        />
        <Divider flexItem orientation="vertical" />
        <Stack direction="row" spacing={0.5} alignItems="center">
          <MenuButton
            value="link"
            iconName={ICON_NAME.LINK}
            selected={state.isLink}
            onClick={handleLinkClick}
          />
          <MenuButton
            value="infoChip"
            iconName={ICON_NAME.INFO}
            selected={false}
            onClick={() => {
              e.chain().focus().insertInfoChip().run();
              // After insert the cursor is just past the chip, so the chip
              // is at cursor - 1. Select it so the selectionUpdate listener
              // opens the edit dialog.
              const chipPos = e.state.selection.from - 1;
              const inserted = e.state.doc.nodeAt(chipPos);
              if (inserted?.type.name !== "infoChip") return;
              e.chain().focus().setNodeSelection(chipPos).run();
            }}
          />
        </Stack>
      </Stack>
    ),
    [defaultActiveDropdown, defaultUpdateDropdown, handleLinkClick, singleLine]
  );

  const renderedPreview = renderPreview ? (
    renderPreview(value || "")
  ) : (
    <Box
      dangerouslySetInnerHTML={{
        __html:
          value && value.trim().length > 0
            ? value
            : `<span style="opacity:0.4">${placeholder}</span>`,
      }}
    />
  );

  // viewOnly: render preview without an editor instance attached.
  // Don't show the placeholder publicly — only show real value content.
  if (viewOnly || !onChange) {
    const hasContent = !!value && value.trim().length > 0;
    if (!hasContent && !renderPreview) return null;
    return (
      <Box
        sx={[
          (theme) => ({
            "& p": { margin: 0 },
            "& .info-chip": {
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
            "& a": { color: theme.palette.primary.main, textDecoration: "underline" },
          }),
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}>
        {renderPreview ? (
          renderPreview(value || "")
        ) : (
          <Box dangerouslySetInnerHTML={{ __html: value || "" }} />
        )}
      </Box>
    );
  }

  return (
    <Box
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      sx={[
        (theme) => ({
          cursor: isEditMode ? "text" : "pointer",
          "& .ProseMirror": {
            outline: "none",
            // Multi-line editors need a minimum tappable height; single-line
            // titles render at their natural line height.
            minHeight: singleLine ? undefined : 40,
          },
          // Reset browser default <p> margins everywhere — the editor uses
          // <p> for paragraphs and so does the read-only preview's
          // dangerouslySetInnerHTML output. Without this the rendered title
          // gets pushed down by 16px from the user-agent stylesheet.
          "& p": { margin: 0 },
          "& a": { color: theme.palette.primary.main, textDecoration: "underline" },
          // Info chip styling — applies to chips rendered both inside the
          // editor (`.ProseMirror .info-chip`) and in the read-only preview
          // (`.info-chip` directly under the container).
          "& .info-chip": {
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
        }),
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}>
      {isEditMode ? (
        <Box sx={{ height: "100%", "& > div": { height: "100%" } }}>
          <EditorContent editor={editor} />
        </Box>
      ) : (
        renderedPreview
      )}

      {isEditMode && (alwaysEdit ? hasFocus : true) && (
        <Portal>
          <Box
            ref={setToolbarRef}
            className="tiptap-toolbar"
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            sx={{
              position: "fixed",
              top: toolbarPos.top,
              left: toolbarPos.left,
              transform: "translate(-50%, -100%)",
              zIndex: 1400,
              pointerEvents: "auto",
            }}>
            <ToolbarContainer>
              {editor && editorState &&
                (renderToolbarButtons
                  ? renderToolbarButtons(editor, editorState)
                  : defaultToolbar(editor, editorState))}
            </ToolbarContainer>
          </Box>
          {editor && linkAnchorEl && (
            <LinkPopover editor={editor} anchorEl={linkAnchorEl} onClose={() => setLinkAnchorEl(null)} />
          )}
        </Portal>
      )}
      {editor && (
        <InfoChipEditDialog
          editor={editor}
          open={infoChipDialogOpen}
          onClose={() => setInfoChipDialogOpen(false)}
          onPersist={() => onChange?.(editor.getHTML())}
        />
      )}
    </Box>
  );
}

export default RichTextEditor;
