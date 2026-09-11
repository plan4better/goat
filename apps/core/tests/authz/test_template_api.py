"""Task 4: the template API — preview, save, list, read, patch, delete,
refresh (T1, T2, T4, T5, T6, T8)."""

import json
from typing import Any, Awaitable, Callable
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.crud.crud_share import share as crud_share
from core.db.models.folder import Folder
from core.db.models.organization import Organization
from core.db.models.space import Space, SpaceKind
from core.db.models.team import Team
from core.db.models.user import User
from core.schemas.share import (
    LayerShareRoleEnum,
    ShareLayerSchema,
    ShareLayerWithTeamOrOrganizationSchema,
)
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.test_content_feed import _feed, _unverified_bearer

S = settings.SCHEMA
VIEW = {
    "latitude": 48.1,
    "longitude": 11.5,
    "zoom": 10,
    "min_zoom": 0,
    "max_zoom": 20,
    "bearing": 0,
    "pitch": 0,
}


async def _create_project(
    client: AsyncClient, folder_id: str, name: str = "src"
) -> str:
    r = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": f"{name}-{uuid4().hex[:6]}",
            "folder_id": folder_id,
            "initial_view_state": VIEW,
        },
    )
    assert r.status_code in (200, 201), r.text
    return str(r.json()["id"])


def _dataset_workflow_config(
    layer_id: UUID, *, node_id: str = "dataset-1"
) -> dict[str, Any]:
    return {
        "nodes": [
            {
                "id": node_id,
                "type": "dataset",
                "position": {"x": 0, "y": 0},
                "data": {
                    "type": "dataset",
                    "label": "Input Layer",
                    "layerId": str(layer_id),
                    "layerType": "feature",
                    "geometryType": "polygon",
                },
            }
        ],
        "edges": [],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "variables": [],
    }


async def _create_workflow(
    client: AsyncClient, project_id: str, config: dict[str, Any]
) -> str:
    r = await client.post(
        f"{settings.API_V2_STR}/project/{project_id}/workflow",
        json={"name": "wf", "config": config},
    )
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


def _layout_config() -> dict[str, Any]:
    return {
        "page": {
            "size": "A4",
            "orientation": "portrait",
            "margins": {"top": 10, "right": 10, "bottom": 10, "left": 10},
        },
        "layout": {"type": "grid", "columns": 12, "rows": 12, "gap": 5},
        "elements": [
            {
                "id": "map-1",
                "type": "map",
                "map_config": {"layers": [{"layer_project_id": 1, "opacity": 1}]},
            },
            {
                "id": "table-1",
                "type": "table",
                "config": {"layer_project_id": 1, "setup": {"layer_project_id": 1}},
            },
        ],
        "theme": None,
        "atlas": {"coverage": {"layer_project_id": 1}},
    }


async def _create_layout(
    client: AsyncClient, project_id: str, config: dict[str, Any]
) -> str:
    r = await client.post(
        f"{settings.API_V2_STR}/project/{project_id}/report-layout",
        json={"name": "layout", "config": config},
    )
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


@pytest.mark.asyncio
async def test_preview_save_list_and_patch_a_workflow_template(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()

    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )

    preview = await client.post(
        f"{settings.API_V2_STR}/template/preview",
        json={
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "folder_id": home,
        },
    )
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()
    assert preview_body["kinds"] == ["workflow"]
    assert len(preview_body["detected_inputs"]) == 1
    detected = preview_body["detected_inputs"][0]
    assert detected["mode"] == "ship"
    assert detected["key"] == "node:dataset-1"
    assert detected["layer_id"] == str(layer.id)

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "My workflow template",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": preview_body["detected_inputs"],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tpl = create_resp.json()
    tid = tpl["id"]
    assert tpl["payload_kind"] == "workflow"
    assert tpl["kinds"] == ["workflow"]
    assert tpl["my_role"] == "owner"
    assert tpl["inputs"][0]["from_catalog"] is False

    listing = await client.get(
        f"{settings.API_V2_STR}/template", params={"source": "mine"}
    )
    assert listing.status_code == 200, listing.text
    row = next(i for i in listing.json()["items"] if i["id"] == tid)
    assert row["my_role"] == "owner"
    assert row["payload_kind"] == "workflow"

    patch_resp = await client.patch(
        f"{settings.API_V2_STR}/template/{tid}", json={"name": "Renamed template"}
    )
    assert patch_resp.status_code == 200, patch_resp.text
    assert patch_resp.json()["name"] == "Renamed template"


@pytest.mark.asyncio
async def test_preview_accepts_a_legacy_dataset_node_layer_type(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    """A dataset node saved before the web narrowed `layerType` to
    feature|table|raster carries `"layer"`; previewing it must still detect
    the input, with no type, instead of failing validation."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()

    config = _dataset_workflow_config(layer.id)
    config["nodes"][0]["data"]["layerType"] = "layer"
    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(client, project_id, config)

    preview = await client.post(
        f"{settings.API_V2_STR}/template/preview",
        json={
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "folder_id": home,
        },
    )
    assert preview.status_code == 200, preview.text
    detected = preview.json()["detected_inputs"]
    assert len(detected) == 1
    assert detected[0]["key"] == "node:dataset-1"
    assert detected[0]["layer_id"] == str(layer.id)
    assert detected[0]["layer_type"] is None


@pytest.mark.asyncio
async def test_layout_template_strips_layer_bindings(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    home = str(fixture_get_home_folder["id"])
    project_id = await _create_project(client, home)
    layout_id = await _create_layout(client, project_id, _layout_config())

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "My layout template",
            "folder_id": home,
            "source": {
                "kind": "layout",
                "project_id": project_id,
                "layout_id": layout_id,
            },
            "inputs": [],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]
    assert create_resp.json()["kinds"] == ["layout"]

    read_resp = await client.get(
        f"{settings.API_V2_STR}/template/{tid}", params={"include_config": "true"}
    )
    assert read_resp.status_code == 200, read_resp.text
    config = read_resp.json()["config"]
    assert config["elements"][0]["map_config"]["layers"] == []
    assert "layer_project_id" not in config["elements"][1]["config"]
    assert "layer_project_id" not in config["elements"][1]["config"]["setup"]
    assert "layer_project_id" not in config["atlas"]["coverage"]


@pytest.mark.asyncio
async def test_project_template_creates_frozen_hidden_copy(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    home = str(fixture_get_home_folder["id"])
    project_id = await _create_project(client, home)

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Dashboard template",
            "folder_id": home,
            "source": {"kind": "project", "project_id": project_id},
            "inputs": [],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]
    assert create_resp.json()["payload_kind"] == "project"

    frozen_id = (
        await db_session.execute(
            text(f"SELECT source_project_id FROM {S}.template WHERE id = :t"),
            {"t": tid},
        )
    ).scalar_one()
    is_template_source = (
        await db_session.execute(
            text(f"SELECT is_template_source FROM {S}.project WHERE id = :p"),
            {"p": frozen_id},
        )
    ).scalar_one()
    assert is_template_source is True

    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    feed = await _feed(client, space_id=str(sid), folder_id=home)
    assert str(frozen_id) not in {i["id"] for i in feed["items"]}


@pytest.mark.asyncio
async def test_delete_soft_deletes_a_template(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    home = str(fixture_get_home_folder["id"])
    project_id = await _create_project(client, home)
    layout_id = await _create_layout(client, project_id, _layout_config())

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Deletable",
            "folder_id": home,
            "source": {
                "kind": "layout",
                "project_id": project_id,
                "layout_id": layout_id,
            },
            "inputs": [],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]

    delete_resp = await client.delete(f"{settings.API_V2_STR}/template/{tid}")
    assert delete_resp.status_code == 204, delete_resp.text

    read_resp = await client.get(f"{settings.API_V2_STR}/template/{tid}")
    assert read_resp.status_code == 404, read_resp.text


@pytest.mark.asyncio
async def test_refresh_resnapshots_after_the_workflow_is_edited(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()

    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )

    preview = await client.post(
        f"{settings.API_V2_STR}/template/preview",
        json={
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "folder_id": home,
        },
    )
    assert preview.status_code == 200, preview.text

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Refreshable",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": preview.json()["detected_inputs"],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]

    edited_config = _dataset_workflow_config(layer.id)
    edited_config["nodes"][0]["data"]["label"] = "Renamed Input"
    put_resp = await client.put(
        f"{settings.API_V2_STR}/project/{project_id}/workflow/{workflow_id}",
        json={"config": edited_config},
    )
    assert put_resp.status_code == 200, put_resp.text

    refresh_resp = await client.post(f"{settings.API_V2_STR}/template/{tid}/refresh")
    assert refresh_resp.status_code == 200, refresh_resp.text

    read_resp = await client.get(
        f"{settings.API_V2_STR}/template/{tid}", params={"include_config": "true"}
    )
    assert read_resp.status_code == 200, read_resp.text
    assert read_resp.json()["config"]["nodes"][0]["data"]["label"] == "Renamed Input"


@pytest.mark.asyncio
async def test_refresh_reconciles_inputs_when_a_dataset_node_is_added(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    """B2: `refresh` used to re-freeze the config with the STORED inputs
    as-is, so a dataset node added to the source since save was invisible
    to it -- frozen with the author's raw `layerId` and no `templateInput`
    marker, never read-checked, never counted by the publish guard. It must
    instead reconcile against a fresh `detect_workflow_inputs` scan: the
    surviving key keeps its mode, the newly-detected key defaults to "ask"."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer_a = await make_layer(owner, home_folder)
    layer_b = await make_layer(owner, home_folder)
    await db_session.commit()

    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer_a.id)
    )

    preview = await client.post(
        f"{settings.API_V2_STR}/template/preview",
        json={
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "folder_id": home,
        },
    )
    assert preview.status_code == 200, preview.text

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Reconciled on refresh",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": preview.json()["detected_inputs"],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]
    assert len(create_resp.json()["inputs"]) == 1

    two_node_config = _dataset_workflow_config(layer_a.id, node_id="dataset-1")
    two_node_config["nodes"].append(
        {
            "id": "dataset-2",
            "type": "dataset",
            "position": {"x": 100, "y": 0},
            "data": {
                "type": "dataset",
                "label": "Second Input Layer",
                "layerId": str(layer_b.id),
                "layerType": "feature",
                "geometryType": "polygon",
            },
        }
    )
    put_resp = await client.put(
        f"{settings.API_V2_STR}/project/{project_id}/workflow/{workflow_id}",
        json={"config": two_node_config},
    )
    assert put_resp.status_code == 200, put_resp.text

    refresh_resp = await client.post(f"{settings.API_V2_STR}/template/{tid}/refresh")
    assert refresh_resp.status_code == 200, refresh_resp.text
    refreshed = refresh_resp.json()
    assert len(refreshed["inputs"]) == 2
    by_key = {i["key"]: i for i in refreshed["inputs"]}
    assert by_key["node:dataset-1"]["mode"] == "ship"
    assert by_key["node:dataset-2"]["mode"] == "ask"
    assert by_key["node:dataset-2"]["layer_id"] is None

    read_resp = await client.get(
        f"{settings.API_V2_STR}/template/{tid}", params={"include_config": "true"}
    )
    assert read_resp.status_code == 200, read_resp.text
    config = read_resp.json()["config"]
    new_node = next(n for n in config["nodes"] if n["id"] == "dataset-2")
    assert new_node["data"]["unresolved"] is True
    assert new_node["data"].get("layerId") is None


@pytest.mark.asyncio
async def test_stranger_gets_403_reading_a_template(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    home = str(fixture_get_home_folder["id"])
    project_id = await _create_project(client, home)
    layout_id = await _create_layout(client, project_id, _layout_config())

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Private",
            "folder_id": home,
            "source": {
                "kind": "layout",
                "project_id": project_id,
                "layout_id": layout_id,
            },
            "inputs": [],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]

    stranger = await make_user()
    await db_session.commit()

    resp = await client.get(
        f"{settings.API_V2_STR}/template/{tid}",
        headers={"Authorization": f"Bearer {_unverified_bearer(stranger.id)}"},
    )
    assert resp.status_code == 403, resp.text


async def _team_folder(db: AsyncSession, space_id: UUID, owner: UUID) -> UUID:
    """A team-space folder — `make_folder` only targets personal spaces."""
    return (
        await db.execute(
            text(
                f"""
                INSERT INTO {S}.folder (id, name, user_id, space_id, updated_at)
                VALUES (gen_random_uuid(), :n, :u, :s, now())
                RETURNING id
                """
            ),
            {"n": f"f-{uuid4().hex[:6]}", "u": owner, "s": space_id},
        )
    ).scalar_one()


@pytest.mark.asyncio
async def test_create_422s_on_a_workflow_inputs_key_mismatch(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()

    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
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
                    "key": "node:does-not-exist",
                    "label": "Wrong",
                    "mode": "ship",
                    "layer_id": str(layer.id),
                }
            ],
        },
    )
    assert create_resp.status_code == 422, create_resp.text


@pytest.mark.asyncio
async def test_ask_mode_input_never_stores_a_layer_id_or_from_catalog(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()

    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Ask input",
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
                    "mode": "ask",
                    # A client trying to sneak a layer_id/from_catalog=True
                    # into an ask slot must be overridden server-side.
                    "layer_id": str(layer.id),
                    "layer_type": "feature",
                    "geometry_type": "polygon",
                    "from_catalog": True,
                }
            ],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    stored = create_resp.json()["inputs"][0]
    assert stored["mode"] == "ask"
    assert stored["layer_id"] is None
    assert stored["from_catalog"] is False


@pytest.mark.asyncio
async def test_project_template_detects_ship_inputs_for_its_layers(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer_a = await make_layer(owner, home_folder)
    layer_b = await make_layer(owner, home_folder)
    await db_session.execute(
        text(f"UPDATE {S}.layer SET catalog_external_uid = 'ext-1' WHERE id = :id"),
        {"id": layer_b.id},
    )
    await db_session.commit()

    project_id = await _create_project(client, home)
    add_resp = await client.post(
        f"{settings.API_V2_STR}/project/{project_id}/layer",
        params=[("layer_ids", str(layer_a.id)), ("layer_ids", str(layer_b.id))],
    )
    assert add_resp.status_code == 200, add_resp.text

    preview = await client.post(
        f"{settings.API_V2_STR}/template/preview",
        json={
            "source": {"kind": "project", "project_id": project_id},
            "folder_id": home,
        },
    )
    assert preview.status_code == 200, preview.text
    inputs = preview.json()["detected_inputs"]
    assert len(inputs) == 2
    by_layer = {i["layer_id"]: i for i in inputs}
    assert by_layer[str(layer_a.id)]["mode"] == "ship"
    assert by_layer[str(layer_a.id)]["from_catalog"] is False
    assert by_layer[str(layer_b.id)]["from_catalog"] is True

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Project with layers",
            "folder_id": home,
            "source": {"kind": "project", "project_id": project_id},
            "inputs": [],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    assert len(create_resp.json()["inputs"]) == 2


@pytest.mark.asyncio
async def test_share_datasets_preserves_an_existing_grant_to_a_different_team(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    me = fixture_create_user
    home = str(fixture_get_home_folder["id"])
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    me_user = await db_session.get(User, me)
    assert me_user is not None
    layer = await make_layer(me_user, home_folder)

    org = await make_org()
    await db_session.execute(
        text(f'UPDATE {S}."user" SET organization_id = :o WHERE id = :u'),
        {"o": org.id, "u": me},
    )
    me_user = await db_session.get(User, me)
    assert me_user is not None
    team_a = await make_team(org=org)  # not a member — just an existing grantee
    team_b = await make_team(me_user, org=org)  # me is a member of this one
    space_b = await make_space(SpaceKind.team, team=team_b)
    folder_b = await _team_folder(db_session, space_b.id, me)
    await db_session.commit()

    # Seed an existing viewer grant for Team A directly.
    await crud_share.share_resource(
        db=db_session,
        resource_type="layer",
        resource_id=layer.id,
        shared_with=ShareLayerSchema(
            teams=[
                ShareLayerWithTeamOrOrganizationSchema(
                    id=str(team_a.id), role=LayerShareRoleEnum.layer_viewer
                )
            ]
        ),
        granted_by=me,
    )
    await db_session.commit()

    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )
    preview = await client.post(
        f"{settings.API_V2_STR}/template/preview",
        json={
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "folder_id": str(folder_b),
        },
    )
    assert preview.status_code == 200, preview.text

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Shared into team B",
            "folder_id": str(folder_b),
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": preview.json()["detected_inputs"],
            "share_datasets": [str(layer.id)],
        },
    )
    assert create_resp.status_code == 201, create_resp.text

    grants = await crud_share.get_grants(
        db=db_session, resource_type="layer", resource_id=layer.id
    )
    team_ids = {t.id for t in (grants.teams or [])}
    assert str(team_a.id) in team_ids, "Team A's existing grant must survive"
    assert str(team_b.id) in team_ids, "Team B must receive the new viewer grant"


@pytest.mark.asyncio
async def test_create_422s_shipping_a_layer_the_caller_cannot_read(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    roles: dict[str, UUID],
) -> None:
    """B3: the source project being readable does not mean every layer its
    workflow references is -- a caller who can only read a shared project
    must not be able to declare a "ship" input for a layer they cannot
    themselves read."""
    owner_id = fixture_create_user
    owner = await db_session.get(User, owner_id)
    assert owner is not None
    home = str(fixture_get_home_folder["id"])
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    private_layer = await make_layer(owner, home_folder)
    await db_session.commit()

    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(private_layer.id)
    )

    caller = await make_user()
    caller_folder = await make_folder(caller)
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('project', :p, 'user', :u, :r, :o)"
        ),
        {
            "p": project_id,
            "u": caller.id,
            "r": roles["project-viewer"],
            "o": owner_id,
        },
    )
    await db_session.commit()
    caller_headers = {"Authorization": f"Bearer {_unverified_bearer(caller.id)}"}

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Shipping someone else's private layer",
            "folder_id": str(caller_folder.id),
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "ship",
                    "layer_id": str(private_layer.id),
                }
            ],
        },
        headers=caller_headers,
    )
    assert create_resp.status_code == 422, create_resp.text
    assert create_resp.json()["detail"]["code"] == "template_input_not_readable"


@pytest.mark.asyncio
async def test_share_datasets_403s_naming_a_layer_the_caller_cannot_share(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    roles: dict[str, UUID],
) -> None:
    """B3: a shipped input only needs to be readable, but naming a layer in
    `share_datasets` widens who can read it -- that requires "share" (rank
    >= editor) on the layer itself, not merely "read"."""
    owner_id = fixture_create_user
    owner = await db_session.get(User, owner_id)
    assert owner is not None
    home = str(fixture_get_home_folder["id"])
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()

    caller = await make_user()
    caller_folder = await make_folder(caller)
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('layer', :l, 'user', :u, :r, :o)"
        ),
        {
            "l": layer.id,
            "u": caller.id,
            "r": roles["layer-viewer"],
            "o": owner_id,
        },
    )
    await db_session.commit()
    caller_headers = {"Authorization": f"Bearer {_unverified_bearer(caller.id)}"}

    project_resp = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": f"caller-src-{uuid4().hex[:6]}",
            "folder_id": str(caller_folder.id),
            "initial_view_state": VIEW,
        },
        headers=caller_headers,
    )
    assert project_resp.status_code in (200, 201), project_resp.text
    project_id = project_resp.json()["id"]

    workflow_resp = await client.post(
        f"{settings.API_V2_STR}/project/{project_id}/workflow",
        json={"name": "wf", "config": _dataset_workflow_config(layer.id)},
        headers=caller_headers,
    )
    assert workflow_resp.status_code == 201, workflow_resp.text
    workflow_id = workflow_resp.json()["id"]

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Cannot share",
            "folder_id": str(caller_folder.id),
            "source": {
                "kind": "workflow",
                "project_id": project_id,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "ship",
                    "layer_id": str(layer.id),
                }
            ],
            "share_datasets": [str(layer.id)],
        },
        headers=caller_headers,
    )
    assert create_resp.status_code == 403, create_resp.text


@pytest.mark.asyncio
async def test_list_templates_paginates_with_an_accurate_total(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    home = str(fixture_get_home_folder["id"])
    for i in range(3):
        project_id = await _create_project(client, home, name=f"pg{i}")
        layout_id = await _create_layout(client, project_id, _layout_config())
        r = await client.post(
            f"{settings.API_V2_STR}/template",
            json={
                "name": f"Page {i}",
                "folder_id": home,
                "source": {
                    "kind": "layout",
                    "project_id": project_id,
                    "layout_id": layout_id,
                },
                "inputs": [],
            },
        )
        assert r.status_code == 201, r.text

    listing = await client.get(
        f"{settings.API_V2_STR}/template",
        params={"source": "mine", "size": 2, "page": 1},
    )
    assert listing.status_code == 200, listing.text
    body = listing.json()
    assert len(body["items"]) == 2
    assert body["total"] == 3


async def _create_layout_template(
    client: AsyncClient, *, folder_id: str, name: str = "Movable"
) -> str:
    project_id = await _create_project(client, folder_id, name=name)
    layout_id = await _create_layout(client, project_id, _layout_config())
    r = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": name,
            "folder_id": folder_id,
            "source": {
                "kind": "layout",
                "project_id": project_id,
                "layout_id": layout_id,
            },
            "inputs": [],
        },
    )
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


@pytest.mark.asyncio
async def test_owner_moves_a_template_to_another_folder_in_the_same_space(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_folder: Callable[..., Awaitable[Folder]],
) -> None:
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    other_folder = await make_folder(owner)
    await db_session.commit()

    tid = await _create_layout_template(client, folder_id=home)

    patch_resp = await client.patch(
        f"{settings.API_V2_STR}/template/{tid}",
        json={"folder_id": str(other_folder.id)},
    )
    assert patch_resp.status_code == 200, patch_resp.text
    assert patch_resp.json()["folder_id"] == str(other_folder.id)

    read_resp = await client.get(f"{settings.API_V2_STR}/template/{tid}")
    assert read_resp.status_code == 200, read_resp.text
    assert read_resp.json()["folder_id"] == str(other_folder.id)


@pytest.mark.asyncio
async def test_moving_a_template_to_a_folder_in_another_space_is_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
) -> None:
    home = str(fixture_get_home_folder["id"])
    stranger = await make_user()
    foreign_folder = await make_folder(stranger)
    await db_session.commit()

    tid = await _create_layout_template(client, folder_id=home)

    patch_resp = await client.patch(
        f"{settings.API_V2_STR}/template/{tid}",
        json={"folder_id": str(foreign_folder.id)},
    )
    assert patch_resp.status_code == 404, patch_resp.text

    read_resp = await client.get(f"{settings.API_V2_STR}/template/{tid}")
    assert read_resp.status_code == 200, read_resp.text
    assert read_resp.json()["folder_id"] == home


@pytest.mark.asyncio
async def test_editor_without_write_on_the_destination_folder_cannot_move_a_template(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    roles: dict[str, UUID],
) -> None:
    """Mirrors the layer-move guard (endpoints/v2/layer.py): write on the
    template alone is not enough to move it into a folder the caller may
    not write into, even when that folder is in the SAME space (e.g. a
    restricted folder someone else only shared read access to)."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    other_folder = await make_folder(owner)

    tid = await _create_layout_template(client, folder_id=home)

    editor = await make_user()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('template', :t, 'user', :u, :r, :b)"
        ),
        {
            "t": UUID(tid),
            "u": editor.id,
            "r": roles["template-editor"],
            "b": owner.id,
        },
    )
    # `editor` may write the template, but only read the destination folder.
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('folder', :f, 'user', :u, :r, :b)"
        ),
        {
            "f": other_folder.id,
            "u": editor.id,
            "r": roles["folder-viewer"],
            "b": owner.id,
        },
    )
    await db_session.commit()

    patch_resp = await client.patch(
        f"{settings.API_V2_STR}/template/{tid}",
        json={"folder_id": str(other_folder.id)},
        headers={"Authorization": f"Bearer {_unverified_bearer(editor.id)}"},
    )
    assert patch_resp.status_code == 403, patch_resp.text

    read_resp = await client.get(f"{settings.API_V2_STR}/template/{tid}")
    assert read_resp.status_code == 200, read_resp.text
    assert read_resp.json()["folder_id"] == home


@pytest.mark.asyncio
async def test_viewer_cannot_move_a_template(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    roles: dict[str, UUID],
) -> None:
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    other_folder = await make_folder(owner)

    tid = await _create_layout_template(client, folder_id=home)

    viewer = await make_user()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('template', :t, 'user', :u, :r, :b)"
        ),
        {
            "t": UUID(tid),
            "u": viewer.id,
            "r": roles["template-viewer"],
            "b": owner.id,
        },
    )
    await db_session.commit()

    patch_resp = await client.patch(
        f"{settings.API_V2_STR}/template/{tid}",
        json={"folder_id": str(other_folder.id)},
        headers={"Authorization": f"Bearer {_unverified_bearer(viewer.id)}"},
    )
    assert patch_resp.status_code == 403, patch_resp.text

    read_resp = await client.get(f"{settings.API_V2_STR}/template/{tid}")
    assert read_resp.status_code == 200, read_resp.text
    assert read_resp.json()["folder_id"] == home


@pytest.mark.asyncio
async def test_a_granted_reader_gets_no_payload_derived_data_and_no_config(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_user: Callable[..., Awaitable[User]],
    make_layer: Callable[..., Awaitable[Any]],
    roles: dict[str, UUID],
) -> None:
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()

    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )
    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Previewable",
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
                    "mode": "ship",
                    "layer_id": str(layer.id),
                    "layer_type": "feature",
                    "geometry_type": "polygon",
                }
            ],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]
    # A workflow payload has no page to label, and no descriptor is stored
    # for any payload — a reader's preview is the saved thumbnail.
    assert create_resp.json()["page_size"] is None
    assert "preview" not in create_resp.json()

    reader = await make_user()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('template', :t, 'user', :u, :r, :b)"
        ),
        {
            "t": UUID(tid),
            "u": reader.id,
            "r": roles["template-viewer"],
            "b": owner.id,
        },
    )
    await db_session.commit()
    reader_headers = {"Authorization": f"Bearer {_unverified_bearer(reader.id)}"}

    detail = await client.get(
        f"{settings.API_V2_STR}/template/{tid}",
        params={"include_config": "true"},
        headers=reader_headers,
    )
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["my_role"] == "viewer"
    assert body["config"] is None
    # Nothing derived from the payload reaches a reader: the dataset the
    # workflow ships is nowhere in what they get back.
    assert str(layer.id) not in json.dumps(
        {k: v for k, v in body.items() if k not in ("inputs", "datasets_needing_share")}
    )

    # The listing is scoped by space, and a direct grant puts the template in
    # none of the reader's own spaces — the GOAT shelf is how a non-owner
    # lists someone else's template, so publish it and read that shelf.
    await db_session.execute(
        text(f"UPDATE {S}.template SET catalog_status = 'published' WHERE id = :t"),
        {"t": UUID(tid)},
    )
    await db_session.commit()
    listing = await client.get(
        f"{settings.API_V2_STR}/template",
        params={"source": "goat"},
        headers=reader_headers,
    )
    assert listing.status_code == 200, listing.text
    row = next(i for i in listing.json()["items"] if i["id"] == tid)
    assert row["config"] is None


@pytest.mark.asyncio
async def test_a_layout_templates_page_is_stored_as_the_client_sent_it(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """The two values a layout card is labelled with are the client's: the
    server stores them verbatim and returns them to every reader, on the
    detail route and in the listing."""
    home = str(fixture_get_home_folder["id"])
    project_id = await _create_project(client, home, name="Paged")
    layout_id = await _create_layout(client, project_id, _layout_config())
    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Paged",
            "folder_id": home,
            "source": {
                "kind": "layout",
                "project_id": project_id,
                "layout_id": layout_id,
            },
            "inputs": [],
            "page_size": "A3",
            "page_orientation": "landscape",
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]
    assert create_resp.json()["page_size"] == "A3"
    assert create_resp.json()["page_orientation"] == "landscape"

    read_resp = await client.get(f"{settings.API_V2_STR}/template/{tid}")
    assert read_resp.status_code == 200, read_resp.text
    assert read_resp.json()["page_size"] == "A3"
    assert read_resp.json()["page_orientation"] == "landscape"

    listing = await client.get(
        f"{settings.API_V2_STR}/template", params={"source": "mine"}
    )
    assert listing.status_code == 200, listing.text
    row = next(i for i in listing.json()["items"] if i["id"] == tid)
    assert (row["page_size"], row["page_orientation"]) == ("A3", "landscape")

    # And a template saved without them simply carries none.
    plain = await _create_layout_template(client, folder_id=home, name="Unpaged")
    plain_resp = await client.get(f"{settings.API_V2_STR}/template/{plain}")
    assert plain_resp.status_code == 200, plain_resp.text
    assert plain_resp.json()["page_size"] is None
    assert plain_resp.json()["page_orientation"] is None


@pytest.mark.asyncio
async def test_a_patch_can_relabel_a_layout_templates_page(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """The page follows the config: a client that re-freezes a layout sends
    the page it now prints on with the same PATCH that carries the rest."""
    home = str(fixture_get_home_folder["id"])
    tid = await _create_layout_template(client, folder_id=home, name="Relabelled")

    patch_resp = await client.patch(
        f"{settings.API_V2_STR}/template/{tid}",
        json={"page_size": "Letter", "page_orientation": "portrait"},
    )
    assert patch_resp.status_code == 200, patch_resp.text
    assert patch_resp.json()["page_size"] == "Letter"
    assert patch_resp.json()["page_orientation"] == "portrait"


@pytest.mark.asyncio
async def test_a_template_shared_with_me_is_listed_under_all(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[Any]],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    """A grant on a template is how it reaches someone outside its space,
    and the pickers ask for `source=all` — so a shared template that is not
    in that answer cannot be used from a project or a workflow at all. It
    is still not "mine"."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )
    source = {"kind": "workflow", "project_id": project_id, "workflow_id": workflow_id}
    preview = await client.post(
        f"{settings.API_V2_STR}/template/preview",
        json={"source": source, "folder_id": home},
    )
    assert preview.status_code == 200, preview.text
    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Shared with a colleague",
            "folder_id": home,
            "source": source,
            "inputs": preview.json()["detected_inputs"],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]

    colleague = await make_user(owner.organization_id)
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('template', :t, 'user', :u, :r, :o)"
        ),
        {"t": tid, "u": colleague.id, "r": roles["template-viewer"], "o": owner.id},
    )
    await db_session.commit()
    headers = {"Authorization": f"Bearer {_unverified_bearer(colleague.id)}"}

    everything = await client.get(
        f"{settings.API_V2_STR}/template", params={"source": "all"}, headers=headers
    )
    assert everything.status_code == 200, everything.text
    shared = next((i for i in everything.json()["items"] if i["id"] == tid), None)
    assert shared is not None
    assert shared["my_role"] == "viewer"

    mine = await client.get(
        f"{settings.API_V2_STR}/template", params={"source": "mine"}, headers=headers
    )
    assert all(i["id"] != tid for i in mine.json()["items"])


@pytest.mark.asyncio
async def test_granting_a_template_shares_its_shipped_datasets(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_user: Callable[..., Awaitable[Any]],
    make_folder: Callable[..., Awaitable[Any]],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    """A shipped input only resolves for someone who may read its layer, so
    a template handed over without its datasets arrived as an empty
    workflow. The grant on the template now carries a viewer grant on each
    shipped dataset, the way saving into a team space already did."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )
    source = {"kind": "workflow", "project_id": project_id, "workflow_id": workflow_id}
    preview = await client.post(
        f"{settings.API_V2_STR}/template/preview",
        json={"source": source, "folder_id": home},
    )
    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Comes with its data",
            "folder_id": home,
            "source": source,
            "inputs": preview.json()["detected_inputs"],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]

    colleague = await make_user(owner.organization_id)
    colleague_folder = await make_folder(colleague)
    await db_session.commit()

    grant = await client.post(
        f"{settings.API_V2_STR}/template/{tid}/grant",
        json={
            "grantee_type": "user",
            "grantee_id": str(colleague.id),
            "role": "template-viewer",
        },
    )
    assert grant.status_code == 201, grant.text

    headers = {"Authorization": f"Bearer {_unverified_bearer(colleague.id)}"}
    use_resp = await client.post(
        f"{settings.API_V2_STR}/template/{tid}/use",
        json={"target_folder_id": str(colleague_folder.id)},
        headers=headers,
    )
    assert use_resp.status_code == 200, use_resp.text
    body = use_resp.json()
    assert body["unresolved_inputs"] == []
    assert len(body["added_layer_project_ids"]) == 1


@pytest.mark.asyncio
async def test_list_templates_filters_by_source(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    """The save dialog asks "which templates were saved from this workflow?"
    — a filter on the stored source reference, one condition per given id."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    wf_a = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )
    wf_b = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )

    async def save(workflow_id: str, name: str) -> str:
        source = {
            "kind": "workflow",
            "project_id": project_id,
            "workflow_id": workflow_id,
        }
        preview = await client.post(
            f"{settings.API_V2_STR}/template/preview",
            json={"source": source, "folder_id": home},
        )
        assert preview.status_code == 200, preview.text
        created = await client.post(
            f"{settings.API_V2_STR}/template",
            json={
                "name": name,
                "folder_id": home,
                "source": source,
                "inputs": preview.json()["detected_inputs"],
            },
        )
        assert created.status_code == 201, created.text
        return str(created.json()["id"])

    a1 = await save(wf_a, "A first")
    a2 = await save(wf_a, "A second")
    b1 = await save(wf_b, "B only")

    r = await client.get(
        f"{settings.API_V2_STR}/template",
        params={
            "source": "all",
            "source_project_id": project_id,
            "source_workflow_id": wf_a,
        },
    )
    assert r.status_code == 200, r.text
    ids = {i["id"] for i in r.json()["items"]}
    assert ids == {a1, a2}
    assert b1 not in ids

    r = await client.get(
        f"{settings.API_V2_STR}/template",
        params={"source": "all", "source_project_id": project_id},
    )
    assert {i["id"] for i in r.json()["items"]} >= {a1, a2, b1}


@pytest.mark.asyncio
async def test_read_resolves_the_source_and_its_availability(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    """The edit dialog links to where the template came from and disables
    "Update from source" when that is gone — names and a flag, resolved on
    the single read only."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()
    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )
    source = {"kind": "workflow", "project_id": project_id, "workflow_id": workflow_id}
    preview = await client.post(
        f"{settings.API_V2_STR}/template/preview",
        json={"source": source, "folder_id": home},
    )
    created = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Resolved",
            "folder_id": home,
            "source": source,
            "inputs": preview.json()["detected_inputs"],
        },
    )
    assert created.status_code == 201, created.text
    tid = created.json()["id"]

    read = await client.get(f"{settings.API_V2_STR}/template/{tid}")
    assert read.status_code == 200, read.text
    info = read.json()["source"]
    assert info["kind"] == "workflow"
    assert info["project_id"] == project_id
    assert info["workflow_id"] == workflow_id
    assert info["project_name"]
    assert info["workflow_name"]
    assert info["available"] is True

    # The list never pays for the resolution.
    listed = await client.get(
        f"{settings.API_V2_STR}/template", params={"source": "mine"}
    )
    row = next(i for i in listed.json()["items"] if i["id"] == tid)
    assert row["source"] is None

    # Delete the workflow: the reference stays, availability drops.
    deleted = await client.delete(
        f"{settings.API_V2_STR}/project/{project_id}/workflow/{workflow_id}"
    )
    assert deleted.status_code in (200, 204), deleted.text
    read = await client.get(f"{settings.API_V2_STR}/template/{tid}")
    info = read.json()["source"]
    assert info["workflow_id"] == workflow_id
    assert info["workflow_name"] is None
    assert info["available"] is False


@pytest.mark.asyncio
async def test_a_template_under_a_shared_folder_is_listed_under_all(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[Any]],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    """Most templates travel through a folder shared with a team or an
    organisation, not through a grant on the template itself. "Everyone"
    in the template browser has to reach them the way a single read does —
    through any folder above the template — or a colleague sees only their
    own templates there."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    # A shared folder with a subfolder: the template sits two levels down.
    shared_folder_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.folder (id, name, user_id, space_id, parent_id, updated_at) "
                "VALUES (gen_random_uuid(), 'shared', :u, :s, :p, now()) RETURNING id"
            ),
            {"u": owner.id, "s": home_folder.space_id, "p": home_folder.id},
        )
    ).scalar_one()
    sub_folder_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.folder (id, name, user_id, space_id, parent_id, updated_at) "
                "VALUES (gen_random_uuid(), 'nested', :u, :s, :p, now()) RETURNING id"
            ),
            {"u": owner.id, "s": home_folder.space_id, "p": shared_folder_id},
        )
    ).scalar_one()
    await db_session.commit()
    project_id = await _create_project(client, home)
    workflow_id = await _create_workflow(
        client, project_id, _dataset_workflow_config(layer.id)
    )
    source = {"kind": "workflow", "project_id": project_id, "workflow_id": workflow_id}
    preview = await client.post(
        f"{settings.API_V2_STR}/template/preview",
        json={"source": source, "folder_id": str(sub_folder_id)},
    )
    assert preview.status_code == 200, preview.text
    created = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Under a shared folder",
            "folder_id": str(sub_folder_id),
            "source": source,
            "inputs": preview.json()["detected_inputs"],
        },
    )
    assert created.status_code == 201, created.text
    tid = created.json()["id"]

    colleague = await make_user(owner.organization_id)
    # The grant sits on the top folder, two levels above the template.
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('folder', :f, 'user', :c, :r, :u)"
        ),
        {
            "f": shared_folder_id,
            "c": colleague.id,
            "r": roles["folder-viewer"],
            "u": owner.id,
        },
    )
    await db_session.commit()
    headers = {"Authorization": f"Bearer {_unverified_bearer(colleague.id)}"}

    everything = await client.get(
        f"{settings.API_V2_STR}/template", params={"source": "all"}, headers=headers
    )
    assert everything.status_code == 200, everything.text
    listed = next((i for i in everything.json()["items"] if i["id"] == tid), None)
    assert (
        listed is not None
    ), "a template under a shared folder is missing from Everyone"
    assert listed["my_role"] == "viewer"

    mine = await client.get(
        f"{settings.API_V2_STR}/template", params={"source": "mine"}, headers=headers
    )
    assert all(i["id"] != tid for i in mine.json()["items"])
