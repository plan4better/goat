from datetime import datetime, timedelta

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


def test_a_repeated_renewal_keeps_the_usage_since_the_first():
    org = make_organization(total_credits=1000, used_credits=940)
    renewal = {"total_credits": 5000, "plan_renewal_date": "2026-08-01T00:00:00"}
    crud_org.apply_entitlement(organization=org, entitlement=renewal, reset_usage=True)
    org.used_credits = 120  # used after the renewal

    # The same renewal again (a retry, possibly with a newer as_of).
    crud_org.apply_entitlement(
        organization=org,
        entitlement={**renewal, "as_of": "2026-08-01T00:05:00"},
        reset_usage=True,
    )
    assert float(org.used_credits) == 120

    # The next renewal resets.
    crud_org.apply_entitlement(
        organization=org,
        entitlement={**renewal, "plan_renewal_date": "2026-09-01T00:00:00"},
        reset_usage=True,
    )
    assert float(org.used_credits) == 0


def test_apply_entitlement_plan_change_keeps_usage():
    # Within a running period: the push that starts the first one clears usage.
    org = make_organization(
        total_credits=1000,
        used_credits=300,
        credits_reset_at=datetime.now() + timedelta(days=20),
    )
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


# --- AI credits: the allowance follows the seats unless a push overrides it.

PER_EDITOR = 200


def _apply(org, reset_usage=False, **entitlement):
    return crud_org.apply_entitlement(
        organization=org,
        entitlement=entitlement,
        reset_usage=reset_usage,
        ai_credits_per_editor=PER_EDITOR,
    )


def test_a_subscriptions_ai_credits_follow_its_seats():
    org = make_organization(on_trial=False, total_ai_credits=None)
    _apply(org, total_editors=5)
    assert float(org.total_ai_credits) == 5 * PER_EDITOR
    assert org.ai_credits_override is False

    _apply(org, total_editors=7)
    assert float(org.total_ai_credits) == 7 * PER_EDITOR

    _apply(org, total_editors=None)
    assert org.total_ai_credits is None  # unlimited seats, unlimited AI credits


def test_an_explicit_allowance_wins_and_lasts_while_pushes_leave_seats_alone():
    org = make_organization(on_trial=False)
    _apply(org, total_editors=5, total_ai_credits=5000)
    assert float(org.total_ai_credits) == 5000
    assert org.ai_credits_override is True

    _apply(org, suspended=False, plan_renewal_date="2027-01-01T00:00:00")
    assert float(org.total_ai_credits) == 5000
    assert org.ai_credits_override is True

    _apply(org, total_editors=6, total_ai_credits=None)
    assert org.total_ai_credits is None  # null: unlimited
    assert org.ai_credits_override is True


def test_a_push_with_seats_and_without_the_override_ends_it():
    org = make_organization(on_trial=False)
    _apply(org, total_editors=5, total_ai_credits=5000)

    _apply(org, total_editors=6)
    assert float(org.total_ai_credits) == 6 * PER_EDITOR
    assert org.ai_credits_override is False


def test_a_trial_keeps_its_ai_credits_when_its_seats_change():
    org = make_organization(on_trial=True, total_ai_credits=100)
    _apply(org, total_editors=5)
    assert float(org.total_ai_credits) == 100


def test_a_conversion_gives_the_seat_allowance():
    org = make_organization(on_trial=True, total_editors=4, total_ai_credits=100)
    _apply(org, on_trial=False)
    assert float(org.total_ai_credits) == 4 * PER_EDITOR

    trial = make_organization(on_trial=True, total_editors=4, total_ai_credits=100)
    _apply(trial, on_trial=False, total_editors=10)
    assert float(trial.total_ai_credits) == 10 * PER_EDITOR


def test_a_conversion_keeps_an_override_given_during_the_trial():
    org = make_organization(on_trial=True, total_editors=4)
    _apply(org, total_ai_credits=750)
    _apply(org, on_trial=False)
    assert float(org.total_ai_credits) == 750
    assert org.ai_credits_override is True


def test_used_ai_credits_reset_with_the_other_credits():
    org = make_organization(on_trial=False, used_credits=40, used_ai_credits=90)
    renewal = {"plan_renewal_date": "2026-08-01T00:00:00"}
    _apply(org, reset_usage=True, **renewal)
    assert (float(org.used_credits), float(org.used_ai_credits)) == (0, 0)

    org.used_credits, org.used_ai_credits = 10, 20
    _apply(org, reset_usage=True, **renewal)  # a repeat
    assert (float(org.used_credits), float(org.used_ai_credits)) == (10, 20)

    _apply(org, total_editors=3)  # no reset asked for
    assert float(org.used_ai_credits) == 20

    trial = make_organization(on_trial=True, used_credits=5, used_ai_credits=60)
    _apply(trial, on_trial=False)  # a conversion
    assert (float(trial.used_credits), float(trial.used_ai_credits)) == (0, 0)


def test_the_first_monthly_period_starts_with_nothing_used():
    """Usage booked before the organization had a period (with billing off AI
    answers are recorded, never limited) does not count against its first
    allowance: the push that starts the period clears it."""
    org = make_organization(
        on_trial=False, credits_reset_at=None, used_credits=300, used_ai_credits=30
    )
    _apply(org, total_editors=4)
    assert (float(org.used_credits), float(org.used_ai_credits)) == (0, 0)
    assert org.credits_reset_at is not None
    assert float(org.total_ai_credits) == 4 * PER_EDITOR


def test_a_push_within_a_running_period_keeps_what_was_used():
    org = make_organization(on_trial=False, credits_reset_at=None)
    _apply(org, total_editors=4)  # the first period starts
    period_ends = org.credits_reset_at
    org.used_credits, org.used_ai_credits = 120, 12

    _apply(org, total_editors=5)
    _apply(org, total_editors=5, suspended=False)  # the same seats again
    assert (float(org.used_credits), float(org.used_ai_credits)) == (120, 12)
    assert org.credits_reset_at == period_ends
