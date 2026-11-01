from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from core.db.models.invitation import Invitation
from core.deps import keycloak as keycloak_deps
from core.endpoints.v2 import organizations
from core.schemas.invitations import InvitationOrgCreate
from fastapi import HTTPException
from keycloak.exceptions import KeycloakGetError, KeycloakPostError, KeycloakPutError

ADMIN_ID = "d78bf1ae-72f5-4104-8f0c-f48c80f3f63b"
ORG_ID = str(uuid4())
NEW_KC_USER_ID = "0b6c8a52-5d0e-4e0a-9a51-4f7e1d2c3b4a"
EMAIL = "new.colleague@example.com"


def _organization() -> SimpleNamespace:
    return SimpleNamespace(
        id=ORG_ID, name="Org", avatar=None, region="EU", suspended=False
    )


def _stored_invitation() -> AsyncMock:
    async def stored(db: Any, obj_in: Invitation) -> Invitation:
        obj_in.id = uuid4()
        return obj_in

    return AsyncMock(side_effect=stored)


def _admin(existing_users: list[dict] | None = None) -> MagicMock:
    admin = MagicMock()
    admin.get_users.return_value = existing_users or []
    admin.create_user.return_value = NEW_KC_USER_ID
    admin.send_update_account.return_value = {}
    return admin


async def _invite(
    admin: MagicMock | None,
    *,
    core_users: list[Any] | None = None,
    email: str = EMAIL,
    create_invitation: AsyncMock | None = None,
) -> tuple[Any, MagicMock, AsyncMock]:
    create_invitation = create_invitation or _stored_invitation()
    with (
        patch.object(
            organizations.crud_user,
            "get_by_key",
            AsyncMock(return_value=core_users or []),
        ),
        patch.object(
            organizations.crud_organization,
            "get",
            AsyncMock(return_value=_organization()),
        ),
        patch.object(
            organizations.crud_invitation,
            "query_by_payload_attribute",
            AsyncMock(return_value=[]),
        ),
        patch.object(organizations.crud_organization, "check_seats_quota"),
        patch.object(organizations.crud_invitation, "create", create_invitation),
        patch.object(organizations, "send_email") as send_email,
        patch.object(organizations, "user_language", AsyncMock(return_value="de")),
        patch.object(keycloak_deps, "keycloak_admin", AsyncMock(return_value=admin)),
    ):
        result = await organizations.invite_user_to_organization(
            db=MagicMock(),
            organization_id=ORG_ID,
            user_token={"sub": ADMIN_ID},
            payload=InvitationOrgCreate(user_email=email, role="organization-editor"),
        )
    return result, send_email, create_invitation


@pytest.fixture
def provisioning_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(keycloak_deps.settings, "AUTH", True)
    monkeypatch.setattr(
        keycloak_deps.settings, "KEYCLOAK_PROVISION_INVITED_USERS", True
    )
    monkeypatch.setattr(keycloak_deps.settings, "KEYCLOAK_CLIENT_ID", "goat")
    monkeypatch.setattr(
        keycloak_deps.settings, "CLIENT_URL", "https://goat.example.org"
    )


@pytest.mark.unit
async def test_flag_off_makes_no_keycloak_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(keycloak_deps.settings, "AUTH", True)
    monkeypatch.setattr(
        keycloak_deps.settings, "KEYCLOAK_PROVISION_INVITED_USERS", False
    )
    admin = _admin()
    result, send_email, create_invitation = await _invite(admin)
    assert admin.mock_calls == []
    create_invitation.assert_awaited_once()
    send_email.assert_called_once()
    assert result.account_setup is None


@pytest.mark.unit
async def test_auth_off_makes_no_keycloak_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(keycloak_deps.settings, "AUTH", False)
    monkeypatch.setattr(
        keycloak_deps.settings, "KEYCLOAK_PROVISION_INVITED_USERS", True
    )
    admin = _admin()
    result, _, create_invitation = await _invite(admin)
    assert admin.mock_calls == []
    create_invitation.assert_awaited_once()
    assert result.account_setup is None


@pytest.mark.unit
async def test_unknown_email_creates_user_and_sends_setup_email(
    provisioning_on: None,
) -> None:
    admin = _admin()
    result, send_email, create_invitation = await _invite(admin)

    admin.get_users.assert_called_once_with({"email": EMAIL, "exact": True})
    admin.create_user.assert_called_once_with(
        {
            "username": EMAIL,
            "email": EMAIL,
            "enabled": True,
            "emailVerified": False,
            "requiredActions": ["UPDATE_PASSWORD"],
        }
    )
    admin.send_update_account.assert_called_once_with(
        user_id=NEW_KC_USER_ID,
        payload=["UPDATE_PASSWORD"],
        client_id="goat",
        lifespan=7 * 24 * 60 * 60,
        redirect_uri=(
            f"https://goat.example.org/onboarding/organization/invite/{result.id}"
        ),
    )
    create_invitation.assert_awaited_once()
    send_email.assert_called_once()
    assert result.account_setup == "email_sent"
    assert result.model_dump(mode="json")["account_setup"] == "email_sent"


@pytest.mark.unit
async def test_known_keycloak_email_is_not_created(provisioning_on: None) -> None:
    admin = _admin(existing_users=[{"id": "kc-user", "email": EMAIL}])
    result, send_email, _ = await _invite(admin)
    admin.create_user.assert_not_called()
    admin.send_update_account.assert_not_called()
    send_email.assert_called_once()
    assert result.account_setup is None


@pytest.mark.unit
async def test_search_match_on_another_email_still_creates(
    provisioning_on: None,
) -> None:
    # Keycloak's email search can match on a substring; only an exact
    # (case-insensitive) address counts as an existing account.
    admin = _admin(existing_users=[{"id": "kc-other", "email": f"x{EMAIL}"}])
    result, _, _ = await _invite(admin)
    admin.create_user.assert_called_once()
    assert result.account_setup == "email_sent"


@pytest.mark.unit
async def test_existing_goat_user_skips_keycloak(provisioning_on: None) -> None:
    admin = _admin()
    core_user = SimpleNamespace(id=uuid4(), organization_id=None)
    result, _, create_invitation = await _invite(admin, core_users=[core_user])
    assert admin.mock_calls == []
    create_invitation.assert_awaited_once()
    assert result.account_setup is None


@pytest.mark.unit
async def test_setup_email_failure_keeps_user_and_invitation(
    provisioning_on: None,
) -> None:
    admin = _admin()
    admin.send_update_account.side_effect = KeycloakPutError(
        error_message=b'{"errorMessage":"Failed to send execute actions email"}',
        response_code=500,
    )
    result, send_email, create_invitation = await _invite(admin)
    admin.create_user.assert_called_once()
    admin.delete_user.assert_not_called()
    create_invitation.assert_awaited_once()
    send_email.assert_called_once()
    assert result.account_setup == "manual"


@pytest.mark.unit
async def test_concurrently_created_user_counts_as_existing(
    provisioning_on: None,
) -> None:
    admin = _admin()
    admin.create_user.side_effect = KeycloakPostError(
        error_message=b'{"errorMessage":"User exists with same username"}',
        response_code=409,
    )
    result, _, create_invitation = await _invite(admin)
    admin.send_update_account.assert_not_called()
    create_invitation.assert_awaited_once()
    assert result.account_setup is None


@pytest.mark.unit
async def test_create_failure_surfaces_before_the_invitation_is_stored(
    provisioning_on: None,
) -> None:
    admin = _admin()
    admin.create_user.side_effect = KeycloakPostError(
        error_message=b'{"error":"unknown_error"}', response_code=403
    )
    create_invitation = _stored_invitation()
    with pytest.raises(HTTPException) as exc:
        await _invite(admin, create_invitation=create_invitation)
    assert exc.value.status_code == 502
    create_invitation.assert_not_awaited()


@pytest.mark.unit
async def test_lookup_failure_surfaces(provisioning_on: None) -> None:
    admin = _admin()
    admin.get_users.side_effect = KeycloakGetError(
        error_message=b'{"error":"unknown_error"}', response_code=403
    )
    with pytest.raises(HTTPException) as exc:
        await _invite(admin)
    assert exc.value.status_code == 502
    admin.create_user.assert_not_called()


@pytest.mark.unit
async def test_unconfigured_admin_client_keeps_todays_flow(
    provisioning_on: None,
) -> None:
    result, send_email, create_invitation = await _invite(None)
    create_invitation.assert_awaited_once()
    send_email.assert_called_once()
    assert result.account_setup is None


@pytest.mark.unit
async def test_provisioned_invitee_accepts_with_mixed_case_token_email() -> None:
    from core.endpoints.v2 import users

    invitation = Invitation(
        id=uuid4(),
        send_by=uuid4(),
        organization_id=ORG_ID,
        type="organization",
        status="pending",
        payload={
            "user_email": EMAIL,
            "organization_id": ORG_ID,
            "role": "organization-editor",
        },
    )
    user = SimpleNamespace(id=uuid4(), organization=None, organization_id=None)
    update_invitation = AsyncMock()
    remove_roles = AsyncMock()
    with (
        patch.object(users.crud_invitation, "get", AsyncMock(return_value=invitation)),
        patch.object(
            users.crud_user, "create_if_not_exists", AsyncMock(return_value=user)
        ),
        patch.object(
            users.crud_organization, "get", AsyncMock(return_value=_organization())
        ),
        patch.object(
            users.crud_role, "get_by_key", AsyncMock(return_value=[MagicMock()])
        ),
        patch.object(users, "UserRoleLink", MagicMock()),
        patch.object(users.crud_invitation, "update", update_invitation),
        patch.object(users.crud_role, "remove_organization_roles", remove_roles),
    ):
        await users.accept_invitation(
            db=AsyncMock(add=MagicMock()),
            user_token={"sub": NEW_KC_USER_ID, "email": "New.Colleague@Example.com"},
            token="token",
            invitation_id=str(invitation.id),
        )
    remove_roles.assert_awaited_once()
    update_invitation.assert_awaited_once()
    assert update_invitation.await_args.kwargs["obj_in"] == {"status": "accepted"}
