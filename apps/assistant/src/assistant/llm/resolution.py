"""user → organization → settings → active connection → target (spec §4.5).

No silent fallback (D4): when the organization's chosen connection cannot be
used, the result is "unavailable" with a reason, never GOAT AI in its place.
GOAT AI is only offered as ``fallback`` when the admin enabled it; the run
manager decides when to use it.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from assistant.config import AssistantSettings
from assistant.llm.providers import Target, default_target
from assistant.llm.types import DataPolicy
from assistant.llm.vault import CredentialsUnreadable, SecretBox
from assistant.org_repo import Member, OrgSettingsRepository

UnavailableReason = Literal[
    "no_organization",
    "disabled",
    "no_connection",
    "connection_not_allowed",
    "credentials_unreadable",
]


class AssistantUnavailable(Exception):  # noqa: N818
    def __init__(self, reason: UnavailableReason) -> None:
        super().__init__(reason)
        self.reason: UnavailableReason = reason


@dataclass(frozen=True)
class Resolution:
    organization_id: UUID
    data_policy: DataPolicy
    main: Target
    #: GOAT AI, when the admin enabled the fallback and an own connection is active.
    fallback: Target | None


@dataclass(frozen=True)
class AssistantStatus:
    available: bool
    reason: UnavailableReason | None
    provider: str | None
    model: str | None
    data_policy: DataPolicy


class ModelResolver:
    def __init__(
        self,
        org_repo: OrgSettingsRepository,
        settings: AssistantSettings,
        secrets: SecretBox | None = None,
    ) -> None:
        self.org_repo = org_repo
        self.settings = settings
        self.secrets = (
            secrets if secrets is not None else SecretBox.from_settings(settings)
        )

    def goat_ai(self) -> Target | None:
        return default_target(self.settings)

    @property
    def org_connections_enabled(self) -> bool:
        """Own connections need the operator's consent and a key to store them."""
        return self.settings.allow_org_connections and self.secrets is not None

    def connection_allowed(self, provider: str) -> bool:
        return (
            self.org_connections_enabled and provider in self.settings.allowed_providers
        )

    def encrypt(self, credentials: Mapping[str, str]) -> str:
        if self.secrets is None:
            raise CredentialsUnreadable()
        return self.secrets.encrypt(credentials)

    def decrypt(self, connection: Mapping[str, Any]) -> dict[str, str]:
        if self.secrets is None:
            raise CredentialsUnreadable()
        return self.secrets.decrypt(connection["credentials_encrypted"])

    def target_for(self, connection: Mapping[str, Any]) -> Target:
        return Target(
            connection_id=connection["id"],
            provider=connection["provider"],
            model=connection["model"],
            provider_order=tuple(connection["provider_order"] or ()),
            allow_fallbacks=connection["allow_fallbacks"],
            base_url=connection["base_url"],
            region=connection["region"],
            credentials=self.decrypt(connection),
        )

    async def resolve(self, user_id: UUID) -> Resolution:
        member = await self.org_repo.member(user_id)
        if member is None:
            raise AssistantUnavailable("no_organization")
        return await self.resolve_member(member)

    async def resolve_member(self, member: Member) -> Resolution:
        settings = await self.org_repo.get_settings(member.organization_id)
        if not settings.enabled:
            raise AssistantUnavailable("disabled")
        goat_ai = self.goat_ai()
        if settings.active_connection_id is None:
            if goat_ai is None:
                raise AssistantUnavailable("no_connection")
            return Resolution(
                member.organization_id, settings.data_policy, goat_ai, None
            )
        connection = await self.org_repo.get_connection(
            member.organization_id, settings.active_connection_id
        )
        if connection is None:
            raise AssistantUnavailable("no_connection")
        if not self.connection_allowed(connection["provider"]):
            raise AssistantUnavailable("connection_not_allowed")
        try:
            main = self.target_for(connection)
        except CredentialsUnreadable as exc:
            raise AssistantUnavailable("credentials_unreadable") from exc
        fallback = goat_ai if settings.allow_default_fallback else None
        return Resolution(member.organization_id, settings.data_policy, main, fallback)

    async def status_of(self, member: Member) -> AssistantStatus:
        try:
            resolution = await self.resolve_member(member)
        except AssistantUnavailable as exc:
            settings = await self.org_repo.get_settings(member.organization_id)
            return AssistantStatus(False, exc.reason, None, None, settings.data_policy)
        return AssistantStatus(
            True,
            None,
            resolution.main.provider,
            resolution.main.model,
            resolution.data_policy,
        )
