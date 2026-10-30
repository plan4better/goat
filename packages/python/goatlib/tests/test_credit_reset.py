from datetime import datetime

from goatlib.tasks.credit_reset import advance_renewal, should_reset


def test_should_reset():
    now = datetime(2026, 7, 1, 0, 5)
    assert should_reset(datetime(2026, 7, 1, 0, 0), now) is True
    assert should_reset(datetime(2026, 8, 1, 0, 0), now) is False
    assert should_reset(None, now) is False


def test_advance_renewal_jumps_past_now_in_month_steps():
    # renewal far in the past -> advance month-by-month to first boundary after now
    now = datetime(2026, 7, 15)
    out = advance_renewal(datetime(2026, 1, 31), now)
    assert out > now
    # day clamps for short months along the way; result is a real date after now
    assert out.year == 2026 and out.month in (7, 8)  # next boundary after Jul 15


def test_billing_tasks_do_nothing_with_billing_off(monkeypatch):
    # Self-hosted workers: no metering, no trials.

    from goatlib.tasks import (
        compute_rollup,
        credit_reset,
        traffic_rollup,
        trial_expiry,
    )
    from goatlib.tasks._db import SKIPPED

    monkeypatch.delenv("BILLING_ENABLED", raising=False)
    for task in (compute_rollup, traffic_rollup, credit_reset):
        assert task.main() == SKIPPED
    assert trial_expiry.main() == SKIPPED


def test_one_failing_organization_does_not_stop_the_others(monkeypatch):
    import asyncpg
    from goatlib.tasks import credit_reset

    due = [{"id": i, "credits_reset_at": datetime(2026, 7, 1)} for i in ("a", "b", "c")]

    class Core:
        def __init__(self):
            self.updated = []

        async def fetch(self, sql, now):
            return due

        async def execute(self, sql, org_id, when):
            if org_id == "b":
                raise RuntimeError("locked")
            self.updated.append(org_id)

        async def close(self):
            pass

    core = Core()

    async def connect(dsn, timeout=None):
        return core

    monkeypatch.setenv("BILLING_ENABLED", "1")
    monkeypatch.setattr(asyncpg, "connect", connect)
    monkeypatch.setattr(credit_reset, "core_dsn", lambda: "core")
    monkeypatch.setattr(credit_reset, "_redis", lambda: None)
    result = credit_reset.main()
    assert core.updated == ["a", "c"]
    assert result["reset"] == 2
    assert [e["organization_id"] for e in result["errors"]] == ["b"]
