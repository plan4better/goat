"""Template datasets in "copy" mode: every user gets their own editable copy.

Saving: a copy input is validated and stored like a shipped one (the author
must read it, it must have a table to copy), keeps its choice across a
refresh, and is shared with the template's grantees. Using: the project or
workflow is made as before, and one `layer_copy` job per copied dataset is
started through the processes service (mocked here), its id returned in
`copy_jobs`. The job's database side is goatlib's
(`goatlib.tools.layer_copy`), run here against this schema with the
DuckLake table copy stubbed out (that half is tested in goatlib against a
real DuckDB): afterwards the user writes their copy and not the source,
dashboards and workflows follow the entry, and the author's later edits to
the source stay out of the copy.
"""

import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import asyncpg
import pytest
import pytest_asyncio
from core.core.config import settings
from core.crud import crud_template as crud_template_module
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.user import User
from fastapi import HTTPException
from goatlib.tools.layer_copy import (
    COPY_STAMP,
    LayerCopyOutput,
    LayerCopyParams,
    LayerCopyRunner,
)
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.test_content_feed import _unverified_bearer
from tests.authz.test_template_api import (
    _create_project,
    _create_workflow,
    _dataset_workflow_config,
)

S = settings.SCHEMA
API = settings.API_V2_STR
EXTENT = "POLYGON((7 50, 8 50, 8 51, 7 51, 7 50))"

MakeLayer = Callable[..., Awaitable[Layer]]
MakeUser = Callable[..., Awaitable[User]]
MakeFolder = Callable[..., Awaitable[Folder]]


async def _connect() -> asyncpg.Connection:
    assert settings.ASYNC_SQLALCHEMY_DATABASE_URI is not None
    url = make_url(settings.ASYNC_SQLALCHEMY_DATABASE_URI)
    return await asyncpg.connect(
        host=url.host,
        port=url.port,
        user=url.username,
        password=url.password,
        database=url.database,
    )


@pytest_asyncio.fixture
async def processes() -> AsyncIterator[AsyncMock]:
    """The processes service: every submitted job gets an id `job-<n>`."""
    counter = iter(range(1, 1000))

    async def submit(**kwargs: Any) -> str:
        return f"job-{next(counter)}"

    mock = AsyncMock(side_effect=submit)
    with patch.object(crud_template_module, "execute_process", new=mock):
        yield mock


async def _run_copy_job(
    job_inputs: dict[str, Any],
    user_id: UUID,
    *,
    feature_count: int = 3,
    copy_error: Exception | None = None,
) -> LayerCopyOutput:
    """Run the job the way a worker would, with the inputs core submitted
    and the caller processes injects — minus the DuckLake table."""
    runner = LayerCopyRunner()
    runner.settings = MagicMock(customer_schema=S, pmtiles_enabled=False)
    info = {
        "feature_count": feature_count,
        "geometry_type": "POINT" if feature_count else None,
        "geometry_column": "geometry",
        "extent_wkt": EXTENT if feature_count else None,
    }
    with (
        patch.object(runner, "_connect", new=_connect),
        patch.object(
            runner,
            "_copy_table",
            side_effect=copy_error if copy_error is not None else (lambda *a: info),
        ),
        patch.object(runner, "_drop_table") as drop,
        patch.object(runner, "_generate_pmtiles"),
        patch.object(runner, "get_job_id", return_value=None),
    ):
        try:
            return await runner.copy(
                LayerCopyParams(user_id=str(user_id), **job_inputs)
            )
        finally:
            runner.dropped = drop.call_args_list  # type: ignore[attr-defined]


async def _rich_layer(
    db: AsyncSession, make_layer: MakeLayer, owner: User, folder: Folder, name: str
) -> Layer:
    """A layer with everything a copy has to carry over."""
    layer = await make_layer(owner, folder)
    await db.execute(
        text(
            f"""
            UPDATE {S}.layer SET
                name = :name,
                description = 'Planned projects, one row each',
                tags = ARRAY['bonn', 'planning'],
                feature_layer_geometry_type = 'point',
                size = 2048,
                properties = CAST(:props AS jsonb),
                field_config = CAST(:fields AS jsonb),
                other_properties = CAST(:other AS jsonb),
                extent = ST_Multi(ST_GeomFromText(:extent, 4326))
            WHERE id = :id
            """
        ),
        {
            "id": layer.id,
            "name": name,
            "props": json.dumps({"color": [200, 0, 0], "filled": True}),
            "fields": json.dumps(
                {"status": {"type": "dropdown", "options": ["geplant", "im Bau"]}}
            ),
            "other": json.dumps({"workflow_export": {"workflow_id": "w-1"}}),
            "extent": EXTENT,
        },
    )
    return layer


async def _links(db: AsyncSession, project_id: str | UUID) -> dict[UUID, list[int]]:
    rows = (
        await db.execute(
            text(
                f"SELECT id, layer_id FROM {S}.layer_project "
                "WHERE project_id = :p ORDER BY id"
            ),
            {"p": str(project_id)},
        )
    ).all()
    out: dict[UUID, list[int]] = {}
    for row in rows:
        out.setdefault(row.layer_id, []).append(row.id)
    return out


async def _add_layers(client: AsyncClient, project_id: str, *layer_ids: UUID) -> None:
    resp = await client.post(
        f"{API}/project/{project_id}/layer",
        params=[("layer_ids", str(layer_id)) for layer_id in layer_ids],
    )
    assert resp.status_code == 200, resp.text


async def _copy_stamp(db: AsyncSession, link_id: int) -> dict[str, Any] | None:
    stamp = (
        await db.execute(
            text(
                f"SELECT other_properties -> '{COPY_STAMP}' FROM {S}.layer_project "
                "WHERE id = :id"
            ),
            {"id": link_id},
        )
    ).scalar_one()
    return stamp if isinstance(stamp, dict) else None


async def _workflow_nodes(db: AsyncSession, project_id: str | UUID) -> dict[str, Any]:
    configs = (
        await db.execute(
            text(
                f"SELECT config FROM {S}.workflow WHERE project_id = :p ORDER BY created_at"
            ),
            {"p": str(project_id)},
        )
    ).scalars()
    return {n["id"]: n["data"] for config in configs for n in config["nodes"]}


def _legacy_node(node_id: str, layer_id: UUID) -> dict[str, Any]:
    """A dataset node saved with `layerId` only, the shape of most nodes in
    the Bonn projects (e.g. "Vorhaben (Eingabe)" in "Prüfroutine (mehrere
    Vorhaben)"): no `projectLayerId`, `layerType: "layer"`."""
    return {
        "id": node_id,
        "type": "dataset",
        "position": {"x": -2991.9, "y": 94.8},
        "data": {
            "type": "dataset",
            "label": "Vorhaben (Eingabe)",
            "layerId": str(layer_id),
            "layerName": "Vorhaben (Eingabe)",
            "layerType": "layer",
            "geometryType": "point",
            "filterInitialized": True,
        },
    }


def _tool_node(node_id: str, layer_id: UUID) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": "tool",
        "position": {"x": 0, "y": 0},
        "data": {
            "type": "tool",
            "processId": "buffer",
            "config": {"input_layer_id": str(layer_id), "distances": [500]},
        },
    }


async def _write_allowed(db: AsyncSession, layer_id: UUID | str, user_id: UUID) -> bool:
    return bool(
        (
            await db.execute(
                text(f"SELECT {S}.layer_write_allowed(:l, :u)"),
                {"l": str(layer_id), "u": user_id},
            )
        ).scalar()
    )


async def _project_template(
    client: AsyncClient,
    home: str,
    project_id: str,
    inputs: list[dict[str, Any]],
    name: str = "Bonn training",
) -> Any:
    return await client.post(
        f"{API}/template",
        json={
            "name": name,
            "folder_id": home,
            "source": {"kind": "project", "project_id": project_id},
            "inputs": inputs,
        },
    )


def _choice(layer: Layer, mode: str, *, copy_content: bool = True) -> dict[str, Any]:
    return {
        "key": f"layer:{layer.id}",
        "label": layer.name,
        "mode": mode,
        "copy_content": copy_content,
        "layer_id": str(layer.id),
    }


async def _setup(
    client: AsyncClient,
    db: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
) -> tuple[User, Folder, str]:
    home = str(fixture_get_home_folder["id"])
    owner = await db.get(User, fixture_create_user)
    folder = await db.get(Folder, UUID(home))
    assert owner is not None and folder is not None
    return owner, folder, home


# ----------------------------------------------------------------------------
# Saving
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_project_template_stores_each_datasets_ship_or_copy_choice(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await _rich_layer(
        db_session, make_layer, owner, folder, "Vorhaben (Eingabe)"
    )
    housing = await _rich_layer(
        db_session, make_layer, owner, folder, "Neuer Wohnungsbau"
    )
    districts = await make_layer(owner, folder)
    await db_session.commit()
    project_id = await _create_project(client, home, name="bonn")
    await _add_layers(client, project_id, planned.id, housing.id, districts.id)

    resp = await _project_template(
        client,
        home,
        project_id,
        [
            _choice(planned, "copy", copy_content=False),
            _choice(housing, "copy"),
            # The save dialog's cleared share checkbox: read as "ship".
            _choice(districts, "ask"),
        ],
    )

    assert resp.status_code == 201, resp.text
    by_key = {i["key"]: i for i in resp.json()["inputs"]}
    assert by_key[f"layer:{planned.id}"]["mode"] == "copy"
    assert by_key[f"layer:{planned.id}"]["copy_content"] is False
    assert by_key[f"layer:{housing.id}"]["mode"] == "copy"
    assert by_key[f"layer:{housing.id}"]["copy_content"] is True
    assert by_key[f"layer:{districts.id}"]["mode"] == "ship"
    assert by_key[f"layer:{districts.id}"]["layer_id"] == str(districts.id)


@pytest.mark.asyncio
async def test_a_project_template_saved_without_choices_ships_everything(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    """Regression: a client that sends no inputs saves what it always did,
    and using the template starts no job."""
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    layer = await make_layer(owner, folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, layer.id)

    resp = await _project_template(client, home, project_id, [])
    assert resp.status_code == 201, resp.text
    (shipped,) = resp.json()["inputs"]
    assert shipped["mode"] == "ship"

    use = await client.post(
        f"{API}/template/{resp.json()['id']}/use", json={"target_folder_id": home}
    )
    assert use.status_code == 200, use.text
    assert use.json()["copy_jobs"] == []
    processes.assert_not_awaited()
    links = await _links(db_session, use.json()["project_id"])
    assert list(links) == [layer.id]


@pytest.mark.asyncio
async def test_choices_for_datasets_the_project_does_not_have_are_refused_before_anything_is_written(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    layer = await make_layer(owner, folder)
    elsewhere = await make_layer(owner, folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, layer.id)
    frozen_before = (
        await db_session.execute(
            text(f"SELECT COUNT(*) FROM {S}.project WHERE is_template_source")
        )
    ).scalar_one()

    resp = await _project_template(
        client, home, project_id, [_choice(elsewhere, "copy")]
    )

    assert resp.status_code == 422, resp.text
    frozen_after = (
        await db_session.execute(
            text(f"SELECT COUNT(*) FROM {S}.project WHERE is_template_source")
        )
    ).scalar_one()
    # The engine autocommits: a refusal after the frozen copy would leave one.
    assert frozen_after == frozen_before


@pytest.mark.asyncio
async def test_a_dataset_without_a_table_cannot_be_copied(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    wfs = await make_layer(owner, folder)
    await db_session.execute(
        text(f"UPDATE {S}.layer SET data_type = 'wfs' WHERE id = :id"), {"id": wfs.id}
    )
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, wfs.id)

    resp = await _project_template(client, home, project_id, [_choice(wfs, "copy")])

    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == {
        "code": "template_input_not_copyable",
        "layer_id": str(wfs.id),
    }
    # Shipping it stays possible.
    ok = await _project_template(client, home, project_id, [_choice(wfs, "ship")])
    assert ok.status_code == 201, ok.text


@pytest.mark.asyncio
async def test_a_workflow_copy_input_is_stored_and_frozen_like_a_shipped_one(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    layer = await make_layer(owner, folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )

    resp = await client.post(
        f"{API}/template",
        json={
            "name": "Copy workflow",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "copy",
                    "copy_content": False,
                    "layer_id": str(layer.id),
                }
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    (stored,) = resp.json()["inputs"]
    assert (stored["mode"], stored["copy_content"]) == ("copy", False)
    assert stored["layer_id"] == str(layer.id)

    config = (
        await db_session.execute(
            text(f"SELECT config FROM {S}.template WHERE id = :t"),
            {"t": resp.json()["id"]},
        )
    ).scalar_one()
    node = config["nodes"][0]["data"]
    assert node["layerId"] == str(layer.id)
    assert node["templateInput"] == "node:dataset-1"
    assert "unresolved" not in node

    # A copy input naming another layer than the node is refused, like ship.
    other = await make_layer(owner, folder)
    await db_session.commit()
    bad = await client.post(
        f"{API}/template",
        json={
            "name": "Mismatch",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "copy",
                    "layer_id": str(other.id),
                }
            ],
        },
    )
    assert bad.status_code == 422, bad.text


@pytest.mark.asyncio
async def test_a_dataset_the_author_cannot_read_cannot_be_copied(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    make_user: MakeUser,
    make_folder: MakeFolder,
    roles: dict[str, UUID],
) -> None:
    _, _, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    stranger = await make_user()
    theirs = await make_layer(stranger, await make_folder(stranger))
    await db_session.commit()
    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(theirs.id)
    )

    resp = await client.post(
        f"{API}/template",
        json={
            "name": "Not mine",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "copy",
                    "layer_id": str(theirs.id),
                }
            ],
        },
    )

    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "template_input_not_readable"


@pytest.mark.asyncio
async def test_refresh_keeps_each_inputs_copy_choice(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await make_layer(owner, folder)
    districts = await make_layer(owner, folder)
    added_later = await make_layer(owner, folder)
    await db_session.commit()

    # Project payload.
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, planned.id, districts.id)
    project_template = await _project_template(
        client, home, project_id, [_choice(planned, "copy", copy_content=False)]
    )
    assert project_template.status_code == 201, project_template.text
    await _add_layers(client, project_id, added_later.id)
    refreshed = await client.post(
        f"{API}/template/{project_template.json()['id']}/refresh"
    )
    assert refreshed.status_code == 200, refreshed.text
    by_key = {i["key"]: i for i in refreshed.json()["inputs"]}
    assert (
        by_key[f"layer:{planned.id}"]["mode"],
        by_key[f"layer:{planned.id}"]["copy_content"],
    ) == ("copy", False)
    assert by_key[f"layer:{districts.id}"]["mode"] == "ship"
    # A dataset added since ships, as on a first save.
    assert by_key[f"layer:{added_later.id}"]["mode"] == "ship"

    # Workflow payload.
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(planned.id)
    )
    workflow_template = await client.post(
        f"{API}/template",
        json={
            "name": "Copy workflow",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "copy",
                    "copy_content": True,
                    "layer_id": str(planned.id),
                }
            ],
        },
    )
    assert workflow_template.status_code == 201, workflow_template.text
    refreshed = await client.post(
        f"{API}/template/{workflow_template.json()['id']}/refresh"
    )
    assert refreshed.status_code == 200, refreshed.text
    (kept,) = refreshed.json()["inputs"]
    assert (kept["mode"], kept["copy_content"], kept["layer_id"]) == (
        "copy",
        True,
        str(planned.id),
    )


@pytest.mark.asyncio
async def test_a_template_grant_lets_the_grantee_read_the_datasets_it_copies(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    make_user: MakeUser,
    roles: dict[str, UUID],
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await make_layer(owner, folder)
    stranger = await make_user()
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, planned.id)
    template = await _project_template(
        client, home, project_id, [_choice(planned, "copy")]
    )
    assert template.status_code == 201, template.text

    grant = await client.post(
        f"{API}/template/{template.json()['id']}/grant",
        json={
            "grantee_type": "user",
            "grantee_id": str(stranger.id),
            "role": "template-viewer",
        },
    )

    assert grant.status_code in (200, 201), grant.text
    readable = (
        await db_session.execute(
            text(f"SELECT {S}.can('layer', :l, :u, 'read')"),
            {"l": planned.id, "u": stranger.id},
        )
    ).scalar()
    assert readable is True
    # Read, never write: the grantee edits their copy, not the author's data.
    assert await _write_allowed(db_session, planned.id, stranger.id) is False


@pytest.mark.asyncio
async def test_a_template_grant_gives_no_read_of_a_dataset_copied_empty(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    make_user: MakeUser,
    roles: dict[str, UUID],
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await make_layer(owner, folder)
    stranger = await make_user()
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, planned.id)
    template = await _project_template(
        client, home, project_id, [_choice(planned, "copy", copy_content=False)]
    )
    assert template.status_code == 201, template.text

    grant = await client.post(
        f"{API}/template/{template.json()['id']}/grant",
        json={
            "grantee_type": "user",
            "grantee_id": str(stranger.id),
            "role": "template-viewer",
        },
    )

    assert grant.status_code in (200, 201), grant.text
    readable = (
        await db_session.execute(
            text(f"SELECT {S}.can('layer', :l, :u, 'read')"),
            {"l": planned.id, "u": stranger.id},
        )
    ).scalar()
    assert readable is False


@pytest.mark.asyncio
@pytest.mark.parametrize("copy_content", [True, False])
async def test_publishing_makes_a_dataset_copied_with_its_rows_public(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
    copy_content: bool,
) -> None:
    """A copy with its rows is read from the author's dataset, so it becomes
    public like a shipped one. An empty copy only takes the structure, made
    on the template's behalf: the author's rows stay private."""
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await make_layer(owner, folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, planned.id)
    template = await _project_template(
        client, home, project_id, [_choice(planned, "copy", copy_content=copy_content)]
    )
    assert template.status_code == 201, template.text

    published = await client.post(f"{API}/template/{template.json()['id']}/publish")

    assert published.status_code == 200, published.text
    (copied,) = published.json()["inputs"]
    assert copied["mode"] == "copy"
    assert copied["public_read"] is copy_content
    assert published.json()["ships_data"] is copy_content
    public = (
        await db_session.execute(
            text(f"SELECT public_read FROM {S}.layer WHERE id = :l"), {"l": planned.id}
        )
    ).scalar()
    assert public is copy_content


# ----------------------------------------------------------------------------
# Using
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_using_a_project_template_starts_one_copy_job_per_copied_dataset(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await make_layer(owner, folder)
    housing = await make_layer(owner, folder)
    districts = await make_layer(owner, folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, planned.id, housing.id, districts.id)
    # The planning layer a second time, in another styling: both entries
    # get the one copy.
    await db_session.execute(
        text(
            f"INSERT INTO {S}.layer_project "
            '(layer_id, project_id, name, "order", updated_at) '
            "VALUES (:l, :p, 'Vorhaben (Kopie)', 9, now())"
        ),
        {"l": planned.id, "p": project_id},
    )
    # Move the first entry out and back: updating an indexed column stores it
    # behind the second entry, as rows end up after other writes. Copying the
    # project must still keep it first.
    elsewhere = await _create_project(client, home)
    for source, target in ((project_id, elsewhere), (elsewhere, project_id)):
        await db_session.execute(
            text(
                f"UPDATE {S}.layer_project SET project_id = :target "
                "WHERE layer_id = :l AND project_id = :source "
                "AND name <> 'Vorhaben (Kopie)'"
            ),
            {"l": planned.id, "source": source, "target": target},
        )
    await db_session.commit()
    template = await _project_template(
        client,
        home,
        project_id,
        [_choice(planned, "copy", copy_content=False), _choice(housing, "copy")],
    )
    tid = template.json()["id"]
    token = _unverified_bearer(owner.id)

    use = await client.post(
        f"{API}/template/{tid}/use",
        json={"target_folder_id": home, "name": "My training"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert use.status_code == 200, use.text
    body = use.json()
    links = await _links(db_session, body["project_id"])
    jobs = {job["source_layer_id"]: job for job in body["copy_jobs"]}
    assert set(jobs) == {str(planned.id), str(housing.id)}
    assert jobs[str(planned.id)]["layer_project_ids"] == links[planned.id]
    assert len(links[planned.id]) == 2
    assert jobs[str(planned.id)]["copy_content"] is False
    assert jobs[str(housing.id)]["copy_content"] is True
    assert {job["job_id"] for job in body["copy_jobs"]} == {"job-1", "job-2"}
    assert all(job["error"] is None for job in body["copy_jobs"])

    assert processes.await_count == 2
    submitted = {
        call.kwargs["inputs"]["source_layer_id"]: call.kwargs
        for call in processes.await_args_list
    }
    planned_call = submitted[str(planned.id)]
    assert planned_call["process_id"] == "layer_copy"
    assert planned_call["access_token"] == token
    assert planned_call["inputs"] == {
        "source_layer_id": str(planned.id),
        "project_id": body["project_id"],
        "layer_project_ids": links[planned.id],
        "copy_content": False,
        "template_id": tid,
        # What the job list calls the job: "Copy: <entry>".
        "layer_name": planned.name,
    }
    # Until the job ran, the entries show the author's dataset (read-only),
    # and say a copy is on its way.
    assert planned.id in links and districts.id in links
    for link_id in links[planned.id]:
        stamp = await _copy_stamp(db_session, link_id)
        assert stamp == {
            "source_layer_id": str(planned.id),
            "template_id": tid,
            "copy_content": False,
            "status": "pending",
        }
    assert await _copy_stamp(db_session, links[districts.id][0]) is None


@pytest.mark.asyncio
async def test_a_workflow_copy_input_gets_its_own_entry_and_a_job(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    """The project the workflow lands in already shows the dataset: that
    entry keeps showing it, and the copy gets an entry of its own."""
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    layer = await make_layer(owner, folder)
    await db_session.commit()
    source_project = await _create_project(client, home, name="source")
    workflow_id = await _create_workflow(
        client, source_project, _dataset_workflow_config(layer.id)
    )
    template = await client.post(
        f"{API}/template",
        json={
            "name": "Copy workflow",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": source_project,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "copy",
                    "layer_id": str(layer.id),
                }
            ],
        },
    )
    tid = template.json()["id"]
    target = await _create_project(client, home, name="target")
    await _add_layers(client, target, layer.id)
    (existing_link,) = (await _links(db_session, target))[layer.id]

    use = await client.post(f"{API}/template/{tid}/use", json={"project_id": target})

    assert use.status_code == 200, use.text
    body = use.json()
    (job,) = body["copy_jobs"]
    (new_link,) = body["added_layer_project_ids"]
    assert new_link != existing_link
    assert job["layer_project_ids"] == [new_link]
    assert job["job_id"] == "job-1"
    assert sorted((await _links(db_session, target))[layer.id]) == sorted(
        [existing_link, new_link]
    )
    wf = await client.get(f"{API}/project/{target}/workflow/{body['workflow_id']}")
    node = wf.json()["config"]["nodes"][0]["data"]
    assert node["projectLayerId"] == new_link
    assert node["layerId"] == str(layer.id)

    # Binding the caller's own layer instead: nothing to copy.
    own = await make_layer(owner, folder)
    await db_session.commit()
    bound = await client.post(
        f"{API}/template/{tid}/use",
        json={"project_id": target, "bindings": {"node:dataset-1": str(own.id)}},
    )
    assert bound.status_code == 200, bound.text
    assert bound.json()["copy_jobs"] == []
    assert processes.await_count == 1


@pytest.mark.asyncio
async def test_a_copy_that_cannot_start_leaves_the_entry_on_the_source(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await make_layer(owner, folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, planned.id)
    template = await _project_template(
        client, home, project_id, [_choice(planned, "copy")]
    )

    refused = AsyncMock(side_effect=HTTPException(status_code=503, detail="down"))
    with patch.object(crud_template_module, "execute_process", new=refused):
        use = await client.post(
            f"{API}/template/{template.json()['id']}/use",
            json={"target_folder_id": home},
        )

    assert use.status_code == 200, use.text
    (job,) = use.json()["copy_jobs"]
    assert job["job_id"] is None
    assert job["error"] == "copy_not_started"
    links = await _links(db_session, use.json()["project_id"])
    assert list(links) == [planned.id]
    # The entry says its copy never started, so the project can offer it again.
    stamp = await _copy_stamp(db_session, links[planned.id][0])
    assert stamp is not None
    assert (stamp["status"], stamp["error"]) == ("failed", "copy_not_started")


@pytest.mark.asyncio
async def test_a_dataset_the_user_cannot_read_is_not_copied(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    make_user: MakeUser,
    make_folder: MakeFolder,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    """A template whose dataset its author may only view, so the template
    cannot pass it on (rule 6c): the frozen copy links the dataset anyway,
    but no job starts."""
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    lender = await make_user()
    planned = await make_layer(lender, await make_folder(lender))
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('layer', :l, 'user', :u, :r, :b)"
        ),
        {"l": planned.id, "u": owner.id, "r": roles["layer-viewer"], "b": lender.id},
    )
    stranger = await make_user()
    stranger_folder = await make_folder(stranger)
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, planned.id)
    template = await _project_template(
        client, home, project_id, [_choice(planned, "copy")]
    )
    tid = template.json()["id"]
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('template', :t, 'user', :u, :r, :b)"
        ),
        {
            "t": UUID(tid),
            "u": stranger.id,
            "r": roles["template-viewer"],
            "b": owner.id,
        },
    )
    await db_session.commit()

    use = await client.post(
        f"{API}/template/{tid}/use",
        json={"target_folder_id": str(stranger_folder.id)},
        headers={"Authorization": f"Bearer {_unverified_bearer(stranger.id)}"},
    )

    assert use.status_code == 200, use.text
    (job,) = use.json()["copy_jobs"]
    assert (job["job_id"], job["error"]) == (None, "source_not_readable")
    processes.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_empty_copy_starts_although_the_user_cannot_read_the_dataset(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    make_user: MakeUser,
    make_folder: MakeFolder,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    """Only the template has to be readable: the job is started for the
    template (processes checks the template has this "copy, empty" input),
    and the author's dataset stays unreadable to the user."""
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await make_layer(owner, folder)
    stranger = await make_user()
    stranger_folder = await make_folder(stranger)
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, planned.id)
    template = await _project_template(
        client, home, project_id, [_choice(planned, "copy", copy_content=False)]
    )
    tid = template.json()["id"]
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('template', :t, 'user', :u, :r, :b)"
        ),
        {
            "t": UUID(tid),
            "u": stranger.id,
            "r": roles["template-viewer"],
            "b": owner.id,
        },
    )
    await db_session.commit()

    use = await client.post(
        f"{API}/template/{tid}/use",
        json={"target_folder_id": str(stranger_folder.id)},
        headers={"Authorization": f"Bearer {_unverified_bearer(stranger.id)}"},
    )

    assert use.status_code == 200, use.text
    (job,) = use.json()["copy_jobs"]
    assert job["error"] is None
    processes.assert_awaited_once()
    inputs = processes.await_args.kwargs["inputs"]
    assert inputs["copy_content"] is False
    assert inputs["template_id"] == tid
    readable = (
        await db_session.execute(
            text(f"SELECT {S}.can('layer', :l, :u, 'read')"),
            {"l": planned.id, "u": stranger.id},
        )
    ).scalar()
    assert readable is False


# ----------------------------------------------------------------------------
# The copy job, against this schema
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_after_the_copy_the_user_edits_their_own_layer_and_not_the_authors(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    make_user: MakeUser,
    make_folder: MakeFolder,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    """The Bonn case: the author's project template ships a planning layer
    to copy empty; a participant uses it, the copy job runs, and the
    participant now enters data into their own layer, which every
    reference in the project follows."""
    author, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await _rich_layer(
        db_session, make_layer, author, folder, "Vorhaben (Eingabe)"
    )
    districts = await make_layer(author, folder)
    participant = await make_user()
    participant_folder = await make_folder(participant)
    await db_session.commit()

    source_project = await _create_project(client, home, name="bonn")
    await _add_layers(client, source_project, planned.id, districts.id)
    source_links = await _links(db_session, source_project)
    (planned_link,) = source_links[planned.id]
    (districts_link,) = source_links[districts.id]
    await db_session.execute(
        text(
            f"""
            UPDATE {S}.layer_project SET
                name = 'Teststandort', query = CAST(:q AS jsonb),
                other_properties = CAST(:o AS jsonb)
            WHERE id = :id
            """
        ),
        {
            "id": planned_link,
            "q": json.dumps({"op": "=", "args": [{"property": "status"}, "geplant"]}),
            "o": json.dumps({"catalog_item": {"id": "frozen"}, "legend": "x"}),
        },
    )
    await db_session.execute(
        text(
            f"UPDATE {S}.project SET builder_config = CAST(:b AS jsonb) WHERE id = :p"
        ),
        {
            "p": source_project,
            "b": json.dumps(
                {
                    "interface": [
                        {
                            "type": "widget",
                            "config": {
                                "type": "table",
                                "setup": {"layer_project_id": planned_link},
                            },
                        }
                    ],
                    "settings": {"downloadable_layers": [planned_link, districts_link]},
                }
            ),
        },
    )
    await db_session.commit()
    workflow_config = _dataset_workflow_config(planned.id)
    workflow_config["nodes"][0]["data"]["projectLayerId"] = planned_link
    other_node = _dataset_workflow_config(districts.id, node_id="dataset-2")["nodes"][0]
    other_node["data"]["projectLayerId"] = districts_link
    workflow_config["nodes"].append(other_node)
    await _create_workflow(client, source_project, workflow_config)

    template = await _project_template(
        client, home, source_project, [_choice(planned, "copy", copy_content=False)]
    )
    assert template.status_code == 201, template.text
    tid = template.json()["id"]
    grant = await client.post(
        f"{API}/template/{tid}/grant",
        json={
            "grantee_type": "user",
            "grantee_id": str(participant.id),
            "role": "template-viewer",
        },
    )
    assert grant.status_code in (200, 201), grant.text

    use = await client.post(
        f"{API}/template/{tid}/use",
        json={"target_folder_id": str(participant_folder.id)},
        headers={"Authorization": f"Bearer {_unverified_bearer(participant.id)}"},
    )
    assert use.status_code == 200, use.text
    project_id = use.json()["project_id"]
    (job,) = use.json()["copy_jobs"]
    (submitted,) = processes.await_args_list
    links_before = await _links(db_session, project_id)
    (link_id,) = links_before[planned.id]
    assert job["layer_project_ids"] == [link_id]
    # Before the job ran: the participant reads the author's layer, and may
    # not write it.
    assert await _write_allowed(db_session, planned.id, participant.id) is False
    builder_before = (
        await db_session.execute(
            text(f"SELECT builder_config FROM {S}.project WHERE id = :p"),
            {"p": project_id},
        )
    ).scalar_one()

    output = await _run_copy_job(
        submitted.kwargs["inputs"], participant.id, feature_count=0
    )

    assert output.copied is True
    assert output.layer_project_ids == [link_id]
    copy_id = UUID(str(output.layer_id))
    assert copy_id != planned.id

    # The entry keeps its id, name, filter and everything a project refers
    # to it by; it now shows the copy and says where the copy came from.
    link = (
        await db_session.execute(
            text(
                f"SELECT layer_id, name, query, other_properties FROM {S}.layer_project "
                "WHERE id = :id"
            ),
            {"id": link_id},
        )
    ).one()
    assert link.layer_id == copy_id
    assert link.name == "Teststandort"
    assert link.query == {"op": "=", "args": [{"property": "status"}, "geplant"]}
    assert link.other_properties[COPY_STAMP]["source_layer_id"] == str(planned.id)
    assert link.other_properties["legend"] == "x"
    assert "catalog_item" not in link.other_properties
    links_after = await _links(db_session, project_id)
    assert links_after[copy_id] == [link_id]
    assert planned.id not in links_after
    assert links_after[districts.id] == links_before[districts.id]

    # The copy is the participant's, in their project's folder and space,
    # and carries the author's description, tags, style and dropdowns.
    copy_row = (
        await db_session.execute(
            text(
                f"""
                SELECT l.user_id, l.folder_id, l.space_id, l.name, l.description,
                       l.tags, l.type, l.feature_layer_type,
                       l.feature_layer_geometry_type, l.properties, l.field_config,
                       l.other_properties, l.size, l.extent IS NULL AS no_extent,
                       l.public_read, p.folder_id AS project_folder,
                       p.space_id AS project_space
                FROM {S}.layer l, {S}.project p
                WHERE l.id = :l AND p.id = :p
                """
            ),
            {"l": copy_id, "p": project_id},
        )
    ).one()
    assert copy_row.user_id == participant.id
    assert copy_row.folder_id == copy_row.project_folder == participant_folder.id
    assert copy_row.space_id == copy_row.project_space
    assert copy_row.name == "Vorhaben (Eingabe)"
    assert copy_row.description == "Planned projects, one row each"
    assert copy_row.tags == ["bonn", "planning"]
    assert (copy_row.type, copy_row.feature_layer_type) == ("feature", "standard")
    assert copy_row.feature_layer_geometry_type == "point"
    assert copy_row.properties == {"color": [200, 0, 0], "filled": True}
    assert copy_row.field_config == {
        "status": {"type": "dropdown", "options": ["geplant", "im Bau"]}
    }
    assert copy_row.other_properties == {
        COPY_STAMP: {
            "source_layer_id": str(planned.id),
            "template_id": tid,
            "copy_content": False,
        }
    }
    # An empty copy holds no data yet, so it takes no storage and no extent.
    assert copy_row.size == 0
    assert copy_row.no_extent is True
    assert copy_row.public_read is False

    # Writes: the participant may edit the copy, and still not the source.
    assert await _write_allowed(db_session, copy_id, participant.id) is True
    assert await _write_allowed(db_session, planned.id, participant.id) is False

    # The dashboard still names the same entry — which now shows the copy.
    builder_after = (
        await db_session.execute(
            text(f"SELECT builder_config FROM {S}.project WHERE id = :p"),
            {"p": project_id},
        )
    ).scalar_one()
    assert builder_after == builder_before
    assert (
        builder_after["interface"][0]["config"]["setup"]["layer_project_id"] == link_id
    )
    assert link_id in builder_after["settings"]["downloadable_layers"]

    # The workflow's dataset node reading the entry reads the copy; the
    # other dataset is untouched.
    (config,) = (
        await db_session.execute(
            text(f"SELECT config FROM {S}.workflow WHERE project_id = :p"),
            {"p": project_id},
        )
    ).scalars()
    nodes = {n["id"]: n["data"] for n in config["nodes"]}
    assert nodes["dataset-1"]["projectLayerId"] == link_id
    assert nodes["dataset-1"]["layerId"] == str(copy_id)
    assert nodes["dataset-2"]["layerId"] == str(districts.id)

    # The author's later edits stay in the author's layer.
    await db_session.execute(
        text(
            f"""
            UPDATE {S}.layer SET description = 'changed by the author',
                field_config = '{{}}'::jsonb, tags = ARRAY['changed']
            WHERE id = :id
            """
        ),
        {"id": planned.id},
    )
    await db_session.commit()
    after_edit = (
        await db_session.execute(
            text(
                f"SELECT description, field_config, tags FROM {S}.layer WHERE id = :l"
            ),
            {"l": copy_id},
        )
    ).one()
    assert after_edit.description == "Planned projects, one row each"
    assert after_edit.field_config["status"]["type"] == "dropdown"
    assert after_edit.tags == ["bonn", "planning"]
    # And the author's own project is untouched.
    assert (await _links(db_session, source_project)) == source_links

    # Running the job again changes nothing.
    again = await _run_copy_job(submitted.kwargs["inputs"], participant.id)
    assert again.copied is False
    assert again.layer_id == str(copy_id)
    copies = (
        await db_session.execute(
            text(
                f"SELECT COUNT(*) FROM {S}.layer "
                f"WHERE other_properties -> '{COPY_STAMP}' ->> 'source_layer_id' = :s"
            ),
            {"s": str(planned.id)},
        )
    ).scalar_one()
    assert copies == 1


@pytest.mark.asyncio
async def test_an_entry_put_on_the_users_copy_becomes_shareable(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    make_user: MakeUser,
    make_folder: MakeFolder,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    """The user had no `share` on the author's dataset, so the entry made for
    it was not shareable. Once it shows the user's own copy it is, or the
    copy would stay hidden from everyone the project is shared with."""
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await make_layer(owner, folder)
    stranger = await make_user()
    stranger_folder = await make_folder(stranger)
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, planned.id)
    template = await _project_template(
        client, home, project_id, [_choice(planned, "copy", copy_content=False)]
    )
    tid = template.json()["id"]
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('template', :t, 'user', :u, :r, :b)"
        ),
        {
            "t": UUID(tid),
            "u": stranger.id,
            "r": roles["template-viewer"],
            "b": owner.id,
        },
    )
    await db_session.commit()
    use = await client.post(
        f"{API}/template/{tid}/use",
        json={"target_folder_id": str(stranger_folder.id)},
        headers={"Authorization": f"Bearer {_unverified_bearer(stranger.id)}"},
    )
    assert use.status_code == 200, use.text
    new_project = use.json()["project_id"]
    entries = f"SELECT layer_id, shareable FROM {S}.layer_project WHERE project_id = :p"
    before = (await db_session.execute(text(entries), {"p": new_project})).all()
    assert [(r.layer_id, r.shareable) for r in before] == [(planned.id, False)]
    (submitted,) = processes.await_args_list

    output = await _run_copy_job(
        submitted.kwargs["inputs"], stranger.id, feature_count=0
    )

    assert output.copied is True
    after = (await db_session.execute(text(entries), {"p": new_project})).all()
    assert [(r.layer_id, r.shareable) for r in after] == [
        (UUID(str(output.layer_id)), True)
    ]


@pytest.mark.asyncio
async def test_a_full_copy_takes_the_sources_size_and_extent(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    housing = await _rich_layer(
        db_session, make_layer, owner, folder, "Neuer Wohnungsbau"
    )
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, housing.id)
    template = await _project_template(
        client, home, project_id, [_choice(housing, "copy")]
    )
    use = await client.post(
        f"{API}/template/{template.json()['id']}/use", json={"target_folder_id": home}
    )
    (submitted,) = processes.await_args_list

    output = await _run_copy_job(submitted.kwargs["inputs"], owner.id, feature_count=3)

    assert output.copied is True
    assert output.feature_count == 3
    row = (
        await db_session.execute(
            text(
                f"SELECT size, ST_AsText(extent) AS extent FROM {S}.layer WHERE id = :l"
            ),
            {"l": output.layer_id},
        )
    ).one()
    # Counts towards the user's storage like the data it holds.
    assert row.size == 2048
    assert row.extent.startswith("MULTIPOLYGON")
    assert list(await _links(db_session, use.json()["project_id"])) == [
        UUID(str(output.layer_id))
    ]


@pytest.mark.asyncio
async def test_a_failed_copy_leaves_the_entry_on_the_source_and_no_layer_behind(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await make_layer(owner, folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    await _add_layers(client, project_id, planned.id)
    template = await _project_template(
        client, home, project_id, [_choice(planned, "copy")]
    )
    use = await client.post(
        f"{API}/template/{template.json()['id']}/use", json={"target_folder_id": home}
    )
    (submitted,) = processes.await_args_list
    layers_before = (
        await db_session.execute(text(f"SELECT COUNT(*) FROM {S}.layer"))
    ).scalar_one()

    with pytest.raises(RuntimeError, match="lake unavailable"):
        await _run_copy_job(
            submitted.kwargs["inputs"],
            owner.id,
            copy_error=RuntimeError("lake unavailable"),
        )

    links = await _links(db_session, use.json()["project_id"])
    assert list(links) == [planned.id]
    stamp = await _copy_stamp(db_session, links[planned.id][0])
    assert stamp is not None
    assert stamp["status"] == "failed"
    assert stamp["error"] == "lake unavailable"
    layers_after = (
        await db_session.execute(text(f"SELECT COUNT(*) FROM {S}.layer"))
    ).scalar_one()
    assert layers_after == layers_before

    # A retry does the copy.
    output = await _run_copy_job(submitted.kwargs["inputs"], owner.id)
    assert output.copied is True
    stamp = await _copy_stamp(db_session, links[planned.id][0])
    assert stamp is not None and stamp["status"] == "done"


@pytest.mark.asyncio
async def test_the_job_refuses_entries_of_another_project(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
) -> None:
    """processes checks the project the job names; the job then refuses an
    entry that is not that project's, so a caller cannot repoint someone
    else's project through their own."""
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    layer = await make_layer(owner, folder)
    await db_session.commit()
    mine = await _create_project(client, home, name="mine")
    other = await _create_project(client, home, name="other")
    await _add_layers(client, mine, layer.id)
    await _add_layers(client, other, layer.id)
    (other_link,) = (await _links(db_session, other))[layer.id]

    with pytest.raises(ValueError, match="not in project"):
        await _run_copy_job(
            {
                "source_layer_id": str(layer.id),
                "project_id": mine,
                "layer_project_ids": [other_link],
                "copy_content": True,
            },
            owner.id,
        )

    assert (await _links(db_session, other))[layer.id] == [other_link]


# ----------------------------------------------------------------------------
# Workflow nodes that name their layer without an entry (the Bonn projects)
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_workflows_of_a_project_template_read_the_copy_even_without_entries(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    make_user: MakeUser,
    make_folder: MakeFolder,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    """Tool 4 / "Prüfroutine": the dataset node reading "Vorhaben (Eingabe)"
    carries only a `layerId`. After the participant's copy it must read the
    copy, or the run silently analyses the author's rows."""
    author, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await _rich_layer(
        db_session, make_layer, author, folder, "Vorhaben (Eingabe)"
    )
    districts = await make_layer(author, folder)
    participant = await make_user()
    participant_folder = await make_folder(participant)
    await db_session.commit()
    source_project = await _create_project(client, home, name="tool4")
    await _add_layers(client, source_project, planned.id, districts.id)
    await _create_workflow(
        client,
        source_project,
        {
            "nodes": [
                _legacy_node("dataset-vorhaben", planned.id),
                {**_legacy_node("dataset-gemeinden", districts.id)},
                _tool_node("tool-buffer", planned.id),
            ],
            "edges": [],
        },
    )
    template = await _project_template(
        client, home, source_project, [_choice(planned, "copy")]
    )
    tid = template.json()["id"]
    await client.post(
        f"{API}/template/{tid}/grant",
        json={
            "grantee_type": "user",
            "grantee_id": str(participant.id),
            "role": "template-viewer",
        },
    )

    use = await client.post(
        f"{API}/template/{tid}/use",
        json={"target_folder_id": str(participant_folder.id)},
        headers={"Authorization": f"Bearer {_unverified_bearer(participant.id)}"},
    )
    assert use.status_code == 200, use.text
    project_id = use.json()["project_id"]
    links = await _links(db_session, project_id)
    (planned_link,) = links[planned.id]
    (districts_link,) = links[districts.id]

    # The project made from the template gives each such node its entry.
    nodes = await _workflow_nodes(db_session, project_id)
    assert nodes["dataset-vorhaben"]["projectLayerId"] == planned_link
    assert nodes["dataset-gemeinden"]["projectLayerId"] == districts_link

    (submitted,) = processes.await_args_list
    output = await _run_copy_job(submitted.kwargs["inputs"], participant.id)
    copy_id = str(output.layer_id)

    nodes = await _workflow_nodes(db_session, project_id)
    assert nodes["dataset-vorhaben"]["layerId"] == copy_id
    assert nodes["dataset-vorhaben"]["projectLayerId"] == planned_link
    assert nodes["tool-buffer"]["config"]["input_layer_id"] == copy_id
    assert nodes["dataset-gemeinden"]["layerId"] == str(districts.id)
    # The author's workflow still reads the author's layer.
    source_nodes = await _workflow_nodes(db_session, source_project)
    assert source_nodes["dataset-vorhaben"]["layerId"] == str(planned.id)
    assert "projectLayerId" not in source_nodes["dataset-vorhaben"]


@pytest.mark.asyncio
async def test_unlinked_nodes_follow_a_copy_shown_through_two_entries(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    """Shown twice (two stylings), the layer has no one entry to give the
    node when the project is made; once both entries show the copy, the
    node is pointed at the copy by its layer (Schulung → Szenario)."""
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    housing = await make_layer(owner, folder)
    await db_session.commit()
    source_project = await _create_project(client, home, name="schulung")
    await _add_layers(client, source_project, housing.id)
    await db_session.execute(
        text(
            f"INSERT INTO {S}.layer_project "
            '(layer_id, project_id, name, "order", updated_at) '
            "VALUES (:l, :p, 'Neuer Wohnungsbau (Umriss)', 9, now())"
        ),
        {"l": housing.id, "p": source_project},
    )
    await db_session.commit()
    await _create_workflow(
        client,
        source_project,
        {"nodes": [_legacy_node("dataset-wohnungsbau", housing.id)], "edges": []},
    )
    template = await _project_template(
        client, home, source_project, [_choice(housing, "copy", copy_content=False)]
    )
    use = await client.post(
        f"{API}/template/{template.json()['id']}/use", json={"target_folder_id": home}
    )
    project_id = use.json()["project_id"]
    entries = sorted((await _links(db_session, project_id))[housing.id])
    assert len(entries) == 2
    nodes = await _workflow_nodes(db_session, project_id)
    assert "projectLayerId" not in nodes["dataset-wohnungsbau"]

    (submitted,) = processes.await_args_list
    output = await _run_copy_job(submitted.kwargs["inputs"], owner.id, feature_count=0)

    nodes = await _workflow_nodes(db_session, project_id)
    assert nodes["dataset-wohnungsbau"]["layerId"] == str(output.layer_id)
    assert nodes["dataset-wohnungsbau"]["projectLayerId"] == entries[0]


@pytest.mark.asyncio
async def test_unlinked_nodes_meaning_the_users_own_entry_are_left_alone(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    """A workflow template's copy lands in a project that already shows the
    dataset through an entry of its own: the project's own workflow, whose
    node names the dataset by `layerId` only, may mean that entry, so it
    keeps reading the dataset; the template's workflow reads the copy."""
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    layer = await make_layer(owner, folder)
    await db_session.commit()
    source_project = await _create_project(client, home, name="source")
    workflow_id = await _create_workflow(
        client, source_project, _dataset_workflow_config(layer.id)
    )
    template = await client.post(
        f"{API}/template",
        json={
            "name": "Copy workflow",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": source_project,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "copy",
                    "layer_id": str(layer.id),
                }
            ],
        },
    )
    target = await _create_project(client, home, name="target")
    await _add_layers(client, target, layer.id)
    await _create_workflow(
        client, target, {"nodes": [_legacy_node("dataset-mine", layer.id)], "edges": []}
    )

    use = await client.post(
        f"{API}/template/{template.json()['id']}/use", json={"project_id": target}
    )
    (submitted,) = processes.await_args_list
    output = await _run_copy_job(submitted.kwargs["inputs"], owner.id)

    nodes = await _workflow_nodes(db_session, target)
    assert nodes["dataset-mine"]["layerId"] == str(layer.id)
    assert "projectLayerId" not in nodes["dataset-mine"]
    assert nodes["dataset-1"]["layerId"] == str(output.layer_id)
    assert (
        nodes["dataset-1"]["projectLayerId"]
        == use.json()["copy_jobs"][0]["layer_project_ids"][0]
    )


# ----------------------------------------------------------------------------
# Using a workflow copy template again in the same project
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_using_a_workflow_copy_template_again_reuses_its_entry_and_copy(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    layer = await make_layer(owner, folder)
    await db_session.commit()
    source_project = await _create_project(client, home, name="source")
    workflow_id = await _create_workflow(
        client, source_project, _dataset_workflow_config(layer.id)
    )
    template = await client.post(
        f"{API}/template",
        json={
            "name": "Prüfroutine",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": source_project,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "copy",
                    "layer_id": str(layer.id),
                }
            ],
        },
    )
    tid = template.json()["id"]
    target = await _create_project(client, home, name="target")
    # The project already shows the dataset under its own name.
    await _add_layers(client, target, layer.id)

    async def preview() -> tuple[str, int | None]:
        """What a use would bind the node to, written by nobody."""
        resp = await client.post(
            f"{API}/template/{tid}/use/preview", json={"project_id": target}
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["config"]["nodes"][0]["data"]
        return data["layerId"], data.get("projectLayerId")

    # The copy would get an entry of its own, which does not exist yet.
    assert await preview() == (str(layer.id), None)
    assert len((await _links(db_session, target))[layer.id]) == 1
    assert processes.await_count == 0

    first = await client.post(f"{API}/template/{tid}/use", json={"project_id": target})
    (job,) = first.json()["copy_jobs"]
    (entry,) = job["layer_project_ids"]
    name = (
        await db_session.execute(
            text(f"SELECT name FROM {S}.layer_project WHERE id = :id"), {"id": entry}
        )
    ).scalar_one()
    assert name == layer.name  # not "Copy from …"
    # The entry the first use made, still on the source: no job is started.
    assert await preview() == (str(layer.id), entry)
    assert processes.await_count == 1

    # Not copied yet: using the template again gives the same entry its job.
    second = await client.post(f"{API}/template/{tid}/use", json={"project_id": target})
    assert second.json()["added_layer_project_ids"] == []
    (again,) = second.json()["copy_jobs"]
    assert again["layer_project_ids"] == [entry]
    assert again["job_id"] is not None

    output = await _run_copy_job(
        processes.await_args_list[-1].kwargs["inputs"], owner.id
    )

    # Copied: a third use binds the new workflow to the entry and its copy,
    # with no new entry, no new copy and no job.
    assert await preview() == (str(output.layer_id), entry)
    third = await client.post(f"{API}/template/{tid}/use", json={"project_id": target})
    assert third.status_code == 200, third.text
    assert third.json()["added_layer_project_ids"] == []
    assert third.json()["copy_jobs"] == []
    assert processes.await_count == 2
    wf = await client.get(
        f"{API}/project/{target}/workflow/{third.json()['workflow_id']}"
    )
    node = wf.json()["config"]["nodes"][0]["data"]
    assert (node["layerId"], node["projectLayerId"]) == (str(output.layer_id), entry)
    links = await _links(db_session, target)
    assert links[UUID(str(output.layer_id))] == [entry]
    assert len(links[layer.id]) == 1  # the project's own entry, unchanged


@pytest.mark.asyncio
async def test_a_use_preview_clears_the_settings_naming_an_empty_copys_entry(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: MakeLayer,
    roles: dict[str, UUID],
    processes: AsyncMock,
) -> None:
    """A use points the tool settings naming an empty copy's dataset by the
    author's entry at the entry it makes for the copy. Before the use there
    is no such entry, so the preview clears those settings, as a step still
    to be chosen has them, instead of naming the author's entry, or the
    entry of a copy that has not arrived: both show the template's dataset,
    which the user may not read. A shipped dataset's settings name the
    entry the user reads it through, and a copy that arrived names its own."""
    owner, folder, home = await _setup(
        client, db_session, fixture_create_user, fixture_get_home_folder, make_layer
    )
    planned = await make_layer(owner, folder)
    shipped = await make_layer(owner, folder)
    await db_session.commit()
    source_project = await _create_project(client, home, name="source")
    await _add_layers(client, source_project, planned.id, shipped.id)
    source_links = await _links(db_session, source_project)
    (planned_entry,) = source_links[planned.id]
    (shipped_entry,) = source_links[shipped.id]
    config = _dataset_workflow_config(planned.id)
    config["nodes"][0]["data"]["projectLayerId"] = planned_entry
    second = _dataset_workflow_config(shipped.id, node_id="dataset-2")["nodes"][0]
    second["data"]["projectLayerId"] = shipped_entry
    heat = {
        "id": "heat",
        "type": "tool",
        "position": {"x": 300, "y": 0},
        "data": {
            "type": "tool",
            "processId": "heatmap_gravity",
            "config": {
                "routing_mode": "walking",
                "opportunities": [
                    {"layer_project_id": planned_entry, "max_cost": 10},
                    {"layer_project_id": shipped_entry, "max_cost": 10},
                ],
            },
        },
    }
    config["nodes"] += [{**second, "position": {"x": 0, "y": 200}}, heat]
    config["edges"] = [
        {
            "id": f"e{n}",
            "source": f"dataset-{n}",
            "target": "heat",
            "targetHandle": f"opportunity_layer_{n}_id",
        }
        for n in (1, 2)
    ]
    workflow_id = await _create_workflow(client, source_project, config)
    template = await client.post(
        f"{API}/template",
        json={
            "name": "Erreichbarkeit",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": source_project,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Planned",
                    "mode": "copy",
                    "copy_content": False,
                    "layer_id": str(planned.id),
                },
                {
                    "key": "node:dataset-2",
                    "label": "Shipped",
                    "mode": "ship",
                    "layer_id": str(shipped.id),
                },
            ],
        },
    )
    assert template.status_code == 201, template.text
    tid = template.json()["id"]
    target = await _create_project(client, home, name="target")

    async def preview() -> tuple[str, list[Any]]:
        """The planned step's layer and the heatmap's opportunity entries."""
        resp = await client.post(
            f"{API}/template/{tid}/use/preview", json={"project_id": target}
        )
        assert resp.status_code == 200, resp.text
        nodes = {node["id"]: node["data"] for node in resp.json()["config"]["nodes"]}
        entries = [
            o["layer_project_id"] for o in nodes["heat"]["config"]["opportunities"]
        ]
        return nodes["dataset-1"]["layerId"], entries

    # Before the first use: no entry of the copy's yet, and the shipped
    # dataset keeps the author's entry, as before (a use links it anew).
    assert await preview() == (str(planned.id), [None, shipped_entry])

    first = await client.post(f"{API}/template/{tid}/use", json={"project_id": target})
    assert first.status_code == 200, first.text
    (job,) = first.json()["copy_jobs"]
    (entry,) = job["layer_project_ids"]
    used = (await _workflow_nodes(db_session, target))["heat"]["config"]
    assert used["opportunities"][0]["layer_project_id"] == entry
    (shipped_link,) = (await _links(db_session, target))[shipped.id]

    # The copy has not arrived: its entry still shows the template's dataset.
    assert await preview() == (str(planned.id), [None, shipped_link])

    output = await _run_copy_job(processes.await_args.kwargs["inputs"], owner.id)
    assert await preview() == (str(output.layer_id), [entry, shipped_link])
