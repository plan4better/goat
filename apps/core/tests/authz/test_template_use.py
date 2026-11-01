"""Task 5: `POST /template/{id}/use` (T7) - every numbered step."""

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models.folder import Folder
from core.db.models.organization import Organization
from core.db.models.project import Project
from core.db.models.space import Space, SpaceDefaultRole, SpaceKind
from core.db.models.team import Team
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.test_content_feed import _unverified_bearer
from tests.authz.test_template_api import (
    _create_layout,
    _create_project,
    _create_workflow,
    _dataset_workflow_config,
    _layout_config,
)

S = settings.SCHEMA


async def _team_folder(db: AsyncSession, space_id: UUID, owner: UUID) -> UUID:
    """A team-space folder - `make_folder` only targets personal spaces."""
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
async def test_workflow_template_used_into_an_existing_project_links_and_binds(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    """Scenario 1: the dataset node binds to a NEW layer_project_id in the
    target project, the layer lands in a group named after the template,
    and unresolved_inputs is empty."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()

    source_project_id = await _create_project(client, home, name="source")
    workflow_id = await _create_workflow(
        client, source_project_id, _dataset_workflow_config(layer.id)
    )
    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Buffer workflow",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": source_project_id,
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

    target_project_id = await _create_project(client, home, name="target")

    use_resp = await client.post(
        f"{settings.API_V2_STR}/template/{tid}/use",
        json={"project_id": target_project_id},
    )
    assert use_resp.status_code == 200, use_resp.text
    body = use_resp.json()
    assert body["project_id"] == target_project_id
    assert body["workflow_id"] is not None
    assert body["layout_id"] is None
    assert len(body["added_layer_project_ids"]) == 1
    assert body["unresolved_inputs"] == []

    new_link_id = body["added_layer_project_ids"][0]
    link_row = (
        await db_session.execute(
            text(
                f"SELECT layer_id, layer_project_group_id FROM {S}.layer_project "
                "WHERE id = :id"
            ),
            {"id": new_link_id},
        )
    ).one()
    assert str(link_row.layer_id) == str(layer.id)
    assert link_row.layer_project_group_id is not None
    group_name = (
        await db_session.execute(
            text(f"SELECT name FROM {S}.layer_project_group WHERE id = :id"),
            {"id": link_row.layer_project_group_id},
        )
    ).scalar_one()
    assert group_name == "Buffer workflow"

    wf_resp = await client.get(
        f"{settings.API_V2_STR}/project/{target_project_id}/workflow/{body['workflow_id']}"
    )
    assert wf_resp.status_code == 200, wf_resp.text
    node_data = wf_resp.json()["config"]["nodes"][0]["data"]
    assert node_data["layerId"] == str(layer.id)
    assert node_data["projectLayerId"] == new_link_id
    assert "unresolved" not in node_data


@pytest.mark.asyncio
async def test_a_workflow_template_use_writes_the_description_it_is_given(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """The created workflow carries the use's description; a use without one
    leaves it empty."""
    home = str(fixture_get_home_folder["id"])
    source_project_id = await _create_project(client, home, name="source")
    workflow_id = await _create_workflow(
        client,
        source_project_id,
        {
            "nodes": [],
            "edges": [],
            "viewport": {"x": 0, "y": 0, "zoom": 1},
            "variables": [],
        },
    )
    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Empty workflow",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": source_project_id,
                "workflow_id": workflow_id,
            },
            "inputs": [],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]
    target_project_id = await _create_project(client, home, name="target")

    for description in ("Made by the assistant.\n\nThe template's own text.", None):
        use_resp = await client.post(
            f"{settings.API_V2_STR}/template/{tid}/use",
            json={"project_id": target_project_id, "description": description},
        )
        assert use_resp.status_code == 200, use_resp.text
        wf_resp = await client.get(
            f"{settings.API_V2_STR}/project/{target_project_id}"
            f"/workflow/{use_resp.json()['workflow_id']}"
        )
        assert wf_resp.status_code == 200, wf_resp.text
        assert wf_resp.json()["description"] == description


@pytest.mark.asyncio
async def test_stranger_who_cannot_read_the_shipped_dataset_gets_an_unresolved_input(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
    roles: dict[str, UUID],
) -> None:
    """Scenario 2: the template is shared to a stranger via a grant, but it
    ships a dataset its author may only view, so the template cannot pass it
    on (rule 6c) - using it leaves the input unresolved and adds no layer.
    Scenario 3: `bindings` with the stranger's own layer resolves it
    instead."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    lender = await make_user()
    layer = await make_layer(lender, await make_folder(lender))
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('layer', :l, 'user', :u, :r, :b)"
        ),
        {"l": layer.id, "u": owner.id, "r": roles["layer-viewer"], "b": lender.id},
    )
    await db_session.commit()

    source_project_id = await _create_project(client, home, name="source")
    workflow_id = await _create_workflow(
        client, source_project_id, _dataset_workflow_config(layer.id)
    )
    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Shared workflow",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": source_project_id,
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

    stranger = await make_user()
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
    stranger_folder = await make_folder(stranger)
    stranger_project = await make_project(stranger, stranger_folder)
    await db_session.commit()

    headers = {"Authorization": f"Bearer {_unverified_bearer(stranger.id)}"}

    use_resp = await client.post(
        f"{settings.API_V2_STR}/template/{tid}/use",
        json={"project_id": str(stranger_project.id)},
        headers=headers,
    )
    assert use_resp.status_code == 200, use_resp.text
    body = use_resp.json()
    assert body["added_layer_project_ids"] == []
    assert len(body["unresolved_inputs"]) == 1
    assert body["unresolved_inputs"][0]["key"] == "node:dataset-1"

    # Scenario 3: binding the stranger's own layer resolves it.
    stranger_layer = await make_layer(stranger, stranger_folder)
    await db_session.commit()

    bound_resp = await client.post(
        f"{settings.API_V2_STR}/template/{tid}/use",
        json={
            "project_id": str(stranger_project.id),
            "bindings": {"node:dataset-1": str(stranger_layer.id)},
        },
        headers=headers,
    )
    assert bound_resp.status_code == 200, bound_resp.text
    bound_body = bound_resp.json()
    assert bound_body["unresolved_inputs"] == []
    assert len(bound_body["added_layer_project_ids"]) == 1

    link_row = (
        await db_session.execute(
            text(f"SELECT layer_id FROM {S}.layer_project WHERE id = :id"),
            {"id": bound_body["added_layer_project_ids"][0]},
        )
    ).one()
    assert str(link_row.layer_id) == str(stranger_layer.id)


@pytest.mark.asyncio
async def test_layout_template_into_a_new_project_adds_no_layers(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """Scenario 4: a layout template used via `target_folder_id` creates a
    new project and inserts the layout, without touching any layers."""
    home = str(fixture_get_home_folder["id"])
    source_project_id = await _create_project(client, home, name="layout-src")
    layout_id = await _create_layout(client, source_project_id, _layout_config())

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "A layout",
            "folder_id": home,
            "source": {
                "kind": "layout",
                "project_id": source_project_id,
                "layout_id": layout_id,
            },
            "inputs": [],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]

    use_resp = await client.post(
        f"{settings.API_V2_STR}/template/{tid}/use",
        json={"target_folder_id": home},
    )
    assert use_resp.status_code == 200, use_resp.text
    body = use_resp.json()
    assert body["project_id"] != source_project_id
    assert body["layout_id"] is not None
    assert body["workflow_id"] is None
    assert body["added_layer_project_ids"] == []
    assert body["unresolved_inputs"] == []

    project_resp = await client.get(
        f"{settings.API_V2_STR}/project/{body['project_id']}"
    )
    assert project_resp.status_code == 200, project_resp.text
    assert project_resp.json()["folder_id"] == home

    layout_resp = await client.get(
        f"{settings.API_V2_STR}/project/{body['project_id']}/report-layout/{body['layout_id']}"
    )
    assert layout_resp.status_code == 200, layout_resp.text


@pytest.mark.asyncio
async def test_project_template_into_another_spaces_folder_leaves_the_source_untouched(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    """Scenario 5: using a project template into a folder that belongs to a
    DIFFERENT space places the copy there, and the frozen source copy
    (which lives in the source project's own space) is untouched."""
    me = fixture_create_user
    home = str(fixture_get_home_folder["id"])
    me_user = await db_session.get(User, me)
    assert me_user is not None

    source_project_id = await _create_project(client, home, name="dashboard-src")

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Dashboard template",
            "folder_id": home,
            "source": {"kind": "project", "project_id": source_project_id},
            "inputs": [],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]

    frozen_row = (
        await db_session.execute(
            text(f"SELECT source_project_id FROM {S}.template WHERE id = :t"),
            {"t": tid},
        )
    ).one()
    frozen_id = frozen_row.source_project_id
    frozen_before = (
        await db_session.execute(
            text(
                f"SELECT space_id, folder_id, name, deleted_at "
                f"FROM {S}.project WHERE id = :p"
            ),
            {"p": frozen_id},
        )
    ).one()

    org = await make_org()
    await db_session.execute(
        text(f'UPDATE {S}."user" SET organization_id = :o WHERE id = :u'),
        {"o": org.id, "u": me},
    )
    team = await make_team(me_user, org=org)
    team_space = await make_space(
        SpaceKind.team, team=team, default_role=SpaceDefaultRole.editor
    )
    team_folder_id = await _team_folder(db_session, team_space.id, me)
    await db_session.commit()

    use_resp = await client.post(
        f"{settings.API_V2_STR}/template/{tid}/use",
        json={"target_folder_id": str(team_folder_id), "name": "Team copy"},
    )
    assert use_resp.status_code == 200, use_resp.text
    body = use_resp.json()
    assert body["project_id"] != str(frozen_id)

    new_project_row = (
        await db_session.execute(
            text(f"SELECT space_id, folder_id, name FROM {S}.project WHERE id = :p"),
            {"p": body["project_id"]},
        )
    ).one()
    assert str(new_project_row.space_id) == str(team_space.id)
    assert str(new_project_row.folder_id) == str(team_folder_id)
    assert new_project_row.name == "Team copy"

    frozen_after = (
        await db_session.execute(
            text(
                f"SELECT space_id, folder_id, name, deleted_at "
                f"FROM {S}.project WHERE id = :p"
            ),
            {"p": frozen_id},
        )
    ).one()
    assert frozen_after.space_id == frozen_before.space_id
    assert frozen_after.folder_id == frozen_before.folder_id
    assert frozen_after.name == frozen_before.name
    assert frozen_after.deleted_at is None


async def _project_rows(db: AsyncSession, project_id: str) -> dict[str, int]:
    """How many layer entries, groups and workflows the project holds."""
    counts: dict[str, int] = {}
    for table in ("layer_project", "layer_project_group", "workflow"):
        counts[table] = (
            await db.execute(
                text(f"SELECT count(*) FROM {S}.{table} WHERE project_id = :p"),
                {"p": UUID(project_id)},
            )
        ).scalar_one()
    return counts


@pytest.mark.asyncio
async def test_a_use_preview_binds_the_config_and_writes_nothing(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
) -> None:
    """`POST /template/{id}/use/preview` answers with the config a use would
    write into the project, bound as the use binds it, and the inputs it
    would leave open. Nothing is linked, grouped or created. A layer the use
    would link anew has no projectLayerId yet; a layer the project already
    shows has its entry's."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    shipped = await make_layer(owner, home_folder)
    asked = await make_layer(owner, home_folder)
    mine = await make_layer(owner, home_folder)
    await db_session.commit()

    config = _dataset_workflow_config(shipped.id)
    second = _dataset_workflow_config(asked.id, node_id="dataset-2")["nodes"][0]
    config["nodes"].append({**second, "position": {"x": 0, "y": 200}})
    source_project_id = await _create_project(client, home, name="source")
    workflow_id = await _create_workflow(client, source_project_id, config)
    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Two inputs",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": source_project_id,
                "workflow_id": workflow_id,
            },
            "inputs": [
                {
                    "key": "node:dataset-1",
                    "label": "Input Layer",
                    "mode": "ship",
                    "layer_id": str(shipped.id),
                    "layer_type": "feature",
                    "geometry_type": "polygon",
                },
                {
                    "key": "node:dataset-2",
                    "label": "Asked Layer",
                    "mode": "ask",
                    "layer_type": "feature",
                    "geometry_type": "polygon",
                },
            ],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]

    target_project_id = await _create_project(client, home, name="target")
    linked = await client.post(
        f"{settings.API_V2_STR}/project/{target_project_id}/layer",
        params={"layer_ids": str(mine.id)},
    )
    assert linked.status_code == 200, linked.text
    mine_link = (
        await db_session.execute(
            text(
                f"SELECT id FROM {S}.layer_project "
                "WHERE project_id = :p AND layer_id = :l"
            ),
            {"p": UUID(target_project_id), "l": mine.id},
        )
    ).scalar_one()
    before = await _project_rows(db_session, target_project_id)

    preview = await client.post(
        f"{settings.API_V2_STR}/template/{tid}/use/preview",
        json={"project_id": target_project_id},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    nodes = {node["id"]: node["data"] for node in body["config"]["nodes"]}
    assert nodes["dataset-1"]["layerId"] == str(shipped.id)
    assert "projectLayerId" not in nodes["dataset-1"]
    assert "unresolved" not in nodes["dataset-1"]
    assert nodes["dataset-2"]["unresolved"] is True
    assert "layerId" not in nodes["dataset-2"]
    assert [item["key"] for item in body["unresolved_inputs"]] == ["node:dataset-2"]

    bound = await client.post(
        f"{settings.API_V2_STR}/template/{tid}/use/preview",
        json={
            "project_id": target_project_id,
            "bindings": {"node:dataset-2": str(mine.id)},
        },
    )
    assert bound.status_code == 200, bound.text
    bound_body = bound.json()
    data = next(
        node["data"]
        for node in bound_body["config"]["nodes"]
        if node["id"] == "dataset-2"
    )
    assert data["layerId"] == str(mine.id)
    assert data["projectLayerId"] == mine_link
    assert "unresolved" not in data
    assert bound_body["unresolved_inputs"] == []

    assert await _project_rows(db_session, target_project_id) == before


@pytest.mark.asyncio
async def test_a_use_preview_takes_a_workflow_template_and_what_a_use_takes(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_layer: Callable[..., Awaitable[Any]],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_project: Callable[..., Awaitable[Project]],
    roles: dict[str, UUID],
) -> None:
    """A layout template has no config to bind: 422. A user who may read the
    template but not write the project is refused as a use refuses them."""
    home = str(fixture_get_home_folder["id"])
    owner = await db_session.get(User, fixture_create_user)
    assert owner is not None
    home_folder = await db_session.get(Folder, UUID(home))
    assert home_folder is not None
    layer = await make_layer(owner, home_folder)
    await db_session.commit()
    target_project_id = await _create_project(client, home, name="target")

    layout_source = await _create_project(client, home, name="layout-src")
    layout_id = await _create_layout(client, layout_source, _layout_config())
    layout_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "A layout",
            "folder_id": home,
            "source": {
                "kind": "layout",
                "project_id": layout_source,
                "layout_id": layout_id,
            },
            "inputs": [],
        },
    )
    assert layout_resp.status_code == 201, layout_resp.text
    refused = await client.post(
        f"{settings.API_V2_STR}/template/{layout_resp.json()['id']}/use/preview",
        json={"project_id": target_project_id},
    )
    assert refused.status_code == 422, refused.text

    source_project_id = await _create_project(client, home, name="source")
    workflow_id = await _create_workflow(
        client, source_project_id, _dataset_workflow_config(layer.id)
    )
    workflow_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Buffer workflow",
            "folder_id": home,
            "source": {
                "kind": "workflow",
                "project_id": source_project_id,
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
    assert workflow_resp.status_code == 201, workflow_resp.text
    tid = workflow_resp.json()["id"]

    reader = await make_user()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('template', :t, 'user', :u, :r, :b)"
        ),
        {"t": UUID(tid), "u": reader.id, "r": roles["template-viewer"], "b": owner.id},
    )
    await db_session.commit()
    headers = {"Authorization": f"Bearer {_unverified_bearer(reader.id)}"}
    # The owner's project: the reader may not write it, so a use is refused.
    for path in ("use", "use/preview"):
        resp = await client.post(
            f"{settings.API_V2_STR}/template/{tid}/{path}",
            json={"project_id": target_project_id},
            headers=headers,
        )
        assert resp.status_code == 403, (path, resp.text)
    # Their own project: the preview binds there.
    reader_project = await make_project(reader, await make_folder(reader))
    await db_session.commit()
    allowed = await client.post(
        f"{settings.API_V2_STR}/template/{tid}/use/preview",
        json={"project_id": str(reader_project.id)},
        headers=headers,
    )
    assert allowed.status_code == 200, allowed.text

    # A user the template is not shared with, on a project of their own: the
    # preview is refused, with or without bindings, and names nothing of it.
    stranger = await make_user()
    stranger_folder = await make_folder(stranger)
    stranger_project = await make_project(stranger, stranger_folder)
    stranger_layer = await make_layer(stranger, stranger_folder)
    await db_session.commit()
    stranger_headers = {"Authorization": f"Bearer {_unverified_bearer(stranger.id)}"}
    for bindings in ({}, {"node:dataset-1": str(stranger_layer.id)}):
        refused = await client.post(
            f"{settings.API_V2_STR}/template/{tid}/use/preview",
            json={"project_id": str(stranger_project.id), "bindings": bindings},
            headers=stranger_headers,
        )
        assert refused.status_code == 403, refused.text
        assert set(refused.json()) == {"detail"}
        for secret in (str(layer.id), "Buffer workflow", "Input Layer", "dataset-1"):
            assert secret not in refused.text
