"""Removing a user must never delete content the organization still needs."""

from typing import Tuple
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.crud.crud_space import space as crud_space
from core.db.models._link_model import ResourceGrant
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.utils import make_organization

S = settings.SCHEMA


async def _role_id(db: AsyncSession, name: str, resource_type: str) -> UUID:
    role_id = (
        await db.execute(text(f"SELECT id FROM {S}.role WHERE name = :n"), {"n": name})
    ).scalar_one_or_none()
    if role_id is not None:
        return UUID(str(role_id))
    inserted_id = (
        await db.execute(
            text(
                f"INSERT INTO {S}.role (name, resource_type) "
                "VALUES (:n, :t) RETURNING id"
            ),
            {"n": name, "t": resource_type},
        )
    ).scalar_one()
    return UUID(str(inserted_id))


async def _org_with_users(
    db: AsyncSession,
) -> Tuple[Organization, User, User, Folder, Folder, Layer]:
    org = make_organization(id=uuid4())
    db.add(org)
    await db.flush()
    leaver = User(
        id=uuid4(),
        email=f"leaver-{uuid4().hex[:6]}@goat.test",
        firstname="L",
        lastname="V",
        avatar="",
        organization_id=org.id,
    )
    heir = User(
        id=uuid4(),
        email=f"heir-{uuid4().hex[:6]}@goat.test",
        firstname="H",
        lastname="R",
        avatar="",
        organization_id=org.id,
    )
    db.add_all([leaver, heir])
    await db.flush()
    # organization-viewer role link is what remove_user looks for
    role_id = (
        await db.execute(
            text(f"SELECT id FROM {S}.role WHERE name = 'organization-viewer'")
        )
    ).scalar_one_or_none()
    if role_id is None:
        role_id = (
            await db.execute(
                text(
                    f"INSERT INTO {S}.role (name, resource_type) "
                    "VALUES ('organization-viewer','organization') RETURNING id"
                )
            )
        ).scalar_one()
    await db.execute(
        text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
        {"u": leaver.id, "r": role_id},
    )
    leaver_space_id = (await crud_space.ensure_personal(db, leaver.id)).id
    home = Folder(id=uuid4(), user_id=leaver.id, space_id=leaver_space_id, name="home")
    work = Folder(
        id=uuid4(), user_id=leaver.id, space_id=leaver_space_id, name="Field surveys"
    )
    db.add_all([home, work])
    await db.flush()
    layer = Layer(
        id=uuid4(),
        user_id=leaver.id,
        folder_id=work.id,
        space_id=leaver_space_id,
        name="survey",
        type="feature",
        feature_layer_type="standard",
        feature_layer_geometry_type="point",
    )
    db.add(layer)
    await db.commit()
    return org, leaver, heir, home, work, layer


@pytest.mark.asyncio
async def test_remove_user_who_owns_content_without_reassign_is_refused(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    org, leaver, heir, home, work, layer = await _org_with_users(db_session)
    # Captured before expire_all(): these ORM objects were loaded by this
    # session, and reading an attribute off an expired instance would trigger
    # an implicit synchronous reload that AsyncSession cannot perform outside
    # an awaited call.
    leaver_id, layer_id = leaver.id, layer.id
    response = await client.delete(
        f"{settings.API_V2_STR}/organizations/{org.id}/users/{leaver_id}"
    )
    assert response.status_code == 400
    assert "reassign" in response.json()["detail"].lower()
    db_session.expire_all()
    assert await db_session.get(User, leaver_id) is not None
    assert await db_session.get(Layer, layer_id) is not None


@pytest.mark.asyncio
async def test_remove_user_with_reassign_moves_content_to_heir(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    org, leaver, heir, home, work, layer = await _org_with_users(db_session)
    # Captured before expire_all(): see comment in the previous test.
    leaver_id, leaver_email, heir_id, layer_id = (
        leaver.id,
        leaver.email,
        heir.id,
        layer.id,
    )
    response = await client.delete(
        f"{settings.API_V2_STR}/organizations/{org.id}/users/{leaver_id}",
        params={"reassign_to": str(heir_id)},
    )
    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert await db_session.get(User, leaver_id) is None
    moved_layer = await db_session.get(Layer, layer_id)
    assert moved_layer is not None and moved_layer.user_id == heir_id
    folders = (
        (await db_session.execute(select(Folder).where(Folder.user_id == heir_id)))
        .scalars()
        .all()
    )
    names = sorted(f.name for f in folders)
    assert "Field surveys" in names
    assert (
        f"From {leaver_email}" in names
    ), "the leaver's home folder must not collide with the heir's"


@pytest.mark.asyncio
async def test_remove_user_who_owns_only_the_home_folder_needs_no_reassign(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Every user is seeded a `home` folder; a folder alone must not force
    `reassign_to` — only Layer/Project/Bundle ownership does. A non-empty
    folder is still covered because the layers/projects inside it count; an
    empty folder cascading away with its owner is acceptable."""
    org = make_organization(id=uuid4())
    db_session.add(org)
    await db_session.flush()
    leaver = User(
        id=uuid4(),
        email=f"leaver-{uuid4().hex[:6]}@goat.test",
        firstname="L",
        lastname="V",
        avatar="",
        organization_id=org.id,
    )
    db_session.add(leaver)
    await db_session.flush()
    role_id = (
        await db_session.execute(
            text(f"SELECT id FROM {S}.role WHERE name = 'organization-viewer'")
        )
    ).scalar_one_or_none()
    if role_id is None:
        role_id = (
            await db_session.execute(
                text(
                    f"INSERT INTO {S}.role (name, resource_type) "
                    "VALUES ('organization-viewer','organization') RETURNING id"
                )
            )
        ).scalar_one()
    await db_session.execute(
        text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
        {"u": leaver.id, "r": role_id},
    )
    db_session.add(
        Folder(
            id=uuid4(),
            user_id=leaver.id,
            space_id=(await crud_space.ensure_personal(db_session, leaver.id)).id,
            name="home",
        )
    )
    await db_session.commit()
    leaver_id = leaver.id

    response = await client.delete(
        f"{settings.API_V2_STR}/organizations/{org.id}/users/{leaver_id}"
    )
    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert await db_session.get(User, leaver_id) is None


@pytest.mark.asyncio
async def test_remove_user_deletes_grants_received_but_keeps_grants_given(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """I5: `resource_grant.grantee_id` has no FK to user (it is polymorphic
    across user/team/organization), so a grant the leaver RECEIVED would
    otherwise survive as an orphan row pointing at a deleted user — delete
    it explicitly. A grant the leaver GAVE (`granted_by`) is different
    existing behaviour: `_reassign_content` re-points `granted_by` to the
    heir rather than deleting the grant."""
    org, leaver, heir, home, work, layer = await _org_with_users(db_session)

    # a layer the heir owns, shared with the leaver (a grant the leaver RECEIVED)
    heir_layer = Layer(
        id=uuid4(),
        user_id=heir.id,
        folder_id=home.id,
        name="heir-layer",
        type="feature",
        feature_layer_type="standard",
        feature_layer_geometry_type="point",
    )
    db_session.add(heir_layer)
    await db_session.flush()
    viewer_role_id = await _role_id(db_session, "layer-viewer", "layer")
    received_grant_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.resource_grant "
                "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
                "VALUES ('layer', :rid, 'user', :leaver, :role, :heir) RETURNING id"
            ),
            {
                "rid": heir_layer.id,
                "leaver": leaver.id,
                "role": viewer_role_id,
                "heir": heir.id,
            },
        )
    ).scalar_one()

    # the leaver's own layer, shared with the heir (a grant the leaver GAVE)
    given_grant_id = (
        await db_session.execute(
            text(
                f"INSERT INTO {S}.resource_grant "
                "(resource_type, resource_id, grantee_type, grantee_id, role_id, granted_by) "
                "VALUES ('layer', :rid, 'user', :heir, :role, :leaver) RETURNING id"
            ),
            {
                "rid": layer.id,
                "heir": heir.id,
                "role": viewer_role_id,
                "leaver": leaver.id,
            },
        )
    ).scalar_one()
    await db_session.commit()

    leaver_id, heir_id = leaver.id, heir.id
    response = await client.delete(
        f"{settings.API_V2_STR}/organizations/{org.id}/users/{leaver_id}",
        params={"reassign_to": str(heir_id)},
    )
    assert response.status_code == 200, response.text
    db_session.expire_all()

    assert (
        await db_session.get(ResourceGrant, received_grant_id) is None
    ), "a grant the leaver received must not survive as an orphan"
    given_grant = await db_session.get(ResourceGrant, given_grant_id)
    assert given_grant is not None, "a grant the leaver gave must survive"
    assert (
        given_grant.granted_by == heir_id
    ), "granted_by must be re-pointed to the heir"


@pytest.mark.asyncio
async def test_reassign_to_outside_organization_is_refused(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    org, leaver, heir, *_ = await _org_with_users(db_session)
    outsider = User(
        id=uuid4(),
        email=f"out-{uuid4().hex[:6]}@goat.test",
        firstname="O",
        lastname="U",
        avatar="",
    )
    db_session.add(outsider)
    await db_session.commit()
    response = await client.delete(
        f"{settings.API_V2_STR}/organizations/{org.id}/users/{leaver.id}",
        params={"reassign_to": str(outsider.id)},
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_removing_a_member_without_a_name_answers_like_any_other(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """An invitee who never entered a name is removed and answered like
    anyone else. The route answers the user row `remove_user` loaded, an
    instance of its `User` response model, so missing names are passed
    through as null rather than validated against the model's `str`."""
    org = make_organization(id=uuid4())
    db_session.add(org)
    await db_session.flush()
    nameless_id = uuid4()
    db_session.add(
        User(
            id=nameless_id,
            email=f"nameless-{uuid4().hex[:6]}@goat.test",
            firstname=None,
            lastname=None,
            avatar=None,
            organization_id=org.id,
        )
    )
    await db_session.commit()
    viewer = await _role_id(db_session, "organization-viewer", "organization")
    await db_session.execute(
        text(f"INSERT INTO {S}.user_role (user_id, role_id) VALUES (:u, :r)"),
        {"u": nameless_id, "r": viewer},
    )
    await db_session.commit()

    response = await client.delete(
        f"{settings.API_V2_STR}/organizations/{org.id}/users/{nameless_id}"
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["id"], body["firstname"], body["lastname"]) == (
        str(nameless_id),
        None,
        None,
    )
    gone = await db_session.execute(
        text(f"SELECT 1 FROM {S}.user WHERE id = :id"), {"id": nameless_id}
    )
    assert gone.first() is None
