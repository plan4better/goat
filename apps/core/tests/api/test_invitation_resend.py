"""Sending a pending invitation again (B6, decision 6).

An invitee whose Keycloak account still waits for its first password gets the
account setup mail again; anyone else gets GOAT's invitation mail. One mail per
resend, at most one every 10 minutes per invitation, counted from the
payload's `last_sent_at` (written by the invite and every resend) or, for an
older invitation, from `created_at`. The slot is claimed in one statement
before the mail goes out, so two resends at once send one mail and a change
made to the invitation meanwhile (a new role) stays. AUTH is off here, so
these are the handler's own checks.
"""

import json
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from core.core.config import settings
from core.crud.crud_invitation import invitation as crud_invitation
from core.db.models.invitation import Invitation
from core.db.models.user import User
from core.deps import keycloak as keycloak_deps
from core.endpoints.v2 import organizations
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.utils import as_user, make_organization, seeded_roles

ORGS = f"{settings.API_V2_STR}/organizations"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.fixture
async def org(db_session: AsyncSession) -> dict[str, Any]:
    await seeded_roles(db_session)
    organization = make_organization(id=uuid4())
    db_session.add(organization)
    await db_session.flush()
    admin = User(
        id=uuid4(),
        email=f"resend-admin-{uuid4().hex[:8]}@goat.test",
        firstname="Ada",
        lastname="Admin",
        avatar="",
        organization_id=organization.id,
    )
    db_session.add(admin)
    await db_session.commit()
    return {"id": organization.id, "admin": admin.id}


async def _invitation(
    db_session: AsyncSession, org: dict[str, Any], **fields: Any
) -> Invitation:
    payload = {
        "user_email": f"invitee-{uuid4().hex[:8]}@goat.test",
        "organization_id": str(org["id"]),
        "role": "organization-viewer",
        **fields.pop("payload", {}),
    }
    invitation = Invitation(
        send_by=org["admin"],
        organization_id=org["id"],
        type="organization",
        status=fields.pop("status", "pending"),
        created_at=fields.pop("created_at", _now() - timedelta(hours=1)),
        payload=payload,
        **fields,
    )
    db_session.add(invitation)
    await db_session.commit()
    await db_session.refresh(invitation)
    return invitation


async def _resend(client: AsyncClient, org: dict[str, Any], invitation_id: Any):
    return await client.post(
        f"{ORGS}/{org['id']}/invitations/{invitation_id}/resend",
        headers=as_user(org["admin"]),
    )


async def _write_payload(
    db_session: AsyncSession, invitation_id: Any, **changes: Any
) -> None:
    """Another request's write: merges `changes` into the stored payload."""
    await db_session.execute(
        text(
            f"UPDATE {settings.SCHEMA}.invitation "
            "SET payload = payload || CAST(:changes AS jsonb) WHERE id = :id"
        ),
        {"changes": json.dumps(changes), "id": invitation_id},
    )
    await db_session.commit()


def _after_the_read(write: Any) -> Any:
    """`crud_invitation.get` as the handler calls it, with `write` done right
    after the row was read: the handler goes on with what it read."""
    real_get = crud_invitation.get

    async def get(db: Any, id: Any) -> Any:
        found = await real_get(db=db, id=id)
        await write()
        return found

    return patch.object(organizations.crud_invitation, "get", side_effect=get)


async def _stored(db_session: AsyncSession, invitation: Invitation) -> Invitation:
    invitation_id = invitation.id  # read before expiring: no lazy load after
    db_session.expire_all()
    stored = await db_session.get(Invitation, invitation_id)
    assert stored is not None
    return stored


@pytest.mark.asyncio
async def test_the_goat_mail_goes_to_an_invitee_who_can_sign_in(
    client: AsyncClient, db_session: AsyncSession, org: dict[str, Any]
) -> None:
    invitation = await _invitation(db_session, org)
    with (
        patch.object(organizations, "send_email") as send_email,
        patch.object(
            keycloak_deps, "pending_setup_user_id", AsyncMock(return_value=None)
        ),
        patch.object(keycloak_deps, "send_account_setup_email", AsyncMock()) as setup,
    ):
        answer = await _resend(client, org, invitation.id)
    assert answer.status_code == 200, answer.text
    assert answer.json()["account_setup"] is None
    send_email.assert_called_once()
    assert send_email.call_args.kwargs["email_to"] == invitation.payload["user_email"]
    assert send_email.call_args.kwargs["environment"]["action_url"] == (
        f"{settings.CLIENT_URL}/onboarding/organization/invite/{invitation.id}"
    )
    setup.assert_not_awaited()

    sent = datetime.fromisoformat(
        (await _stored(db_session, invitation)).payload["last_sent_at"]
    )
    assert abs(datetime.now(timezone.utc) - sent) < timedelta(minutes=1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("delivered", "expected"), [(True, "email_sent"), (False, "manual")]
)
async def test_the_setup_mail_goes_to_an_account_still_without_a_password(
    client: AsyncClient,
    db_session: AsyncSession,
    org: dict[str, Any],
    delivered: bool,
    expected: str,
) -> None:
    invitation = await _invitation(db_session, org)
    with (
        patch.object(organizations, "send_email") as send_email,
        patch.object(
            keycloak_deps, "pending_setup_user_id", AsyncMock(return_value="kc-1")
        ),
        patch.object(
            keycloak_deps,
            "send_account_setup_email",
            AsyncMock(return_value=delivered),
        ) as setup,
    ):
        answer = await _resend(client, org, invitation.id)
    assert answer.status_code == 200, answer.text
    assert answer.json()["account_setup"] == expected
    send_email.assert_not_called()  # one mail per resend
    setup.assert_awaited_once_with(
        "kc-1",
        redirect_uri=f"{settings.CLIENT_URL}/onboarding/organization/invite/{invitation.id}",
    )
    sent = datetime.fromisoformat(
        (await _stored(db_session, invitation)).payload["last_sent_at"]
    )
    assert abs(datetime.now(timezone.utc) - sent) < timedelta(minutes=1)


@pytest.mark.asyncio
async def test_a_resend_waits_ten_minutes_from_the_last_send(
    client: AsyncClient, db_session: AsyncSession, org: dict[str, Any]
) -> None:
    recent = await _invitation(
        db_session,
        org,
        payload={"last_sent_at": (_now() - timedelta(minutes=3)).isoformat()},
    )
    young = await _invitation(db_session, org, created_at=_now() - timedelta(minutes=2))
    old = await _invitation(
        db_session,
        org,
        payload={"last_sent_at": (_now() - timedelta(minutes=11)).isoformat()},
    )
    exactly = await _invitation(
        db_session,
        org,
        payload={"last_sent_at": (_now() - timedelta(minutes=10)).isoformat()},
    )
    with (
        patch.object(organizations, "send_email") as send_email,
        patch.object(
            keycloak_deps, "pending_setup_user_id", AsyncMock(return_value=None)
        ),
    ):
        too_soon = await _resend(client, org, recent.id)
        assert too_soon.status_code == 429, too_soon.text
        wait = int(too_soon.headers["Retry-After"])
        assert 400 <= wait <= 420

        # Without last_sent_at the invitation counts from its creation.
        assert (await _resend(client, org, young.id)).status_code == 429

        allowed = await _resend(client, org, old.id)
        assert allowed.status_code == 200, allowed.text
        # ... and the next one right after it waits again.
        assert (await _resend(client, org, old.id)).status_code == 429

        assert (await _resend(client, org, exactly.id)).status_code == 200
    assert send_email.call_count == 2


@pytest.mark.unit
def test_the_wait_is_whole_seconds_up_to_ten_minutes_after_the_last_send() -> None:
    now = datetime(2026, 11, 8, 12, 0, 0)
    assert organizations.resend_wait(None, now) is None
    assert organizations.resend_wait(now - timedelta(minutes=10), now) is None
    almost = now - (timedelta(minutes=10) - timedelta(seconds=0.5))
    assert organizations.resend_wait(almost, now) == 1
    assert organizations.resend_wait(now - timedelta(minutes=3), now) == 420


@pytest.mark.asyncio
async def test_the_429_names_the_configured_wait(
    client: AsyncClient,
    db_session: AsyncSession,
    org: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(organizations, "RESEND_AFTER", timedelta(minutes=30))
    recent = await _invitation(
        db_session,
        org,
        payload={"last_sent_at": (_now() - timedelta(minutes=15)).isoformat()},
    )
    with patch.object(organizations, "send_email") as send_email:
        answer = await _resend(client, org, recent.id)
    assert answer.status_code == 429, answer.text
    assert answer.json()["detail"] == "The invitation was sent less than 30 minutes ago"
    assert 880 <= int(answer.headers["Retry-After"]) <= 900
    send_email.assert_not_called()


@pytest.mark.asyncio
async def test_the_refusals(
    client: AsyncClient, db_session: AsyncSession, org: dict[str, Any]
) -> None:
    other = make_organization(id=uuid4())
    db_session.add(other)
    await db_session.commit()
    accepted = await _invitation(db_session, org, status="accepted")
    expired = await _invitation(db_session, org, expires=_now() - timedelta(days=1))
    joined_elsewhere = await _invitation(db_session, org)
    db_session.add(
        User(
            id=uuid4(),
            email=joined_elsewhere.payload["user_email"],
            firstname="Jo",
            lastname="Ined",
            avatar="",
            organization_id=other.id,
        )
    )
    await db_session.commit()
    with patch.object(organizations, "send_email") as send_email:
        unknown = await _resend(client, org, uuid4())
        assert (
            unknown.status_code == 400
            and unknown.json()["detail"] == "Invitation not found"
        )
        not_pending = await _resend(client, org, accepted.id)
        assert not_pending.status_code == 400, not_pending.text
        assert not_pending.json()["detail"] == "Invitation not found"

        wrong_org = await client.post(
            f"{ORGS}/{other.id}/invitations/{joined_elsewhere.id}/resend",
            headers=as_user(org["admin"]),
        )
        assert wrong_org.status_code == 400, wrong_org.text

        gone = await _resend(client, org, expired.id)
        assert (
            gone.status_code == 409
            and gone.json()["detail"] == "The invitation has expired"
        )

        taken = await _resend(client, org, joined_elsewhere.id)
        assert taken.status_code == 400
        assert taken.json()["detail"] == "Invited user already has an organization"
    send_email.assert_not_called()


@pytest.mark.asyncio
async def test_the_invite_writes_last_sent_at_so_a_resend_right_after_waits(
    client: AsyncClient, db_session: AsyncSession, org: dict[str, Any]
) -> None:
    email = f"fresh-{uuid4().hex[:8]}@goat.test"
    with (
        patch.object(organizations, "send_email"),
        patch.object(
            keycloak_deps, "pending_setup_user_id", AsyncMock(return_value=None)
        ),
    ):
        invited = await client.post(
            f"{ORGS}/{org['id']}/invitations",
            json={"user_email": email, "role": "organization-viewer"},
            headers=as_user(org["admin"]),
        )
        assert invited.status_code == 200, invited.text
        assert "last_sent_at" in invited.json()["payload"]
        again = await _resend(client, org, invited.json()["id"])
    assert again.status_code == 429, again.text


@pytest.mark.asyncio
async def test_a_missing_organization_answers_404_and_sends_nothing(
    client: AsyncClient, db_session: AsyncSession, org: dict[str, Any]
) -> None:
    invitation = await _invitation(db_session, org)
    with (
        patch.object(organizations, "send_email") as send_email,
        patch.object(
            organizations.crud_organization, "get", AsyncMock(return_value=None)
        ),
    ):
        answer = await _resend(client, org, invitation.id)
    assert answer.status_code == 404, answer.text
    assert answer.json()["detail"] == "Organization not found"
    send_email.assert_not_called()
    assert "last_sent_at" not in (await _stored(db_session, invitation)).payload


@pytest.mark.asyncio
async def test_two_resends_at_once_send_one_mail(
    client: AsyncClient, db_session: AsyncSession, org: dict[str, Any]
) -> None:
    """The other resend stamps the invitation after this one read it: this one
    finds the slot taken and answers 429 instead of sending a second mail."""
    invitation = await _invitation(
        db_session,
        org,
        payload={"last_sent_at": (_now() - timedelta(minutes=11)).isoformat()},
    )
    theirs = datetime.now(timezone.utc).isoformat()

    async def the_other_resend() -> None:
        await _write_payload(db_session, invitation.id, last_sent_at=theirs)

    with (
        _after_the_read(the_other_resend),
        patch.object(organizations, "send_email") as send_email,
        patch.object(
            keycloak_deps, "pending_setup_user_id", AsyncMock(return_value=None)
        ),
    ):
        answer = await _resend(client, org, invitation.id)
    assert answer.status_code == 429, answer.text
    assert 590 <= int(answer.headers["Retry-After"]) <= 600
    send_email.assert_not_called()
    assert (await _stored(db_session, invitation)).payload["last_sent_at"] == theirs


@pytest.mark.asyncio
async def test_the_claim_takes_a_slot_only_with_the_stamp_it_read(
    db_session: AsyncSession, org: dict[str, Any]
) -> None:
    read = await _invitation(
        db_session,
        org,
        payload={"last_sent_at": (_now() - timedelta(minutes=11)).isoformat()},
    )
    first = datetime.now(timezone.utc)
    assert await crud_invitation.claim_send(db_session, invitation=read, sent_at=first)
    # `read` still holds the old stamp: a second claim from it loses.
    assert not await crud_invitation.claim_send(
        db_session, invitation=read, sent_at=first + timedelta(seconds=1)
    )
    stored = await _stored(db_session, read)
    assert stored.payload["last_sent_at"] == first.isoformat()
    # From the stored stamp it wins; without a stamp read and stored it wins.
    assert await crud_invitation.claim_send(
        db_session, invitation=stored, sent_at=first + timedelta(seconds=2)
    )
    unsent = await _invitation(db_session, org)
    assert await crud_invitation.claim_send(
        db_session, invitation=unsent, sent_at=first
    )
    # Only a pending invitation is claimed.
    accepted = await _invitation(db_session, org, status="accepted")
    assert not await crud_invitation.claim_send(
        db_session, invitation=accepted, sent_at=first
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("when", ["after_the_read", "during_the_mail"])
async def test_a_role_changed_meanwhile_stays(
    client: AsyncClient, db_session: AsyncSession, org: dict[str, Any], when: str
) -> None:
    """A role change (PATCH .../invitations/{id}/role) that lands while the
    resend runs is kept: the resend writes only `last_sent_at`."""
    invitation = await _invitation(db_session, org)

    async def change_role() -> None:
        await _write_payload(db_session, invitation.id, role="organization-editor")

    async def mail(*_: Any, **__: Any) -> bool:
        if when == "during_the_mail":
            await change_role()
        return True

    async def read_hook() -> None:
        if when == "after_the_read":
            await change_role()

    with (
        _after_the_read(read_hook),
        patch.object(
            keycloak_deps, "pending_setup_user_id", AsyncMock(return_value="kc-1")
        ),
        patch.object(
            keycloak_deps, "send_account_setup_email", AsyncMock(side_effect=mail)
        ),
    ):
        answer = await _resend(client, org, invitation.id)
    assert answer.status_code == 200, answer.text
    stored = (await _stored(db_session, invitation)).payload
    assert stored["role"] == "organization-editor"
    assert "last_sent_at" in stored
    assert answer.json()["payload"]["role"] == "organization-editor"


@pytest.mark.asyncio
@pytest.mark.parametrize("when", ["after_the_read", "during_the_mail"])
async def test_an_invitation_withdrawn_meanwhile_is_not_found(
    client: AsyncClient, db_session: AsyncSession, org: dict[str, Any], when: str
) -> None:
    """Withdrawn after the handler read it: the claim finds no pending row, or
    the answer finds no row; either way 400 as for any unknown invitation."""
    invitation = await _invitation(db_session, org)

    async def withdraw() -> None:
        await db_session.execute(
            text(f"DELETE FROM {settings.SCHEMA}.invitation WHERE id = :id"),
            {"id": invitation.id},
        )
        await db_session.commit()

    async def mail(*_: Any, **__: Any) -> bool:
        if when == "during_the_mail":
            await withdraw()
        return True

    async def read_hook() -> None:
        if when == "after_the_read":
            await withdraw()

    with (
        _after_the_read(read_hook),
        patch.object(
            keycloak_deps, "pending_setup_user_id", AsyncMock(return_value="kc-1")
        ),
        patch.object(
            keycloak_deps, "send_account_setup_email", AsyncMock(side_effect=mail)
        ) as setup,
    ):
        answer = await _resend(client, org, invitation.id)
    assert answer.status_code == 400, answer.text
    assert answer.json()["detail"] == "Invitation not found"
    assert setup.await_count == (1 if when == "during_the_mail" else 0)


@pytest.mark.asyncio
async def test_a_role_change_keeps_a_stamp_written_meanwhile(
    client: AsyncClient, db_session: AsyncSession, org: dict[str, Any]
) -> None:
    """The other way round: a resend that stamps `last_sent_at` while a role
    change (PATCH .../invitations/{id}/role) runs keeps its stamp, since the
    role change writes only `role`. Rewriting the whole payload as read would
    put the old stamp back and let the next resend through early."""
    invitation = await _invitation(db_session, org)
    stamp = _now().replace(microsecond=0).isoformat() + "+00:00"
    stamped: list[bool] = []

    async def resend_stamps() -> None:
        if not stamped:  # once, right after the handler's read
            stamped.append(True)
            await _write_payload(db_session, invitation.id, last_sent_at=stamp)

    with _after_the_read(resend_stamps):
        answer = await client.patch(
            f"{ORGS}/{org['id']}/invitations/{invitation.id}/role",
            json={"role": "organization-editor"},
            headers=as_user(org["admin"]),
        )
    assert answer.status_code == 200, answer.text
    assert stamped
    stored = (await _stored(db_session, invitation)).payload
    assert stored["role"] == "organization-editor"
    assert stored["last_sent_at"] == stamp
    # The answer is the invitation as stored.
    assert answer.json()["payload"] == stored


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("change", "after_read"),
    [
        ("withdrawn", 1),  # after the route's read: the role change finds no row
        ("withdrawn", 2),  # after the role change's own read: its UPDATE hits none
        ("accepted", 2),  # no longer pending: nothing to change either
    ],
)
async def test_a_role_change_on_an_invitation_gone_meanwhile_is_not_found(
    client: AsyncClient,
    db_session: AsyncSession,
    org: dict[str, Any],
    change: str,
    after_read: int,
) -> None:
    """An invitation withdrawn (or accepted) while its role changes answers
    400 "Invitation not found", as the resend does, not a 500."""
    invitation = await _invitation(db_session, org)
    invitation_id = invitation.id
    reads: list[int] = []

    async def meanwhile() -> None:
        reads.append(len(reads) + 1)
        if len(reads) != after_read:
            return
        statement = (
            f"DELETE FROM {settings.SCHEMA}.invitation WHERE id = :id"
            if change == "withdrawn"
            else f"UPDATE {settings.SCHEMA}.invitation SET status = 'accepted' WHERE id = :id"
        )
        await db_session.execute(text(statement), {"id": invitation_id})
        await db_session.commit()

    with _after_the_read(meanwhile):
        answer = await client.patch(
            f"{ORGS}/{org['id']}/invitations/{invitation_id}/role",
            json={"role": "organization-editor"},
            headers=as_user(org["admin"]),
        )
    assert len(reads) >= after_read
    assert answer.status_code == 400, answer.text
    assert answer.json()["detail"] == "Invitation not found"
    if change == "accepted":
        stored = (await _stored(db_session, invitation)).payload
        assert stored["role"] == "organization-viewer"
