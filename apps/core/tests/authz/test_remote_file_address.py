"""A raster layer added from a file's address may carry an access key in that
address's query string. Whoever cannot edit the layer, and every public read,
gets the address without its query string and fragment; whoever can edit it
gets it whole. Map services keep their address for everyone: the browser
loads their tiles from it."""

import json
from collections.abc import Awaitable, Callable
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.crud.crud_space import space as crud_space
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.team import Team
from core.db.models.user import User
from goatlib.tools.project_export import ProjectExportRunner, archive_files
from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.test_shareable_links import _bearer, _grant, _write_allowed

S = settings.SCHEMA
API = settings.API_V2_STR

FILE = "https://example.org/a/b.tif?sig=secret#x"
FILE_SHOWN = "https://example.org/a/b.tif"
WMS = (
    "https://maps.example.org/wms?SERVICE=WMS&REQUEST=GetMap&LAYERS=a"
    "&key=service-key&BBOX={bbox-epsg-3857}"
)
XYZ = "https://tiles.example.org/{z}/{x}/{y}.png?api_key=service-key"


async def _raster(
    db: AsyncSession, owner: User, folder: Folder, *, data_type: str, url: str
) -> Layer:
    layer = Layer(
        id=uuid4(),
        user_id=owner.id,
        folder_id=folder.id,
        space_id=(await crud_space.ensure_personal(db, owner.id)).id,
        name=f"{data_type}-{uuid4().hex[:6]}",
        type="raster",
        data_type=data_type,
        url=url,
    )
    db.add(layer)
    await db.flush()
    return layer


class World:
    owner: User
    viewer: User
    editor: User
    project: Project
    cog: Layer
    wms: Layer
    xyz: Layer
    links: dict[UUID, int]


@pytest.fixture
async def world(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
) -> World:
    """A project in its owner's personal space with a remote file, a WMS and
    an XYZ layer of the owner's. `viewer` views the project; `editor` views
    it too and may edit the remote file's dataset."""
    w = World()
    org = await make_org()
    w.owner = await make_user(org.id)
    w.viewer = await make_user(org.id)
    w.editor = await make_user(org.id)
    folder = await make_folder(w.owner)
    w.project = await make_project(w.owner, folder)
    w.cog = await _raster(db_session, w.owner, folder, data_type="cog", url=FILE)
    w.wms = await _raster(db_session, w.owner, folder, data_type="wms", url=WMS)
    w.xyz = await _raster(db_session, w.owner, folder, data_type="xyz", url=XYZ)
    for user in (w.viewer, w.editor):
        await _grant(
            db_session,
            roles,
            rtype="project",
            rid=w.project.id,
            grantee=user.id,
            role_name="project-viewer",
            by=w.owner.id,
        )
    await _grant(
        db_session,
        roles,
        rtype="layer",
        rid=w.cog.id,
        grantee=w.editor.id,
        role_name="layer-editor",
        by=w.owner.id,
    )
    await db_session.commit()

    added = await client.post(
        f"{API}/project/{w.project.id}/layer",
        params={"layer_ids": [str(w.cog.id), str(w.wms.id), str(w.xyz.id)]},
        headers=_bearer(w.owner.id),
    )
    assert added.status_code == 200, added.text
    w.links = {UUID(row["layer_id"]): row["id"] for row in added.json()}

    # The fixture is only worth something if the roles are what they say.
    assert await _write_allowed(db_session, w.cog.id, w.owner.id) is True
    assert await _write_allowed(db_session, w.cog.id, w.editor.id) is True
    assert await _write_allowed(db_session, w.cog.id, w.viewer.id) is False
    return w


def _urls(rows: list[dict[str, Any]]) -> dict[str, str | None]:
    return {row["layer_id"]: row.get("url") for row in rows}


async def _get(client: AsyncClient, path: str, user: User | None = None) -> Response:
    response = await client.get(
        f"{API}/{path}", headers=_bearer(user.id) if user else {}
    )
    assert response.status_code == 200, response.text
    return response


async def _publish(client: AsyncClient, w: World) -> Response:
    response = await client.post(
        f"{API}/project/{w.project.id}/publish", headers=_bearer(w.owner.id)
    )
    assert response.status_code == 200, response.text
    return response


@pytest.mark.asyncio
async def test_a_project_viewer_gets_the_files_address_without_its_query(
    client: AsyncClient, world: World
) -> None:
    w = world
    listed = _urls(
        (await _get(client, f"project/{w.project.id}/layer", w.viewer)).json()
    )
    assert listed[str(w.cog.id)] == FILE_SHOWN

    one = await _get(
        client, f"project/{w.project.id}/layer/{w.links[w.cog.id]}", w.viewer
    )
    assert one.json()["url"] == FILE_SHOWN

    dataset = await _get(client, f"layer/{w.cog.id}", w.viewer)
    assert dataset.json()["url"] == FILE_SHOWN


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["owner", "editor"])
async def test_whoever_can_edit_the_dataset_gets_the_address_whole(
    client: AsyncClient, world: World, who: str
) -> None:
    w = world
    user = getattr(w, who)
    listed = _urls((await _get(client, f"project/{w.project.id}/layer", user)).json())
    assert listed[str(w.cog.id)] == FILE

    one = await _get(client, f"project/{w.project.id}/layer/{w.links[w.cog.id]}", user)
    assert one.json()["url"] == FILE

    dataset = await _get(client, f"layer/{w.cog.id}", user)
    assert dataset.json()["url"] == FILE


@pytest.mark.asyncio
async def test_a_viewer_of_the_dataset_adding_it_to_their_project_gets_it_shortened(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
    world: World,
) -> None:
    """Editing the project is not editing the dataset: the answers to adding
    the layer and to renaming its entry are built by the read path, so they
    are shortened like the read."""
    w = world
    await _grant(
        db_session,
        roles,
        rtype="layer",
        rid=w.cog.id,
        grantee=w.viewer.id,
        role_name="layer-viewer",
        by=w.owner.id,
    )
    own = await make_project(w.viewer, await make_folder(w.viewer))
    await db_session.commit()

    added = await client.post(
        f"{API}/project/{own.id}/layer",
        params={"layer_ids": [str(w.cog.id)]},
        headers=_bearer(w.viewer.id),
    )
    assert added.status_code == 200, added.text
    assert added.json()[0]["url"] == FILE_SHOWN
    assert await _write_allowed(db_session, w.cog.id, w.viewer.id) is False

    saved = await client.put(
        f"{API}/project/{own.id}/layer/{added.json()[0]['id']}",
        json={"name": "Renamed"},
        headers=_bearer(w.viewer.id),
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["url"] == FILE_SHOWN


@pytest.mark.asyncio
async def test_a_layer_listing_shortens_the_files_address_for_a_viewer(
    client: AsyncClient, db_session: AsyncSession, roles: dict[str, UUID], world: World
) -> None:
    """The dataset listing of an organization shows what is shared with it,
    which its members may only view."""
    w = world
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('layer', :l, 'organization', :o, :r, :by)"
        ),
        {
            "l": w.cog.id,
            "o": w.viewer.organization_id,
            "r": roles["layer-viewer"],
            "by": w.owner.id,
        },
    )
    await db_session.commit()
    response = await client.post(
        f"{API}/layer",
        params={"organization_id": str(w.viewer.organization_id)},
        json={},
        headers=_bearer(w.viewer.id),
    )
    assert response.status_code == 200, response.text
    urls = {item["id"]: item.get("url") for item in response.json()["items"]}
    assert urls[str(w.cog.id)] == FILE_SHOWN

    own = await client.post(f"{API}/layer", json={}, headers=_bearer(w.owner.id))
    assert own.status_code == 200, own.text
    urls = {item["id"]: item.get("url") for item in own.json()["items"]}
    assert urls[str(w.cog.id)] == FILE


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["viewer", "owner"])
async def test_map_services_keep_their_address_for_everyone(
    client: AsyncClient, world: World, who: str
) -> None:
    w = world
    user = getattr(w, who)
    listed = _urls((await _get(client, f"project/{w.project.id}/layer", user)).json())
    assert listed[str(w.wms.id)] == WMS
    assert listed[str(w.xyz.id)] == XYZ
    assert (await _get(client, f"layer/{w.wms.id}", user)).json()["url"] == WMS
    assert (await _get(client, f"layer/{w.xyz.id}", user)).json()["url"] == XYZ


@pytest.mark.asyncio
async def test_a_snapshot_published_now_stores_and_serves_the_shortened_address(
    client: AsyncClient, db_session: AsyncSession, world: World
) -> None:
    w = world
    published = _urls((await _publish(client, w)).json()["config"]["layers"])
    assert published[str(w.cog.id)] == FILE_SHOWN

    stored = (
        await db_session.execute(
            text(f"SELECT config FROM {S}.project_public WHERE project_id = :p"),
            {"p": w.project.id},
        )
    ).scalar_one()
    assert _urls(stored["layers"])[str(w.cog.id)] == FILE_SHOWN

    public = await _get(client, f"project/{w.project.id}/public")
    urls = _urls(public.json()["config"]["layers"])
    assert urls[str(w.cog.id)] == FILE_SHOWN
    assert urls[str(w.wms.id)] == WMS
    assert urls[str(w.xyz.id)] == XYZ


async def _store_full_addresses(db: AsyncSession, w: World) -> None:
    """The snapshot as a publish before this rule stored it: the file's
    address whole."""
    config = (
        await db.execute(
            text(f"SELECT config FROM {S}.project_public WHERE project_id = :p"),
            {"p": w.project.id},
        )
    ).scalar_one()
    for row in config["layers"]:
        if row["layer_id"] == str(w.cog.id):
            row["url"] = FILE
    await db.execute(
        text(
            f"UPDATE {S}.project_public SET config = CAST(:c AS jsonb) "
            "WHERE project_id = :p"
        ),
        {"c": json.dumps(config), "p": w.project.id},
    )
    await db.commit()


@pytest.mark.asyncio
async def test_a_snapshot_published_before_is_served_with_the_shortened_address(
    client: AsyncClient, db_session: AsyncSession, world: World
) -> None:
    w = world
    await _publish(client, w)
    await _store_full_addresses(db_session, w)

    public = await _get(client, f"project/{w.project.id}/public")
    urls = _urls(public.json()["config"]["layers"])
    assert urls[str(w.cog.id)] == FILE_SHOWN
    assert urls[str(w.wms.id)] == WMS
    assert urls[str(w.xyz.id)] == XYZ

    # The settings routes of a published project answer with the stored
    # snapshot too.
    tracking = await client.put(
        f"{API}/project/{w.project.id}/public/tracking",
        json={"require_consent": True},
        headers=_bearer(w.owner.id),
    )
    assert tracking.status_code == 200, tracking.text
    assert _urls(tracking.json()["config"]["layers"])[str(w.cog.id)] == FILE_SHOWN


@pytest.mark.asyncio
async def test_no_viewer_or_anonymous_answer_carries_the_files_secret(
    client: AsyncClient, db_session: AsyncSession, world: World
) -> None:
    """Every answer a viewer or an anonymous caller gets, searched whole."""
    w = world
    answers = [
        await _get(client, f"project/{w.project.id}/layer", w.viewer),
        await _get(
            client, f"project/{w.project.id}/layer/{w.links[w.cog.id]}", w.viewer
        ),
        await _get(client, f"layer/{w.cog.id}", w.viewer),
        await _get(client, f"project/{w.project.id}/map", w.viewer),
    ]
    await _publish(client, w)
    answers.append(await _get(client, f"project/{w.project.id}/public"))
    await _store_full_addresses(db_session, w)
    answers.append(await _get(client, f"project/{w.project.id}/public"))

    for answer in answers:
        assert "secret" not in answer.text, answer.request.url
    # The owner's answer does carry it: the search above would find it.
    owner = await _get(client, f"project/{w.project.id}/layer", w.owner)
    assert "secret" in owner.text


async def _export(user: User, project_id: UUID) -> dict[str, Any]:
    """The archive's JSON files of a project export run by `user`: goatlib's
    export tool, reading this schema with core's real authorization
    functions."""
    assert settings.ASYNC_SQLALCHEMY_DATABASE_URI is not None
    url = make_url(settings.ASYNC_SQLALCHEMY_DATABASE_URI)
    runner = ProjectExportRunner()
    runner.settings = SimpleNamespace(  # type: ignore[assignment]
        customer_schema=S,
        postgres_connect_args=lambda: {
            "host": url.host,
            "port": url.port,
            "user": url.username,
            "password": url.password,
            "database": url.database,
        },
    )
    metadata = await runner._gather_metadata(str(project_id), str(user.id))
    return archive_files(metadata)


@pytest.mark.asyncio
async def test_a_project_export_holds_the_address_the_exporter_may_see(
    world: World,
) -> None:
    """Whoever may read a project may export it. The archive holds a remote
    file's address whole only for whoever may edit that layer."""
    w = world

    def urls(files: dict[str, Any]) -> dict[str, str | None]:
        return {
            layer["id"]: layer["url"] for layer in files["layers/index.json"]["layers"]
        }

    read = await _export(w.viewer, w.project.id)
    assert urls(read)[str(w.cog.id)] == FILE_SHOWN
    assert read[f"layers/{w.cog.id}/metadata.json"]["url"] == FILE_SHOWN
    assert urls(read)[str(w.wms.id)] == WMS
    assert urls(read)[str(w.xyz.id)] == XYZ
    assert "secret" not in json.dumps(read, default=str)

    for editor in (w.owner, w.editor):
        assert urls(await _export(editor, w.project.id))[str(w.cog.id)] == FILE


async def _team_grant(
    db: AsyncSession,
    roles: dict[str, UUID],
    *,
    rtype: str,
    rid: UUID,
    team: Team,
    role_name: str,
    by: UUID,
) -> None:
    await db.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES (:t, :r, 'team', :g, :role, :by)"
        ),
        {"t": rtype, "r": rid, "g": team.id, "role": roles[role_name], "by": by},
    )


@pytest.mark.asyncio
async def test_the_edit_right_through_a_team_gets_the_address_whole(
    client: AsyncClient,
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    world: World,
) -> None:
    """A team the dataset is shared with as editor: its member gets the
    address whole. A team it is shared with as viewer: its member gets it
    shortened."""
    w = world
    team_editor = await make_user(w.owner.organization_id)
    team_viewer = await make_user(w.owner.organization_id)
    for member, layer_role in (
        (team_editor, "layer-editor"),
        (team_viewer, "layer-viewer"),
    ):
        team = await make_team(member)
        for rtype, rid, role_name in (
            ("project", w.project.id, "project-viewer"),
            ("layer", w.cog.id, layer_role),
        ):
            await _team_grant(
                db_session,
                roles,
                rtype=rtype,
                rid=rid,
                team=team,
                role_name=role_name,
                by=w.owner.id,
            )
    await db_session.commit()
    assert await _write_allowed(db_session, w.cog.id, team_editor.id) is True
    assert await _write_allowed(db_session, w.cog.id, team_viewer.id) is False

    for user, expected in ((team_editor, FILE), (team_viewer, FILE_SHOWN)):
        listed = _urls(
            (await _get(client, f"project/{w.project.id}/layer", user)).json()
        )
        assert listed[str(w.cog.id)] == expected
        dataset = await _get(client, f"layer/{w.cog.id}", user)
        assert dataset.json()["url"] == expected
