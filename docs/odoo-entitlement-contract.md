# Odoo → GOAT entitlement contract

Direction (decided 2026-06-10, refined 2026-07-16): GOAT core is
billing-provider-agnostic. Odoo owns the customer/subscription/invoice/trial/
dunning lifecycle and pushes **entitlement state** into core through one
service-protected endpoint. Core stores and enforces that state; it never
talks to Odoo.

## Commercial model (decided 2026-07-16)

One base product plus per-unit add-ons — no tiers:

| Odoo product | Meaning | `x_goat_*` values |
|---|---|---|
| GOAT (id 8) | base subscription | editors 3, viewers 2, storage_mb 5120, projects 50 |
| GOAT Extra Editor User (id 9) | +1 editor per qty | editors 1 |
| GOAT Extra Viewer User (id 13) | +1 viewer per qty | viewers 1 |
| GOAT Extra Project (id 14) | +1 project per qty | projects 1 |
| GOAT Extra Storage (GB) (id 15) | +1 GB per qty | storage_mb 1024 |

GOAT Professional (11) / Enterprise (12) are archived. All Odoo-side setup
(catalog, white-label checkbox, legacy plan-field removal, automation) lives
in one replayable CLI: `scripts/odoo/odoo_setup.py` (subcommands + `all`;
dry-run default, `--apply` to write, staging-guarded).

**Entitlement math** (computed by the Odoo automation when it builds the
payload):

```
total_<quota> = base.x_goat_<quota> + Σ(line qty × addon.x_goat_<quota>)
```

The `x_goat_*` fields on the subscription (`sale.order`) itself act as a
manual **override** for negotiated deals: when set (> 0), they win over the
computed value.

**Premium features** are NOT products. They are checkboxes on the
subscription's GOAT tab (e.g. `x_goat_white_label`), controlled by sales per
customer, and shipped in the payload as the `extras` list. Pricing for them
lives in the negotiated subscription price, invisibly to the catalog.

## Endpoint

```
POST /api/v2/webhooks/odoo/entitlement
X-Webhook-Secret: <ODOO_WEBHOOK_SECRET>
```

Auth: shared secret header, compared against core's `ODOO_WEBHOOK_SECRET`
setting. Unset secret ⇒ endpoint always answers 401 (the self-hosted /
no-billing state).

## Payload

```json
{
  "organization_id": "b65e040a-f8f0-453f-9888-baa2b9342cce",
  "total_editors": 5,
  "total_viewers": 2,
  "total_projects": 60,
  "total_storage": 15360,
  "total_credits": null,
  "extras": ["white_label"],
  "plan_renewal_date": "2026-08-01T00:00:00",
  "reset_usage": true
}
```

Semantics (all keys except `organization_id` optional — absent keys leave the
org row untouched):

| Key | Type | Meaning |
|---|---|---|
| `organization_id` | UUID | GOAT org id, from `sale.order.x_goat_organization_id`. The join key between the two systems — must be filled when a customer is wired up. |
| `total_editors` / `total_viewers` / `total_projects` | int \| null | capacity caps; `null` = unlimited |
| `total_storage` | float (MB) \| null | storage cap in MB; `null` = unlimited |
| `total_credits` | number \| null | consumption allowance (phase 2 — metering); `null` = unlimited |
| `extras` | list[str] \| null | granted premium features (grant-list). `null` = ALL enabled (self-hosted default), `[]` = none, else exactly the granted ones. Known values: `white_label`. |
| `plan_renewal_date` | ISO datetime | next renewal, informational + shown in UI |
| `suspended` | bool | suspend (churn) / reactivate the organization |
| `on_trial` | bool | the adapter always sends `false`: a real subscription ends any trial (conversion) |
| `reset_usage` | bool (default true) | zero `used_credits` (renewal semantics). Send `false` for mid-cycle plan changes. |

Not in the payload (deliberately): `plan_name` — plan names (and Stripe) are
REMOVED on this branch: no `PlanTypeEnum`, no `plan_name`/`stripe_id`
columns, no `/billing/plans`, no tier cards. **Merging this branch is
therefore gated on the Odoo cutover** (prod orgs backfilled into Odoo, the
automation live). Dunning mechanics stay Odoo-native — core only ever sees
the resulting caps/suspension.

Suspension (churn): same endpoint — `{"organization_id": ..., "suspended":
true, "reset_usage": false}` maps onto the existing `organization.suspended`
column (and `false` reactivates). Implemented in `apply_entitlement()`.

## Adapter (decided 2026-07-16: Windmill, not an Odoo addon)

Odoo stays configuration-only; all logic lives in this repo:

```
Odoo automation rule (on_create_or_write on sale.order, is_subscription,
watching subscription_state / order_line / x_goat_*)
  → native "Send Webhook Notification" action
      POSTs {_action, _id, _model, x_goat_organization_id}
  → Windmill f/goat/tasks/odoo_entitlement_push
      (goatlib/tasks/odoo_entitlement.py: reads the subscription over
       XML-RPC, computes the payload, POSTs to core with the secret)
  → core /webhooks/odoo/entitlement → apply_entitlement()
```

- Task modes: `order_id > 0` = push one (webhook path); `order_id = 0` =
  reconcile every pushable subscription (nightly 02:00 schedule — heals
  missed webhooks, and running it manually is the initial backfill).
- Pushable states: `3_progress` (active), `4_paused` / `6_churn` (both push
  `suspended: true`). Quotation states (draft/renewal/renewed/upsell) are
  skipped — the confirmed subscription pushes.
- `reset_usage` is always `false` until credit metering (phase 2) exists;
  there is nothing to reset yet.
- Windmill env: `ODOO_URL`, `ODOO_DB`, `ODOO_BILLING_USER`, `ODOO_BILLING_API_KEY`, `CORE_URL`,
  `ODOO_WEBHOOK_SECRET`.
- Odoo side is created by `scripts/odoo/odoo_setup.py automation
  --webhook-url <windmill url>` (replayable; rerun after staging rebuilds).

**Wiring caveat (verify at first sync):** Odoo's webhook payload keys are
fixed (`_id`, `_model`, …) and the generated Windmill script expects
`order_id`. If Windmill rejects the unknown args, add a preprocessor to the
Windmill script (or a thin wrapper script) mapping `_id` → `order_id`.

## Lifecycle events → payloads

| Odoo event | Payload |
|---|---|
| subscription confirmed / changed / renewed | full quotas + extras, `suspended: false` |
| subscription paused / churned | full quotas + extras, `suspended: true` |
| nightly reconcile | same as above, for every pushable subscription |

## Enforcement in core

- Capacity caps: org row `total_*` columns, enforced by
  `customer.check_organization()` (SQL authz) and `CRUDOrganization`
  helpers. `NULL` total = unlimited (SQL NULL comparison already skips the
  quota check).
- Premium features: `organization.extras` (nullable text[]). Resources that
  require a feature declare it in `resource.extras`; the SQL gate passes when
  `org.extras IS NULL` or the required extras are contained in the granted
  ones. Currently gated: `white_label` (public-project custom domain
  POST/DELETE + per-project tracking opt-in).
- `apply_entitlement()` in `crud_organization.py` is the single writer for
  entitlement state.

## Trials (GOAT-managed — decided 2026-07-17)

A trial is a product/CRM concern: there is no deal yet, so there is no Odoo
record. Odoo never learns about trials; it only ends them by pushing the
first real entitlement.

- **Start:** SaaS signup (`ODOO_WEBHOOK_SECRET` set) creates the org with
  `on_trial=true`, `plan_renewal_date = now + TRIAL_DAYS` (config, default
  14) and the `TRIAL_QUOTA_*` config quotas (default = the GOAT base product
  floor: 3 editors / 2 viewers / 5 GB / 50 projects), `extras = []`.
- **Enforcement:** the `trial_expiry` Windmill task (daily 03:00) classifies
  trials and calls `POST /api/v2/webhooks/trial` (same secret):
  `stage=expiring` (default 3 days before the end — warning email to the
  org contact) and `stage=expired` (suspend + email). The warning window is
  exactly one day wide, so a daily run fires it once. The org stays
  `on_trial` when suspended — expiry is not conversion.
- **Conversion:** sales links + confirms the Odoo subscription; the
  entitlement push carries `on_trial: false` and `suspended: false`, which
  both ends the trial and reactivates an expired-suspended org.
- **Extension:** superuser bumps `plan_renewal_date` (manual admin action).
- The web UI (trial chip, days-left) reads only `on_trial` +
  `plan_renewal_date` — no changes needed.

## Self-hosted

No Odoo, no adapter, nothing to configure: `ODOO_WEBHOOK_SECRET` unset keeps
the endpoint inert; orgs get env-driven defaults (`DEFAULT_PLAN_NAME`,
`DEFAULT_QUOTA_*`); `extras = NULL` ⇒ every premium feature enabled.

## Pending DB changes (hand-written migration, NOT yet created or applied)

- `organization.total_*` → nullable; `total_credits`/`used_credits` → Numeric
- `organization.extras` → new nullable text[] column
- `organization.plan_name` / `stripe_id` → dropped (plans + Stripe removed)
- `organization` CRM firmographics (`industry`, `department`, `use_case`,
  `location`, `phone_number`, `size`) → dropped — the canonical copy lives in
  the CRM (HubSpot today, Odoo CRM after the migration)
- `resource.plan_names` → renamed `extras` (text[]), re-seeded values
- re-install `customer.check_organization()` from the updated SQL source

All steps are existence-guarded: the `init` baseline builds fresh DBs from
current models (already the end state), so the migration no-ops there.

The migration is `0011_billing_and_usage` (after `0010_support_tickets`), together with usage metering.

## Odoo instances

- Production: never test against it.
- Staging (an Odoo.sh copy of production): its URL and database name change
  on every rebuild, so set `ODOO_URL` / `ODOO_DB` again after each one.
  Staging config is wiped on rebuild: keep every Odoo-side change scripted and
  replayable (`scripts/odoo/odoo_setup.py`).
