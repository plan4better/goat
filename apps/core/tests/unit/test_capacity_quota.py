import pytest
from core.crud.crud_organization import organization as crud_org
from core.db.models.organization import OrganizationRolesEnum
from fastapi import HTTPException
from tests.utils import make_organization


def test_seats_unlimited_when_total_none():
    org = make_organization(total_editors=None, used_editors=999)
    crud_org.check_seats_quota(
        role=OrganizationRolesEnum.editor, organization=org
    )  # no raise


def test_seats_block_when_full():
    org = make_organization(total_editors=1, used_editors=1)
    with pytest.raises(HTTPException) as ei:
        crud_org.check_seats_quota(role=OrganizationRolesEnum.editor, organization=org)
    assert ei.value.status_code == 400


def test_capacity_projects_block_and_unlimited():
    org = make_organization(total_projects=5, used_projects=5)
    with pytest.raises(HTTPException):
        crud_org.check_capacity_quota(organization=org, quota="projects", incoming=1)

    org2 = make_organization(total_projects=None, used_projects=10_000)
    crud_org.check_capacity_quota(
        organization=org2, quota="projects", incoming=1
    )  # no raise


def test_capacity_storage_is_size_aware():
    # total 50 MB, used 49 MB; a 2 MB upload (incoming) pushes over -> block
    org = make_organization(total_storage=50, used_storage=49)
    with pytest.raises(HTTPException):
        crud_org.check_capacity_quota(organization=org, quota="storage", incoming=2)
    # a 0.5 MB upload still fits
    crud_org.check_capacity_quota(
        organization=org, quota="storage", incoming=0.5
    )  # no raise
