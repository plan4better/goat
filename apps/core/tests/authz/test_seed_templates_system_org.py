"""Where the GOAT layout starters live when login is on.

With AUTH on and no GOAT_TEMPLATES_ORGANIZATION_ID, the starters go into the
space of a member-less system organization with a fixed id, so every install
shows them on its template shelf.
"""

from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import GOAT_SYSTEM_ORGANIZATION_ID, settings
from core.db.models import Organization, User
from core.db.models.folder import Folder
from core.db.models.space import Space
from core.db.models.template import Template, TemplateCatalogStatus
from core.db.seed_templates import STARTERS, seed_templates
from core.scripts import initial_data
from httpx import AsyncClient
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from tests.utils import make_organization


async def _drop_system_organization(db: AsyncSession) -> None:
    await db.execute(
        delete(Organization).where(Organization.id == GOAT_SYSTEM_ORGANIZATION_ID)
    )
    await db.commit()


@pytest.fixture
async def no_system_organization(db_session: AsyncSession) -> Any:
    await _drop_system_organization(db_session)
    yield
    await _drop_system_organization(db_session)


async def _starters(db: AsyncSession) -> list[Template]:
    return list(
        (
            await db.execute(
                select(Template).where(Template.source_ref["kind"].astext == "seed")
            )
        )
        .scalars()
        .all()
    )


async def _space_of(db: AsyncSession, organization_id: UUID) -> Space:
    return (
        await db.execute(select(Space).where(Space.organization_id == organization_id))
    ).scalar_one()


async def _count(db: AsyncSession, stmt: Any) -> int:
    return int((await db.execute(stmt)).scalar_one())


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_system_organization")
async def test_login_on_without_configured_org_seeds_into_system_org(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "AUTH", True)
    monkeypatch.setattr(settings, "GOAT_TEMPLATES_ORGANIZATION_ID", None)

    await seed_templates(db_session)

    org = await db_session.get(Organization, GOAT_SYSTEM_ORGANIZATION_ID)
    assert org is not None
    assert org.name == "GOAT"
    assert org.total_projects == settings.DEFAULT_QUOTA_PROJECTS
    assert org.on_trial is False and org.suspended is False
    members = await _count(
        db_session,
        select(func.count())
        .select_from(User)
        .where(User.organization_id == GOAT_SYSTEM_ORGANIZATION_ID),
    )
    assert members == 0

    space = await _space_of(db_session, GOAT_SYSTEM_ORGANIZATION_ID)
    starters = await _starters(db_session)
    assert len(starters) == len(STARTERS)
    assert {t.space_id for t in starters} == {space.id}
    assert all(t.catalog_status == TemplateCatalogStatus.published for t in starters)


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_system_organization")
async def test_system_org_seed_is_idempotent(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "AUTH", True)
    monkeypatch.setattr(settings, "GOAT_TEMPLATES_ORGANIZATION_ID", None)

    await seed_templates(db_session)
    org = await db_session.get(Organization, GOAT_SYSTEM_ORGANIZATION_ID)
    assert org is not None
    first_updated_at = org.updated_at
    space_id = (await _space_of(db_session, GOAT_SYSTEM_ORGANIZATION_ID)).id
    first_ids = {t.id for t in await _starters(db_session)}

    await seed_templates(db_session)

    orgs = await _count(
        db_session,
        select(func.count())
        .select_from(Organization)
        .where(Organization.id == GOAT_SYSTEM_ORGANIZATION_ID),
    )
    assert orgs == 1
    await db_session.refresh(org)
    assert org.updated_at == first_updated_at
    spaces = await _count(
        db_session,
        select(func.count())
        .select_from(Space)
        .where(Space.organization_id == GOAT_SYSTEM_ORGANIZATION_ID),
    )
    assert spaces == 1
    folders = await _count(
        db_session,
        select(func.count()).select_from(Folder).where(Folder.space_id == space_id),
    )
    assert folders == 1
    assert {t.id for t in await _starters(db_session)} == first_ids


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_system_organization")
async def test_login_off_keeps_the_default_user_space(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    fixture_create_user: Any,
) -> None:
    monkeypatch.setattr(settings, "AUTH", False)
    monkeypatch.setattr(settings, "GOAT_TEMPLATES_ORGANIZATION_ID", None)

    await seed_templates(db_session)

    assert await db_session.get(Organization, GOAT_SYSTEM_ORGANIZATION_ID) is None
    personal = (
        await db_session.execute(
            select(Space).where(Space.user_id == UUID(settings.DEFAULT_USER_ID))
        )
    ).scalar_one()
    starters = await _starters(db_session)
    assert len(starters) == len(STARTERS)
    assert {t.space_id for t in starters} == {personal.id}


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_system_organization")
async def test_configured_org_is_used_and_no_system_org_is_made(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    configured = make_organization(id=uuid4())
    db_session.add(configured)
    await db_session.commit()
    monkeypatch.setattr(settings, "AUTH", True)
    monkeypatch.setattr(settings, "GOAT_TEMPLATES_ORGANIZATION_ID", configured.id)
    try:
        await seed_templates(db_session)

        assert await db_session.get(Organization, GOAT_SYSTEM_ORGANIZATION_ID) is None
        space = await _space_of(db_session, configured.id)
        starters = await _starters(db_session)
        assert len(starters) == len(STARTERS)
        assert {t.space_id for t in starters} == {space.id}
    finally:
        await db_session.execute(
            delete(Organization).where(Organization.id == configured.id)
        )
        await db_session.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize("auth", [True, False])
async def test_initial_data_always_seeds_the_starters(
    monkeypatch: pytest.MonkeyPatch, auth: bool
) -> None:
    calls: list[str] = []

    async def record(name: str) -> None:
        calls.append(name)

    class _Sessions:
        def init(self, _uri: str) -> None:
            pass

        async def close(self) -> None:
            pass

        def session(self) -> Any:
            class _Ctx:
                async def __aenter__(self) -> object:
                    return object()

                async def __aexit__(self, *_: object) -> None:
                    return None

            return _Ctx()

    async def fake_seed(_session: object, *, name: str) -> None:
        await record(name)

    monkeypatch.setattr(initial_data, "session_manager", _Sessions())
    monkeypatch.setattr(initial_data, "init_functions", lambda: record("functions"))
    monkeypatch.setattr(initial_data, "init_triggers", lambda: record("triggers"))
    monkeypatch.setattr(
        initial_data, "seed_roles", lambda s: fake_seed(s, name="roles")
    )
    monkeypatch.setattr(
        initial_data,
        "seed_default_user_org",
        lambda s: fake_seed(s, name="default_org"),
    )
    monkeypatch.setattr(
        initial_data, "seed_templates", lambda s: fake_seed(s, name="templates")
    )
    monkeypatch.setattr(settings, "AUTH", auth)
    monkeypatch.setattr(settings, "GOAT_TEMPLATES_ORGANIZATION_ID", None)

    await initial_data.main()

    assert calls[-1] == "templates"
    assert ("default_org" in calls) is (not auth)


@pytest.mark.asyncio
@pytest.mark.usefixtures("no_system_organization")
async def test_system_org_starters_reach_non_members(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    fixture_create_user: Any,
) -> None:
    with monkeypatch.context() as seeding:
        seeding.setattr(settings, "AUTH", True)
        seeding.setattr(settings, "GOAT_TEMPLATES_ORGANIZATION_ID", None)
        await seed_templates(db_session)

    r = await client.get(f"{settings.API_V2_STR}/template?source=goat")
    assert r.status_code == 200, r.text
    assert {item["name"] for item in r.json()["items"]} == {s["name"] for s in STARTERS}
