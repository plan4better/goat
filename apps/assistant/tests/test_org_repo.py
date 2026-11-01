from uuid import UUID, uuid4

import pytest

from assistant.db import Database
from assistant.llm.providers import ConnectionFields
from assistant.org_repo import (
    ConnectionInUse,
    ConnectionNotTested,
    NameTaken,
    OrgSettings,
    OrgSettingsRepository,
    UnknownConnection,
)

USER = UUID(int=1)
ADMIN = UUID(int=3)
OTHER_ADMIN = UUID(int=4)
ORG = UUID(int=100)
OTHER_ORG = UUID(int=200)
FIELDS = ConnectionFields(
    provider="openai_compatible",
    base_url="https://llm.example.org/v1",
    region=None,
    model="own-model",
)


async def _create(
    org_repo: OrgSettingsRepository, name: str = "Own", organization: UUID = ORG
) -> UUID:
    row = await org_repo.create_connection(
        organization, name=name, fields=FIELDS, credentials_encrypted="token"
    )
    return UUID(str(row["id"]))


async def test_member_and_admin_flag(
    org_repo: OrgSettingsRepository, db: Database
) -> None:
    member = await org_repo.member(USER)
    assert (
        member is not None
        and member.organization_id == ORG
        and member.is_admin is False
    )
    admin = await org_repo.member(ADMIN)
    assert admin is not None and admin.is_admin is True
    assert await org_repo.member(uuid4()) is None

    owner = uuid4()
    owner_role = uuid4()
    await db.pool.execute(
        f"INSERT INTO {db.customer('role')} (id, name) VALUES ($1, 'organization-owner')",
        owner_role,
    )
    await db.pool.execute(
        f"INSERT INTO {db.customer('user')} (id, organization_id) VALUES ($1, $2)",
        owner,
        ORG,
    )
    await db.pool.execute(
        f"INSERT INTO {db.customer('user_role')} (user_id, role_id) VALUES ($1, $2)",
        owner,
        owner_role,
    )
    owner_member = await org_repo.member(owner)
    assert owner_member is not None and owner_member.is_admin is True


async def test_settings_default_and_upsert(org_repo: OrgSettingsRepository) -> None:
    assert await org_repo.get_settings(ORG) == OrgSettings(organization_id=ORG)
    connection_id = await _create(org_repo)
    saved = await org_repo.save_settings(
        ORG,
        enabled=True,
        active_connection_id=connection_id,
        data_policy="restricted",
        allow_default_fallback=True,
        updated_by=ADMIN,
    )
    assert saved == OrgSettings(ORG, True, connection_id, "restricted", True)
    again = await org_repo.save_settings(
        ORG,
        enabled=False,
        active_connection_id=None,
        data_policy="standard",
        allow_default_fallback=False,
        updated_by=ADMIN,
    )
    assert again == OrgSettings(ORG, False, None, "standard", False)
    with pytest.raises(UnknownConnection):
        await org_repo.save_settings(
            ORG,
            enabled=True,
            active_connection_id=uuid4(),
            data_policy="standard",
            allow_default_fallback=False,
            updated_by=ADMIN,
        )


async def test_connections_are_scoped_to_their_organization(
    org_repo: OrgSettingsRepository,
) -> None:
    connection_id = await _create(org_repo)
    assert [c["id"] for c in await org_repo.list_connections(ORG)] == [connection_id]
    assert await org_repo.list_connections(OTHER_ORG) == []
    assert await org_repo.get_connection(OTHER_ORG, connection_id) is None
    assert (
        await org_repo.update_connection(
            OTHER_ORG, connection_id, {"name": "x"}, reset_test=False
        )
        is None
    )
    assert await org_repo.delete_connection(OTHER_ORG, connection_id) is False
    assert await org_repo.get_connection(ORG, connection_id) is not None


async def test_names_are_unique_per_organization(
    org_repo: OrgSettingsRepository,
) -> None:
    await _create(org_repo, "Same")
    with pytest.raises(NameTaken):
        await _create(org_repo, "Same")
    other = await _create(org_repo, "Other")
    with pytest.raises(NameTaken):
        await org_repo.update_connection(ORG, other, {"name": "Same"}, reset_test=False)
    await _create(org_repo, "Same", organization=OTHER_ORG)


async def test_test_results_and_their_reset(org_repo: OrgSettingsRepository) -> None:
    connection_id = await _create(org_repo)
    tested = await org_repo.record_test(
        ORG, connection_id, ok=True, error=None, capabilities={"tool_calling": True}
    )
    assert (
        tested is not None
        and tested["last_test_ok"] is True
        and tested["last_test_at"] is not None
    )
    failed = await org_repo.record_test(
        ORG, connection_id, ok=False, error="HTTP 401", capabilities=None
    )
    assert failed is not None
    assert failed["last_test_error"] == "HTTP 401"
    assert failed["capabilities"] == {"tool_calling": True}  # kept when a test fails
    renamed = await org_repo.update_connection(
        ORG, connection_id, {"name": "Renamed"}, reset_test=False
    )
    assert renamed is not None and renamed["last_test_ok"] is False
    changed = await org_repo.update_connection(
        ORG, connection_id, {"model": "other"}, reset_test=True
    )
    assert changed is not None
    assert (changed["model"], changed["last_test_ok"], changed["capabilities"]) == (
        "other",
        None,
        {},
    )
    message = "The provider rejected the credentials (HTTP 401)."
    await org_repo.mark_connection_failed(OTHER_ORG, connection_id, message)
    untouched = await org_repo.get_connection(ORG, connection_id)
    assert untouched is not None
    assert (untouched["last_test_ok"], untouched["last_test_error"]) == (None, None)
    await org_repo.mark_connection_failed(ORG, connection_id, message)
    marked = await org_repo.get_connection(ORG, connection_id)
    assert marked is not None and marked["last_test_ok"] is False
    assert marked["last_test_error"] == message


async def test_the_active_connection_cannot_be_deleted(
    org_repo: OrgSettingsRepository,
) -> None:
    connection_id = await _create(org_repo)
    await org_repo.save_settings(
        ORG,
        enabled=True,
        active_connection_id=connection_id,
        data_policy="standard",
        allow_default_fallback=False,
        updated_by=ADMIN,
    )
    with pytest.raises(ConnectionInUse):
        await org_repo.delete_connection(ORG, connection_id)
    await org_repo.save_settings(
        ORG,
        enabled=True,
        active_connection_id=None,
        data_policy="standard",
        allow_default_fallback=False,
        updated_by=ADMIN,
    )
    assert await org_repo.delete_connection(ORG, connection_id) is True


async def test_activation_requires_a_passed_test_in_the_same_statement(
    org_repo: OrgSettingsRepository,
) -> None:
    connection_id = await _create(org_repo)
    with pytest.raises(ConnectionNotTested):
        await org_repo.save_settings(
            ORG,
            enabled=True,
            active_connection_id=connection_id,
            data_policy="standard",
            allow_default_fallback=False,
            updated_by=ADMIN,
            require_tested=True,
        )
    await org_repo.record_test(ORG, connection_id, ok=True, error=None, capabilities={})
    saved = await org_repo.save_settings(
        ORG,
        enabled=True,
        active_connection_id=connection_id,
        data_policy="standard",
        allow_default_fallback=False,
        updated_by=ADMIN,
        require_tested=True,
    )
    assert saved.active_connection_id == connection_id
    # Another organization's tested connection does not qualify.
    with pytest.raises(ConnectionNotTested):
        await org_repo.save_settings(
            OTHER_ORG,
            enabled=True,
            active_connection_id=connection_id,
            data_policy="standard",
            allow_default_fallback=False,
            updated_by=OTHER_ADMIN,
            require_tested=True,
        )


async def test_a_reset_may_store_a_new_capability_profile(
    org_repo: OrgSettingsRepository,
) -> None:
    connection_id = await _create(org_repo)
    await org_repo.record_test(
        ORG, connection_id, ok=True, error=None, capabilities={"tool_calling": True}
    )
    changed = await org_repo.update_connection(
        ORG,
        connection_id,
        {"model": "other", "capabilities": {"context_window": 8192}},
        reset_test=True,
    )
    assert changed is not None
    assert (changed["last_test_ok"], changed["capabilities"]) == (
        None,
        {"context_window": 8192},
    )


async def test_unknown_update_columns_are_refused(
    org_repo: OrgSettingsRepository,
) -> None:
    connection_id = await _create(org_repo)
    with pytest.raises(ValueError):
        await org_repo.update_connection(
            ORG, connection_id, {"organization_id": OTHER_ORG}, reset_test=False
        )


async def test_capabilities_cannot_be_passed_and_changed_together(
    org_repo: OrgSettingsRepository,
) -> None:
    connection_id = await _create(org_repo)
    with pytest.raises(ValueError):
        await org_repo.update_connection(
            ORG,
            connection_id,
            {"capabilities": {"context_window": 8192}},
            reset_test=False,
            passed_capabilities={"tool_calling": True},
        )


async def test_another_organizations_connection_is_unknown_even_without_the_test_requirement(
    org_repo: OrgSettingsRepository,
) -> None:
    """Linking it would let one organization block another's delete (RESTRICT)."""
    connection_id = await _create(org_repo)
    await org_repo.record_test(ORG, connection_id, ok=True, error=None, capabilities={})
    with pytest.raises(UnknownConnection):
        await org_repo.save_settings(
            OTHER_ORG,
            enabled=True,
            active_connection_id=connection_id,
            data_policy="standard",
            allow_default_fallback=False,
            updated_by=OTHER_ADMIN,
        )
    assert await org_repo.delete_connection(ORG, connection_id) is True


async def test_requiring_a_test_does_not_block_clearing_the_active_connection(
    org_repo: OrgSettingsRepository,
) -> None:
    saved = await org_repo.save_settings(
        ORG,
        enabled=True,
        active_connection_id=None,
        data_policy="standard",
        allow_default_fallback=False,
        updated_by=ADMIN,
        require_tested=True,
    )
    assert saved.active_connection_id is None
