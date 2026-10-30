# Sign-up fields of the GOAT realm

`user-profile.json` is the realm's declarative user profile (Keycloak 22,
feature `declarative-user-profile`): what the sign-up page asks for. It lived
only in the live realm before; this file is the source now.

One step: first name, last name, email, password (no username field while the
realm has "Email as username" on, as the GOAT realm has), the terms (required)
and the newsletter (optional). Both are stored as the ISO timestamp of the
moment the box was ticked (the checkbox posts it as its value), empty when not
ticked. On the profile update and IdP review pages the boxes start from the
stored value, so resubmitting the form does not clear an earlier consent. Country, profession, domain and phone are no
longer asked: existing users keep their old values as unmanaged attributes,
nothing reads them. Students apply separately for a longer trial.

## The trial emails note

Under the newsletter box the sign-up page can say that the operator sends
emails during the trial (tips, reminders, an offer to keep using GOAT; the
texts are `trialEmailsNote` in `src/login/i18n.ts`). It is shown only when the
`subscribe_to_newsletter` attribute carries the annotation
`"trialEmailsNote": "true"` in the realm's user profile, as `user-profile.json`
here does for Plan4Better's hosted realm. Without the annotation (self-hosted
realms, or any realm that sends no trial emails) there is no note.

## Applying it to a realm

1. Realm settings → User profile → JSON editor: paste `user-profile.json`, save.
2. Clients → `goat` → Client scopes → the dedicated scope → Add mapper → By
   configuration → User Attribute: name `newsletter`, user attribute
   `subscribe_to_newsletter`, token claim name `newsletter`, claim JSON type
   String, added to the ID token and access token. GOAT core reads the claim when
   it first sees the user (`user.newsletter_subscribe`) and passes the consent on
   to the accounts provider (Odoo, when configured).
3. Realm settings → Login: "User registration" and "Verify email" on (SaaS only;
   self-hosted realms keep registration off).

The page itself is `src/login/pages/RegisterUserProfile.tsx`; `kcContext.ts`
mocks it for `pnpm dev` with these attributes.
