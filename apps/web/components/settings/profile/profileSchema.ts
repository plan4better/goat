import * as z from "zod";

const name = (required: string) =>
  z.string().trim().min(1, required).max(255, "settings_profile_name_too_long");

/** Persönliche Angaben: the names are required after trimming, at most 255
 * characters; the address as zod's `email()`; the picture is a URL or a data URL. */
export const profileSchema = z.object({
  avatar: z.string(),
  firstname: name("settings_profile_firstname_required"),
  lastname: name("settings_profile_lastname_required"),
  email: z.string().trim().email("settings_profile_email_invalid"),
});

export type ProfileValues = z.infer<typeof profileSchema>;
