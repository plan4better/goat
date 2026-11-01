"""What GOAT reports about its people and organizations to a CRM/billing system.

Odoo is the implementation today (core.accounts.odoo_provider); another system
implements the same four operations. Every operation is idempotent: the sync
repeats a report that did not arrive (see core.accounts.sync), so a provider
finds or creates its record rather than adding another one.

Ids are GOAT's (UUIDs as strings). A provider answers with its own id for the
person or company, which GOAT keeps (user.odoo_contact_id,
organization.odoo_company_id: the column names predate the provider split).
"""

from datetime import date
from typing import Literal, Protocol

# GOAT's own language codes; a provider maps them to its own.
Language = Literal["de", "en"]
Role = Literal["owner", "admin", "editor", "viewer"]


class AccountsError(Exception):
    """The provider refused the report or cannot be reached. A provider raises
    nothing else for those cases, so the sync can tell them from its own bugs."""


class AccountsProvider(Protocol):
    async def sign_up(
        self,
        *,
        user_id: str,
        name: str,
        email: str,
        marketing_consent: bool,
        language: Language | None,
    ) -> int | None:
        """A person with a verified email. Returns their contact id at the
        provider. `language` is None when the provider's own should stay."""
        ...

    async def start_trial(
        self,
        *,
        user_id: str,
        organization_id: str,
        organization_name: str,
        trial_start: date,
        trial_end: date,
    ) -> int | None:
        """The person created an organization that starts a trial. Returns the
        organization's company id at the provider."""
        ...

    async def join(
        self,
        *,
        user_id: str,
        organization_id: str,
        organization_name: str,
        role: Role,
    ) -> int | None:
        """An invited member joined an organization the provider knows. Returns
        the organization's company id."""
        ...

    async def status(
        self, *, organization_id: str, suspended: bool, on_trial: bool
    ) -> None:
        """GOAT changed the organization's state itself (suspended, reactivated
        or converted from trial to subscription)."""
        ...
