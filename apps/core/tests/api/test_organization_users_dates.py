"""Members carry the date they joined; invitations when they were made, last
sent and when they expire (B5).

`joined_at` is the user row's creation: core makes the row when someone
creates an organization or accepts an invitation. `last_sent_at` is the
payload's value (written by the invite and every resend), else `created_at`.
"""

from datetime import datetime
from uuid import uuid4

import pytest
from core.core.config import settings
from core.crud.crud_invitation import last_sent_at
from core.db.models.invitation import Invitation
from core.db.models.user import User
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from tests.utils import as_user, give_org_role, make_organization, seeded_roles

ORGS = f"{settings.API_V2_STR}/organizations"


@pytest.mark.asyncio
async def test_members_and_invitations_carry_their_dates(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    roles = await seeded_roles(db_session)
    org = make_organization(id=uuid4())
    db_session.add(org)
    await db_session.flush()
    admin = User(
        id=uuid4(),
        email=f"dates-{uuid4().hex[:8]}@goat.test",
        firstname="Ada",
        lastname="Admin",
        avatar="",
        organization_id=org.id,
        created_at=datetime(2024, 3, 5, 9, 30),
    )
    db_session.add(admin)
    await db_session.commit()
    await give_org_role(db_session, admin.id, roles["organization-admin"])

    def invitation(email: str, **fields) -> Invitation:
        return Invitation(
            send_by=admin.id,
            organization_id=org.id,
            type="organization",
            status="pending",
            payload={
                "user_email": email,
                "organization_id": str(org.id),
                "role": "organization-viewer",
                **fields.pop("payload", {}),
            },
            **fields,
        )

    db_session.add_all(
        [
            invitation(
                "sent@goat.test",
                created_at=datetime(2026, 10, 1, 8, 0),
                expires=datetime(2026, 12, 1, 8, 0),
                payload={"last_sent_at": "2026-10-30T12:00:00+00:00"},
            ),
            invitation("old@goat.test", created_at=datetime(2026, 9, 1, 8, 0)),
        ]
    )
    await db_session.commit()

    answer = await client.get(
        f"{ORGS}/{org.id}/users",
        params={"include_invitations": "true"},
        headers=as_user(admin.id),
    )
    assert answer.status_code == 200, answer.text
    rows = {row["email"]: row for row in answer.json()}

    me = rows[admin.email]
    assert me["joined_at"].startswith("2024-03-05T09:30")
    assert (me["invited_at"], me["expires_at"], me["last_sent_at"]) == (
        None,
        None,
        None,
    )

    sent = rows["sent@goat.test"]
    assert sent["joined_at"] is None
    assert sent["invited_at"].startswith("2026-10-01T08:00")
    assert sent["expires_at"].startswith("2026-12-01T08:00")
    assert sent["last_sent_at"].startswith("2026-10-30T12:00")

    old = rows["old@goat.test"]
    assert old["expires_at"] is None
    assert old["last_sent_at"].startswith("2026-09-01T08:00")


@pytest.mark.unit
def test_last_sent_at_reads_the_payload_and_falls_back_to_created_at() -> None:
    made = datetime(2026, 9, 1, 8, 0)
    invitation = Invitation(
        send_by=uuid4(),
        type="organization",
        status="pending",
        created_at=made,
        payload={"user_email": "x@goat.test"},
    )
    assert last_sent_at(invitation) == made
    invitation.payload = {
        **invitation.payload,
        "last_sent_at": "2026-10-30T12:00:00+00:00",
    }
    assert last_sent_at(invitation) == datetime(2026, 10, 30, 12, 0)
    # The same instant in naive UTC, whatever zone the payload names.
    for stored in (
        "2026-10-30T14:00:00+02:00",  # another zone: converted, not cut off
        "2026-10-30T12:00:00Z",
        "2026-10-30T12:00:00",  # no zone: UTC already
    ):
        invitation.payload = {**invitation.payload, "last_sent_at": stored}
        sent = last_sent_at(invitation)
        assert (sent, sent.tzinfo) == (datetime(2026, 10, 30, 12, 0), None), stored
    invitation.payload = {**invitation.payload, "last_sent_at": "not a date"}
    assert last_sent_at(invitation) == made


@pytest.mark.asyncio
async def test_a_role_change_answers_the_member_with_their_join_date(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    roles = await seeded_roles(db_session)
    org = make_organization(id=uuid4())
    db_session.add(org)
    await db_session.flush()

    def person(name: str, joined: datetime) -> User:
        return User(
            id=uuid4(),
            email=f"{name}-{uuid4().hex[:8]}@goat.test",
            firstname=name.title(),
            lastname="Dates",
            avatar="",
            organization_id=org.id,
            created_at=joined,
        )

    admin = person("admin", datetime(2024, 3, 5, 9, 30))
    viewer = person("viewer", datetime(2025, 6, 7, 10, 15))
    db_session.add_all([admin, viewer])
    await db_session.commit()
    await give_org_role(db_session, admin.id, roles["organization-admin"])
    await give_org_role(db_session, viewer.id, roles["organization-viewer"])

    answer = await client.patch(
        f"{ORGS}/{org.id}/users/{viewer.id}",
        json={"role": "organization-editor"},
        headers=as_user(admin.id),
    )
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["roles"] == ["organization-editor"]
    assert body["joined_at"].startswith("2025-06-07T10:15")


@pytest.mark.asyncio
async def test_an_unchanged_role_answers_the_member_too(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Saving a member with the role they already hold changes nothing and
    answers the same member shape as a change (it used to answer the user
    row, which the response model refused with a 500)."""
    roles = await seeded_roles(db_session)
    org = make_organization(id=uuid4())
    db_session.add(org)
    await db_session.flush()
    admin, editor = (
        User(
            id=uuid4(),
            email=f"{name}-{uuid4().hex[:8]}@goat.test",
            firstname=name.title(),
            lastname="Same",
            avatar="",
            organization_id=org.id,
            created_at=joined,
        )
        for name, joined in (
            ("admin", datetime(2024, 3, 5, 9, 30)),
            ("editor", datetime(2025, 6, 7, 10, 15)),
        )
    )
    db_session.add_all([admin, editor])
    await db_session.commit()
    await give_org_role(db_session, admin.id, roles["organization-admin"])
    await give_org_role(db_session, editor.id, roles["organization-editor"])

    answer = await client.patch(
        f"{ORGS}/{org.id}/users/{editor.id}",
        json={"role": "organization-editor"},
        headers=as_user(admin.id),
    )
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["id"] == str(editor.id)
    assert body["roles"] == ["organization-editor"]
    assert body["invitation_status"] == "accepted"
    assert body["joined_at"].startswith("2025-06-07T10:15")
