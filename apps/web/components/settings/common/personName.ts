/** A person's display name: first and last name, else the address (an
 * invitation, or an account whose names are empty). */
export const personName = (person: {
  firstname?: string | null;
  lastname?: string | null;
  email?: string | null;
}): string =>
  [person.firstname, person.lastname]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ") ||
  person.email ||
  "";
