"""Plan4Better's Odoo, as GOAT's integrations reach it (SaaS only).

Conventions every Odoo integration in core follows (support tickets, account
reports):

- Settings: the connection is shared, `ODOO_URL` and `ODOO_DB`. Each
  integration has its own API key and settings under its own prefix
  (`ODOO_SUPPORT_*`, `ODOO_ACCOUNTS_*`), with a key that belongs to its own
  least-privilege Odoo user. An integration is on only when the connection
  and its own settings are all set; self-hosted installs set none of them.
- Calls go through `OdooClient` (JSON-2), one instance per integration, with
  that integration's allow-list of (model, method). The time limits, the
  concurrency cap and the circuit breaker are per instance, so one
  integration's trouble does not stop another's calls.
- Errors: `OdooUnavailable` (timeout, refused connection, 5xx, breaker open)
  and `OdooRejected` (Odoo answered 4xx). An integration translates them into
  its own domain errors at its boundary (see core.support.odoo_client).
- Identity: `user.odoo_contact_id` (res.partner of a person) and
  `organization.odoo_company_id` (res.partner of the customer company) link
  GOAT records to Odoo. Odoo records that belong to a GOAT organization carry
  its id in `x_goat_organization_id` (helpdesk.ticket, sale.order).
- Odoo-side setup (users, groups, rights, fields, server actions) lives in Odoo
  modules in Plan4Better's Odoo.sh repository, one per integration (support:
  `goat_support`), installed and tested there with the code.
"""

from core.odoo.client import OdooClient
from core.odoo.errors import OdooError, OdooRejected, OdooUnavailable

__all__ = ["OdooClient", "OdooError", "OdooRejected", "OdooUnavailable"]
