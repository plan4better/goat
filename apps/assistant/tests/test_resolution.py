from uuid import UUID, uuid4

import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr

from assistant.config import AssistantSettings
from assistant.llm.providers import ConnectionFields
from assistant.llm.resolution import AssistantUnavailable, ModelResolver
from assistant.llm.vault import SecretBox
from assistant.org_repo import OrgSettingsRepository

USER = UUID(int=1)
ADMIN = UUID(int=3)
ORG = UUID(int=100)


async def _own_connection(
    org_repo: OrgSettingsRepository,
    settings: AssistantSettings,
    *,
    activate: bool = True,
    fallback: bool = False,
) -> UUID:
    box = SecretBox.from_settings(settings)
    assert box is not None
    row = await org_repo.create_connection(
        ORG,
        name="Own",
        fields=ConnectionFields(
            provider="openai_compatible",
            base_url="https://llm.example.org/v1",
            region=None,
            model="own-model",
        ),
        credentials_encrypted=box.encrypt({"api_key": "sk-own-abcd1234"}),
    )
    connection_id = UUID(str(row["id"]))
    await org_repo.record_test(ORG, connection_id, ok=True, error=None, capabilities={})
    if activate:
        await org_repo.save_settings(
            ORG,
            enabled=True,
            active_connection_id=connection_id,
            data_policy="restricted",
            allow_default_fallback=fallback,
            updated_by=ADMIN,
        )
    return connection_id


async def _reason(resolver: ModelResolver, user: UUID = USER) -> str:
    with pytest.raises(AssistantUnavailable) as caught:
        await resolver.resolve(user)
    return caught.value.reason


async def test_defaults_resolve_to_goat_ai(
    org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    resolution = await ModelResolver(org_repo, settings).resolve(USER)
    assert resolution.organization_id == ORG
    # An organization that never saved AI settings reads data under Standard.
    assert resolution.data_policy == "standard"
    assert (
        resolution.main.provider,
        resolution.main.model,
        resolution.main.connection_id,
    ) == ("test", "test", None)
    assert resolution.fallback is None


async def test_unavailable_reasons(
    org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    assert (
        await _reason(ModelResolver(org_repo, settings), uuid4()) == "no_organization"
    )
    no_goat_ai = settings.model_copy(update={"default_provider": "none"})
    assert await _reason(ModelResolver(org_repo, no_goat_ai)) == "no_connection"
    await org_repo.save_settings(
        ORG,
        enabled=False,
        active_connection_id=None,
        data_policy="standard",
        allow_default_fallback=False,
        updated_by=ADMIN,
    )
    assert await _reason(ModelResolver(org_repo, settings)) == "disabled"


async def test_the_active_own_connection(
    org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    connection_id = await _own_connection(org_repo, settings)
    resolution = await ModelResolver(org_repo, settings).resolve(USER)
    main = resolution.main
    assert main.connection_id == connection_id
    assert (main.provider, main.model) == ("openai_compatible", "own-model")
    assert main.base_url == "https://llm.example.org/v1"
    assert dict(main.credentials) == {"api_key": "sk-own-abcd1234"}
    assert resolution.data_policy == "restricted"
    assert resolution.fallback is None
    assert "sk-own" not in repr(resolution)


async def test_fallback_only_when_enabled(
    org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    await _own_connection(org_repo, settings, fallback=True)
    resolution = await ModelResolver(org_repo, settings).resolve(USER)
    assert resolution.fallback is not None and resolution.fallback.provider == "test"
    no_goat_ai = settings.model_copy(update={"default_provider": "none"})
    assert (await ModelResolver(org_repo, no_goat_ai).resolve(USER)).fallback is None


async def test_disallowed_connection_is_unavailable_not_replaced(
    org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    """Review Focus 1: the operator switches the provider type or own
    connections off; the organization's choice is not quietly replaced by
    GOAT AI, even with fallback on."""
    await _own_connection(org_repo, settings, fallback=True)
    only_openai = settings.model_copy(update={"allowed_providers": ["openai"]})
    assert (
        await _reason(ModelResolver(org_repo, only_openai)) == "connection_not_allowed"
    )
    no_own = settings.model_copy(update={"allow_org_connections": False})
    assert await _reason(ModelResolver(org_repo, no_own)) == "connection_not_allowed"
    no_key = settings.model_copy(update={"secrets_key": SecretStr("")})
    assert await _reason(ModelResolver(org_repo, no_key)) == "connection_not_allowed"


async def test_unreadable_credentials(
    org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    await _own_connection(org_repo, settings)
    other_key = SecretBox([Fernet.generate_key().decode()])
    resolver = ModelResolver(org_repo, settings, secrets=other_key)
    assert await _reason(resolver) == "credentials_unreadable"


async def test_status_of_a_member(
    org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    resolver = ModelResolver(org_repo, settings)
    member = await org_repo.member(USER)
    assert member is not None
    status = await resolver.status_of(member)
    assert (
        status.available,
        status.reason,
        status.provider,
        status.model,
        status.goat_ai,
    ) == (True, None, "test", "test", True)
    await org_repo.save_settings(
        ORG,
        enabled=False,
        active_connection_id=None,
        data_policy="restricted",
        allow_default_fallback=False,
        updated_by=ADMIN,
    )
    off = await resolver.status_of(member)
    assert (off.available, off.reason, off.provider, off.data_policy, off.goat_ai) == (
        False,
        "disabled",
        None,
        "restricted",
        False,
    )


async def test_status_says_whether_goat_ai_answers(
    org_repo: OrgSettingsRepository, settings: AssistantSettings
) -> None:
    """An own connection answers also when GOAT AI stands by as its fallback."""
    resolver = ModelResolver(org_repo, settings)
    member = await org_repo.member(USER)
    assert member is not None
    assert (await resolver.status_of(member)).goat_ai is True
    await _own_connection(org_repo, settings, fallback=True)
    own = await resolver.status_of(member)
    assert (own.available, own.provider, own.goat_ai) == (
        True,
        "openai_compatible",
        False,
    )
