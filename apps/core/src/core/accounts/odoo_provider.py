"""AccountsProvider on Odoo: the goat_accounts module's server action.

GOAT calls the server action named ACTION_NAME as the bridge user
("GOAT Accounts Bot", ODOO_ACCOUNTS_API_KEY), with the operation and its
arguments in the context. The module is in Plan4Better's Odoo repository and
released together with this code.
"""

from datetime import date
from typing import Any

from core import odoo
from core.accounts.provider import AccountsError, Language, Role

# The goat_accounts module's server action (data/ir_actions_server.xml there).
ACTION_NAME = "GOAT: accounts"
ALLOWED_CALLS = frozenset(
    {("ir.actions.server", "search"), ("ir.actions.server", "run")}
)
# Odoo's language codes for GOAT's.
ODOO_LANGUAGES: dict[str, str] = {"de": "de_DE", "en": "en_US"}


class OdooAccountsProvider:
    def __init__(self, client: odoo.OdooClient, action_name: str) -> None:
        self._client = client
        self._action_name = action_name
        self._action_id: int | None = None

    async def _run(self, op: str, **context: Any) -> dict[str, Any]:
        """Run one operation of the server action as the bridge user."""
        try:
            if self._action_id is None:
                found = await self._client.call(
                    "ir.actions.server",
                    "search",
                    domain=[("name", "=", self._action_name)],
                    limit=1,
                )
                if not found:
                    raise AccountsError(f"no server action {self._action_name!r}")
                self._action_id = int(found[0])
            result = await self._client.call(
                "ir.actions.server",
                "run",
                ids=[self._action_id],
                context={"goat_op": op, **context},
            )
        except odoo.OdooError as exc:
            raise AccountsError(str(exc)) from exc
        return result or {}

    async def sign_up(
        self,
        *,
        user_id: str,
        name: str,
        email: str,
        marketing_consent: bool,
        language: Language | None,
    ) -> int | None:
        lang = ODOO_LANGUAGES.get(language) if language else None
        result = await self._run(
            "sign_up",
            goat_user_id=user_id,
            goat_name=name,
            goat_email=email,
            goat_marketing_consent=marketing_consent,
            **({"goat_lang": lang} if lang else {}),
        )
        return result.get("goat_contact_id")

    async def start_trial(
        self,
        *,
        user_id: str,
        organization_id: str,
        organization_name: str,
        trial_start: date,
        trial_end: date,
    ) -> int | None:
        result = await self._run(
            "start_trial",
            goat_user_id=user_id,
            goat_organization_id=organization_id,
            goat_organization_name=organization_name,
            goat_trial_start=trial_start.isoformat(),
            goat_trial_end=trial_end.isoformat(),
        )
        return result.get("goat_company_id")

    async def join(
        self,
        *,
        user_id: str,
        organization_id: str,
        organization_name: str,
        role: Role,
    ) -> int | None:
        result = await self._run(
            "join",
            goat_user_id=user_id,
            goat_organization_id=organization_id,
            goat_organization_name=organization_name,
            goat_role=role,
        )
        return result.get("goat_company_id")

    async def status(
        self, *, organization_id: str, suspended: bool, on_trial: bool
    ) -> None:
        await self._run(
            "status",
            goat_organization_id=organization_id,
            goat_suspended=suspended,
            goat_on_trial=on_trial,
        )
