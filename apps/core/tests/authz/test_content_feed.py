"""Task 7: the unified feed — `GET /content`.

Backs Phase 3's Content page, which replaces the old client-merged
Datasets/Projects pages with one feed over four content tables (folder,
project, layer, bundle) plus a "shared with me" and a "recent" view.
"""

import base64
import json
from typing import Any, Awaitable, Callable, cast
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.crud.crud_space import space as crud_space
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA


async def _feed(
    client: AsyncClient, **params: str | int | float | bool | None
) -> dict[str, Any]:
    r = await client.get(
        f"{settings.API_V2_STR}/content",
        params={k: v for k, v in params.items() if v is not None},
    )
    assert r.status_code == 200, r.text
    return dict(r.json())


def _unverified_bearer(user_id: UUID, *, roles: list[str] | None = None) -> str:
    """A JWT-shaped (but unsigned) bearer token carrying `sub`, and
    `realm_access.roles` when `roles` is given.

    `get_user_id` (endpoints/deps.py) reads `sub` via
    `jwt.get_unverified_claims` regardless of `AUTH`, so this is enough to
    make the test client act as a different caller under `AUTH=False` —
    `auth_z` itself never inspects the signature in that mode either. With
    `roles` omitted the claims carry no `realm_access` at all, matching
    every existing caller's expectation that this token holds no roles
    (e.g. `is_superuser`/`require_superuser` reject it).
    """

    def _segment(payload: dict[str, Any]) -> str:
        return (
            base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        )

    claims: dict[str, Any] = {"sub": str(user_id)}
    if roles is not None:
        claims["realm_access"] = {"roles": roles}
    return f"{_segment({'alg': 'none', 'typ': 'JWT'})}.{_segment(claims)}.sig"


@pytest.mark.asyncio
async def test_space_view_lists_children_with_folders_first(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    f = await client.post(f"{settings.API_V2_STR}/folder", json={"name": "Surveys"})
    fid = f.json()["id"]
    p = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": "zzz project",
            "folder_id": str(fixture_get_home_folder["id"]),
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
    assert p.status_code in (200, 201), p.text
    page = await _feed(client, space_id=str(sid))
    types = [i["type"] for i in page["items"]]
    assert types.index("folder") < types.index("project"), "folders first"
    ids = {i["id"] for i in page["items"]}
    assert fid in ids and p.json()["id"] in ids
    assert all(i["my_role"] == "owner" for i in page["items"])
    assert all(
        i["restricted"] is False and i["restricted_inherited"] is False
        for i in page["items"]
    ), "nothing is restricted unless it was marked so"
    inside = await _feed(client, space_id=str(sid), folder_id=fid)
    assert inside["items"] == []


@pytest.mark.asyncio
async def test_shared_with_me_lists_user_grants_and_folder_grants_only(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    me = fixture_create_user
    org = await make_org()
    await db_session.execute(
        text(f'UPDATE {S}."user" SET organization_id = :o WHERE id = :u'),
        {"o": org.id, "u": me},
    )
    other = await make_user(org.id)
    their_folder = await make_folder(other, "theirs")
    shared_layer = await make_layer(other, their_folder)
    private_layer = await make_layer(other, their_folder)
    folder_shared = await make_folder(other, "shared folder")
    inside = await make_layer(other, folder_shared)
    g = (
        f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, "
        "grantee_id, role_id, granted_by) VALUES (:t, :r, 'user', :u, :role, :o)"
    )
    await db_session.execute(
        text(g),
        {
            "t": "layer",
            "r": shared_layer.id,
            "u": me,
            "role": roles["layer-viewer"],
            "o": other.id,
        },
    )
    await db_session.execute(
        text(g),
        {
            "t": "folder",
            "r": folder_shared.id,
            "u": me,
            "role": roles["folder-editor"],
            "o": other.id,
        },
    )
    await db_session.commit()
    page = await _feed(client, view="shared_with_me")
    got = {(i["type"], i["id"]) for i in page["items"]}
    assert ("layer", str(shared_layer.id)) in got
    assert (
        "folder",
        str(folder_shared.id),
    ) in got, "the shared folder is listed as a folder"
    assert (
        "layer",
        str(inside.id),
    ) not in got, "its contents are reached by opening it, not flattened"
    assert ("layer", str(private_layer.id)) not in got
    roles_by_id = {i["id"]: i["my_role"] for i in page["items"]}
    assert (
        roles_by_id[str(shared_layer.id)] == "viewer"
        and roles_by_id[str(folder_shared.id)] == "editor"
    )


@pytest.mark.asyncio
async def test_orphan_folder_with_a_team_grant_is_unreachable_in_shared_listings(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_team: Callable[..., Awaitable[Any]],
) -> None:
    """A folder with no space AND no user (a genuine orphan — its owning row
    is gone) must not be resurrected into a listing just because a stale
    team grant on it still exists: neither `GET /folder` (through
    `create_query_accessible_folders`'s shared branches) nor `GET
    /content?view=shared_with_me` (through crud_content's own space_id
    check) may surface it."""
    me = fixture_create_user
    org = await make_org()
    await db_session.execute(
        text(f'UPDATE {S}."user" SET organization_id = :o WHERE id = :u'),
        {"o": org.id, "u": me},
    )
    me_user = await db_session.get(User, me)
    assert me_user is not None
    team = await make_team(me_user, org=org)
    orphan_folder_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.folder (id, user_id, space_id, name, updated_at) "
                "VALUES (gen_random_uuid(), NULL, NULL, 'orphan', now()) RETURNING id"
            )
        )
    ).scalar_one()
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, "
            "grantee_id, role_id, granted_by) VALUES ('folder', :f, 'team', :t, :r, :o)"
        ),
        {
            "f": orphan_folder_id,
            "t": team.id,
            "r": roles["folder-editor"],
            "o": me,
        },
    )
    await db_session.commit()

    folders = await client.get(f"{settings.API_V2_STR}/folder")
    assert folders.status_code == 200, folders.text
    assert str(orphan_folder_id) not in {f["id"] for f in folders.json()}

    page = await _feed(client, view="shared_with_me")
    got_ids = {i["id"] for i in page["items"]}
    assert str(orphan_folder_id) not in got_ids


@pytest.mark.asyncio
async def test_feed_hides_trash_and_bundle_member_layers(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    fid = str(fixture_get_home_folder["id"])
    lid = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.layer (id, name, type, feature_layer_type, "
                "feature_layer_geometry_type, user_id, folder_id, space_id, updated_at) "
                "VALUES (gen_random_uuid(), 'gone', 'feature', 'standard', 'point', "
                ":u, :f, :s, now()) RETURNING id"
            ),
            {"u": fixture_create_user, "f": fid, "s": sid},
        )
    ).scalar_one()
    await db_session.execute(
        text(f"UPDATE {S}.layer SET deleted_at = now() WHERE id = :l"), {"l": lid}
    )
    await db_session.commit()
    page = await _feed(client, space_id=str(sid), folder_id=fid)
    assert str(lid) not in {i["id"] for i in page["items"]}


@pytest.mark.asyncio
async def test_feed_refuses_a_space_the_caller_is_not_in(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
) -> None:
    other = await make_user((await make_org()).id)
    # `other`'s personal space is never backfilled eagerly (crud_space.py) —
    # get-or-create it the same way real first-use traffic would, rather
    # than assuming a row already exists.
    sid = (await crud_space.ensure_personal(db_session, other.id)).id
    await db_session.commit()
    r = await client.get(
        f"{settings.API_V2_STR}/content", params={"space_id": str(sid)}
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_shared_folder_is_openable_by_its_grantee_not_by_a_stranger(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    me = fixture_create_user
    org = await make_org()
    other = await make_user(org.id)
    their_space_id = (await crud_space.ensure_personal(db_session, other.id)).id
    shared_folder = await make_folder(other, "shared")
    inside_layer = await make_layer(other, shared_folder)
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, "
            "grantee_id, role_id, granted_by) VALUES ('folder', :r, 'user', :u, :role, :o)"
        ),
        {"r": shared_folder.id, "u": me, "role": roles["folder-viewer"], "o": other.id},
    )
    await db_session.commit()

    # The grantee opens the folder in a space they are not a member of.
    page = await _feed(
        client, space_id=str(their_space_id), folder_id=str(shared_folder.id)
    )
    ids = {i["id"] for i in page["items"]}
    assert str(inside_layer.id) in ids
    my_roles = {i["id"]: i["my_role"] for i in page["items"]}
    assert my_roles[str(inside_layer.id)] == "viewer"

    # A stranger with no grant on the folder may not.
    stranger = await make_user(org.id)
    await db_session.commit()
    r = await client.get(
        f"{settings.API_V2_STR}/content",
        params={"space_id": str(their_space_id), "folder_id": str(shared_folder.id)},
        headers={"Authorization": f"Bearer {_unverified_bearer(stranger.id)}"},
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_recent_view_orders_by_updated_at_and_excludes_trash_and_unreachable(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    me = fixture_create_user
    home = str(fixture_get_home_folder["id"])
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"), {"u": me}
        )
    ).scalar_one()

    async def _layer_updated_minutes_ago(name: str, minutes: int) -> UUID:
        row_id = (
            await db_session.execute(
                text(
                    f"INSERT INTO {S}.layer (id, name, type, feature_layer_type, "
                    "feature_layer_geometry_type, user_id, folder_id, space_id, updated_at) "
                    "VALUES (gen_random_uuid(), :n, 'feature', 'standard', 'point', "
                    ":u, :f, :s, now() - (:m || ' minutes')::interval) RETURNING id"
                ),
                {"n": name, "u": me, "f": home, "s": sid, "m": minutes},
            )
        ).scalar_one()
        return cast(UUID, row_id)

    l_old = await _layer_updated_minutes_ago("old", 30)
    l_mid = await _layer_updated_minutes_ago("mid", 20)
    l_new = await _layer_updated_minutes_ago("new", 10)
    l_trashed = await _layer_updated_minutes_ago("trashed", 5)
    await db_session.execute(
        text(f"UPDATE {S}.layer SET deleted_at = now() WHERE id = :l"), {"l": l_trashed}
    )

    org = await make_org()
    other = await make_user(org.id)
    their_folder = await make_folder(other, "theirs")
    unreachable = await make_layer(other, their_folder)

    await db_session.commit()

    page = await _feed(client, view="recent", size=100)
    mine_in_order = [
        i["id"]
        for i in page["items"]
        if i["id"] in {str(l_old), str(l_mid), str(l_new)}
    ]
    assert mine_in_order == [str(l_new), str(l_mid), str(l_old)], page["items"]

    all_ids = {i["id"] for i in page["items"]}
    assert str(l_trashed) not in all_ids
    assert str(unreachable.id) not in all_ids


@pytest.mark.asyncio
async def test_shared_with_space_lists_foreign_items_granted_to_the_team(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
) -> None:
    team = await client.post(f"{settings.API_V2_STR}/teams", json={"name": "Feed team"})
    assert team.status_code == 200, team.text
    team_id = team.json()["id"]
    team_space_id = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE team_id = :t"), {"t": team_id}
        )
    ).scalar_one()
    # A personal folder shared with the team ...
    f = await client.post(
        f"{settings.API_V2_STR}/folder", json={"name": "For the team"}
    )
    fid = f.json()["id"]
    s = await client.post(
        f"{settings.API_V2_STR}/folder/{fid}/share",
        json={"grantee_type": "team", "grantee_id": team_id, "role": "folder-viewer"},
    )
    assert s.status_code in (200, 201), s.text
    # ... and one that is not.
    await client.post(f"{settings.API_V2_STR}/folder", json={"name": "Private"})

    page = await _feed(client, view="shared_with_space", space_id=str(team_space_id))
    names = [i["name"] for i in page["items"]]
    assert names == ["For the team"]
    assert page["items"][0]["space_id"] != str(team_space_id)

    # A project granted to the same team lists here too, not just folders.
    p = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": "Team project",
            "folder_id": str(fixture_get_home_folder["id"]),
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
    assert p.status_code in (200, 201), p.text
    grant = await client.post(
        f"{settings.API_V2_STR}/share/project/{p.json()['id']}",
        params={"team_ids": team_id},
        json={"teams": [{"id": team_id, "role": "project-viewer"}]},
    )
    assert grant.status_code in (200, 201), grant.text
    page = await _feed(client, view="shared_with_space", space_id=str(team_space_id))
    assert sorted(i["name"] for i in page["items"]) == ["For the team", "Team project"]

    # An item living *in* the space is never listed by this view — the
    # section is "shared with", not "owned by".
    in_space = await client.post(
        f"{settings.API_V2_STR}/folder",
        json={"name": "Lives in the team", "space_id": str(team_space_id)},
    )
    assert in_space.status_code == 201, in_space.text
    page = await _feed(client, view="shared_with_space", space_id=str(team_space_id))
    assert "Lives in the team" not in {i["name"] for i in page["items"]}

    missing = await client.get(
        f"{settings.API_V2_STR}/content", params={"view": "shared_with_space"}
    )
    assert missing.status_code == 400

    # The caller's own personal space is not a "shared with" target: 404.
    personal_space_id = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    personal = await client.get(
        f"{settings.API_V2_STR}/content",
        params={"view": "shared_with_space", "space_id": str(personal_space_id)},
    )
    assert personal.status_code == 404, personal.text

    # And a non-member of the team may not read the section at all: 403.
    stranger_id = uuid4()
    db_session.add(
        User(
            id=stranger_id,
            email=f"stranger-{stranger_id.hex[:8]}@goat.test",
            firstname="No",
            lastname="Team",
            avatar="",
        )
    )
    await db_session.commit()
    forbidden = await client.get(
        f"{settings.API_V2_STR}/content",
        params={"view": "shared_with_space", "space_id": str(team_space_id)},
        headers={"Authorization": f"Bearer {_unverified_bearer(stranger_id)}"},
    )
    assert forbidden.status_code == 403, forbidden.text


@pytest.mark.asyncio
async def test_team_space_root_folds_its_home_folder_away(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
) -> None:
    """A space's root lists what its `home` folder holds and never the
    `home` folder itself — for a team space exactly as for a personal one,
    since every space is provisioned with that root folder."""
    team = await client.post(f"{settings.API_V2_STR}/teams", json={"name": "Root fold"})
    assert team.status_code == 200, team.text
    team_space_id = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE team_id = :t"),
            {"t": team.json()["id"]},
        )
    ).scalar_one()
    team_home_id = (
        await db_session.execute(
            text(
                f"SELECT id FROM {S}.folder WHERE space_id = :s AND parent_id IS NULL "
                "AND name = 'home' AND deleted_at IS NULL"
            ),
            {"s": team_space_id},
        )
    ).scalar_one()

    # What "Add new -> New Project" at the team root does: file it in the
    # space's `home` folder.
    p = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": "Team root project",
            "folder_id": str(team_home_id),
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
    assert p.status_code in (200, 201), p.text
    # A real folder at the team root stays visible.
    sub = await client.post(
        f"{settings.API_V2_STR}/folder",
        json={"name": "Plans", "space_id": str(team_space_id)},
    )
    assert sub.status_code == 201, sub.text

    page = await _feed(client, space_id=str(team_space_id))
    names = {i["name"] for i in page["items"]}
    assert "Team root project" in names
    assert "Plans" in names
    assert "home" not in names
    assert str(team_home_id) not in {i["id"] for i in page["items"]}


@pytest.mark.asyncio
async def test_space_view_lists_a_content_shortcut_with_is_shortcut_true(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
    roles: dict[str, UUID],
) -> None:
    """A `content_shortcut` row left behind after a transfer shows up in the
    space view, badged `is_shortcut=True`, alongside the item's real name
    (joined off the live row, wherever it now lives) and the target's own
    `space_id` — the space following the shortcut leads to."""
    me = fixture_create_user
    home = str(fixture_get_home_folder["id"])
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"), {"u": me}
        )
    ).scalar_one()
    p = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": "shortcut target",
            "folder_id": home,
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
    pid = p.json()["id"]

    # The target has moved into a team space; the shortcut stays behind in
    # the personal folder it used to live in.
    team = await client.post(
        f"{settings.API_V2_STR}/teams", json={"name": "Shortcut team"}
    )
    assert team.status_code == 200, team.text
    team_space_id = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE team_id = :t"),
            {"t": team.json()["id"]},
        )
    ).scalar_one()
    team_home_id = (
        await db_session.execute(
            text(
                f"SELECT id FROM {S}.folder WHERE space_id = :s AND parent_id IS NULL "
                "AND name = 'home' AND deleted_at IS NULL"
            ),
            {"s": team_space_id},
        )
    ).scalar_one()
    await db_session.execute(
        text(f"UPDATE {S}.project SET space_id = :s, folder_id = :f WHERE id = :p"),
        {"s": team_space_id, "f": team_home_id, "p": pid},
    )
    await db_session.execute(
        text(
            f"INSERT INTO {S}.content_shortcut (space_id, folder_id, target_type, target_id, created_by) "
            "VALUES (:s, :f, 'project', :t, :u)"
        ),
        {"s": sid, "f": home, "t": pid, "u": me},
    )
    await db_session.commit()

    page = await _feed(client, space_id=str(sid), folder_id=home)
    shortcut_rows = [i for i in page["items"] if i["id"] == pid and i["is_shortcut"]]
    assert len(shortcut_rows) == 1
    assert shortcut_rows[0]["name"] == "shortcut target"
    # The row carries the target's space, not the space the shortcut sits in.
    assert shortcut_rows[0]["space_id"] == str(team_space_id)
    assert shortcut_rows[0]["space_id"] != str(sid)


@pytest.mark.asyncio
async def test_feed_marks_a_published_project_public(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """`is_public` says whether a row has a published public snapshot — the
    Content page's audience chip reads it. Only projects can be published,
    so a layer in the same space stays False."""
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    home = str(fixture_get_home_folder["id"])
    view_state = {
        "latitude": 48.1,
        "longitude": 11.5,
        "zoom": 10,
        "min_zoom": 0,
        "max_zoom": 20,
        "bearing": 0,
        "pitch": 0,
    }
    published = await client.post(
        f"{settings.API_V2_STR}/project",
        json={"name": "published", "folder_id": home, "initial_view_state": view_state},
    )
    assert published.status_code in (200, 201), published.text
    private = await client.post(
        f"{settings.API_V2_STR}/project",
        json={"name": "private", "folder_id": home, "initial_view_state": view_state},
    )
    assert private.status_code in (200, 201), private.text
    published_id = published.json()["id"]
    private_id = private.json()["id"]

    before = await _feed(client, space_id=str(sid))
    rows_before = {i["id"]: i for i in before["items"]}
    assert rows_before[published_id]["is_public"] is False
    assert rows_before[private_id]["is_public"] is False

    r = await client.post(f"{settings.API_V2_STR}/project/{published_id}/publish")
    assert r.status_code in (200, 201), r.text

    after = await _feed(client, space_id=str(sid))
    rows = {i["id"]: i for i in after["items"]}
    assert rows[published_id]["is_public"] is True, "a published project is public"
    assert rows[private_id]["is_public"] is False, "an unpublished one is not"
    assert all(
        i["is_public"] is False for i in after["items"] if i["type"] != "project"
    ), "only a project can be published"

    # And it goes back to False once the snapshot is taken offline.
    unpub = await client.delete(
        f"{settings.API_V2_STR}/project/{published_id}/unpublish"
    )
    assert unpub.status_code in (200, 204), unpub.text
    again = await _feed(client, space_id=str(sid))
    assert {i["id"]: i for i in again["items"]}[published_id]["is_public"] is False


@pytest.mark.asyncio
async def test_feed_returns_loadable_thumbnail_urls(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """The feed never hands the client a bare `thumbnails/…` storage key: a
    stored key is resolved to an absolute URL, a row without one falls back
    to its kind's default artwork, and a folder has no thumbnail at all."""
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    home = str(fixture_get_home_folder["id"])
    p = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": "thumbed",
            "folder_id": home,
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
    assert p.status_code in (200, 201), p.text
    pid = p.json()["id"]
    folder = await client.post(f"{settings.API_V2_STR}/folder", json={"name": "Plain"})
    fid = folder.json()["id"]

    # A project the builder has saved a thumbnail for carries the storage
    # key in the column, exactly as the thumbnail upload writes it.
    await db_session.execute(
        text(f"UPDATE {S}.project SET thumbnail_url = :t WHERE id = :p"),
        {"t": "thumbnails/projects/some-key.png", "p": pid},
    )
    await db_session.commit()

    page = await _feed(client, space_id=str(sid))
    rows = {i["id"]: i for i in page["items"]}
    assert rows[pid]["thumbnail_url"] is not None
    assert not cast(str, rows[pid]["thumbnail_url"]).startswith("thumbnails/")
    assert cast(str, rows[pid]["thumbnail_url"]).startswith(("http://", "https://"))
    assert rows[fid]["thumbnail_url"] is None, "a folder has no artwork"

    # A project without one still gets a URL: the default project artwork.
    await db_session.execute(
        text(f"UPDATE {S}.project SET thumbnail_url = NULL WHERE id = :p"),
        {"p": pid},
    )
    await db_session.commit()
    default_page = await _feed(client, space_id=str(sid))
    assert {i["id"]: i for i in default_page["items"]}[pid][
        "thumbnail_url"
    ] == settings.DEFAULT_PROJECT_THUMBNAIL


@pytest.mark.asyncio
async def test_feed_names_the_creator_of_every_row(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """`created_by` resolves the content table's `user_id` to a name and a
    picture — one lookup per page, None once the creating account is gone."""
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    await db_session.execute(
        text(
            f'UPDATE {S}."user" SET firstname = :f, lastname = :l, avatar = :a WHERE id = :u'
        ),
        {
            "f": "Marie",
            "l": "Klein",
            "a": "https://img.test/mk.png",
            "u": fixture_create_user,
        },
    )
    await db_session.commit()
    f = await client.post(
        f"{settings.API_V2_STR}/folder", json={"name": "Creator check"}
    )
    fid = f.json()["id"]

    page = await _feed(client, space_id=str(sid))
    rows = {i["id"]: i for i in page["items"]}
    assert rows[fid]["created_by"] == {
        "id": str(fixture_create_user),
        "name": "Marie Klein",
        "avatar": "https://img.test/mk.png",
    }

    await db_session.execute(
        text(f"UPDATE {S}.folder SET user_id = NULL WHERE id = :f"), {"f": fid}
    )
    await db_session.commit()
    again = await _feed(client, space_id=str(sid))
    assert {i["id"]: i for i in again["items"]}[fid]["created_by"] is None


@pytest.mark.asyncio
async def test_recent_view_can_order_by_my_last_open(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """`order_by=last_opened_at` puts the project I opened most recently
    first, even though another one was edited later."""
    home = str(fixture_get_home_folder["id"])
    names = ["older-open", "never-opened", "latest-open"]
    ids = []
    for n in names:
        r = await client.post(
            f"{settings.API_V2_STR}/project",
            json={
                "name": n,
                "folder_id": home,
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
        ids.append(r.json()["id"])
    await db_session.execute(
        text(
            f"UPDATE {S}.user_project SET last_opened_at = now() - interval '2 days' WHERE project_id = :p"
        ),
        {"p": ids[0]},
    )
    await db_session.execute(
        text(
            f"UPDATE {S}.user_project SET last_opened_at = now() WHERE project_id = :p"
        ),
        {"p": ids[2]},
    )
    await db_session.execute(
        text(
            f"UPDATE {S}.project SET updated_at = now() - interval '1 day' WHERE id = :p"
        ),
        {"p": ids[1]},
    )
    await db_session.commit()
    page = await _feed(
        client, view="recent", types="project", order_by="last_opened_at", size=10
    )
    order = [i["name"] for i in page["items"] if i["name"] in names]
    # COALESCE(last_opened_at, updated_at) DESC: latest-open (opened now),
    # never-opened (falls back to updated_at = now - 1 day), older-open
    # (opened 2 days ago). A never-opened project sorts by its updated_at,
    # an opened one by my own last open.
    assert order == ["latest-open", "never-opened", "older-open"]


@pytest.mark.asyncio
async def test_frozen_template_source_project_is_hidden_from_feed_and_trash(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """A project frozen as a template's source copy (T2) carries
    `is_template_source = true`: it is content nobody browses directly, so
    it never appears in any feed view nor in the trash after it is soft
    deleted — only the template row pointing at it is."""
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    home = str(fixture_get_home_folder["id"])
    p = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": "frozen source",
            "folder_id": home,
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
    assert p.status_code in (200, 201), p.text
    pid = p.json()["id"]
    await db_session.execute(
        text(f"UPDATE {S}.project SET is_template_source = TRUE WHERE id = :p"),
        {"p": pid},
    )
    await db_session.commit()

    page = await _feed(client, space_id=str(sid), folder_id=home)
    assert pid not in {i["id"] for i in page["items"]}
    recent = await _feed(client, view="recent")
    assert pid not in {i["id"] for i in recent["items"]}

    delete = await client.delete(f"{settings.API_V2_STR}/project/{pid}")
    assert delete.status_code in (200, 204), delete.text
    trash = await client.get(
        f"{settings.API_V2_STR}/content/trash", params={"space_id": str(sid)}
    )
    assert trash.status_code == 200, trash.text
    assert pid not in {i["id"] for i in trash.json()}


@pytest.mark.asyncio
async def test_search_reaches_into_subfolders_while_browsing_stays_exact(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """A search covers the browsed folder and everything beneath it (the whole
    space from its root); without a search the listing is still the folder's
    direct children only."""
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    outer = (
        await client.post(
            f"{settings.API_V2_STR}/folder", json={"name": "Field surveys"}
        )
    ).json()
    inner = (
        await client.post(
            f"{settings.API_V2_STR}/folder",
            json={"name": "Round 2 QA zzz", "parent_id": outer["id"]},
        )
    ).json()
    other = (
        await client.post(f"{settings.API_V2_STR}/folder", json={"name": "Elsewhere"})
    ).json()
    p = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "name": "zzz deep project",
            "folder_id": inner["id"],
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
    assert p.status_code in (200, 201), p.text
    pid = p.json()["id"]

    # Browsing: only direct children, so neither the nested folder nor the
    # project shows at the root or in the sibling folder.
    root = await _feed(client, space_id=str(sid))
    assert {i["id"] for i in root["items"]} & {inner["id"], pid} == set()
    sibling = await _feed(client, space_id=str(sid), folder_id=other["id"])
    assert sibling["items"] == []

    # Searching from the root reaches both, two levels down.
    hits = await _feed(client, space_id=str(sid), search="zzz")
    assert {i["id"] for i in hits["items"]} == {inner["id"], pid}
    # Searching inside the outer folder reaches them too; the outer folder
    # itself is not a result even though it is in scope.
    hits = await _feed(client, space_id=str(sid), folder_id=outer["id"], search="zzz")
    assert {i["id"] for i in hits["items"]} == {inner["id"], pid}
    # Searching inside an unrelated folder finds nothing.
    hits = await _feed(client, space_id=str(sid), folder_id=other["id"], search="zzz")
    assert hits["items"] == []


@pytest.mark.asyncio
async def test_a_folder_filed_in_home_shows_at_the_space_root(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """A space's `home` folder IS its root: everything filed there is folded
    into the root listing. That holds for sub-folders too — a folder created
    with `parent_id = home` is a root card, not an invisible one."""
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    home_id = str(fixture_get_home_folder["id"])
    in_home = (
        await client.post(
            f"{settings.API_V2_STR}/folder",
            json={"name": "Filed in home", "parent_id": home_id},
        )
    ).json()["id"]
    parentless = (
        await client.post(
            f"{settings.API_V2_STR}/folder", json={"name": "Parentless root"}
        )
    ).json()["id"]

    root = await _feed(client, space_id=str(sid))
    ids = {i["id"] for i in root["items"]}
    assert in_home in ids, "a folder parented on `home` is at the root"
    assert parentless in ids, "so is a folder with no parent at all"
    assert home_id not in ids, "`home` itself never shows a card of its own"


@pytest.mark.asyncio
async def test_a_page_past_the_last_one_still_reports_the_total(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """The total rides along on each row as a window count, so an
    off-the-end page comes back with no rows to read it from. It must still
    report the real total — a pager that reads 0 there loses its page
    count and cannot offer the way back."""
    sid = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.space WHERE user_id = :u"),
            {"u": fixture_create_user},
        )
    ).scalar_one()
    for n in range(3):
        r = await client.post(
            f"{settings.API_V2_STR}/folder", json={"name": f"paged {n}"}
        )
        assert r.status_code == 201, r.text

    first = await _feed(client, space_id=str(sid), page=1, size=2)
    total = first["total"]
    assert total >= 3 and len(first["items"]) == 2

    past_the_end = await _feed(client, space_id=str(sid), page=50, size=2)
    assert past_the_end["items"] == []
    assert past_the_end["total"] == total


@pytest.mark.asyncio
async def test_shared_folder_opens_under_the_grantee_s_own_space_as_context(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    make_org: Callable[[], Awaitable[Organization]],
    make_folder: Callable[..., Awaitable[Folder]],
    make_layer: Callable[..., Awaitable[Layer]],
) -> None:
    """The Content page keeps the browsed space in the address when it steps
    into a folder shared in from another space, so `space_id` may name one
    of the caller's own spaces rather than the folder's — the folder itself
    is still gated by its grant, and the context space by membership."""
    me = fixture_create_user
    org = await make_org()
    other = await make_user(org.id)
    shared_folder = await make_folder(other, "shared")
    inside_layer = await make_layer(other, shared_folder)
    await db_session.execute(
        text(
            f"INSERT INTO {S}.resource_grant (resource_type, resource_id, grantee_type, "
            "grantee_id, role_id, granted_by) VALUES ('folder', :r, 'user', :u, :role, :o)"
        ),
        {"r": shared_folder.id, "u": me, "role": roles["folder-viewer"], "o": other.id},
    )
    await db_session.commit()
    my_space_id = (await crud_space.ensure_personal(db_session, me)).id

    page = await _feed(
        client, space_id=str(my_space_id), folder_id=str(shared_folder.id)
    )
    ids = {i["id"] for i in page["items"]}
    assert str(inside_layer.id) in ids
    rows = {i["id"]: i for i in page["items"]}
    assert rows[str(inside_layer.id)]["my_role"] == "viewer"
    # The rows keep the folder's real space; the context is only the address.
    assert rows[str(inside_layer.id)]["space_id"] != str(my_space_id)

    # A space the caller is not a member of is no context of theirs.
    bystander = await make_user(org.id)
    bystander_space_id = (await crud_space.ensure_personal(db_session, bystander.id)).id
    await db_session.commit()
    r = await client.get(
        f"{settings.API_V2_STR}/content",
        params={
            "space_id": str(bystander_space_id),
            "folder_id": str(shared_folder.id),
        },
    )
    assert r.status_code == 403, r.text

    # The context space does not stand in for the folder's grant.
    r = await client.get(
        f"{settings.API_V2_STR}/content",
        params={
            "space_id": str(bystander_space_id),
            "folder_id": str(shared_folder.id),
        },
        headers={"Authorization": f"Bearer {_unverified_bearer(bystander.id)}"},
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_rows_tied_on_the_sort_column_page_without_repeating(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_get_home_folder: dict[str, object],
) -> None:
    """A bulk import leaves dozens of rows with one identical `updated_at`.
    Each page is its own LIMIT/OFFSET query, and Postgres orders ties any way
    it likes per query, so without a deterministic tiebreak a tie group
    straddling a page boundary repeats rows on the next page and drops
    others. Ties break on (type, id), so the tie group reads the same way
    on every page."""
    me = fixture_create_user
    home_id = UUID(str(fixture_get_home_folder["id"]))
    sid = str((await crud_space.ensure_personal(db_session, me)).id)
    # Written in descending id order so a plain heap scan hands them back
    # the opposite way from the tiebreak.
    ids = sorted((uuid4() for _ in range(6)), reverse=True)
    for layer_id in ids:
        db_session.add(
            Layer(
                id=layer_id,
                user_id=me,
                folder_id=home_id,
                space_id=UUID(sid),
                name=f"tied-{layer_id.hex[:6]}",
                type="feature",
                feature_layer_type="standard",
                feature_layer_geometry_type="polygon",
            )
        )
        await db_session.flush()
    await db_session.execute(
        text(
            f"UPDATE {S}.layer SET updated_at = '2026-01-01T00:00:00Z' WHERE id = ANY(:ids)"
        ),
        {"ids": ids},
    )
    await db_session.commit()

    listed: list[str] = []
    page = 1
    while True:
        r = await _feed(
            client,
            space_id=sid,
            types="layer",
            order_by="updated_at",
            order="ascendent",
            page=page,
            size=2,
        )
        if not r["items"]:
            break
        listed.extend(i["id"] for i in r["items"])
        page += 1

    assert len(listed) == len(set(listed)), "no row is listed on two pages"
    assert set(listed) == {str(i) for i in ids}
    assert listed == sorted(str(i) for i in ids), "ties read in id order"
