"""Sign-ups, organizations and trials reported to a CRM/billing system (SaaS
with billing only).

What GOAT reports is the AccountsProvider protocol (provider.py); Odoo is the
implementation (odoo_provider.py, the goat_accounts module's server action
"GOAT: accounts"). The operations:

- sign_up: a user with a verified email, on their first request. The provider
  finds or creates their contact; GOAT keeps its id in user.odoo_contact_id.
- start_trial: they created an organization with a trial. The provider finds
  or creates the company (organization.odoo_company_id), the person goes under
  it with the trial tag, and the trial's dates are set; the campaign starts.
- join: an invited member joined an organization.
- status: GOAT suspended an organization itself (its trial ended), or an
  entitlement push converted it, so the company shows it.

Nothing here blocks GOAT: the calls run after the request's own work is
committed, in the background, and a failure is logged only. A user without
odoo_contact_id is reported again on a later request (at most every
RETRY_SECONDS per process), so the provider being down delays the sync,
nothing more. Off without billing or without the provider's settings
(settings.accounts_sync_enabled; `factory.get_provider` is None then).
"""

from core.accounts.sync import (
    report_join,
    report_sign_up,
    report_suspension,
    report_trial,
)

__all__ = ["report_join", "report_sign_up", "report_suspension", "report_trial"]
