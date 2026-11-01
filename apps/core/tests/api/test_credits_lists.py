"""The Usage page's storage and project lists: the organization's layers and
projects, filtered, sorted and paged on the server, for owners and admins."""

import importlib.util
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from core.core.config import settings
from core.crud.crud_space import space as crud_space
from core.db.models._link_model import LayerProjectLink
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.project import Project
from core.db.models.team import Team
from core.db.models.user import User
from core.db.session import session_manager
from core.endpoints.deps import get_user_id
from core.main import app
from sqlalchemy import delete, text
from tests.billing import enable_billing
from tests.utils import make_organization, org_with_default_user

MB = 1_048_576
STORAGE = f"{settings.API_V2_STR}/credits/storage-by-layer"
PROJECTS = f"{settings.API_V2_STR}/credits/projects"


@pytest.fixture(autouse=True)
def billing_on(monkeypatch: pytest.MonkeyPatch) -> None:
    enable_billing(monkeypatch)


@pytest.fixture(autouse=True)
def as_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests read the organization's lists, as its admins do; that
    members get 403 is tested at the end and in
    tests/authz/test_credit_usage_scope.py."""
    from core.endpoints.v2 import credits

    async def admin(db, user_id):
        return True

    monkeypatch.setattr(credits, "_is_admin", admin)


@pytest.fixture
async def caller(db_session):
    """A new organization whose member "Rep Orter" makes the requests and owns
    a folder for the test's layers and projects. Not the default user: it
    keeps the layers and projects of earlier tests, which would join every
    list. Deleting the folder removes the layers and projects in it."""
    org = make_organization()
    db_session.add(org)
    await db_session.flush()
    user_id = uuid4()
    user = User(
        id=user_id,
        email=f"lists-{user_id.hex[:8]}@goat.test",
        firstname="Rep",
        lastname="Orter",
        organization_id=org.id,
    )
    db_session.add(user)
    await db_session.flush()
    folder = Folder(user_id=user_id, name="usage-lists")
    db_session.add(folder)
    await db_session.commit()
    app.dependency_overrides[get_user_id] = lambda: user_id
    try:
        yield user, folder
    finally:
        app.dependency_overrides.pop(get_user_id, None)
        await db_session.execute(delete(Folder).where(Folder.id == folder.id))
        await db_session.commit()


def _at(day: int) -> datetime:
    return datetime(2026, 10, day, 12, tzinfo=UTC)


async def _member(db_session, org_id: UUID, firstname: str, lastname: str) -> User:
    user_id = uuid4()
    user = User(
        id=user_id,
        email=f"lists-{user_id.hex[:8]}@goat.test",
        firstname=firstname,
        lastname=lastname,
        organization_id=org_id,
    )
    db_session.add(user)
    await db_session.flush()
    return user


async def _storage_world(db_session, user: User, folder: Folder) -> User:
    """Roads (lines, in one project, 5 MB), Parcels 50% (polygons, in none,
    9 MB), Table A (a table of the other member Ann Other, in none, 1 MB) and
    Old (trashed, 3 MB). Returns Ann."""
    ann = await _member(db_session, user.organization_id, "Ann", "Other")

    def layer(name: str, size: int, owner: User = user, **fields) -> Layer:
        return Layer(
            user_id=owner.id, folder_id=folder.id, name=name, size=size * MB, **fields
        )

    roads = layer(
        "Roads",
        5,
        type="feature",
        feature_layer_geometry_type="line",
        updated_at=_at(3),
    )
    parcels = layer(
        "Parcels 50%",
        9,
        type="feature",
        feature_layer_geometry_type="polygon",
        updated_at=_at(2),
    )
    table = layer("Table A", 1, owner=ann, type="table", updated_at=_at(1))
    old = layer(
        "Old",
        3,
        type="feature",
        feature_layer_geometry_type="point",
        deleted_at=datetime.now(UTC),
    )
    project = Project(id=uuid4(), user_id=user.id, folder_id=folder.id, name="Streets")
    db_session.add_all([roads, parcels, table, old, project])
    await db_session.flush()
    db_session.add(
        LayerProjectLink(layer_id=roads.id, project_id=project.id, name="Roads")
    )
    await db_session.commit()
    return ann


def _names(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [row["name"] for row in response.json()["rows"]]


@pytest.mark.asyncio
async def test_storage_filters_unused_type_owner_and_search(client, db_session, caller):
    user, folder = caller
    ann = await _storage_world(db_session, user, folder)

    r = await client.get(STORAGE, params={"unused": True})
    assert _names(r) == ["Parcels 50%", "Table A"]
    assert r.json()["total"] == 2
    r = await client.get(STORAGE, params={"type": "line"})
    assert _names(r) == ["Roads"] and r.json()["rows"][0]["projects"] == 1
    roads = r.json()["rows"][0]
    assert (roads["owner_id"], roads["owner"]) == (str(user.id), "Rep Orter")
    assert (roads["type"], roads["geometry_type"]) == ("feature", "line")
    assert roads["updated_at"].startswith("2026-10-03T12:00:00")
    assert _names(await client.get(STORAGE, params={"type": "table"})) == ["Table A"]
    assert _names(await client.get(STORAGE, params={"type": "point"})) == []
    r = await client.get(STORAGE, params={"q": "50%"})
    assert _names(r) == ["Parcels 50%"]
    r = await client.get(STORAGE, params={"owner": str(ann.id)})
    assert _names(r) == ["Table A"] and r.json()["total"] == 1
    # A blank search is no search.
    assert len(_names(await client.get(STORAGE, params={"q": "  "}))) == 3

    r = await client.get(STORAGE, params={"sort": "name", "dir": "asc"})
    assert _names(r)[:3] == ["Parcels 50%", "Roads", "Table A"]
    split = r.json()["split"]
    assert round(split["in_projects_mb"]) == 5 and round(split["unused_mb"]) == 10
    assert round(split["trash_mb"]) == 3
    assert r.json()["trash"]["count"] == 1
    for sort, direction, names in [
        ("size", "desc", ["Parcels 50%", "Roads", "Table A"]),
        ("size", "asc", ["Table A", "Roads", "Parcels 50%"]),
        ("updated", "desc", ["Roads", "Parcels 50%", "Table A"]),
    ]:
        r = await client.get(STORAGE, params={"sort": sort, "dir": direction})
        assert _names(r) == names, (sort, direction)
    # Layers in as many projects follow in the order of their ids.
    r = await client.get(STORAGE, params={"sort": "projects", "dir": "desc"})
    assert [(x["name"], x["projects"]) for x in r.json()["rows"]][0] == ("Roads", 1)
    r = await client.get(STORAGE, params={"sort": "projects", "dir": "asc"})
    assert [x["projects"] for x in r.json()["rows"]] == [0, 0, 1]

    # The total counts what the filters match, the split and the trash all.
    r = await client.get(STORAGE, params={"unused": True, "limit": 1, "offset": 1})
    assert _names(r) == ["Table A"] and r.json()["total"] == 2
    assert r.json()["split"] == split and r.json()["trash"]["count"] == 1

    for bad in [{"type": "feature"}, {"sort": "owner"}, {"dir": "up"}]:
        assert (await client.get(STORAGE, params=bad)).status_code == 422, bad


@pytest.mark.asyncio
async def test_storage_sorts_a_layer_without_a_size_as_empty(
    client, db_session, caller
):
    user, folder = caller
    db_session.add_all(
        [
            Layer(
                user_id=user.id, folder_id=folder.id, name=name, size=size, type="table"
            )
            for name, size in (("Big", 5 * MB), ("Small", MB), ("No size", None))
        ]
    )
    await db_session.commit()

    for direction, names in [
        ("asc", ["No size", "Small", "Big"]),
        ("desc", ["Big", "Small", "No size"]),
    ]:
        params = {"sort": "size", "dir": direction}
        assert _names(await client.get(STORAGE, params=params)) == names, direction
        # The export reads the same query.
        export = await client.get(f"{STORAGE}/export", params=params)
        assert [
            line.split(",")[0] for line in export.text.strip().splitlines()[1:]
        ] == names, direction


@pytest.mark.asyncio
async def test_org_projects_lists_newest_first_with_layer_counts(
    client, db_session, caller
):
    user, folder = caller

    def project(name: str, **fields) -> Project:
        return Project(
            id=uuid4(), user_id=user.id, folder_id=folder.id, name=name, **fields
        )

    a = project("A", updated_at=_at(1))
    b = project("B", updated_at=_at(2))
    gone = project("Gone", updated_at=_at(3), deleted_at=datetime.now(UTC))
    layers = [
        Layer(user_id=user.id, folder_id=folder.id, name=f"L{n}", type="table")
        for n in (1, 2)
    ]
    db_session.add_all([a, b, gone, *layers])
    await db_session.flush()
    db_session.add_all(
        [LayerProjectLink(layer_id=x.id, project_id=a.id, name=x.name) for x in layers]
        + [LayerProjectLink(layer_id=layers[0].id, project_id=gone.id, name="L1")]
    )
    await db_session.commit()

    r = await client.get(PROJECTS, params={"limit": 10})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["name"] for x in body["rows"]] == ["B", "A"] and body["total"] == 2
    assert body["rows"][1]["layers"] == 2 and body["rows"][0]["owner"] == "Rep Orter"
    first = body["rows"][0]
    assert (first["project_id"], first["owner_id"]) == (str(b.id), str(user.id))
    assert first["layers"] == 0
    assert first["updated_at"].startswith("2026-10-02T12:00:00")

    for params, names in [
        ({"sort": "name", "dir": "asc"}, ["A", "B"]),
        ({"sort": "layers"}, ["A", "B"]),
        ({"dir": "asc"}, ["A", "B"]),
        ({"q": "b"}, ["B"]),
        ({"q": " "}, ["B", "A"]),
        ({"owner": str(user.id)}, ["B", "A"]),
        ({"owner": str(uuid4())}, []),
    ]:
        assert _names(await client.get(PROJECTS, params=params)) == names, params
    r = await client.get(PROJECTS, params={"limit": 1, "offset": 1})
    assert _names(r) == ["A"] and r.json()["total"] == 2
    for bad in [{"sort": "size"}, {"limit": 0}, {"limit": 101}, {"offset": -1}]:
        assert (await client.get(PROJECTS, params=bad)).status_code == 422, bad


@pytest.mark.asyncio
async def test_a_layer_is_used_only_by_live_projects_each_counted_once(
    client, db_session, caller
):
    """Twice (2 MB) is in one live project twice; Orphan (4 MB) only in a
    project in the trash, so it counts as in no project."""
    user, folder = caller
    live = Project(id=uuid4(), user_id=user.id, folder_id=folder.id, name="Live")
    trashed = Project(
        id=uuid4(),
        user_id=user.id,
        folder_id=folder.id,
        name="Trashed",
        deleted_at=datetime.now(UTC),
    )
    twice, orphan = (
        Layer(
            user_id=user.id,
            folder_id=folder.id,
            name=name,
            type="table",
            size=size * MB,
        )
        for name, size in (("Twice", 2), ("Orphan", 4))
    )
    db_session.add_all([live, trashed, twice, orphan])
    await db_session.flush()
    db_session.add_all(
        [
            LayerProjectLink(layer_id=twice.id, project_id=live.id, name="Twice"),
            LayerProjectLink(layer_id=twice.id, project_id=live.id, name="Twice 2"),
            LayerProjectLink(layer_id=orphan.id, project_id=trashed.id, name="Orphan"),
        ]
    )
    await db_session.commit()

    r = await client.get(STORAGE, params={"unused": True})
    assert _names(r) == ["Orphan"] and r.json()["rows"][0]["projects"] == 0
    split = r.json()["split"]
    assert round(split["in_projects_mb"]) == 2 and round(split["unused_mb"]) == 4
    r = await client.get(STORAGE)
    assert {x["name"]: x["projects"] for x in r.json()["rows"]} == {
        "Orphan": 0,
        "Twice": 1,
    }


@pytest.mark.asyncio
async def test_org_projects_leave_out_template_copies_and_trashed_layers(
    client, db_session, caller
):
    """A project template's frozen copy is hidden from every project listing;
    a project's layers in the trash are not among its layers."""
    user, folder = caller
    plan = Project(id=uuid4(), user_id=user.id, folder_id=folder.id, name="Plan")
    copy = Project(
        id=uuid4(),
        user_id=user.id,
        folder_id=folder.id,
        name="Plan",
        is_template_source=True,
    )
    kept, binned = (
        Layer(user_id=user.id, folder_id=folder.id, name=name, type="table", **fields)
        for name, fields in (
            ("Kept", {}),
            ("Binned", {"deleted_at": datetime.now(UTC)}),
        )
    )
    db_session.add_all([plan, copy, kept, binned])
    await db_session.flush()
    db_session.add_all(
        [
            LayerProjectLink(layer_id=layer.id, project_id=project.id, name=layer.name)
            for project in (plan, copy)
            for layer in (kept, binned)
        ]
    )
    await db_session.commit()

    r = await client.get(PROJECTS)
    assert r.status_code == 200, r.text
    assert [(x["project_id"], x["layers"]) for x in r.json()["rows"]] == [
        (str(plan.id), 1)
    ]
    assert r.json()["total"] == 1


@pytest.mark.asyncio
async def test_search_takes_wildcards_literally(client, db_session, caller):
    user, folder = caller
    names = ["Lots 50%_1", "Lots 5001", "C:\\data", "C:data"]
    db_session.add_all(
        [
            Layer(user_id=user.id, folder_id=folder.id, name=name, type="table")
            for name in names
        ]
        + [
            Project(id=uuid4(), user_id=user.id, folder_id=folder.id, name=name)
            for name in names
        ]
    )
    await db_session.commit()
    for url in (STORAGE, PROJECTS):
        assert _names(await client.get(url, params={"q": "50%_"})) == ["Lots 50%_1"]
        assert _names(await client.get(url, params={"q": "\\"})) == ["C:\\data"]
        too_long = await client.get(url, params={"q": "x" * 101})
        assert too_long.status_code == 422


@pytest.mark.asyncio
async def test_storage_export_follows_the_filters(client, db_session, caller):
    user, folder = caller
    await _storage_world(db_session, user, folder)

    r = await client.get(f"{STORAGE}/export", params={"unused": True})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "text/csv; charset=utf-8"
    assert r.headers["content-disposition"] == (
        'attachment; filename="goat-storage.csv"'
    )
    lines = r.text.strip().splitlines()
    assert lines[0] == "layer,type,owner,projects,updated,size_mb"
    assert [line.split(",")[0] for line in lines[1:]] == ["Parcels 50%", "Table A"]
    assert lines[1:] == [
        "Parcels 50%,polygon,Rep Orter,0,2026-10-02T12:00:00Z,9.0",
        "Table A,table,Ann Other,0,2026-10-01T12:00:00Z,1.0",
    ]
    by_name = await client.get(
        f"{STORAGE}/export", params={"sort": "name", "dir": "asc", "q": "a"}
    )
    assert [line.split(",")[0] for line in by_name.text.strip().splitlines()[1:]] == [
        "Parcels 50%",
        "Roads",
        "Table A",
    ]


async def _spaces(db_session, user: User) -> tuple[UUID, UUID, UUID, UUID]:
    """The spaces of the caller's organization (its own, a team's, the
    caller's personal space) and the space of another organization."""
    team = Team(
        id=uuid4(), name="Team", avatar="", organization_id=user.organization_id
    )
    other = make_organization()
    db_session.add_all([team, other])
    await db_session.flush()
    spaces = (
        await crud_space.ensure_organization(db_session, user.organization_id),
        await crud_space.ensure_team(db_session, team.id),
        await crud_space.ensure_personal(db_session, user.id),
        await crud_space.ensure_organization(db_session, other.id),
    )
    await db_session.commit()
    org_space, team_space, personal_space, other_space = (s.id for s in spaces)
    assert org_space and team_space and personal_space and other_space
    return org_space, team_space, personal_space, other_space


@pytest.mark.asyncio
async def test_storage_holds_the_layers_of_removed_creators_in_its_spaces(
    client, db_session, caller
):
    """A layer whose creator was removed (user_id null) is the organization's
    while it lives in one of its spaces: listed without an owner, in the
    split and the trash. One in another organization's space is not."""
    user, folder = caller
    org_space, team_space, personal_space, other_space = await _spaces(db_session, user)

    def layer(name: str, size: int, space_id: UUID, **fields) -> Layer:
        return Layer(
            user_id=None,
            folder_id=folder.id,
            space_id=space_id,
            name=name,
            size=size * MB,
            type="table",
            updated_at=_at(5),
            **fields,
        )

    db_session.add_all(
        [
            Layer(
                user_id=user.id,
                folder_id=folder.id,
                name="Mine",
                size=MB,
                type="table",
                updated_at=_at(5),
            ),
            layer("In org space", 2, org_space),
            layer("In team space", 3, team_space),
            layer("In personal space", 4, personal_space),
            layer("Binned", 6, org_space, deleted_at=datetime.now(UTC)),
            layer("Foreign", 7, other_space),
        ]
    )
    await db_session.commit()

    r = await client.get(STORAGE, params={"sort": "name", "dir": "asc"})
    assert _names(r) == ["In org space", "In personal space", "In team space", "Mine"]
    body = r.json()
    assert body["total"] == 4
    removed = body["rows"][0]
    assert (removed["owner_id"], removed["owner"]) == (None, None)
    assert round(body["split"]["unused_mb"]) == 1 + 2 + 3 + 4
    assert round(body["split"]["trash_mb"]) == 6 and body["trash"]["count"] == 1
    # The owner filter names a member: a layer without one is not theirs.
    r = await client.get(STORAGE, params={"owner": str(user.id)})
    assert _names(r) == ["Mine"]
    export = await client.get(
        f"{STORAGE}/export", params={"sort": "name", "dir": "asc"}
    )
    assert export.text.strip().splitlines()[1] == (
        "In org space,table,,0,2026-10-05T12:00:00Z,2.0"
    )


@pytest.mark.asyncio
async def test_org_projects_hold_removed_creators_and_count_the_trash(
    client, db_session, caller
):
    """A project whose creator was removed is listed, without an owner, while
    it lives in one of the organization's spaces. `trash` counts the
    organization's projects in the trash, whatever the filters, without the
    template copies."""
    user, folder = caller
    org_space, team_space, _, other_space = await _spaces(db_session, user)
    binned = {"deleted_at": datetime.now(UTC)}

    def project(name: str, user_id: UUID | None, space_id: UUID | None, **fields):
        return Project(
            id=uuid4(),
            user_id=user_id,
            folder_id=folder.id,
            space_id=space_id,
            name=name,
            **fields,
        )

    db_session.add_all(
        [
            project("Mine", user.id, None, updated_at=_at(2)),
            project("Orphaned", None, org_space, updated_at=_at(1)),
            project("Foreign", None, other_space),
            project("Mine binned", user.id, None, **binned),
            project("Team binned", None, team_space, **binned),
            project("Copy binned", user.id, None, is_template_source=True, **binned),
            project("Foreign binned", None, other_space, **binned),
        ]
    )
    await db_session.commit()

    r = await client.get(PROJECTS)
    assert _names(r) == ["Mine", "Orphaned"]
    body = r.json()
    assert body["total"] == 2 and body["trash"] == {"count": 2}
    orphaned = body["rows"][1]
    assert (orphaned["owner_id"], orphaned["owner"]) == (None, None)
    r = await client.get(PROJECTS, params={"q": "Mine", "owner": str(user.id)})
    assert _names(r) == ["Mine"] and r.json()["trash"] == {"count": 2}


async def _recount() -> None:
    """Runs migration 0020's recount on the test schema: every organization's
    used_projects and used_storage from its projects and layers."""
    path = (
        Path(__file__).resolve().parents[2]
        / "alembic"
        / "versions"
        / "0020_project_count.py"
    )
    spec = importlib.util.spec_from_file_location("m0020_lists", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.S = settings.SCHEMA

    def upgrade(connection: sa.Connection) -> None:
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()

    async with session_manager.connect() as connection:
        await connection.run_sync(upgrade)
        await connection.commit()


@pytest.mark.asyncio
async def test_the_recount_makes_the_split_add_up_to_the_storage_tile(
    client, db_session, caller
):
    """After migration 0020 the Storage tile (used_storage) holds the
    organization's layers, trash included, as the split places them: its
    three parts add up to the tile, from a stale count."""
    user, folder = caller
    await _storage_world(db_session, user, folder)
    org_space, team_space, _, other_space = await _spaces(db_session, user)

    def orphan(name: str, size: int, space_id: UUID, **fields) -> Layer:
        return Layer(
            user_id=None,
            folder_id=folder.id,
            space_id=space_id,
            name=name,
            size=size * MB,
            type="table",
            **fields,
        )

    db_session.add_all(
        [
            orphan("Orphan", 2, org_space),
            orphan("Orphan binned", 4, team_space, deleted_at=datetime.now(UTC)),
            orphan("Foreign", 7, other_space),
        ]
    )
    await db_session.commit()
    org = {"o": user.organization_id}
    await db_session.execute(
        text(
            f"UPDATE {settings.SCHEMA}.organization SET used_storage = 999 WHERE id = :o"
        ),
        org,
    )
    await db_session.commit()

    await _recount()

    used = (
        await db_session.execute(
            text(
                f"SELECT used_storage FROM {settings.SCHEMA}.organization WHERE id = :o"
            ),
            org,
        )
    ).scalar_one()
    # Roads 5 and Parcels 9 of the caller, Table A 1 of Ann, Old 3 in the
    # trash, Orphan 2 and Orphan binned 4 of removed creators.
    assert used == pytest.approx(24)
    r = await client.get(STORAGE)
    assert r.status_code == 200, r.text
    assert sum(r.json()["split"].values()) == pytest.approx(used)


@pytest.mark.asyncio
async def test_org_projects_is_for_admins_only(client, db_session, monkeypatch):
    from core.endpoints.v2 import credits

    async def not_admin(db, user_id):
        return False

    monkeypatch.setattr(credits, "_is_admin", not_admin)
    await org_with_default_user(db_session)
    r = await client.get(PROJECTS)
    assert r.status_code == 403
    r = await client.get(f"{STORAGE}/export")
    assert r.status_code == 403
