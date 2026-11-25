import * as z from "zod";

import { invitationStatusEnum } from "@/lib/validations/invitation";

export const teamRoleEnum = z.enum(["team-owner", "team-member"]);

export const teamRoles = {
  OWNER: "team-owner",
  MEMBER: "team-member",
} as const;

export const teamBaseSchema = z.object({
  name: z.string().min(1).max(50),
  // Core sends null for a team without one.
  description: z.string().max(250).optional().nullable(),
  avatar: z.string().optional().nullable(),
});

/** One face of a team's card (core's `TeamMemberPreview`): the owner first, then by name. */
export const teamMemberPreviewSchema = z.object({
  id: z.string(),
  firstname: z.string().nullable().optional(),
  lastname: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  role: teamRoleEnum,
});

export const teamSchema = teamBaseSchema.extend({
  id: z.string(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  // null for an owner or admin of the organization who is not in the team
  role: teamRoleEnum.nullable(),
  member_count: z.number().optional(),
  members_preview: z.array(teamMemberPreviewSchema).optional(),
});

export const teamMemberSchema = z.object({
  id: z.string(),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
  email: z.string().email(),
  role: teamRoleEnum,
  avatar: z.string().optional(),
  invitation_status: invitationStatusEnum.optional(),
});

export const teamUpdateSchema = teamBaseSchema.partial();

export type TeamBase = z.infer<typeof teamBaseSchema>;
export type Team = z.infer<typeof teamSchema>;
export type TeamMemberPreview = z.infer<typeof teamMemberPreviewSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export type TeamUpdate = z.infer<typeof teamUpdateSchema>;
