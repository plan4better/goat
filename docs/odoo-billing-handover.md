# Odoo billing: handover

Branch `feat/odoo-billing`, built on `feat/support-tickets` (PR #3839). Work in progress: it builds and its
tests pass, but it is not ready to merge. The contract between Odoo and GOAT is in
[`odoo-entitlement-contract.md`](./odoo-entitlement-contract.md); read that first.
What support tickets built (the shared `core.odoo` client, settings and conventions) is in
[`support-tickets-handover.md`](./support-tickets-handover.md).

## Where it comes from

The billing work was done in July 2026 on a branch that was never committed, about 800 commits behind
today's main. This branch carries all of it over in one step, on top of support tickets, and resolves the
conflicts with what main and support changed since (see "Changed while porting").

## Decisions so far

- **Odoo replaces Stripe.** Stripe, plan names and the billing page are removed. Core knows no billing
  provider: it holds the entitlement state on the organization (quotas, `extras`, `on_trial`,
  `plan_renewal_date`, `suspended`) and Odoo pushes changes to it.
- **One product, no tiers.** A single base product "GOAT" plus per-unit add-ons (editor, viewer, project,
  storage). Premium features (white label today) are not products but checkboxes on the subscription,
  pushed as the `extras` grant list (`NULL` = everything, self-hosted; `[]` = nothing).
- **The adapter is a Windmill task** (`goatlib.tasks.odoo_entitlement`), not an Odoo addon: an Odoo
  automation rule calls a Windmill webhook on subscription changes, the task reads the subscription and
  posts it to core (`POST /api/v2/webhooks/odoo/entitlement`). A nightly run reconciles all subscriptions
  and doubles as the backfill.
- **Trials are GOAT's own.** A SaaS signup (`ODOO_WEBHOOK_SECRET` set) starts a trial with the
  `TRIAL_*` quotas; Odoo never sees it. `goatlib.tasks.trial_expiry` warns three days before the end
  and suspends at the end through `POST /api/v2/webhooks/trial`. Converting = the first entitlement push.
- **Signup is one step** (name and type). Industry, department, use case, size, phone and location are no
  longer collected and their columns are dropped: that data belongs in the CRM.
- **Self-hosted** stays as it is: no Odoo, `DEFAULT_QUOTA_*` values, everything enabled.

## What is in the branch

- core: `webhooks/odoo/entitlement` and `webhooks/trial` (shared secret), `apply_entitlement`,
  nullable quotas (`NULL` = unlimited), `organization.extras`, feature gating by extras in
  `check_organization.sql`, `white_label` in `seed_roles`; Stripe and plan code removed.
- Migration `0011_odoo_billing` (after support's `0010`).
- goatlib: the `odoo_entitlement_push` and `trial_expiry` tasks, registered in the task registry.
- web: one-step organization signup, quota display for unlimited values, features gated by extras,
  billing page and plan cards removed.
- `scripts/odoo/odoo_setup.py`: all Odoo-side setup (catalog, white-label checkbox, removal of the old
  plan-name field, the automation rule). Dry run by default, staging only without `--allow-prod`.

## Changed while porting

- The migration became `0011_odoo_billing` with `down_revision = "0010_support_tickets"`.
- Settings follow the Odoo conventions from support (module docstring of `core.odoo`): the task reads
  `ODOO_URL`, `ODOO_DB`, `ODOO_BILLING_USER`, `ODOO_BILLING_API_KEY`; `odoo_setup.py` reads `ODOO_URL`,
  `ODOO_DB`, `ODOO_ADMIN_LOGIN`, `ODOO_ADMIN_KEY` from the environment.
- Main's newer code adjusted: the templates' system organization (no plan, Stripe or signup fields), the
  route inventory (the two webhooks instead of Stripe's), the trial email (configurable artwork and
  contact link), the onboarding e2e test (one step).
- `scripts/odoo/crm_migrate.py` (GOAT to Odoo CRM migration) is not part of this branch: it is a one-off
  tool that reads a local copy of the production database.

## Open before it can ship

1. **Check migration `0011` against production.** It drops `plan_name`, `stripe_id` and the six signup
   columns, and makes quotas nullable. Look at the production data first (anything still read from those
   columns, anything to keep in the CRM).
2. **XML-RPC goes away.** `/xmlrpc` and `/jsonrpc` are deprecated since Odoo 19 and scheduled for removal. The
   task and `odoo_setup.py` still use XML-RPC with a login. Move them to JSON-2 (an API key, no login).
   `core.odoo.OdooClient` is that client; it reads no GOAT settings, so if the task stays in Windmill it
   can move to goatlib as it is (with `aiohttp` as an extra there).
3. **Deployment targets** (see "Deployment Targets Follow Every Change" in `CLAUDE.md`): `ODOO_WEBHOOK_SECRET`
   and `TRIAL_*` are only in `.env.example`. Compose, the Helm chart (an `odoo.billing` block next to
   `odoo.support`), the self-hosting docs EN/DE, the Windmill variables of the tasks and the dev/prod
   overlays still need them. Consider naming the secret `ODOO_BILLING_WEBHOOK_SECRET` before it is set
   anywhere, to match `ODOO_<INTEGRATION>_*`.
4. **Odoo side:** prices and the final quota matrix on the products (set by Plan4Better in the Odoo UI),
   the automation rule pointing at the Windmill webhook (`odoo_setup.py automation --webhook-url`), and
   the GOAT fields on existing subscriptions.
5. **Email safety on staging:** Odoo.sh staging builds neutralise outgoing mail, but check it after every
   rebuild (`ir.mail_server` active flags). Writes from scripts pass `tracking_disable`,
   `mail_create_nolog`, `mail_create_nosubscribe`, `mail_notrack`, `no_reset_password` in the context and
   never call `action_confirm`. On a dev Windmill, leave `ODOO_WEBHOOK_SECRET` unset so `trial_expiry`
   fails instead of emailing or suspending real trial organizations.
6. **Not run here:** the Playwright e2e suite (onboarding changed) and a browser pass over signup, the
   usage page and the members page.
7. Credit metering is a later phase: `reset_usage` stays `false` until it exists.
