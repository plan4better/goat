import pytest
from core.core.config import settings
from core.crud.crud_organization import organization as crud_org
from core.crud.crud_space import space as crud_space
from core.db.models.folder import Folder
from core.db.models.user import User
from sqlalchemy import select
from tests.utils import make_organization

_INITIAL_VIEW_STATE = {
    "latitude": 48.15,
    "longitude": 11.57,
    "zoom": 12,
    "min_zoom": 0,
    "max_zoom": 20,
    "bearing": 0,
    "pitch": 0,
}


async def _ensure_user_and_folder(db_session, org) -> str:
    """Ensure the default user exists, is attached to org, and has a home folder. Returns folder_id."""
    user = await db_session.get(User, settings.DEFAULT_USER_ID)
    if user is None:
        user = User(
            id=settings.DEFAULT_USER_ID,
            email="cap@t.local",
            firstname="C",
            lastname="T",
            organization_id=org.id,
        )
        db_session.add(user)
    else:
        user.organization_id = org.id
    await db_session.flush()

    # Ensure a home folder exists for the default user
    result = await db_session.execute(
        select(Folder).where(
            Folder.user_id == settings.DEFAULT_USER_ID, Folder.name == "home"
        )
    )
    folder = result.scalar_one_or_none()
    if folder is None:
        space = await crud_space.ensure_personal(db_session, settings.DEFAULT_USER_ID)
        folder = Folder(
            user_id=settings.DEFAULT_USER_ID, name="home", space_id=space.id
        )
        db_session.add(folder)
        await db_session.flush()
    await db_session.commit()
    return str(folder.id)


async def _attach_default_user_to(db_session, org):
    user = await db_session.get(User, settings.DEFAULT_USER_ID)
    if user is None:
        user = User(
            id=settings.DEFAULT_USER_ID,
            email="cap@t.local",
            firstname="C",
            lastname="T",
            organization_id=org.id,
        )
        db_session.add(user)
    else:
        user.organization_id = org.id
    await db_session.commit()


@pytest.mark.asyncio
async def test_get_by_user_resolves_org(db_session):
    org = make_organization()
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    await _attach_default_user_to(db_session, org)
    found = await crud_org.get_by_user(db_session, settings.DEFAULT_USER_ID)
    assert found is not None and found.id == org.id


@pytest.mark.asyncio
async def test_project_create_blocked_at_cap(client, db_session):
    org = make_organization(total_projects=3, used_projects=3)  # at cap
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    folder_id = await _ensure_user_and_folder(db_session, org)

    payload = {
        "name": "cap-test-project",
        "folder_id": folder_id,
        "initial_view_state": _INITIAL_VIEW_STATE,
    }
    resp = await client.post(f"{settings.API_V2_STR}/project", json=payload)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_project_create_unlimited_when_total_none(client, db_session):
    org = make_organization(total_projects=None, used_projects=9999)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    folder_id = await _ensure_user_and_folder(db_session, org)

    payload = {
        "name": "cap-test-project",
        "folder_id": folder_id,
        "initial_view_state": _INITIAL_VIEW_STATE,
    }
    resp = await client.post(f"{settings.API_V2_STR}/project", json=payload)
    assert resp.status_code in (201, 200)


@pytest.mark.asyncio
async def test_upload_blocked_over_storage(client, db_session):
    # total 50 MB, used 49.5 MB; request to upload 5 MB -> over cap -> 400
    org = make_organization(total_storage=50, used_storage=49.5)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    await _attach_default_user_to(db_session, org)

    resp = await client.post(
        f"{settings.API_V2_STR}/datasets/request-upload",
        json={
            "filename": "a.gpkg",
            "content_type": "application/octet-stream",
            "file_size": 5 * 1024 * 1024,
        },
    )
    assert resp.status_code == 400
