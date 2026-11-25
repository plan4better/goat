import type { TFunction } from "i18next";

import type { Organization } from "@/lib/validations/organization";

import type { AssignableRole } from "@/components/settings/common/roleWords";
import type { QuotaLevel } from "@/components/settings/usage/quotaLevels";

/** A seat pool; `free` and `total` are null for a pool without a limit. */
export interface Pool {
  used: number;
  total: number | null;
  free: number | null;
}

/** Owners, admins and editors share the editor pool; viewers have their own.
 * Open invitations count in `used_*` already (F9). */
export interface Seats {
  editors: Pool;
  viewers: Pool;
}

const pool = (used: number, total: number | null): Pool => ({
  used,
  total,
  free: total === null ? null : Math.max(0, total - used),
});

export const seatsOf = (
  organization: Pick<Organization, "used_editors" | "total_editors" | "used_viewers" | "total_viewers">
): Seats => ({
  editors: pool(organization.used_editors, organization.total_editors),
  viewers: pool(organization.used_viewers, organization.total_viewers),
});

/** A seat pool is full once every seat is taken (not at 90 %, as a quota). A
 * pool without a limit, or of no seats that nobody uses (a plan without
 * viewers), needs no attention; anyone on a pool of no seats is over it. */
export const seatLevel = ({ used, total }: Pool): QuotaLevel => {
  if (total === null || (total <= 0 && used <= 0)) return "ok";
  if (used > total) return "over";
  return used >= total ? "full" : "ok";
};

const hasFree = (free: number | null, needed = 1) => free === null || free >= needed;
const takesEditorSeat = (role: AssignableRole) => role !== "organization-viewer";

export interface RoleOption {
  role: AssignableRole;
  disabledReason?: string;
}

/**
 * Admin, Bearbeiter, Betrachter for a member or an invitation now in
 * `current`: a role that needs a seat of a full pool is disabled with the
 * reason. Owners, admins and editors share the editor pool, so a swap between
 * admin and editor needs no free seat; core checks the same (B4).
 */
export const roleOptions = (current: AssignableRole, seats: Seats, t: TFunction): RoleOption[] =>
  (["organization-admin", "organization-editor", "organization-viewer"] as AssignableRole[]).map((role) => {
    if (role === current) return { role };
    if (takesEditorSeat(role)) {
      return !takesEditorSeat(current) && !hasFree(seats.editors.free)
        ? { role, disabledReason: t("settings_members_no_editor_seat") }
        : { role };
    }
    return hasFree(seats.viewers.free)
      ? { role }
      : { role, disabledReason: t("settings_members_no_viewer_seat") };
  });

/** The invite dialog's role cards: a pool is open while it has a seat for
 * every address; Bearbeiter is the default while one editor seat is free. */
export const inviteRoleState = (
  seats: Seats,
  addresses: number
): { editorsOk: boolean; viewersOk: boolean; defaultRole: AssignableRole } => ({
  editorsOk: hasFree(seats.editors.free, Math.max(1, addresses)),
  viewersOk: hasFree(seats.viewers.free, Math.max(1, addresses)),
  defaultRole: hasFree(seats.editors.free) ? "organization-editor" : "organization-viewer",
});
