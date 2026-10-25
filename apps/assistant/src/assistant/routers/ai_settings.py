"""Organization AI settings and connections (spec §4.1, §4.3, §4.4, §10).

``/status`` is for every signed-in user. Everything else is for organization
admins (organization-owner or organization-admin; with AUTH=False the default
identity, spec §4.8). No organization ID appears in a path: an admin manages
their own organization, so another organization's connection ID is simply not
found. Keys go in, never out: responses carry the last 4 characters only.
"""

import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from assistant.auth import Principal, get_principal
from assistant.config import AssistantSettings
from assistant.llm.capabilities import capabilities_for, is_tested
from assistant.llm.endpoints import (
    EndpointNotAllowed,
    EndpointPolicy,
    Resolver,
    check_resolves,
    system_resolver,
)
from assistant.llm.failures import log_text, secrets_of
from assistant.llm.probe import ProbeResult, probe_target
from assistant.llm.providers import (
    ConnectionFields,
    ConnectionInvalid,
    Target,
    credential_hint,
    normalize_connection,
    normalize_credentials,
    open_models,
)
from assistant.llm.resolution import AssistantUnavailable, ModelResolver
from assistant.llm.types import DataPolicy, ProviderType
from assistant.llm.vault import CredentialsUnreadable
from assistant.org_repo import (
    ConnectionInUse,
    ConnectionNotTested,
    Member,
    NameTaken,
    OrgSettingsRepository,
    UnknownConnection,
)

logger = logging.getLogger(__name__)

router = APIRouter()

#: Seams for tests: DNS when a base URL is saved, and the Test connection probe.
RESOLVER: Resolver = system_resolver
PROBE: Callable[[Target, EndpointPolicy], Awaitable[ProbeResult]] = probe_target

#: Fields whose change needs a new test (P8).
_RELEVANT = (
    "provider",
    "base_url",
    "region",
    "model",
    "provider_order",
    "allow_fallbacks",
)


def _error(
    status: int, code: str, message: str | None = None, **extra: Any
) -> HTTPException:
    detail: dict[str, Any] = {"code": code, **extra}
    if message is not None:
        detail["message"] = message
    return HTTPException(status_code=status, detail=detail)


# -- request and response models ------------------------------------------------


class StatusOut(BaseModel):
    available: bool
    reason: str | None
    is_admin: bool
    provider: str | None
    model: str | None
    data_policy: DataPolicy
    #: Surfaces where the assistant is switched off (spec §6.3): the dock hides there.
    disabled_surfaces: list[str] = Field(default_factory=list)


class GoatAiOut(BaseModel):
    available: bool
    provider: str | None = None
    model: str | None = None


class InstanceOut(BaseModel):
    goat_ai: GoatAiOut
    #: Own connections are on and usable: the operator allows them and
    #: ``ASSISTANT_SECRETS_KEY`` is set.
    org_connections: bool
    #: False when ``ASSISTANT_SECRETS_KEY`` is missing, which makes own
    #: connections unavailable even where the operator allows them; the admin
    #: page tells the admin why.
    secrets_key_configured: bool
    allowed_providers: list[ProviderType]
    private_endpoints: bool


class SettingsOut(BaseModel):
    enabled: bool
    active_connection_id: UUID | None
    data_policy: DataPolicy
    allow_default_fallback: bool
    #: "ok", or why the organization's members cannot use AI right now.
    status: str
    instance: InstanceOut


class SettingsIn(BaseModel):
    enabled: bool
    active_connection_id: UUID | None = None
    data_policy: DataPolicy = "restricted"
    allow_default_fallback: bool = False


class ConnectionOut(BaseModel):
    id: UUID
    name: str
    provider: ProviderType
    base_url: str | None
    region: str | None
    model: str
    provider_order: list[str]
    allow_fallbacks: bool
    key_last4: str | None
    credentials_readable: bool
    capabilities: dict[str, Any]
    #: The model is on GOAT's tested-models list (§4.3); others show "untested".
    tested_model: bool
    last_test_at: datetime | None
    last_test_ok: bool | None
    last_test_error: str | None
    active: bool
    created_at: datetime
    updated_at: datetime


class ConnectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    provider: ProviderType
    base_url: str | None = None
    region: str | None = None
    model: str = Field(min_length=1, max_length=200)
    #: OpenRouter only (``normalize_connection``).
    provider_order: list[str] = Field(default_factory=list, max_length=20)
    allow_fallbacks: bool = True
    credentials: dict[str, str] = Field(default_factory=dict)


class ConnectionUpdate(BaseModel):
    """Partial: omitted fields are kept; empty credential values keep the stored ones."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    provider: ProviderType | None = None
    base_url: str | None = None
    region: str | None = None
    model: str | None = Field(default=None, min_length=1, max_length=200)
    provider_order: list[str] | None = Field(default=None, max_length=20)
    allow_fallbacks: bool | None = None
    credentials: dict[str, str] | None = None


# -- callers ----------------------------------------------------------------------


@dataclass
class Caller:
    member: Member
    is_admin: bool
    settings: AssistantSettings
    org_repo: OrgSettingsRepository
    resolver: ModelResolver
    policy: EndpointPolicy


def _context(
    request: Request,
) -> tuple[AssistantSettings, OrgSettingsRepository, ModelResolver]:
    settings: AssistantSettings = request.app.state.settings
    org_repo = OrgSettingsRepository(request.app.state.services.db)
    return settings, org_repo, ModelResolver(org_repo, settings)


async def member_caller(
    request: Request, principal: Principal = Depends(get_principal)
) -> Caller:
    settings, org_repo, resolver = _context(request)
    member = await org_repo.member(principal.user_id)
    if member is None:
        raise _error(403, "no_organization")
    return Caller(
        member=member,
        is_admin=not settings.auth or member.is_admin,
        settings=settings,
        org_repo=org_repo,
        resolver=resolver,
        policy=EndpointPolicy.from_settings(settings),
    )


async def admin_caller(caller: Caller = Depends(member_caller)) -> Caller:
    if not caller.is_admin:
        raise _error(403, "not_admin")
    return caller


# -- helpers ------------------------------------------------------------------------


class _Unset:
    """Marks "active connection not looked up yet" (None means there is none)."""


_UNSET = _Unset()


async def _connection_out(
    caller: Caller,
    row: Mapping[str, Any],
    active_id: UUID | None | _Unset = _UNSET,
) -> ConnectionOut:
    if isinstance(active_id, _Unset):
        active_id = (
            await caller.org_repo.get_settings(caller.member.organization_id)
        ).active_connection_id
    try:
        hint = credential_hint(row["provider"], caller.resolver.decrypt(row))
        readable = True
    except CredentialsUnreadable:
        hint, readable = None, False
    return ConnectionOut(
        id=row["id"],
        name=row["name"],
        provider=row["provider"],
        base_url=row["base_url"],
        region=row["region"],
        model=row["model"],
        provider_order=list(row["provider_order"] or []),
        allow_fallbacks=row["allow_fallbacks"],
        key_last4=hint,
        credentials_readable=readable,
        capabilities=row["capabilities"] or {},
        tested_model=is_tested(row["provider"], row["model"]),
        last_test_at=row["last_test_at"],
        last_test_ok=row["last_test_ok"],
        last_test_error=row["last_test_error"],
        active=row["id"] == active_id,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def _settings_out(caller: Caller) -> SettingsOut:
    stored = await caller.org_repo.get_settings(caller.member.organization_id)
    try:
        await caller.resolver.resolve_member(caller.member)
        status = "ok"
    except AssistantUnavailable as exc:
        status = exc.reason
    goat_ai = caller.resolver.goat_ai()
    return SettingsOut(
        enabled=stored.enabled,
        active_connection_id=stored.active_connection_id,
        data_policy=stored.data_policy,
        allow_default_fallback=stored.allow_default_fallback,
        status=status,
        instance=InstanceOut(
            goat_ai=GoatAiOut(
                available=goat_ai is not None,
                provider=goat_ai.provider if goat_ai else None,
                model=goat_ai.model if goat_ai else None,
            ),
            org_connections=caller.resolver.org_connections_enabled,
            secrets_key_configured=caller.resolver.secrets is not None,
            allowed_providers=list(caller.settings.allowed_providers),
            private_endpoints=caller.settings.allow_private_endpoints,
        ),
    )


def _require_provider(caller: Caller, provider: str) -> None:
    if not caller.resolver.org_connections_enabled:
        raise _error(409, "org_connections_unavailable")
    if provider not in caller.settings.allowed_providers:
        raise _error(422, "provider_not_allowed")


async def _checked_fields(
    caller: Caller,
    provider: ProviderType,
    base_url: str | None,
    region: str | None,
    model: str,
    provider_order: Sequence[str],
    allow_fallbacks: bool,
) -> ConnectionFields:
    try:
        fields = normalize_connection(
            provider,
            base_url,
            region,
            model,
            caller.policy,
            provider_order=provider_order,
            allow_fallbacks=allow_fallbacks,
        )
        if fields.base_url is not None:
            await check_resolves(fields.base_url, caller.policy, RESOLVER)
    except EndpointNotAllowed as exc:
        raise _error(422, "endpoint_not_allowed", str(exc)) from exc
    except ConnectionInvalid as exc:
        raise _error(422, "invalid_connection", exc.message, field=exc.field) from exc
    return fields


def _checked_credentials(
    provider: ProviderType, raw: Mapping[str, str]
) -> dict[str, str]:
    try:
        return normalize_credentials(provider, raw)
    except ConnectionInvalid as exc:
        raise _error(422, "invalid_connection", exc.message, field=exc.field) from exc


#: Stands in for the ID of a connection not stored yet: built as an own connection.
_UNSAVED = UUID(int=0)


def _target(
    fields: ConnectionFields,
    credentials: Mapping[str, str],
    connection_id: UUID = _UNSAVED,
) -> Target:
    return Target(
        connection_id=connection_id,
        provider=fields.provider,
        model=fields.model,
        provider_order=fields.provider_order,
        allow_fallbacks=fields.allow_fallbacks,
        base_url=fields.base_url,
        region=fields.region,
        credentials=credentials,
    )


async def _profile(caller: Caller, target: Target) -> dict[str, Any]:
    """The capability profile known for the model before any test (§4.3:
    known models get it pre-filled). Building the models sends no request."""
    try:
        models = open_models(target, caller.policy)
        try:
            return capabilities_for(models.main, target.model)
        finally:
            await models.aclose()
    except Exception as exc:
        # The traceback may echo the key the SDK was given: mask it first.
        logger.warning(
            "No capability profile for %s %s\n%s",
            target.provider,
            target.model,
            log_text(exc, secrets_of(target)),
        )
        return {}


def _stored_credentials(caller: Caller, row: Mapping[str, Any]) -> dict[str, str]:
    try:
        return caller.resolver.decrypt(row)
    except CredentialsUnreadable:
        return {}


async def _owned_connection(caller: Caller, connection_id: UUID) -> dict[str, Any]:
    row = await caller.org_repo.get_connection(
        caller.member.organization_id, connection_id
    )
    if row is None:
        raise _error(404, "not_found")
    return row


#: Connections being probed by this process. A second Test connection or edit
#: probe of the same connection is refused instead of queued: probes take up to
#: a minute and each one costs the admin's tokens. Per process only; several
#: replicas can still probe the same connection once each.
_probing: set[UUID] = set()


@asynccontextmanager
async def _single_flight(connection_id: UUID) -> AsyncIterator[None]:
    if connection_id in _probing:
        raise _error(409, "test_in_progress")
    _probing.add(connection_id)
    try:
        yield
    finally:
        _probing.discard(connection_id)


# -- routes -------------------------------------------------------------------------


@router.get("/status")
async def get_status(
    request: Request, principal: Principal = Depends(get_principal)
) -> StatusOut:
    settings, org_repo, resolver = _context(request)
    member = await org_repo.member(principal.user_id)
    if member is None:
        return StatusOut(
            available=False,
            reason="no_organization",
            is_admin=not settings.auth,
            provider=None,
            model=None,
            data_policy="restricted",
            disabled_surfaces=list(settings.disabled_surfaces),
        )
    status = await resolver.status_of(member)
    return StatusOut(
        available=status.available,
        reason=status.reason,
        is_admin=not settings.auth or member.is_admin,
        provider=status.provider,
        model=status.model,
        data_policy=status.data_policy,
        disabled_surfaces=list(settings.disabled_surfaces),
    )


@router.get("/settings")
async def get_settings(caller: Caller = Depends(admin_caller)) -> SettingsOut:
    return await _settings_out(caller)


@router.put("/settings")
async def put_settings(
    body: SettingsIn, caller: Caller = Depends(admin_caller)
) -> SettingsOut:
    organization_id = caller.member.organization_id
    stored = await caller.org_repo.get_settings(organization_id)
    # The activation checks apply when the active connection changes. Keeping
    # the current one (even if it is failing) must not stop an admin from
    # switching AI off or changing the data policy.
    activating = (
        body.active_connection_id is not None
        and body.active_connection_id != stored.active_connection_id
    )
    if activating:
        assert body.active_connection_id is not None
        row = await caller.org_repo.get_connection(
            organization_id, body.active_connection_id
        )
        if row is None:
            raise _error(422, "connection_not_found")
        if not caller.resolver.connection_allowed(row["provider"]):
            raise _error(422, "connection_not_allowed")
    if body.allow_default_fallback and caller.resolver.goat_ai() is None:
        raise _error(422, "goat_ai_unavailable")
    try:
        await caller.org_repo.save_settings(
            organization_id,
            enabled=body.enabled,
            active_connection_id=body.active_connection_id,
            data_policy=body.data_policy,
            allow_default_fallback=body.allow_default_fallback,
            updated_by=caller.member.user_id,
            # A model that cannot complete the tool call cannot be activated (§4.3).
            require_tested=activating,
        )
    except UnknownConnection as exc:
        raise _error(422, "connection_not_found") from exc
    except ConnectionNotTested as exc:
        raise _error(422, "connection_not_tested") from exc
    return await _settings_out(caller)


@router.get("/connections")
async def list_connections(
    caller: Caller = Depends(admin_caller),
) -> list[ConnectionOut]:
    organization_id = caller.member.organization_id
    active_id = (
        await caller.org_repo.get_settings(organization_id)
    ).active_connection_id
    rows = await caller.org_repo.list_connections(organization_id)
    return [await _connection_out(caller, row, active_id) for row in rows]


@router.post("/connections", status_code=201)
async def create_connection(
    body: ConnectionCreate, caller: Caller = Depends(admin_caller)
) -> ConnectionOut:
    _require_provider(caller, body.provider)
    name = body.name.strip()
    if not name:
        raise _error(422, "invalid_connection", "Enter a name.", field="name")
    fields = await _checked_fields(
        caller,
        body.provider,
        body.base_url,
        body.region,
        body.model,
        body.provider_order,
        body.allow_fallbacks,
    )
    credentials = _checked_credentials(body.provider, body.credentials)
    try:
        row = await caller.org_repo.create_connection(
            caller.member.organization_id,
            name=name,
            fields=fields,
            credentials_encrypted=caller.resolver.encrypt(credentials),
            capabilities=await _profile(caller, _target(fields, credentials)),
        )
    except NameTaken as exc:
        raise _error(409, "name_taken") from exc
    return await _connection_out(caller, row)


@router.patch("/connections/{connection_id}")
async def update_connection(
    connection_id: UUID, body: ConnectionUpdate, caller: Caller = Depends(admin_caller)
) -> ConnectionOut:
    organization_id = caller.member.organization_id
    row = await _owned_connection(caller, connection_id)
    if not caller.resolver.connection_allowed(row["provider"]):
        raise _error(409, "connection_not_allowed")
    sent = body.model_fields_set
    provider: ProviderType = (
        body.provider if body.provider is not None else row["provider"]
    )
    if provider != row["provider"]:
        _require_provider(caller, provider)
    fields = await _checked_fields(
        caller,
        provider,
        body.base_url if "base_url" in sent else row["base_url"],
        body.region if "region" in sent else row["region"],
        body.model if body.model is not None else row["model"],
        body.provider_order
        if body.provider_order is not None
        else row["provider_order"] or [],
        body.allow_fallbacks
        if body.allow_fallbacks is not None
        else row["allow_fallbacks"],
    )

    entered = {
        key: value for key, value in (body.credentials or {}).items() if value.strip()
    }
    if provider != row["provider"] and not entered:
        raise _error(422, "credentials_required")
    credentials: dict[str, str] | None = None
    if entered:
        if provider == row["provider"]:
            # Fields left empty keep their stored values (an AWS key pair may
            # change only its secret).
            try:
                entered = {**caller.resolver.decrypt(row), **entered}
            except CredentialsUnreadable:
                pass
        credentials = _checked_credentials(provider, entered)

    changes: dict[str, Any] = {
        "provider": fields.provider,
        "base_url": fields.base_url,
        "region": fields.region,
        "model": fields.model,
        "provider_order": list(fields.provider_order),
        "allow_fallbacks": fields.allow_fallbacks,
    }
    relevant = credentials is not None or any(
        changes[key] != row[key] for key in _RELEVANT
    )
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise _error(422, "invalid_connection", "Enter a name.", field="name")
        changes["name"] = name
    if credentials is not None:
        changes["credentials_encrypted"] = caller.resolver.encrypt(credentials)

    active = (
        await caller.org_repo.get_settings(organization_id)
    ).active_connection_id == connection_id
    try:
        if relevant and active:
            # The active connection must keep passing the test (P8): probe the
            # new configuration before anything is stored.
            if credentials is None:
                try:
                    credentials = caller.resolver.decrypt(row)
                except CredentialsUnreadable as exc:
                    raise _error(409, "credentials_unreadable") from exc
            candidate = _target(fields, credentials, connection_id)
            async with _single_flight(connection_id):
                result = await PROBE(candidate, caller.policy)
            if not result.ok:
                raise _error(422, "test_failed", result.error)
            # One statement: the new configuration and its passed test.
            updated = await caller.org_repo.update_connection(
                organization_id,
                connection_id,
                changes,
                reset_test=False,
                passed_capabilities=result.capabilities,
            )
        else:
            if relevant:
                # The new model's known profile until a test records the observed one.
                stored = (
                    credentials
                    if credentials is not None
                    else _stored_credentials(caller, row)
                )
                changes["capabilities"] = await _profile(
                    caller, _target(fields, stored, connection_id)
                )
            updated = await caller.org_repo.update_connection(
                organization_id,
                connection_id,
                changes,
                reset_test=relevant,
                # Resetting the test of a connection that was activated since
                # the check above would leave the active connection untested.
                only_if_inactive=relevant,
            )
            if updated is None and relevant:
                if await caller.org_repo.get_connection(organization_id, connection_id):
                    raise _error(409, "connection_changed")
    except NameTaken as exc:
        raise _error(409, "name_taken") from exc
    if updated is None:
        raise _error(404, "not_found")
    return await _connection_out(caller, updated)


@router.delete("/connections/{connection_id}", status_code=204)
async def delete_connection(
    connection_id: UUID, caller: Caller = Depends(admin_caller)
) -> Response:
    organization_id = caller.member.organization_id
    await _owned_connection(caller, connection_id)
    if (
        await caller.org_repo.get_settings(organization_id)
    ).active_connection_id == connection_id:
        raise _error(409, "connection_active")
    try:
        deleted = await caller.org_repo.delete_connection(
            organization_id, connection_id
        )
    except ConnectionInUse as exc:
        raise _error(409, "connection_active") from exc
    if not deleted:
        raise _error(404, "not_found")
    return Response(status_code=204)


@router.post("/connections/{connection_id}/test")
async def test_connection(
    connection_id: UUID, caller: Caller = Depends(admin_caller)
) -> ConnectionOut:
    organization_id = caller.member.organization_id
    row = await _owned_connection(caller, connection_id)
    if not caller.resolver.connection_allowed(row["provider"]):
        raise _error(409, "connection_not_allowed")
    try:
        target = caller.resolver.target_for(row)
    except CredentialsUnreadable as exc:
        raise _error(409, "credentials_unreadable") from exc
    async with _single_flight(connection_id):
        result = await PROBE(target, caller.policy)
    updated = await caller.org_repo.record_test(
        organization_id,
        connection_id,
        ok=result.ok,
        error=result.error,
        capabilities=result.capabilities if result.ok else None,
    )
    if updated is None:
        raise _error(404, "not_found")
    return await _connection_out(caller, updated)
