import type { OrganizationMember } from "@/lib/validations/organization";

import { personName } from "@/components/settings/common/personName";
import { ORG_ROLE_ORDER, type OrgRole, orgRoleOf } from "@/components/settings/common/roleWords";

export type RoleFilter = "all" | "admins" | "editors" | "viewers" | "editorSeats";
export type StatusFilter = "all" | "members" | "pending";

export interface MemberRow {
  id: string;
  /** The display name; an invitation's (and a nameless account's) is its address. */
  name: string;
  email: string;
  avatar: string | null;
  role: OrgRole;
  pending: boolean;
  isSelf: boolean;
  /** Core B5, naive UTC: a member's join date; an invitation's creation and last send. */
  joinedAt?: string | null;
  invitedAt?: string | null;
  lastSentAt?: string | null;
}

export type MemberSort = { key: "member" | "role"; dir: "asc" | "desc" };

export const toMemberRows = (members: OrganizationMember[], selfId: string | undefined): MemberRow[] =>
  members.map((member) => ({
    id: member.id,
    name: personName(member),
    email: member.email,
    avatar: member.avatar || null,
    role: orgRoleOf(member.roles) ?? "organization-viewer",
    pending: member.invitation_status === "pending",
    isSelf: member.id === selfId,
    joinedAt: member.joined_at ?? null,
    invitedAt: member.invited_at ?? null,
    lastSentAt: member.last_sent_at ?? null,
  }));

const ROLE_MATCH: Record<Exclude<RoleFilter, "all">, OrgRole[]> = {
  admins: ["organization-owner", "organization-admin"],
  editors: ["organization-editor"],
  viewers: ["organization-viewer"],
  editorSeats: ["organization-owner", "organization-admin", "organization-editor"],
};

export const filterMemberRows = (
  rows: MemberRow[],
  { query, role, status }: { query: string; role: RoleFilter; status: StatusFilter }
): MemberRow[] => {
  const needle = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (role === "all" || ROLE_MATCH[role].includes(row.role)) &&
      (status === "all" || (status === "pending") === row.pending) &&
      (!needle || row.name.toLowerCase().includes(needle) || row.email.toLowerCase().includes(needle))
  );
};

/** Role: Eigentümer to Betrachter, members before invitations, then by name
 * (an invitation's name is its address). Member: by name. `desc` reverses. */
export const sortMemberRows = (rows: MemberRow[], sort: MemberSort, collator: Intl.Collator): MemberRow[] => {
  const byName = (a: MemberRow, b: MemberRow) => collator.compare(a.name, b.name);
  const byRole = (a: MemberRow, b: MemberRow) =>
    ORG_ROLE_ORDER.indexOf(a.role) - ORG_ROLE_ORDER.indexOf(b.role) ||
    Number(a.pending) - Number(b.pending) ||
    byName(a, b);
  const compare = sort.key === "role" ? byRole : byName;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sign * compare(a, b));
};
