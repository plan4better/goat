import * as z from "zod";

export const normalizeTeamName = (name: string): string => name.trim().toLocaleLowerCase("de");

/** Neues Team and Teamprofil: a name of 1 to 50 characters after trimming, not
 * one of `takenNames` (case-insensitive; the caller leaves out the team's own
 * name when renaming), and a description of at most 250. Core does not check
 * names until phase 2, so this sees only the teams the caller sees. */
export const teamFormSchema = (takenNames: string[]) => {
  const taken = new Set(takenNames.map(normalizeTeamName));
  return z.object({
    name: z
      .string()
      .trim()
      .min(1, "settings_teams_name_required")
      .max(50, "settings_teams_name_help")
      .refine((name) => !taken.has(normalizeTeamName(name)), "settings_teams_name_taken"),
    description: z.string().max(250, "settings_teams_description_too_long"),
  });
};

export type TeamFormValues = z.infer<ReturnType<typeof teamFormSchema>>;
