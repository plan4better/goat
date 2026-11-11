import * as z from "zod";

import type { Team } from "@/lib/validations/team";

export const normalizeTeamName = (name: string): string => name.trim().toLocaleLowerCase("de");

/** Neues Team and Teamprofil: a name of 1 to 50 characters after trimming, not
 * one of `takenNames` (case-insensitive; the caller leaves out the team's own
 * name when renaming), and a description of at most 250. Core checks every
 * team of the organization (409); this sees only the teams the caller sees.
 * `ownName`, the team's saved name, stays valid as it is, as core skips the
 * check for a name that does not change: a duplicate made before names were
 * checked still takes a new picture or description, and one saved before the
 * 50 characters held (core allows 255) keeps its length. Another case of it
 * is a rename, as for core. */
export const teamFormSchema = (takenNames: string[], ownName?: string) => {
  const taken = new Set(takenNames.map(normalizeTeamName));
  const unchanged = ownName?.trim();
  return z.object({
    name: z
      .string()
      .trim()
      .min(1, "settings_teams_name_required")
      .refine((name) => name === unchanged || name.length <= 50, "settings_teams_name_help")
      .refine(
        (name) => name === unchanged || !taken.has(normalizeTeamName(name)),
        "settings_teams_name_taken"
      ),
    description: z.string().max(250, "settings_teams_description_too_long"),
  });
};

export type TeamFormValues = z.infer<ReturnType<typeof teamFormSchema>>;

/** A team whose preview (core lists the owner first) starts without an owner,
 * or has nobody: its owner left the organization. Without a preview (an older
 * answer) nothing is claimed. */
export const isOwnerless = (team: Pick<Team, "members_preview">): boolean =>
  team.members_preview !== undefined && team.members_preview[0]?.role !== "team-owner";
