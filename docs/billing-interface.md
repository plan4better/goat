# Billing interface

What GOAT core exposes to a billing system and what it reports to a CRM. Core
knows no particular billing system: it stores and enforces the entitlement
state of an organization (capacity caps, credits, premium features, trial and
suspension) and tells an accounts provider about people and organizations. The
prices, products and rules that turn a subscription into an entitlement belong
to the billing system.

## Switch and settings

Billing is a switch of its own, independent of support tickets and of any CRM:

| Setting | Meaning |
|---|---|
| `BILLING_ENABLED` | default `false`. Read by core, geoapi, processes and the workers. |
| `BILLING_WEBHOOK_SECRET` | shared secret of the webhooks below; required with billing on. |

Core's billing is on when `BILLING_ENABLED` is true and the secret is set.
The commercial terms (the trial and the credit rates) are no settings: the
billing system pushes them (see "Terms push").

With billing off (self-hosted) both webhooks answer 404, organizations get no
trial and the `DEFAULT_QUOTA_*` values, credits are unlimited and nothing is
metered.

## Terms push

`POST /api/v2/webhooks/billing/terms`, same secret. The trial a new
organization starts with and the credit rates, always all of them:

```json
{
  "trial": {"days": 30, "credits": 10000, "storage_mb": 5120,
            "projects": 50, "editors": 5, "viewers": 2},
  "credit_rates": {"compute": 10, "egress": 20, "ai": 1},
  "as_of": "2026-10-26T12:00:00+00:00"
}
```

`days`, `projects`, `editors` and `viewers` are whole numbers (`days` and
`editors` at least 1), everything is at least 0; an invalid push is refused
with 422 and changes nothing. Rates are credits per minute of compute, per GB
of egress and per 1000 AI tokens. Core keeps the last push
(`customer.billing_terms`, `customer.credit_rate` with source `billing`): new
trials and new charges use it, running trials keep their quotas and past
charges their rate. A push with an `as_of` older than the stored one answers
`200 {"status": "stale"}` and changes nothing.

Until the first push core starts trials and charges with its own defaults
(`core/crud/crud_billing_terms.py`, rates written at startup with source
`default`), so a sign-up never waits for the billing system. Send the terms
when the billing side is set up and whenever they change; sending them
regularly heals a lost push.

## Entitlement push

`POST /api/v2/webhooks/billing/entitlement`, header `X-Webhook-Secret` (wrong
or missing: 401). One push per organization, carrying its complete state, so
the sender combines several subscriptions or contracts into one payload.

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
  "suspended": false,
  "on_trial": false,
  "as_of": "2026-07-01T09:30:00Z",
  "reset_usage": true
}
```

Every key but `organization_id` is optional; a key that is absent leaves that
part of the organization as it is.

| Key | Type | Meaning |
|---|---|---|
| `organization_id` | UUID | GOAT's organization id, the join key between the two systems. |
| `total_editors`, `total_viewers`, `total_projects` | whole number or null | capacity caps; `null` is unlimited. |
| `total_storage` | number (MB) or null | storage cap; `null` is unlimited. |
| `total_credits` | number or null | credit allowance per period; `null` is unlimited. |
| `extras` | list of strings or null | granted premium features. `null` enables all, `[]` none, else exactly the listed ones. |
| `plan_renewal_date` | ISO 8601 datetime | next renewal; shown in the UI. |
| `suspended` | boolean | suspends or reactivates the organization. |
| `on_trial` | boolean | `false` converts a trial into a subscription (it also reactivates a trial that expired). |
| `as_of` | ISO 8601 datetime | the sender's time of the data. A push older than the one already applied is ignored. |
| `reset_usage` | boolean, default `false` | zero the used credits (send `true` on a renewal, with the new `plan_renewal_date`). A push with the renewal date already applied is a repeat and does not reset again. A conversion zeroes them as well. |

A subscription's credits are reset every month from its first push on; a
trial's credits last the whole trial.

**Validation.** The payload is strict: unknown keys and wrong types are
refused with 422 and change nothing. Flags must be JSON booleans (the string
`"false"` is refused, not read as true), caps non-negative numbers (counts
whole numbers), `extras` a list of strings, dates ISO 8601 strings (an offset
is converted to UTC; no unix timestamps).

**Responses.**

| Status | Meaning |
|---|---|
| `200 {"status": "ok"}` | applied. |
| `200 {"status": "stale"}` | `as_of` older than the applied one; nothing changed. |
| `404` | no such organization, or billing is off. |
| `409` | the organization was deleted in GOAT. A push never revives it. |

Pushes are idempotent and serialized per organization, so a sender may repeat
or reconcile them at will.

## Trials

GOAT manages the trial itself, the billing system is not involved until it
converts the organization.

- **Start:** with billing on, a new organization is created with `on_trial`,
  `plan_renewal_date` = now + the trial's `days`, and its quotas as caps
  (the last terms push, else core's defaults).
- **Enforcement:** the `trial_expiry` task (daily) calls
  `POST /api/v2/webhooks/trial`, same secret, with
  `{"organization_id": "<uuid>", "stage": "expiring" | "expired"}`. `expiring`
  sends the warning email (unless the accounts provider's own campaign does),
  `expired` suspends the organization and emails its contact. The
  organization stays `on_trial` while suspended. Both stages are idempotent:
  when nothing applies (already converted, suspended or deleted, or not yet
  due) core answers `200 {"status": "noop"}`.
- **Access:** only a suspended organization is refused. An ended trial keeps
  working until the task's next run suspends it; with billing off, the
  `on_trial` flag has no effect.
- **Conversion:** an entitlement push with `on_trial: false` (and
  `suspended: false`).

## Accounts provider

What GOAT reports about its people and organizations to a CRM is the
`AccountsProvider` protocol (`apps/core/src/core/accounts/provider.py`). A
provider implements four operations, all idempotent (it finds or creates its
record):

| Operation | When | Arguments | Returns |
|---|---|---|---|
| `sign_up` | a user with a verified email makes their first request, or changes GOAT's language | user id, name, email, marketing consent, language (`de` or `en`, or none to leave the provider's alone) | the person's contact id |
| `start_trial` | an owner created an organization that starts a trial | user id, organization id and name, trial start and end date | the organization's company id |
| `join` | an invited member joined an organization | user id, organization id and name, role (`owner`, `admin`, `editor`, `viewer`) | the company id |
| `status` | GOAT suspended or reactivated an organization, or a push converted it | organization id, suspended, on trial | nothing |

GOAT keeps the returned ids (`user.odoo_contact_id`,
`organization.odoo_company_id`; the column names predate the provider split).
The calls run in the background after the request and never fail it. A report
that did not arrive flags the organization (`organization.odoo_sync_pending`,
"accounts sync pending") and a loop in every core replica re-sends the trial,
the status and the joins every 10 minutes. A
provider raises `AccountsError` when it refuses or cannot be reached.

The provider shipped with core is Odoo's (`odoo_provider.py`): it runs a
server action on an Odoo with a bridge user and is on when billing is enabled
and `ODOO_URL`, `ODOO_DB` and `ODOO_ACCOUNTS_API_KEY` are set
(`accounts/factory.py` returns no provider otherwise). With a provider
configured, its campaign sends the trial emails and GOAT only the account
emails.
