"""Owners, admins and editors share the editor pool (B4, F7).

A member or an invitation that moves between admin and editor keeps the seat
it holds, so a full editor pool must not refuse the swap. Moving into the
other pool still needs a free seat there.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from core.crud import crud_organization as crud_module
from core.crud.crud_organization import organization as crud_org
from core.db.models.invitation import Invitation
from core.db.models.organization import OrganizationRolesEnum
from core.schemas.organization import OrganizationMemberRoleUpdateEnum
from fastapi import HTTPException
from tests.utils import make_organization

EDITOR = OrganizationRolesEnum.editor
ADMIN = OrganizationRolesEnum.admin
VIEWER = OrganizationRolesEnum.viewer


def _editors_full(**overrides):
    values = {
        "id": uuid4(),
        "total_editors": 3,
        "used_editors": 3,
        "total_viewers": 10,
        "used_viewers": 2,
    }
    values.update(overrides)
    return make_organization(**values)


class _PastTheSeatCheck(Exception):  # noqa: N818
    """Raised by the role lookup that follows the seat check in update_user_role."""


@pytest.mark.unit
@pytest.mark.parametrize(("current", "target"), [(EDITOR, ADMIN), (ADMIN, EDITOR)])
def test_a_swap_inside_the_editor_pool_needs_no_free_seat(current, target) -> None:
    crud_org.check_seats_quota(
        role=target, organization=_editors_full(), current_role=current
    )  # no raise


@pytest.mark.unit
def test_a_viewer_still_needs_a_free_editor_seat() -> None:
    with pytest.raises(HTTPException) as error:
        crud_org.check_seats_quota(
            role=EDITOR, organization=_editors_full(), current_role=VIEWER
        )
    assert error.value.status_code == 400


@pytest.mark.unit
def test_an_editor_turned_viewer_needs_a_viewer_seat() -> None:
    viewers_full = _editors_full(total_viewers=2, used_viewers=2)
    with pytest.raises(HTTPException):
        crud_org.check_seats_quota(
            role=VIEWER, organization=viewers_full, current_role=EDITOR
        )
    crud_org.check_seats_quota(
        role=VIEWER, organization=_editors_full(), current_role=EDITOR
    )  # a viewer seat is free


@pytest.mark.unit
def test_without_a_current_role_the_target_pool_decides() -> None:
    with pytest.raises(HTTPException):
        crud_org.check_seats_quota(role=ADMIN, organization=_editors_full())


async def _change_member_role(current: str, target: OrganizationMemberRoleUpdateEnum):
    organization = _editors_full()
    member = SimpleNamespace(
        organization_id=organization.id,
        role_links=[SimpleNamespace(role=SimpleNamespace(name=current))],
    )
    with (
        patch.object(
            crud_module.crud_user,
            "get_user_with_roles",
            AsyncMock(return_value=member),
        ),
        patch.object(crud_org, "get", AsyncMock(return_value=organization)),
        patch.object(
            crud_module.crud_role,
            "get_by_key",
            AsyncMock(side_effect=_PastTheSeatCheck),
        ),
    ):
        await crud_org.update_user_role(
            db=AsyncMock(),
            organization_id=str(organization.id),
            user_id=str(uuid4()),
            role=target,
        )


@pytest.mark.unit
async def test_a_member_swaps_editor_to_admin_while_every_editor_seat_is_taken() -> (
    None
):
    with pytest.raises(_PastTheSeatCheck):
        await _change_member_role(EDITOR.value, OrganizationMemberRoleUpdateEnum.admin)


@pytest.mark.unit
async def test_a_viewer_member_is_still_refused_an_editor_seat() -> None:
    with pytest.raises(HTTPException) as error:
        await _change_member_role(VIEWER.value, OrganizationMemberRoleUpdateEnum.editor)
    assert error.value.status_code == 400


@pytest.mark.unit
async def test_an_invitation_swaps_admin_to_editor_while_every_editor_seat_is_taken() -> (
    None
):
    invitation = Invitation(
        id=uuid4(),
        send_by=uuid4(),
        organization_id=uuid4(),
        type="organization",
        status="pending",
        payload={"user_email": "swap@goat.test", "role": ADMIN.value},
    )
    with (
        patch.object(
            crud_module.crud_invitations, "get", AsyncMock(return_value=invitation)
        ),
        patch.object(crud_org, "get", AsyncMock(return_value=_editors_full())),
    ):
        db = AsyncMock()
        # The UPDATE finds the pending invitation and answers its id.
        db.execute.return_value = MagicMock(**{"first.return_value": (invitation.id,)})
        changed = await crud_org.update_invitation_role(
            db=db,
            invitation_id=str(invitation.id),
            role=OrganizationMemberRoleUpdateEnum.editor,
        )
    assert changed is invitation
    # Past the seat check: the new role is written (only that key, one UPDATE).
    db.execute.assert_awaited_once()
    assert db.execute.await_args.args[1] == {
        "role": EDITOR.value,
        "id": invitation.id,
        "pending": "pending",
    }
