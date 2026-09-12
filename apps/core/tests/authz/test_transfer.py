"""Task 8: Transfer — promote-only handoff of My Content into a team or the
organisation space (spec §3.3, D3, D6, D14).
"""

from typing import Awaitable, Callable
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.space import Space, SpaceKind
from core.db.models.team import Team
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

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


async def _setup(
    client: AsyncClient,
    db: AsyncSession,
    me: UUID,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> tuple[Organization, Team, Space, User]:
    org = await make_org()
    await db.execute(
        text(f'UPDATE {S}."user" SET organization_id = :o WHERE id = :u'),
        {"o": org.id, "u": me},
    )
    me_user = await db.get(User, me)
    assert me_user is not None
    mate = await make_user(org.id)
    team = await make_team(me_user, mate, org=org)
    space = await make_space(SpaceKind.team, team=team)
    await db.commit()
    return org, team, space, mate


@pytest.mark.asyncio
async def test_preview_splits_datasets_into_owned_and_not_owned(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    home = str(fixture_get_home_folder["id"])
    p = await client.post(
        f"{settings.API_V2_STR}/project",
        json={"name": "p", "folder_id": home, "initial_view_state": VIEW},
    )
    pid = p.json()["id"]
    mine = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, type, feature_layer_type, feature_layer_geometry_type, user_id, folder_id, space_id, updated_at) "
                f"SELECT gen_random_uuid(), 'mine', 'feature', 'standard', 'point', :u, :f, s.id, now() FROM {S}.space s WHERE s.user_id = :u RETURNING id"
            ),
            {"u": me, "f": home},
        )
    ).scalar_one()
    theirs = await make_layer(mate, await make_folder(mate))
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) VALUES ('layer', :l, 'user', :u, :r, :o)"
        ),
        {"l": theirs.id, "u": me, "r": roles["layer-viewer"], "o": mate.id},
    )
    for lid in (mine, theirs.id):
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer_project (layer_id, project_id, name, \"order\", updated_at) VALUES (:l, :p, 'x', 0, now())"
            ),
            {"l": lid, "p": pid},
        )
    await db_session.commit()

    r = await client.post(
        f"{settings.API_V2_STR}/content/transfer/preview",
        json={
            "items": [{"type": "project", "id": pid}],
            "target_space_id": str(space.id),
        },
    )
    assert r.status_code == 200, r.text
    ds = {d["id"]: d for d in r.json()["datasets"]}
    assert ds[str(mine)]["owned"] is True and ds[str(theirs.id)]["owned"] is False


@pytest.mark.asyncio
async def test_transfer_moves_project_and_selected_datasets_and_drops_user_grants(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    home = str(fixture_get_home_folder["id"])
    pid = (
        await client.post(
            f"{settings.API_V2_STR}/project",
            json={"name": "p", "folder_id": home, "initial_view_state": VIEW},
        )
    ).json()["id"]
    mine = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, type, feature_layer_type, feature_layer_geometry_type, user_id, folder_id, space_id, updated_at) "
                f"SELECT gen_random_uuid(), 'mine', 'feature', 'standard', 'point', :u, :f, s.id, now() FROM {S}.space s WHERE s.user_id = :u RETURNING id"
            ),
            {"u": me, "f": home},
        )
    ).scalar_one()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.layer_project (layer_id, project_id, name, \"order\", updated_at) VALUES (:l, :p, 'x', 0, now())"
        ),
        {"l": mine, "p": pid},
    )
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) VALUES ('project', :p, 'user', :u, :r, :o)"
        ),
        {"p": pid, "u": mate.id, "r": roles["project-viewer"], "o": me},
    )
    await db_session.commit()

    r = await client.post(
        f"{settings.API_V2_STR}/content/transfer",
        json={
            "items": [{"type": "project", "id": pid}],
            "target_space_id": str(space.id),
            "dataset_ids": [str(mine)],
            "leave_shortcut": True,
        },
    )
    assert r.status_code == 200, r.text
    assert (
        r.json()["moved"]
        == {"folder": 0, "project": 1, "layer": 1, "bundle": 0, "template": 0}
        and r.json()["shortcuts"] == 1
    )
    assert (
        await db_session.execute(
            text(f"SELECT space_id FROM {S}.project WHERE id = :p"), {"p": pid}
        )
    ).scalar_one() == space.id
    assert (
        await db_session.execute(
            text(f"SELECT space_id FROM {S}.layer WHERE id = :l"), {"l": mine}
        )
    ).scalar_one() == space.id
    moved_layer_folder_id = (
        await db_session.execute(
            text(f"SELECT folder_id FROM {S}.layer WHERE id = :l"), {"l": mine}
        )
    ).scalar_one()
    assert moved_layer_folder_id is not None, (
        "layer's own folder did not move along, so it lands in the "
        "target space's home folder rather than losing its folder"
    )
    target_home = (
        await db_session.execute(
            text(f"SELECT parent_id, name FROM {S}.folder WHERE id = :f"),
            {"f": moved_layer_folder_id},
        )
    ).one()
    assert target_home == (None, "home")
    assert (
        await db_session.execute(
            text(
                f"SELECT count(*) FROM {S}.resource_grant WHERE resource_id = :p AND grantee_type = 'user'"
            ),
            {"p": pid},
        )
    ).scalar_one() == 0, "1:1 shares removed"
    assert (
        await db_session.execute(
            text(f"SELECT {S}.effective_role('project', :p, :u)"),
            {"p": pid, "u": mate.id},
        )
    ).scalar_one() == "editor", "membership takes over (team default)"
    assert (
        await db_session.execute(
            text(f"SELECT {S}.effective_role('project', :p, :u)"), {"p": pid, "u": me}
        )
    ).scalar_one() == "editor", "the transferer is now just a member"
    assert (
        await db_session.execute(
            text(
                f"SELECT count(*) FROM {S}.content_transfer WHERE item_id = :p AND details->>'status' = 'done'"
            ),
            {"p": pid},
        )
    ).scalar_one() == 1
    assert (
        await db_session.execute(
            text(f"SELECT count(*) FROM {S}.content_shortcut WHERE target_id = :p"),
            {"p": pid},
        )
    ).scalar_one() == 1


@pytest.mark.asyncio
async def test_transfer_refuses_non_owner_non_member_and_other_organisation(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    theirs = await make_layer(mate, await make_folder(mate))
    other_org = await make_org()
    stranger = await make_user(other_org.id)
    other_team = await make_team(stranger, org=other_org)
    other_space = await make_space(SpaceKind.team, team=other_team)
    not_my_team = await make_team(mate, org=org)  # I am not a member
    not_my_space = await make_space(SpaceKind.team, team=not_my_team)
    await db_session.commit()
    body = {
        "items": [{"type": "layer", "id": str(theirs.id)}],
        "target_space_id": str(space.id),
        "dataset_ids": [],
        "leave_shortcut": False,
    }
    assert (
        await client.post(f"{settings.API_V2_STR}/content/transfer", json=body)
    ).status_code == 403, "not the owner"
    pid = (
        await client.post(
            f"{settings.API_V2_STR}/project",
            json={
                "name": "p",
                "folder_id": str(fixture_get_home_folder["id"]),
                "initial_view_state": VIEW,
            },
        )
    ).json()["id"]
    body = {
        "items": [{"type": "project", "id": pid}],
        "target_space_id": str(not_my_space.id),
        "dataset_ids": [],
        "leave_shortcut": False,
    }
    assert (
        await client.post(f"{settings.API_V2_STR}/content/transfer", json=body)
    ).status_code == 403, "not a member of the target"
    body["target_space_id"] = str(other_space.id)
    assert (
        await client.post(f"{settings.API_V2_STR}/content/transfer", json=body)
    ).status_code == 403, "never across organisations"


@pytest.mark.asyncio
async def test_folder_transfer_moves_the_subtree(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    top = (
        await client.post(f"{settings.API_V2_STR}/folder", json={"name": "top"})
    ).json()["id"]
    child = (
        await client.post(
            f"{settings.API_V2_STR}/folder", json={"name": "child", "parent_id": top}
        )
    ).json()["id"]
    await client.post(
        f"{settings.API_V2_STR}/project",
        json={"name": "p", "folder_id": child, "initial_view_state": VIEW},
    )
    r = await client.post(
        f"{settings.API_V2_STR}/content/transfer",
        json={
            "items": [{"type": "folder", "id": top}],
            "target_space_id": str(space.id),
            "dataset_ids": [],
            "leave_shortcut": False,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["moved"]["folder"] == 2 and r.json()["moved"]["project"] == 1
    rows = (
        await db_session.execute(
            text(
                f"SELECT space_id, parent_id FROM {S}.folder WHERE id IN (:a, :b) ORDER BY parent_id NULLS FIRST"
            ),
            {"a": top, "b": child},
        )
    ).all()
    assert (
        all(r[0] == space.id for r in rows)
        and rows[0][1] is None
        and rows[1][1] == UUID(top)
    )


@pytest.mark.asyncio
async def test_folder_transfer_moves_a_three_level_subtree(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    """Regression: `folder_depth_check` fires per-row on `UPDATE OF
    space_id`, and a single multi-row `UPDATE ... WHERE id = ANY(:ids)`
    processes rows in an unspecified order — with only 2 levels this can
    happen to pick a safe order and pass by luck. 3 levels (root, child,
    grandchild) gives Postgres 6 possible orderings, only 1 of them safe
    without `crud_transfer.transfer`'s parent-before-child, level-by-level
    UPDATEs — a much more reliable regression guard than 2."""
    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    root = (
        await client.post(f"{settings.API_V2_STR}/folder", json={"name": "root"})
    ).json()["id"]
    child = (
        await client.post(
            f"{settings.API_V2_STR}/folder", json={"name": "child", "parent_id": root}
        )
    ).json()["id"]
    grandchild = (
        await client.post(
            f"{settings.API_V2_STR}/folder",
            json={"name": "grandchild", "parent_id": child},
        )
    ).json()["id"]

    r = await client.post(
        f"{settings.API_V2_STR}/content/transfer",
        json={
            "items": [{"type": "folder", "id": root}],
            "target_space_id": str(space.id),
            "dataset_ids": [],
            "leave_shortcut": False,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["moved"]["folder"] == 3

    rows = (
        await db_session.execute(
            text(
                f"SELECT id, space_id, parent_id FROM {S}.folder "
                "WHERE id IN (:a, :b, :c)"
            ),
            {"a": root, "b": child, "c": grandchild},
        )
    ).all()
    by_id = {str(r[0]): (r[1], r[2]) for r in rows}
    assert by_id[root] == (space.id, None)
    assert by_id[child] == (space.id, UUID(root))
    assert by_id[grandchild] == (space.id, UUID(child))


@pytest.mark.asyncio
async def test_folder_transfer_moves_trashed_descendants_and_reports_them(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    """A folder's trashed descendants move along (space_id changes, deleted_at
    doesn't) rather than being left behind pointing cross-space — but
    explicitly counted/warned about in preview and audited on transfer."""
    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    # `me` is a plain team member (rank 2) from _setup; listing the target
    # space's trash requires "delete", i.e. space_rank 3 (owner/admin) —
    # promote `me` to team-owner on this team so the final assertion below
    # (trash listing for a target-space owner) is meaningful.
    await db_session.execute(
        text(
            f"UPDATE {S}.user_team SET role_id = :r WHERE team_id = :t AND user_id = :u"
        ),
        {"r": roles["team-owner"], "t": team.id, "u": me},
    )
    top = (
        await client.post(f"{settings.API_V2_STR}/folder", json={"name": "F"})
    ).json()["id"]
    await client.post(
        f"{settings.API_V2_STR}/folder", json={"name": "C1", "parent_id": top}
    )
    c2 = (
        await client.post(
            f"{settings.API_V2_STR}/folder", json={"name": "C2", "parent_id": top}
        )
    ).json()["id"]
    pid = (
        await client.post(
            f"{settings.API_V2_STR}/project",
            json={
                "name": "trashed-p",
                "folder_id": c2,
                "initial_view_state": VIEW,
            },
        )
    ).json()["id"]
    assert (
        await client.delete(f"{settings.API_V2_STR}/folder/{c2}")
    ).status_code == 204
    await db_session.commit()

    preview = await client.post(
        f"{settings.API_V2_STR}/content/transfer/preview",
        json={
            "items": [{"type": "folder", "id": top}],
            "target_space_id": str(space.id),
        },
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["trashed_in_subtrees"] == 2
    assert any(
        "trashed items move along" in w for w in preview.json()["warnings"]
    ), preview.json()["warnings"]

    r = await client.post(
        f"{settings.API_V2_STR}/content/transfer",
        json={
            "items": [{"type": "folder", "id": top}],
            "target_space_id": str(space.id),
            "dataset_ids": [],
            "leave_shortcut": False,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["moved"]["folder"] == 2, "F and C1 only — C2 is trashed"
    assert r.json()["trashed_moved"] == 2, "C2 and its project"

    folder_row = (
        await db_session.execute(
            text(f"SELECT space_id, deleted_at FROM {S}.folder WHERE id = :c"),
            {"c": c2},
        )
    ).one()
    assert (
        folder_row[0] == space.id and folder_row[1] is not None
    ), "C2 moved but stays trashed"
    project_row = (
        await db_session.execute(
            text(f"SELECT space_id, deleted_at FROM {S}.project WHERE id = :p"),
            {"p": pid},
        )
    ).one()
    assert (
        project_row[0] == space.id and project_row[1] is not None
    ), "its project moved but stays trashed"

    details = (
        await db_session.execute(
            text(f"SELECT details FROM {S}.content_transfer WHERE item_id = :t"),
            {"t": top},
        )
    ).scalar_one()
    assert set(details["trashed_moved"]) == {c2, pid}

    trash = await client.get(
        f"{settings.API_V2_STR}/content/trash", params={"space_id": str(space.id)}
    )
    assert trash.status_code == 200, trash.text
    assert c2 in {i["id"] for i in trash.json()}


@pytest.mark.asyncio
async def test_foreign_layer_under_my_folder_is_not_moved(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    """A layer's folder_id pointing into my folder is not, on its own, proof
    it belongs to my subtree — only its own space_id is. A layer stuck in
    someone else's space (dangling/foreign folder_id, e.g. from a data
    inconsistency) must be neither moved nor stripped of its grants."""
    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    top = (
        await client.post(f"{settings.API_V2_STR}/folder", json={"name": "top"})
    ).json()["id"]

    foreign = await make_user(org.id)
    foreign_space_id = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"), {"u": foreign.id}
        )
    ).scalar_one_or_none()
    if foreign_space_id is None:
        foreign_space_id = (
            await db_session.execute(
                text(
                    f"INSERT INTO {S}.space (kind, user_id, default_role, updated_at) "
                    "VALUES ('personal', :u, 'editor', now()) RETURNING id"
                ),
                {"u": foreign.id},
            )
        ).scalar_one()
    foreign_layer_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, user_id, folder_id, space_id, name, "
                "type, feature_layer_type, feature_layer_geometry_type, updated_at) "
                "VALUES (gen_random_uuid(), :u, :f, :s, 'foreign layer', 'feature', "
                "'standard', 'polygon', now()) RETURNING id"
            ),
            {"u": foreign.id, "f": UUID(top), "s": foreign_space_id},
        )
    ).scalar_one()
    await db_session.commit()

    preview = await client.post(
        f"{settings.API_V2_STR}/content/transfer/preview",
        json={
            "items": [{"type": "folder", "id": top}],
            "target_space_id": str(space.id),
        },
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["skipped_foreign"] == 1
    assert any("belong to a different space" in w for w in preview.json()["warnings"])

    r = await client.post(
        f"{settings.API_V2_STR}/content/transfer",
        json={
            "items": [{"type": "folder", "id": top}],
            "target_space_id": str(space.id),
            "dataset_ids": [],
            "leave_shortcut": False,
        },
    )
    assert r.status_code == 200, r.text

    row = (
        await db_session.execute(
            text(f"SELECT space_id FROM {S}.layer WHERE id = :l"),
            {"l": foreign_layer_id},
        )
    ).scalar_one()
    assert row == foreign_space_id, "the foreign layer never moved"


@pytest.mark.asyncio
async def test_transfer_of_a_template_leaves_no_shortcut(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    """C2: `_leave_shortcuts` has no `content_shortcut` branch for templates
    in the space view yet, so transferring one with `leave_shortcut=True`
    must count 0 shortcuts and insert no row — not silently insert one
    nothing ever renders."""
    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    home = str(fixture_get_home_folder["id"])
    pid = (
        await client.post(
            f"{settings.API_V2_STR}/project",
            json={"name": "p", "folder_id": home, "initial_view_state": VIEW},
        )
    ).json()["id"]
    layout_id = (
        await client.post(
            f"{settings.API_V2_STR}/project/{pid}/report-layout",
            json={
                "name": "layout",
                "config": {
                    "page": {
                        "size": "A4",
                        "orientation": "portrait",
                        "margins": {"top": 10, "right": 10, "bottom": 10, "left": 10},
                    },
                    "layout": {"type": "grid", "columns": 12, "rows": 12, "gap": 5},
                    "elements": [],
                    "theme": None,
                    "atlas": None,
                },
            },
        )
    ).json()["id"]
    tid = (
        await client.post(
            f"{settings.API_V2_STR}/template",
            json={
                "name": "Transferable",
                "folder_id": home,
                "source": {
                    "kind": "layout",
                    "project_id": pid,
                    "layout_id": layout_id,
                },
                "inputs": [],
            },
        )
    ).json()["id"]

    r = await client.post(
        f"{settings.API_V2_STR}/content/transfer",
        json={
            "items": [{"type": "template", "id": tid}],
            "target_space_id": str(space.id),
            "dataset_ids": [],
            "leave_shortcut": True,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["moved"]["template"] == 1
    assert r.json()["shortcuts"] == 0

    assert (
        await db_session.execute(
            text(f"SELECT count(*) FROM {S}.content_shortcut WHERE target_id = :t"),
            {"t": tid},
        )
    ).scalar_one() == 0


@pytest.mark.asyncio
async def test_foreign_layer_in_my_bundle_is_not_moved(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    """D3: `POST /bundle/{id}/layers` only checks the caller owns the layer,
    so a bundle's membership can name a layer that lives in another space.
    Transferring the bundle must move only the members in the caller's own
    personal space — the foreign one keeps its space and its user grants,
    and is reported in `skipped_foreign`."""

    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    home = UUID(str(fixture_get_home_folder["id"]))
    my_space_id = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"), {"u": me}
        )
    ).scalar_one()

    bundle_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.bundle (id, name, user_id, folder_id, space_id, bundle_type, updated_at) "
                "VALUES (gen_random_uuid(), 'net', :u, :f, :s, 'street_network', now()) RETURNING id"
            ),
            {"u": me, "f": home, "s": my_space_id},
        )
    ).scalar_one()
    my_member_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, user_id, folder_id, space_id, name, "
                "type, feature_layer_type, feature_layer_geometry_type, updated_at) "
                "VALUES (gen_random_uuid(), :u, :f, :s, 'edges', 'feature', "
                "'standard', 'line', now()) RETURNING id"
            ),
            {"u": me, "f": home, "s": my_space_id},
        )
    ).scalar_one()

    foreign_space_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.space (kind, team_id, default_role, updated_at) "
                "VALUES ('team', :t, 'editor', now()) RETURNING id"
            ),
            {"t": (await make_team(mate, org=org)).id},
        )
    ).scalar_one()
    foreign_layer_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, user_id, folder_id, space_id, name, "
                "type, feature_layer_type, feature_layer_geometry_type, updated_at) "
                "VALUES (gen_random_uuid(), :u, :f, :s, 'nodes', 'feature', "
                "'standard', 'point', now()) RETURNING id"
            ),
            {"u": mate.id, "f": home, "s": foreign_space_id},
        )
    ).scalar_one()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
            "VALUES ('layer', :l, 'user', :u, :r, :o)"
        ),
        {"l": foreign_layer_id, "u": me, "r": roles["layer-viewer"], "o": mate.id},
    )
    for layer_id, role in ((my_member_id, "edges"), (foreign_layer_id, "nodes")):
        await db_session.execute(
            text(
                f"INSERT INTO {S}.bundle_layer (bundle_id, layer_id, role) VALUES (:b, :l, :r)"
            ),
            {"b": bundle_id, "l": layer_id, "r": role},
        )
    await db_session.commit()

    preview = await client.post(
        f"{settings.API_V2_STR}/content/transfer/preview",
        json={
            "items": [{"type": "bundle", "id": str(bundle_id)}],
            "target_space_id": str(space.id),
        },
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["skipped_foreign"] == 1
    assert any("belong to a different space" in w for w in preview.json()["warnings"])

    r = await client.post(
        f"{settings.API_V2_STR}/content/transfer",
        json={
            "items": [{"type": "bundle", "id": str(bundle_id)}],
            "target_space_id": str(space.id),
            "dataset_ids": [],
            "leave_shortcut": False,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["moved"]["layer"] == 1, "only the member in my own space moves"

    rows = dict(
        (
            await db_session.execute(
                text(f"SELECT id, space_id FROM {S}.layer WHERE id IN (:a, :b)"),
                {"a": my_member_id, "b": foreign_layer_id},
            )
        ).all()  # type: ignore[arg-type]
    )
    assert rows[my_member_id] == space.id
    assert rows[foreign_layer_id] == foreign_space_id, "the foreign layer never moved"
    assert (
        await db_session.execute(
            text(
                f"SELECT count(*) FROM {S}.resource_grant WHERE resource_type = 'layer' "
                "AND resource_id = :l AND grantee_type = 'user'"
            ),
            {"l": foreign_layer_id},
        )
    ).scalar_one() == 1, "its user grants are left alone"


@pytest.mark.asyncio
async def test_transferring_a_folder_with_its_own_descendant_keeps_the_subtree(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    """Selecting a folder AND something already inside it is one transfer of
    one subtree: only the outermost folder becomes a root in the target, the
    descendant keeps its parent. Clearing `parent_id` on both would lift the
    child out and drop it flat on the target's root."""
    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    root = (
        await client.post(f"{settings.API_V2_STR}/folder", json={"name": "root"})
    ).json()["id"]
    child = (
        await client.post(
            f"{settings.API_V2_STR}/folder", json={"name": "child", "parent_id": root}
        )
    ).json()["id"]
    grandchild = (
        await client.post(
            f"{settings.API_V2_STR}/folder",
            json={"name": "grandchild", "parent_id": child},
        )
    ).json()["id"]

    r = await client.post(
        f"{settings.API_V2_STR}/content/transfer",
        json={
            "items": [
                {"type": "folder", "id": child},
                {"type": "folder", "id": root},
            ],
            "target_space_id": str(space.id),
            "dataset_ids": [],
            "leave_shortcut": False,
        },
    )
    assert r.status_code == 200, r.text

    rows = (
        await db_session.execute(
            text(
                f"SELECT id, space_id, parent_id FROM {S}.folder "
                "WHERE id IN (:a, :b, :c)"
            ),
            {"a": root, "b": child, "c": grandchild},
        )
    ).all()
    by_id = {str(row[0]): (row[1], row[2]) for row in rows}
    assert by_id[root] == (space.id, None)
    assert by_id[child] == (space.id, UUID(root)), "the child stays under its parent"
    assert by_id[grandchild] == (space.id, UUID(child))


@pytest.mark.asyncio
async def test_a_nested_selected_folder_is_not_name_checked_as_a_root(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    make_team: Callable[..., Awaitable[Team]],
    make_space: Callable[..., Awaitable[Space]],
) -> None:
    """A selected folder that travels inside another selected folder never
    lands on the target's root, so its name cannot collide with one — a
    sub-folder called 'home' must not refuse the whole transfer."""
    me = fixture_create_user
    org, team, space, mate = await _setup(
        client, db_session, me, roles, make_org, make_user, make_team, make_space
    )
    root = (
        await client.post(f"{settings.API_V2_STR}/folder", json={"name": "outer"})
    ).json()["id"]
    child = (
        await client.post(
            f"{settings.API_V2_STR}/folder", json={"name": "home", "parent_id": root}
        )
    ).json()["id"]

    r = await client.post(
        f"{settings.API_V2_STR}/content/transfer",
        json={
            "items": [
                {"type": "folder", "id": root},
                {"type": "folder", "id": child},
            ],
            "target_space_id": str(space.id),
            "dataset_ids": [],
            "leave_shortcut": False,
        },
    )
    assert r.status_code == 200, r.text
    parent = (
        await db_session.execute(
            text(f"SELECT parent_id FROM {S}.folder WHERE id = :c"), {"c": child}
        )
    ).scalar_one()
    assert parent == UUID(root)
