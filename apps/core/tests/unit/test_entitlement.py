from datetime import datetime

from core.crud.crud_organization import organization as crud_org
from tests.utils import make_organization


def test_apply_entitlement_resets_usage_on_renewal():
    org = make_organization(total_credits=1000, used_credits=940)
    crud_org.apply_entitlement(
        organization=org,
        entitlement={
            "total_credits": 5000,
            "total_storage": 51200,
            "plan_renewal_date": "2026-08-01T00:00:00",
        },
        reset_usage=True,
    )
    assert float(org.total_credits) == 5000
    assert float(org.total_storage) == 51200
    assert float(org.used_credits) == 0
    assert org.plan_renewal_date == datetime.fromisoformat("2026-08-01T00:00:00")


def test_apply_entitlement_plan_change_keeps_usage():
    org = make_organization(total_credits=1000, used_credits=300)
    crud_org.apply_entitlement(
        organization=org,
        entitlement={"total_credits": 2000},
        reset_usage=False,
    )
    assert float(org.total_credits) == 2000
    assert float(org.used_credits) == 300  # untouched


def test_apply_entitlement_null_cap_sets_unlimited():
    org = make_organization(total_credits=1000, used_credits=50)
    crud_org.apply_entitlement(
        organization=org,
        entitlement={"total_credits": None},
        reset_usage=False,
    )
    assert org.total_credits is None  # explicit null -> unlimited


def test_apply_entitlement_extras_granted_and_revoked():
    org = make_organization()
    assert org.extras is None  # default: all features enabled

    crud_org.apply_entitlement(
        organization=org,
        entitlement={"extras": ["white_label"]},
        reset_usage=False,
    )
    assert org.extras == ["white_label"]

    crud_org.apply_entitlement(
        organization=org,
        entitlement={"extras": []},
        reset_usage=False,
    )
    assert org.extras == []  # none granted

    crud_org.apply_entitlement(
        organization=org,
        entitlement={"extras": None},
        reset_usage=False,
    )
    assert org.extras is None  # back to unrestricted

    crud_org.apply_entitlement(
        organization=org,
        entitlement={"total_credits": 100},
        reset_usage=False,
    )
    assert org.extras is None  # absent key leaves extras untouched


def test_apply_entitlement_conversion_clears_trial():
    org = make_organization(on_trial=True)
    crud_org.apply_entitlement(
        organization=org,
        entitlement={"total_editors": 5, "on_trial": False},
        reset_usage=False,
    )
    assert org.on_trial is False
    assert org.total_editors == 5

    crud_org.apply_entitlement(
        organization=org,
        entitlement={"total_editors": 6},
        reset_usage=False,
    )
    assert org.on_trial is False  # absent key leaves it untouched


def test_apply_entitlement_suspend_and_reactivate():
    org = make_organization()
    crud_org.apply_entitlement(
        organization=org,
        entitlement={"suspended": True},
        reset_usage=False,
    )
    assert org.suspended is True

    crud_org.apply_entitlement(
        organization=org,
        entitlement={"suspended": False},
        reset_usage=False,
    )
    assert org.suspended is False
