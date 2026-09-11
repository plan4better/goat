"""Task 5: soft delete, listing filters, restore, trash view.

Deleting a folder/project/bundle/layer sets `deleted_at` instead of removing
the row -- the subtree/members stay in the database (invisible to normal
listings and reads) so `GET /content/trash` + `POST /content/restore` can
bring them back. `effective_role` (Task 3) already hides a trashed item from
everyone but its space owner/admin.
"""

from collections.abc import Awaitable, Callable
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.crud.crud_space import space as crud_space
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.project import Project
from core.db.models.user import User
from core.endpoints.v2.bundle import (
    _authorize_bundle_read_or_project_reach,
    _bundle_reachable_via_project,
    list_bundle_layers,
    read_bundle_by_layer,
)
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


async def _folder(client: AsyncClient, name: str, parent: str | None = None) -> str:
    body: dict[str, object] = {"name": name}
    if parent:
        body["parent_id"] = parent
    r = await client.post(f"{settings.API_V2_STR}/folder", json=body)
    assert r.status_code in (200, 201), r.text
    return str(r.json()["id"])


async def _project(client: AsyncClient, folder_id: str, name: str = "p") -> str:
    r = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": name,
            "folder_id": folder_id,
            "initial_view_state": {
                "latitude": 48.1,
                "longitude": 11.5,
                "zoom": 10,
                "min_zoom": 0,
                "max_zoom": 20,
                "bearing": 0,
                "pitch": 0,
            },
        },
    )
    assert r.status_code in (200, 201), r.text
    return str(r.json()["id"])


@pytest.mark.asyncio
async def test_delete_is_soft_and_hides_the_subtree(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    top = await _folder(client, "top")
    child = await _folder(client, "child", top)
    pid = await _project(client, child)
    r = await client.delete(f"{settings.API_V2_STR}/folder/{top}")
    assert r.status_code in (200, 204), r.text
    rows = (
        await db_session.execute(
            text(f"SELECT id, deleted_at FROM {S}.folder WHERE id IN (:a, :b)"),
            {"a": top, "b": child},
        )
    ).all()
    assert len(rows) == 2 and all(
        r[1] is not None for r in rows
    ), "rows stay, deleted_at set"
    assert (
        await db_session.execute(
            text(f"SELECT deleted_at FROM {S}.project WHERE id = :p"), {"p": pid}
        )
    ).scalar_one() is not None
    listed = await client.get(f"{settings.API_V2_STR}/folder")
    assert top not in {f["id"] for f in listed.json()}
    projects = await client.get(
        f"{settings.API_V2_STR}/project", params={"page": 1, "size": 50}
    )
    assert pid not in {p["id"] for p in projects.json()["items"]}
    assert (await client.get(f"{settings.API_V2_STR}/project/{pid}")).status_code == 404


@pytest.mark.asyncio
async def test_trash_lists_and_restore_brings_back_the_subtree(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    top = await _folder(client, "top2")
    child = await _folder(client, "child2", top)
    pid = await _project(client, child)
    assert (await client.delete(f"{settings.API_V2_STR}/folder/{top}")).status_code in (
        200,
        204,
    )
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    trash = await client.get(
        f"{settings.API_V2_STR}/content/trash", params={"space_id": str(sid)}
    )
    assert trash.status_code == 200
    assert {(t["type"], t["id"]) for t in trash.json()} >= {
        ("folder", top)
    }, "the subtree root is listed once, not every descendant"
    r = await client.post(
        f"{settings.API_V2_STR}/content/restore",
        json={"items": [{"type": "folder", "id": top}]},
    )
    assert r.status_code == 204, r.text
    assert (
        await db_session.execute(
            text(
                f"SELECT count(*) FROM {S}.folder WHERE id IN (:a,:b) AND deleted_at IS NULL"
            ),
            {"a": top, "b": child},
        )
    ).scalar_one() == 2
    assert (await client.get(f"{settings.API_V2_STR}/project/{pid}")).status_code == 200


@pytest.mark.asyncio
async def test_deleting_a_published_project_unpublishes_it(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    pid = await _project(client, str(fixture_get_home_folder["id"]), "pub")
    r = await client.post(f"{settings.API_V2_STR}/project/{pid}/publish")
    assert r.status_code in (200, 201), r.text
    assert (
        await client.delete(f"{settings.API_V2_STR}/project/{pid}")
    ).status_code == 204
    assert (
        await db_session.execute(
            text(f"SELECT count(*) FROM {S}.project_public WHERE project_id = :p"),
            {"p": pid},
        )
    ).scalar_one() == 0
    assert (
        await client.get(f"{settings.API_V2_STR}/project/{pid}/public")
    ).status_code == 404


@pytest.mark.asyncio
async def test_restore_of_an_item_whose_folder_is_still_trashed_reparents_to_root(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    top = await _folder(client, "top3")
    child = await _folder(client, "child3", top)
    assert (await client.delete(f"{settings.API_V2_STR}/folder/{top}")).status_code in (
        200,
        204,
    )
    r = await client.post(
        f"{settings.API_V2_STR}/content/restore",
        json={"items": [{"type": "folder", "id": child}]},
    )
    assert r.status_code == 204
    parent = (
        await db_session.execute(
            text(f"SELECT parent_id, deleted_at FROM {S}.folder WHERE id = :c"),
            {"c": child},
        )
    ).one()
    assert parent[0] is None and parent[1] is None


@pytest.mark.asyncio
async def test_restore_reparented_to_root_auto_suffixes_a_colliding_name(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    """A folder reparented to root by restore (its own parent is still
    trashed) may land on a name a live root folder already holds — rather
    than a raw IntegrityError from the unique index, it gets auto-suffixed
    with the same ' (n)' scheme the spaces migration used."""
    await _folder(client, "dup")  # a live root folder named "dup"
    parent = await _folder(client, "soon-trashed")
    child = await _folder(client, "dup", parent)  # same name, nested
    assert (
        await client.delete(f"{settings.API_V2_STR}/folder/{parent}")
    ).status_code in (200, 204)

    r = await client.post(
        f"{settings.API_V2_STR}/content/restore",
        json={"items": [{"type": "folder", "id": child}]},
    )
    assert r.status_code == 204, r.text

    row = (
        await db_session.execute(
            text(f"SELECT parent_id, name FROM {S}.folder WHERE id = :c"),
            {"c": child},
        )
    ).one()
    assert row[0] is None, "reparented to root"
    assert row[1] == "dup (2)", "auto-suffixed against the live root already named dup"


@pytest.mark.asyncio
async def test_restored_layer_is_rehomed_not_orphaned(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    """Restoring a layer whose folder is still trashed re-homes it to the
    space's `home` root folder — exactly like a project or bundle — rather
    than clearing `folder_id` outright, which would leave it reachable
    through no folder listing at all."""
    space_id = (await crud_space.ensure_personal(db_session, fixture_create_user)).id
    folder_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.folder (id, name, user_id, space_id, updated_at) "
                "VALUES (gen_random_uuid(), 'soon-trashed', :u, :s, now()) RETURNING id"
            ),
            {"u": fixture_create_user, "s": space_id},
        )
    ).scalar_one()
    layer_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, user_id, space_id, folder_id, type, updated_at) "
                "VALUES (gen_random_uuid(), 'l', :u, :s, :f, 'table', now()) RETURNING id"
            ),
            {"u": fixture_create_user, "s": space_id, "f": folder_id},
        )
    ).scalar_one()
    await db_session.commit()
    assert (
        await client.delete(f"{settings.API_V2_STR}/folder/{folder_id}")
    ).status_code in (200, 204)

    r = await client.post(
        f"{settings.API_V2_STR}/content/restore",
        json={"items": [{"type": "layer", "id": str(layer_id)}]},
    )
    assert r.status_code == 204, r.text

    row = (
        await db_session.execute(
            text(f"SELECT folder_id, deleted_at FROM {S}.layer WHERE id = :l"),
            {"l": layer_id},
        )
    ).one()
    assert row[1] is None, "restored"
    assert row[0] is not None, "re-homed, not orphaned"
    home = (
        await db_session.execute(
            text(f"SELECT id, parent_id, name FROM {S}.folder WHERE id = :f"),
            {"f": row[0]},
        )
    ).one()
    assert home[1] is None and home[2] == "home", "the space's root home folder"
    # the API-visible layer read reports the same re-homed folder_id
    read = await client.get(f"{settings.API_V2_STR}/layer/{layer_id}")
    assert read.status_code == 200, read.text
    assert read.json()["folder_id"] == str(home[0])


@pytest.mark.asyncio
async def test_delete_layer_is_soft(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    """DELETE /layer/{id} (new route, Task 5) sets `deleted_at` instead of
    removing the row, and the layer disappears from a normal read."""
    space_id = (await crud_space.ensure_personal(db_session, fixture_create_user)).id
    layer_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, user_id, space_id, type, updated_at) "
                "VALUES (gen_random_uuid(), 'l', :u, :s, 'table', now()) RETURNING id"
            ),
            {"u": fixture_create_user, "s": space_id},
        )
    ).scalar_one()
    await db_session.commit()

    r = await client.delete(f"{settings.API_V2_STR}/layer/{layer_id}")
    assert r.status_code == 204, r.text

    assert (
        await db_session.execute(
            text(f"SELECT deleted_at FROM {S}.layer WHERE id = :l"), {"l": layer_id}
        )
    ).scalar_one() is not None
    assert (
        await client.get(f"{settings.API_V2_STR}/layer/{layer_id}")
    ).status_code == 404
    # Deleting it again 404s too — a trashed layer behaves as gone.
    assert (
        await client.delete(f"{settings.API_V2_STR}/layer/{layer_id}")
    ).status_code == 404


@pytest.mark.asyncio
async def test_delete_layer_refuses_a_bundle_member(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    """A layer that belongs to a bundle must be deleted through the bundle —
    DELETE /layer/{id} refuses it with 409 so the bundle stays together."""
    space_id = (await crud_space.ensure_personal(db_session, fixture_create_user)).id
    folder = await db_session.execute(
        text(
            f"INSERT INTO {S}.folder (id, name, user_id, space_id, updated_at) "
            "VALUES (gen_random_uuid(), 'bf', :u, :s, now()) RETURNING id"
        ),
        {"u": fixture_create_user, "s": space_id},
    )
    folder_id = folder.scalar_one()
    layer_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, user_id, space_id, folder_id, type, updated_at) "
                "VALUES (gen_random_uuid(), 'l2', :u, :s, :f, 'table', now()) RETURNING id"
            ),
            {"u": fixture_create_user, "s": space_id, "f": folder_id},
        )
    ).scalar_one()
    bundle_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, space_id, bundle_type, updated_at) "
                "VALUES (gen_random_uuid(), 'b', :u, :f, :s, 'street_network', now()) RETURNING id"
            ),
            {"u": fixture_create_user, "f": folder_id, "s": space_id},
        )
    ).scalar_one()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.bundle_layer (bundle_id, layer_id, role) "
            "VALUES (:b, :l, 'edges')"
        ),
        {"b": bundle_id, "l": layer_id},
    )
    await db_session.commit()

    r = await client.delete(f"{settings.API_V2_STR}/layer/{layer_id}")
    assert r.status_code == 409, r.text
    assert (
        await db_session.execute(
            text(f"SELECT deleted_at FROM {S}.layer WHERE id = :l"), {"l": layer_id}
        )
    ).scalar_one() is None


# --- Review round 1 fixes -----------------------------------------------
# Finding 1: GET /project/{id}/layer must exclude an individually-trashed
# layer, and must 404 once the project itself is trashed.


@pytest.mark.asyncio
async def test_trashed_layer_no_longer_listed_under_its_project(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    space_id = (await crud_space.ensure_personal(db_session, fixture_create_user)).id
    pid = await _project(client, str(fixture_get_home_folder["id"]), "proj-with-layer")
    layer_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, user_id, space_id, type, updated_at) "
                "VALUES (gen_random_uuid(), 'pl', :u, :s, 'table', now()) RETURNING id"
            ),
            {"u": fixture_create_user, "s": space_id},
        )
    ).scalar_one()
    await db_session.execute(
        text(
            f'INSERT INTO {S}.layer_project (layer_id, project_id, "order", name, updated_at) '
            "VALUES (:l, :p, 0, 'pl', now())"
        ),
        {"l": layer_id, "p": pid},
    )
    await db_session.commit()

    before = await client.get(f"{settings.API_V2_STR}/project/{pid}/layer")
    assert before.status_code == 200
    assert any(str(item.get("layer_id")) == str(layer_id) for item in before.json())

    assert (
        await client.delete(f"{settings.API_V2_STR}/layer/{layer_id}")
    ).status_code == 204

    after = await client.get(f"{settings.API_V2_STR}/project/{pid}/layer")
    assert after.status_code == 200
    assert not any(str(item.get("layer_id")) == str(layer_id) for item in after.json())


@pytest.mark.asyncio
async def test_trashed_projects_layer_route_404s(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    pid = await _project(client, str(fixture_get_home_folder["id"]), "proj-to-trash")
    assert (
        await client.delete(f"{settings.API_V2_STR}/project/{pid}")
    ).status_code == 204

    r = await client.get(f"{settings.API_V2_STR}/project/{pid}/layer")
    assert r.status_code == 404


# Finding 2: restoring a folder must only clear rows stamped with that
# folder's own deleted_at, not everything currently trashed under it.


@pytest.mark.asyncio
async def test_restore_of_a_folder_does_not_resurrect_independently_trashed_content(
    client: AsyncClient, db_session: AsyncSession, fixture_create_user: UUID
) -> None:
    top = await _folder(client, "batch-top")
    space_id = (await crud_space.ensure_personal(db_session, fixture_create_user)).id

    # X: deleted on its own, BEFORE the folder goes.
    x_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, user_id, space_id, folder_id, type, updated_at) "
                "VALUES (gen_random_uuid(), 'x', :u, :s, :f, 'table', now()) RETURNING id"
            ),
            {"u": fixture_create_user, "s": space_id, "f": top},
        )
    ).scalar_one()
    await db_session.commit()
    assert (
        await client.delete(f"{settings.API_V2_STR}/layer/{x_id}")
    ).status_code == 204

    # Y: still live when the folder is deleted — part of the same batch.
    y_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, user_id, space_id, folder_id, type, updated_at) "
                "VALUES (gen_random_uuid(), 'y', :u, :s, :f, 'table', now()) RETURNING id"
            ),
            {"u": fixture_create_user, "s": space_id, "f": top},
        )
    ).scalar_one()
    await db_session.commit()

    assert (
        await client.delete(f"{settings.API_V2_STR}/folder/{top}")
    ).status_code == 204

    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    r = await client.post(
        f"{settings.API_V2_STR}/content/restore",
        json={"items": [{"type": "folder", "id": top}]},
    )
    assert r.status_code == 204, r.text

    assert (
        await db_session.execute(
            text(f"SELECT deleted_at FROM {S}.folder WHERE id = :f"), {"f": top}
        )
    ).scalar_one() is None
    assert (
        await db_session.execute(
            text(f"SELECT deleted_at FROM {S}.layer WHERE id = :l"), {"l": y_id}
        )
    ).scalar_one() is None
    assert (
        await db_session.execute(
            text(f"SELECT deleted_at FROM {S}.layer WHERE id = :l"), {"l": x_id}
        )
    ).scalar_one() is not None

    trash = await client.get(
        f"{settings.API_V2_STR}/content/trash", params={"space_id": str(sid)}
    )
    assert {(t["type"], t["id"]) for t in trash.json()} >= {("layer", str(x_id))}


# Finding 3: a trashed bundle must 404 through the project-reach fallback
# too, not just through authorize_bundle's owner path.


@pytest.mark.asyncio
async def test_trashed_bundle_unreachable_via_project_editor_fallback(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[[User, Folder], Awaitable[Layer]],
    make_project: Callable[[User, Folder], Awaitable[Project]],
) -> None:
    """A shared-project editor can normally reach a bundle's membership
    through the project-reach fallback (see tests/authz/test_bundle_reachability.py)
    — but not once the bundle is trashed, on either route that uses it."""
    from core.db.models._link_model import LayerProjectLink

    project_owner = await make_user()
    editor = await make_user()
    project_folder = await make_folder(project_owner)
    project = await make_project(project_owner, project_folder)
    bundle_folder = await make_folder(project_owner)
    layer = await make_layer(project_owner, bundle_folder)
    bundle_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.bundle "
                "(id, name, user_id, folder_id, space_id, bundle_type, deleted_at, updated_at) "
                "VALUES (gen_random_uuid(), 'b', :u, :f, :s, 'street_network', now(), now()) "
                "RETURNING id"
            ),
            {"u": project_owner.id, "f": bundle_folder.id, "s": bundle_folder.space_id},
        )
    ).scalar_one()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.bundle_layer (bundle_id, layer_id, role) "
            "VALUES (:b, :l, 'edges')"
        ),
        {"b": bundle_id, "l": layer.id},
    )
    db_session.add(
        LayerProjectLink(layer_id=layer.id, project_id=project.id, name=layer.name)
    )
    await db_session.flush()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant "
            "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('project', :p, 'user', :g, :r, :o)"
        ),
        {
            "p": project.id,
            "g": editor.id,
            "r": roles["project-editor"],
            "o": project_owner.id,
        },
    )
    await db_session.commit()

    # The SQL-level guard alone already says unreachable once trashed.
    assert (
        await _bundle_reachable_via_project(db_session, bundle_id, editor.id) is False
    )

    with pytest.raises(HTTPException) as exc1:
        await _authorize_bundle_read_or_project_reach(db_session, bundle_id, editor.id)
    assert exc1.value.status_code == 404

    with pytest.raises(HTTPException) as exc2:
        await read_bundle_by_layer(
            async_session=db_session, user_id=editor.id, member_layer_id=layer.id
        )
    assert exc2.value.status_code == 404

    with pytest.raises(HTTPException) as exc3:
        await list_bundle_layers(
            async_session=db_session, user_id=editor.id, bundle_id=bundle_id
        )
    assert exc3.value.status_code == 404


# --- Review round 1, controller ruling on the "mutation routes" concern ---
# Every /project/{project_id}/... route that mutates must 404 on a trashed
# project, not just the reads covered above.


@pytest.mark.asyncio
async def test_restore_of_a_project_template_also_restores_its_frozen_copy(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """C1: deleting a project-payload template soft-deletes its hidden
    frozen source copy along with it (`crud_template.delete`) — restoring
    the template must mirror that and bring the frozen copy back too, not
    leave it silently trashed while the template itself reads as live."""
    home = str(fixture_get_home_folder["id"])
    pid = await _project(client, home, "template-src")

    create_resp = await client.post(
        f"{settings.API_V2_STR}/template",
        json={
            "name": "Restorable",
            "folder_id": home,
            "source": {"kind": "project", "project_id": pid},
            "inputs": [],
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    tid = create_resp.json()["id"]
    frozen_id = (
        await db_session.execute(
            text(f"SELECT source_project_id FROM {S}.template WHERE id = :t"),
            {"t": tid},
        )
    ).scalar_one()

    assert (
        await client.delete(f"{settings.API_V2_STR}/template/{tid}")
    ).status_code == 204
    assert (
        await db_session.execute(
            text(f"SELECT deleted_at FROM {S}.project WHERE id = :p"), {"p": frozen_id}
        )
    ).scalar_one() is not None, "frozen copy deleted alongside the template"

    r = await client.post(
        f"{settings.API_V2_STR}/content/restore",
        json={"items": [{"type": "template", "id": tid}]},
    )
    assert r.status_code == 204, r.text

    assert (
        await db_session.execute(
            text(f"SELECT deleted_at FROM {S}.template WHERE id = :t"), {"t": tid}
        )
    ).scalar_one() is None
    assert (
        await db_session.execute(
            text(f"SELECT deleted_at FROM {S}.project WHERE id = :p"), {"p": frozen_id}
        )
    ).scalar_one() is None, "frozen copy restored alongside the template"


@pytest.mark.asyncio
async def test_mutation_routes_404_on_a_trashed_project(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    pid = await _project(client, str(fixture_get_home_folder["id"]), "proj-mutate")
    assert (
        await client.delete(f"{settings.API_V2_STR}/project/{pid}")
    ).status_code == 204

    add_layer = await client.post(
        f"{settings.API_V2_STR}/project/{pid}/layer",
        params={"layer_ids": [str(uuid4())]},
    )
    assert add_layer.status_code == 404

    update = await client.put(
        f"{settings.API_V2_STR}/project/{pid}", json={"name": "renamed"}
    )
    assert update.status_code == 404

    publish = await client.post(f"{settings.API_V2_STR}/project/{pid}/publish")
    assert publish.status_code == 404
