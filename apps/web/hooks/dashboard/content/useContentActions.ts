"use client";

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { spaceDisplayName } from "@/lib/utils/content";
import type { ContentItem, ContentRole, Space } from "@/lib/validations/content";

import { ContentActions } from "@/types/common";

import type { PopperMenuItem } from "@/components/common/PopperMenu";

/**
 * The role that gates an item's actions: `item.my_role` alone. The
 * backend's `effective_role` already folds space membership into that
 * value, and an owner can deliberately narrow one item's role below the
 * space's own default (spec D8) — so a space's `my_role` must never *raise*
 * what an item itself grants. `space` plays no part in this decision; a
 * space's own role only gates space-level controls (e.g. "Add new"), not
 * per-item actions.
 */
export const roleOf = (item: ContentItem): ContentRole => item.my_role;

/**
 * Whether Share / Move / Delete / Transfer may act on this row: the caller
 * owns it (`roleOf`) and it is the item itself, not a shortcut. A shortcut
 * row carries its *target's* id and role, so acting on it would silently
 * act on the target in another space — the kebab offers a shortcut nothing
 * but OPEN, and every selection path (action bar, details panel, drag)
 * gates on this instead of on the role alone.
 */
export const canActOn = (item: ContentItem): boolean => roleOf(item) === "owner" && !item.is_shortcut;

/**
 * Whether Move may act on a whole selection: every row is actionable
 * (`canActOn`) and they all live in one space. `MoveDialog` browses a single
 * space's folder tree, and `moveContentItems` walks the selection
 * sequentially — a cross-space selection would offer the first item's
 * folders to all of them and half-apply before the backend refused the rest.
 * Leaving a space is a transfer, not a move. Every entry point into Move on
 * a selection (the action bar, the details panel) gates on this.
 */
export const canMoveAll = (items: ContentItem[]): boolean =>
  items.length > 0 && items.every((item) => canActOn(item) && item.space_id === items[0].space_id);

/**
 * Builds the kebab/action-bar menu for one content item, gated by
 * `item.my_role` alone (see `roleOf` above) — not folder or `shared_with`
 * grants, which the item's own `my_role` is assumed to already fold in on
 * the backend, and not the passed `space`'s role either. `space` is only
 * used here to resolve a shortcut's target-space name for its label.
 */
export const useContentActions = () => {
  const { t } = useTranslation("common");

  const getMenuItems = useCallback(
    (item: ContentItem, space: Space | undefined): PopperMenuItem[] => {
      if (item.is_shortcut) {
        return [
          {
            id: ContentActions.OPEN,
            label: t("open_in", { name: spaceDisplayName(space, t) }),
            icon: ICON_NAME.EXTERNAL_LINK,
          },
        ];
      }

      const role = roleOf(item);
      const items: PopperMenuItem[] = [
        { id: ContentActions.OPEN, label: t("open"), icon: ICON_NAME.EXTERNAL_LINK },
        { id: ContentActions.DETAILS, label: t("details"), icon: ICON_NAME.INFO },
      ];

      if (item.type === "bundle") {
        if (role === "owner") {
          items.push(
            { id: ContentActions.MOVE, label: `${t("move_to")}…`, icon: ICON_NAME.FOLDER },
            { id: ContentActions.SHARE, label: t("share"), icon: ICON_NAME.SHARE },
            { id: ContentActions.DELETE, label: t("delete"), icon: ICON_NAME.TRASH, color: "error.main" }
          );
        }
        return items;
      }

      if (item.type === "folder") {
        if (role === "owner" || role === "editor") {
          items.push({ id: ContentActions.RENAME, label: t("rename"), icon: ICON_NAME.EDIT });
        }
        if (role === "owner") {
          items.push(
            { id: ContentActions.MOVE, label: `${t("move_to")}…`, icon: ICON_NAME.FOLDER },
            { id: ContentActions.SHARE, label: t("share"), icon: ICON_NAME.SHARE },
            { id: ContentActions.DELETE, label: t("delete"), icon: ICON_NAME.TRASH, color: "error.main" }
          );
        }
        return items;
      }

      if (item.type === "template") {
        items.push({ id: ContentActions.USE_TEMPLATE, label: t("use_template"), icon: ICON_NAME.CLONE });
        if (role === "owner") {
          items.push(
            { id: ContentActions.MOVE, label: `${t("move_to")}…`, icon: ICON_NAME.FOLDER },
            { id: ContentActions.SHARE, label: t("share"), icon: ICON_NAME.SHARE }
          );
        }
        if (role === "owner" || role === "editor") {
          // One dialog for name, description, categories, thumbnail and —
          // for a superuser — the GOAT catalog switch (see SaveTemplateDialog).
          items.push({ id: ContentActions.EDIT_TEMPLATE, label: `${t("edit")}…`, icon: ICON_NAME.EDIT });
        }
        if (role === "owner") {
          items.push({
            id: ContentActions.DELETE,
            label: t("delete"),
            icon: ICON_NAME.TRASH,
            color: "error.main",
          });
        }
        return items;
      }

      // project or layer
      if (role === "owner" || role === "editor") {
        items.push({ id: ContentActions.EDIT_METADATA, label: t("edit_metadata"), icon: ICON_NAME.EDIT });
      }
      if (role === "owner") {
        items.push(
          { id: ContentActions.MOVE, label: `${t("move_to")}…`, icon: ICON_NAME.FOLDER },
          { id: ContentActions.SHARE, label: t("share"), icon: ICON_NAME.SHARE }
        );
      }

      if (item.type === "layer" && (item.layer_type === "feature" || item.layer_type === "table")) {
        items.push({ id: ContentActions.DOWNLOAD, label: t("download"), icon: ICON_NAME.DOWNLOAD });
        if (role === "owner" || role === "editor") {
          items.push({ id: ContentActions.UPDATE, label: t("update"), icon: ICON_NAME.REFRESH });
        }
      }

      if (item.type === "project") {
        items.push({ id: ContentActions.DUPLICATE, label: t("duplicate"), icon: ICON_NAME.COPY });
        if (role === "owner" || role === "editor") {
          items.push({ id: ContentActions.EXPORT, label: t("export"), icon: ICON_NAME.DOWNLOAD });
        }
      }

      if (role === "owner") {
        items.push({
          id: ContentActions.DELETE,
          label: t("delete"),
          icon: ICON_NAME.TRASH,
          color: "error.main",
        });
      }

      return items;
    },
    [t]
  );

  return { getMenuItems, roleOf, canActOn };
};
