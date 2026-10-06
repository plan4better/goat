# Support tickets: handover

Temporary: this file goes once billing is merged. Support tickets are on branch `feat/support-tickets`
(PR #3839); `feat/odoo-billing` builds on it. The design spec stays local; ask Majk for it.

## What exists

- **core `odoo` module**: generic Odoo JSON-2 client (the caller's allow-list, slot timeout, circuit breaker,
  long timeout for upload calls), `OdooUnavailable` / `OdooRejected`, and the conventions for Odoo integrations in
  its docstring. It reads no GOAT settings (the CA bundle is passed in), so if billing keeps calling Odoo from a
  Windmill task, the module can move to goatlib as it is (plus an `aiohttp` extra there). Settings: shared
  `ODOO_URL` / `ODOO_DB`, one key per integration (`ODOO_SUPPORT_API_KEY`, `ODOO_SUPPORT_TEAM_ID`,
  `ODOO_SUPPORT_POST_ACTION`); Helm `odoo: {url, db, support: {...}}`.
- **core `support` module**: `SupportOdooClient` (bridge allow-list, Odoo errors as support errors), provider,
  service (visibility, verified-email linking, staff detection, read markers, caches), `/api/v2/support` endpoints,
  55 MiB body cap, migration `0010` (`support_ticket_read` + `user.odoo_contact_id` +
  `organization.odoo_company_id`, guarded).
- **No background polling**: staff replies reach users by Odoo's email, which links to the ticket in GOAT. The header
  badge loads on page load, tab focus and after the user's own writes; lists are cached 60 s per user per pod. The
  summary is `{needs_reply, unread}`. A change feed with per-user versions, interval polls, reply toasts and a
  WebSocket were all considered and dropped (core would still have to poll Odoo, plus coordination between pods).
- **Odoo bridge** (`scripts/odoo/support_bridge_setup.py`, `support_bridge_action.py`): portal user and group with
  read-mostly rights, a server action with the ops `post`, `rate`, `contact`, `staff`, `agent`; template patches and
  two inherited notification-layout views so the emails of GOAT tickets link to `<GOAT_URL>/support/<ref>`. The views
  hook in at a structural anchor (`/*/*[1]`) and only act with recipient data; `plan` deactivates them (WARNING
  line) if Odoo's layouts stop using `has_button_access` / `button_access['url']`.
- **web**: `/support` list, `/support/new` form, `/support/[ref]` ticket page (browser-only rendering, phone layout
  from the first frame), header support popover with badge, shared header-popover primitives.
- **deploy**: compose, Helm and the self-hosting docs EN/DE. The Plan4Better dev/prod overlays (infra repo) get the
  settings and the Secret at rollout: dev → staging Odoo with the staging bridge key, prod → production Odoo with its
  own key.

## Staging Odoo

- The bridge (user, group, rights, server action, template patches, layout views) is applied on the current staging
  build. A staging rebuild wipes it: rerun `support_bridge_setup.py plan --apply` and `create-key`, then reset GOAT's
  links (NULL `user.odoo_contact_id`, truncate `support_ticket_read`).
- Bridge rights: tickets read/write/create (the Customer Care team only); res.partner, mail.message, mail.followers,
  rating, subtypes and templates read-only; ir.attachment read/create; mail.compose.message create; no mail.mail.
- Emails were checked with the views active: a GOAT ticket's "Ticket received" and agent reply link only to GOAT in
  de_DE and en_US; a non-GOAT ticket keeps the Odoo portal links in both languages.
- The integration tests (`apps/core/tests/integration/support`, run when a local `.env` has the staging key) leave
  `GOAT IT …` / `[TEST]` tickets and `@example.invalid` contacts behind: the bridge cannot delete anything by design.

## Production rollout (not done)

Order: Odoo setup first, then core. The setup script needs `ODOO_URL`, `ODOO_DB`, `ODOO_ADMIN_KEY` and `GOAT_URL`
(no default: it decides where Odoo's emails link to). `support_bridge_setup.py plan` (dry run) →
`plan --apply --production` → `create-key` → Secret → deploy core. A core running against an older server action
loses only the "Handled by" photo (it stops asking for the `agent` op for 10 minutes after "unknown operation"); a
failing `staff` op makes linking by email fail closed, so the setup has to be in place before users start.

**Hard gate, after the production apply and after every Odoo upgrade:** run `plan` (dry run) and look for WARNING
lines (a layout changed: our view gets deactivated on `--apply`), then check a GOAT and a non-GOAT ticket's agent
reply and "Ticket received" emails in en_US and de_DE: GOAT tickets link to GOAT, others to the Odoo portal. The
inherited views extend the layouts every notification email of the database uses. On staging this was checked with
`mail_auto_delete=False` on the reply and the template's `auto_delete` off, reading `mail.mail.body_html`, then
deleting the tickets and contacts (the scripts for it are local; ask Majk). On production use one internal test
ticket and an internal address instead of throwaway contacts.

Also check that the bridge can read its own `res.users` record. Contacts of staff who have left that are linked to
GOAT users unlink themselves on the next contact check.

Before production: check the production ingress for a body limit and read timeouts (uploads up to 50 MB per message,
55 MiB per request; ingress-nginx defaults to 1 MB), egress from core to Odoo, and core's memory for 50 MB uploads.
The overlays run `core.scripts.initial_data` after migrations (it seeds the `support` authz resource).

## Decisions

1. Decided 2026-10-02: the support address is configurable via `NEXT_PUBLIC_SUPPORT_EMAIL` (Helm `web.supportEmail`)
   and defaults to `support@plan4better.de` on every installation. "Report a problem" without Odoo is always an
   email to that address; white-label operators set their own.
2. A verified email is required to link a GOAT user to an Odoo contact; invited users start with
   `emailVerified=False`. (Still to confirm.)
3. Colleagues without a stored contact are matched to an existing Odoo contact by email only when Keycloak vouches
   for it (`emailVerified` true and the Keycloak email equals the GOAT email); otherwise they get a new contact.
   Order: stored id, then Keycloak-verified email (staff and the bridge excluded, the org's company preferred), then
   create. The verdict is cached 10 min; with `AUTH=False` or Keycloak unreachable colleagues get a new contact.
4. `/support/colleagues` shows member emails to every org member, viewers too. (Still to confirm.)
5. German copy as drafted. (Still to confirm.)
6. Staff avatar cache 1 h; list cache 60 s per user.
7. Decided 2026-10-02: read-only viewers can create tickets too. Logged-in users get the support entry in the
   view-only header as well; logged-out public visitors have none (tickets need an account).

## How it behaves (summary)

Public-subtype allow-list (fail-closed). First sight of a contact counts as read (seeded per contact, re-seeded on
relink). Odoo refusals → 503 "unavailable". The bridge was hardened over several staging rounds: no impersonation of
staff (former staff included), dedupe with quotes, no follower/rating/message/mail.mail/attachment writes, contacts
only through the action. The description is the first message; failed files are reported after partial failures.
Staff = current or former staff (internal user, active or archived, or an hr.employee). Plain partner names (no
"Company, Name"). Deleted authors show as "Unknown sender". Stale stored contacts are relinked. Staff photos are
inlined (`image_128`, real photos only, ≤ 64 KB, cached 1 h); everyone else gets initials. Unread also counts for
tickets closed in the last 14 days (the rule exists in core and web). UI on the shared dashboard components; copy
without dashes, neutral tone.

## Known limits

- One-line events ("Ticket received", "Resolved on") and an "All files" panel are not built.
- Project picker: recent projects plus search (first page of results).
- The "Handled by" photo shows only once the assigned agent has written on the ticket (the bridge can't read
  res.users).
- A former employee whose user and HR record are both deleted counts as a customer again.
- While the server action's `staff` op fails, former staff show as customer-side in the thread and follower list
  (display only: posting as them stays refused; linking by email fails closed).
- The DB session stays checked out while core waits on Odoo (bounded by the breaker); needs a `get_db` change.
- The badge does not change while a page sits open. Changes by staff or colleagues show up to 60 s late (list
  cache); the user's own writes at once on the same pod.

## Later

User docs EN/DE; a bridge-key expiry warning and an Odoo check in core's dependency probe; the privacy notice names
Odoo. Phases 3 ("Report problem" in the failed-job toast, with job data and a map snapshot) and 4 (staff access to
customer projects) get their own plan.
