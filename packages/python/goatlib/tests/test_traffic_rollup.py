import asyncio
import time

from goatlib.tasks import traffic_rollup as tr
from goatlib.tasks.traffic_rollup import (
    claim_egress,
    decide_over_budget,
    parse_meter_key,
    recover_inflight,
    refresh_over_budget_flags,
)


def test_parse_meter_key():
    assert parse_meter_key("meter:egress:org1:lyr9:tiles") == ("org1", "lyr9", "tiles")
    assert parse_meter_key("meter:egress:org1:lyr9:features") == (
        "org1",
        "lyr9",
        "features",
    )


def test_decide_over_budget():
    assert decide_over_budget(100, 100) is True
    assert decide_over_budget(99, 100) is False
    assert decide_over_budget(10_000, None) is False  # unlimited never over


class _FakePipeline:
    def __init__(self, redis):
        self._redis = redis
        self._queue: list = []

    def __getattr__(self, name):
        def queue(*args):
            self._queue.append((name, args))

        return queue

    def execute(self):
        return [getattr(self._redis, n)(*a) for n, a in self._queue]


class _FakeRedis:
    def __init__(self, hashes=None, flags=()):
        self.h = {k: dict(v) for k, v in (hashes or {}).items()}
        self.flags = set(flags)
        self.fail_delete = False

    def scan_iter(self, match):
        prefix = match.replace("*", "")
        if prefix.startswith("meter:over_budget:"):
            return [f for f in self.flags if f.startswith(prefix)]
        return [k for k in list(self.h) if k.startswith(prefix)]

    def hgetall(self, key):
        return self.h.get(key, {})

    def delete(self, key):
        self.h.pop(key, None)
        self.flags.discard(key)

    def set(self, key, value):
        self.flags.add(key)

    def rename(self, src, dst):
        if src not in self.h:
            raise RuntimeError("ERR no such key")
        self.h[dst] = self.h.pop(src)

    def hincrby(self, key, field, amount):
        h = self.h.setdefault(key, {})
        h[field] = str(int(h.get(field, 0)) + amount)

    def hsetnx(self, key, field, value):
        self.h.setdefault(key, {}).setdefault(field, value)

    def pipeline(self):
        return _FakePipeline(self)


ORG = "11111111-1111-1111-1111-111111111111"
ORG2 = "22222222-2222-2222-2222-222222222222"
LIVE = f"meter:egress:{ORG}:lyr1:tiles"


def _hash(n_bytes=1000, count=4, anon=1, owner="ownA"):
    return {
        "bytes": str(n_bytes),
        "count": str(count),
        "anon_count": str(anon),
        "owner": owner,
    }


def test_claim_renames_to_an_inflight_key_and_drops_junk():
    zero = f"meter:egress:{ORG}:lyr2:features"
    bad = "meter:egress:short"
    r = _FakeRedis({LIVE: _hash(1073741824, 42, 30), zero: _hash(0), bad: _hash()})
    rows = claim_egress(r, "123-abc")
    inflight = f"meter:egress_inflight:123-abc:{ORG}:lyr1:tiles"
    assert rows == [
        {
            "key": inflight,
            "live_key": LIVE,
            "org": ORG,
            "owner": "ownA",
            "layer": "lyr1",
            "service": "tiles",
            "bytes": 1073741824,
            "count": 42,
            "anon_count": 30,
        }
    ]
    assert LIVE not in r.h  # moved: new traffic starts a fresh live key
    assert inflight in r.h
    assert zero not in r.h and bad not in r.h
    assert not any("lyr2" in k for k in r.h)  # the zero hash was dropped too


def test_claim_skips_a_key_that_vanished_after_the_scan():
    r = _FakeRedis({LIVE: _hash()})
    r.scan_iter = lambda match: [LIVE, f"meter:egress:{ORG}:gone:tiles"]
    assert [x["layer"] for x in claim_egress(r, "1-a")] == ["lyr1"]


def test_claim_dry_run_has_no_side_effects():
    zero = f"meter:egress:{ORG}:lyr2:features"
    r = _FakeRedis({LIVE: _hash(), zero: _hash(0), "meter:egress:bad": _hash()})
    before = {k: dict(v) for k, v in r.h.items()}
    rows = claim_egress(r, "1-a", dry_run=True)
    assert [x["layer"] for x in rows] == ["lyr1"]
    assert r.h == before


class _FakeCore:
    def __init__(self, orgs=(), charged_claims=(), fail_charge=False, fail_check=False):
        self.orgs = list(orgs)
        self.claims = set(charged_claims)
        self.fail_charge, self.fail_check = fail_charge, fail_check
        self.charges: list[tuple] = []

    async def execute(self, sql, *args):
        if self.fail_charge:
            raise RuntimeError("timeout")
        import json

        self.charges.append((args, json.loads(args[-1])))
        self.claims.add(json.loads(args[-1])["claim"])

    async def fetchrow(self, sql, org, claim):
        if self.fail_check:
            raise RuntimeError("db down")
        return {"?column?": 1} if claim in self.claims else None

    async def fetch(self, sql, flagged):
        self.flagged_arg = flagged
        return [
            {"id": o, "used_credits": u, "total_credits": t}
            for o, u, t in self.orgs
            if t is not None and (u or 0) >= t or o in flagged
        ]

    async def close(self):
        pass


def _run_main(monkeypatch, redis, core, dry_run=False):
    import asyncpg

    async def connect(dsn, timeout=None):
        return core

    monkeypatch.setenv("BILLING_ENABLED", "1")
    monkeypatch.setattr(asyncpg, "connect", connect)
    monkeypatch.setattr(tr, "core_dsn", lambda: "core")
    monkeypatch.setattr(tr, "_redis", lambda: redis)
    return tr.main(tr.TrafficRollupParams(dry_run=dry_run))


def test_charge_carries_the_claim_marker_and_deletes_the_inflight_key(monkeypatch):
    r = _FakeRedis({LIVE: _hash()})
    core = _FakeCore()
    summary = _run_main(monkeypatch, r, core)
    assert summary["charged"] == 1 and summary["failed"] == 0
    payload = core.charges[0][1]
    assert payload["claim"].startswith("meter:egress_inflight:")
    assert payload["run_id"] in payload["claim"]
    assert not r.h  # nothing live, nothing in flight


def test_failed_charge_merges_counts_back_into_the_live_key(monkeypatch):
    r = _FakeRedis({LIVE: _hash(1000, 4, 1)})
    core = _FakeCore(fail_charge=True)
    # a write that arrives while the charge is running goes to the new live key
    summary = _run_main(monkeypatch, r, core)
    assert summary["failed"] == 1 and summary["charged"] == 0
    assert r.h == {LIVE: _hash(1000, 4, 1)}


def test_failed_charge_that_actually_committed_is_not_restored(monkeypatch):
    r = _FakeRedis({LIVE: _hash()})
    core = _FakeCore()

    async def execute(sql, *args):  # commits, then the answer is lost
        import json

        core.claims.add(json.loads(args[-1])["claim"])
        raise TimeoutError("lost reply")

    core.execute = execute
    summary = _run_main(monkeypatch, r, core)
    assert summary["charged"] == 1
    assert not r.h  # no double charge next run


def test_unknown_charge_state_keeps_the_inflight_key(monkeypatch):
    r = _FakeRedis({LIVE: _hash()})
    core = _FakeCore(fail_charge=True, fail_check=True)
    summary = _run_main(monkeypatch, r, core)
    assert summary["failed"] == 1
    assert len(r.h) == 1 and next(iter(r.h)).startswith("meter:egress_inflight:")


def test_dry_run_charges_nothing_and_touches_no_redis_key(monkeypatch):
    r = _FakeRedis({LIVE: _hash()}, flags={f"meter:over_budget:{ORG}"})
    core = _FakeCore(orgs=[(ORG, 0, 100)])
    summary = _run_main(monkeypatch, r, core, dry_run=True)
    assert summary["rows"] == 1 and summary["charged"] == 0
    assert core.charges == []
    assert r.h == {LIVE: _hash()}
    assert r.flags == {f"meter:over_budget:{ORG}"}


def test_recovery_merges_back_old_unpaid_keys_and_drops_paid_ones():
    old = int(time.time()) - 3600
    unpaid = f"meter:egress_inflight:{old}-aa:{ORG}:lyr1:tiles"
    paid = f"meter:egress_inflight:{old}-bb:{ORG}:lyr9:tiles"
    running = f"meter:egress_inflight:{int(time.time())}-cc:{ORG}:lyr5:tiles"
    r = _FakeRedis(
        {
            unpaid: _hash(500, 2, 0),
            paid: _hash(700, 3, 0),
            running: _hash(1, 1, 0),
            LIVE: _hash(100, 1, 0),  # traffic that came in meanwhile
        }
    )
    core = _FakeCore(charged_claims={paid})
    assert asyncio.run(recover_inflight(r, core, "customer")) == 2
    assert r.h[LIVE] == {
        "bytes": "600",
        "count": "3",
        "anon_count": "0",
        "owner": "ownA",
    }
    assert unpaid not in r.h and paid not in r.h
    assert running in r.h  # a run that may still be going is left alone
    assert f"meter:egress:{ORG}:lyr9:tiles" not in r.h


def test_flags_follow_the_balance_not_the_traffic():
    flag = lambda o: f"meter:over_budget:{o}"  # noqa: E731
    r = _FakeRedis(flags={flag(ORG), flag("garbage")})
    # ORG was topped up (flag must go), ORG2 is over budget by compute alone
    core = _FakeCore(orgs=[(ORG, 100, 500), (ORG2, 900, 800)])
    result = asyncio.run(refresh_over_budget_flags(r, core, "customer"))
    assert r.flags == {flag(ORG2)}
    assert result == {"flags_set": 1, "flags_cleared": 1}
    assert core.flagged_arg == [ORG]  # the junk flag never reaches SQL


def test_unlimited_and_deleted_orgs_lose_their_flag():
    r = _FakeRedis(flags={f"meter:over_budget:{ORG}", f"meter:over_budget:{ORG2}"})
    core = _FakeCore(orgs=[(ORG, 10**9, None)])  # unlimited; ORG2 no longer exists
    asyncio.run(refresh_over_budget_flags(r, core, "customer"))
    assert r.flags == set()


def test_flag_refresh_runs_without_any_new_traffic(monkeypatch):
    r = _FakeRedis(flags={f"meter:over_budget:{ORG}"})
    core = _FakeCore(orgs=[(ORG, 0, 100)])
    summary = _run_main(monkeypatch, r, core)
    assert summary["rows"] == 0
    assert r.flags == set()
