from goatlib.tasks.compute_rollup import select_chargeable, tool_from_path


def _job(**o):
    base = {
        "job_id": "j1",
        "user_id": "u1",
        "runnable_path": "f/goat/tools/buffer",
        "trigger_kind": None,
        "status": "success",
        "duration_ms": 4000,
        "has_children": False,
        "parent_job": None,
        "args": {},
    }
    base.update(o)
    return base


def test_tool_from_path():
    assert tool_from_path("f/goat/tools/catchment_area_pt") == "catchment_area_pt"
    assert tool_from_path(None) == "(unknown)"


def test_charges_a_standalone_tool():
    items = select_chargeable([_job()], already_charged=set())
    assert len(items) == 1
    it = items[0]
    assert it.user_id == "u1"
    assert it.action == "buffer"
    assert it.duration_seconds == 4.0  # 4000 ms
    assert it.payload["job_id"] == "j1"


def test_excludes_scheduled_failed_orchestrator_and_already_charged():
    jobs = [
        _job(job_id="sched", trigger_kind="schedule"),
        _job(job_id="fail", status="failure"),
        _job(job_id="orch", has_children=True),  # workflow_runner parent
        _job(job_id="orch2", runnable_path="f/goat/tools/workflow_runner"),
        _job(job_id="dup"),  # already charged
        _job(job_id="ok"),
    ]
    items = select_chargeable(jobs, already_charged={"dup"})
    assert {i.job_id for i in items} == {"ok"}


def test_workflow_node_tags_run_workflow_node_and_project():
    job = _job(
        job_id="node1",
        runnable_path="f/goat/tools/oev_gueteklassen",
        parent_job="orch-job-7",
        args={
            "user_id": "u1",
            "workflow_id": "wf9",
            "node_id": "n3",
            "project_id": "p7",
        },
    )
    p = select_chargeable([job], already_charged=set())[0].payload
    assert p["workflow_id"] == "wf9"
    assert p["node_id"] == "n3"
    assert (
        p["workflow_run_id"] == "orch-job-7"
    )  # parent_job = per-execution id (counts runs)
    assert p["project_id"] == "p7"


def test_skips_job_without_user():
    assert select_chargeable([_job(user_id=None)], set()) == []


def test_housekeeping_jobs_are_free():
    from goatlib.tasks.compute_rollup import select_chargeable

    job = {
        "job_id": "j1",
        "user_id": "u1",
        "args": {},
        "runnable_path": "f/goat/tools/layer_delete",
        "trigger_kind": None,
        "status": "success",
        "has_children": False,
        "duration_ms": 4000,
    }
    assert select_chargeable([job], set()) == []
    assert (
        len(select_chargeable([{**job, "runnable_path": "f/goat/tools/buffer"}], set()))
        == 1
    )


def test_an_export_carries_its_file_size_for_data_transfer():
    layer = _job(runnable_path="f/goat/tools/layer_export", export_size="6746")
    project = _job(
        job_id="p1", runnable_path="f/goat/tools/project_export", export_size="42989205"
    )
    items = select_chargeable([layer, project], set())
    assert [i.export_bytes for i in items] == [6746, 42989205]


def test_other_tools_and_odd_sizes_carry_no_data_transfer():
    other = _job(export_size="999")  # not an export: ignored even with a size
    broken = _job(
        job_id="b1", runnable_path="f/goat/tools/layer_export", export_size="n/a"
    )
    missing = _job(job_id="m1", runnable_path="f/goat/tools/layer_export")
    assert [
        i.export_bytes for i in select_chargeable([other, broken, missing], set())
    ] == [0, 0, 0]


# --- main(): selection window and per-job transactions -----------------------


class _FakeTx:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        self.conn.tx_open += 1

    async def __aexit__(self, *exc):
        self.conn.tx_open -= 1
        return False


class _FakeCore:
    """Core connection: records charge_credits calls, fails on demand."""

    def __init__(self, failing=(), duplicates=()):
        self.failing = set(failing)
        self.duplicates = set(duplicates)
        self.calls: list[tuple] = []
        self.tx_open = 0
        self.closed = False

    def transaction(self):
        return _FakeTx(self)

    async def fetch(self, sql, *args):
        if "credit_usage" in sql:
            return []
        return [{"uid": "u1", "oid": "org1"}]

    async def execute(self, sql, *args):
        assert self.tx_open, "charge must run inside a transaction"
        import json

        job_id = json.loads(args[-1])["job_id"]
        if job_id in self.failing:
            raise RuntimeError("boom")
        if job_id in self.duplicates:
            import asyncpg

            raise asyncpg.UniqueViolationError("duplicate")
        self.calls.append((args[2], job_id))

    async def close(self):
        self.closed = True


class _FakeWm:
    def __init__(self):
        self.sql = ""
        self.args = ()

    async def fetch(self, sql, *args):
        self.sql, self.args = sql, args
        return [_job(job_id=j) | {"export_size": None} for j in ("a", "b", "c", "d")]

    async def close(self):
        pass


def _run_main(monkeypatch, core, params=None, wm=None):
    import asyncpg
    from goatlib.tasks import compute_rollup as cr

    wm = wm or _FakeWm()

    async def connect(dsn, timeout=None):
        return wm if dsn == "wm" else core

    monkeypatch.setenv("BILLING_ENABLED", "1")
    monkeypatch.setattr(asyncpg, "connect", connect)
    monkeypatch.setattr(cr, "_windmill_dsn", lambda: "wm")
    monkeypatch.setattr(cr, "core_dsn", lambda: "core")
    return cr.main(params or cr.ComputeRollupParams()), wm


def test_selects_by_completion_time_with_a_day_of_lookback(monkeypatch):
    from goatlib.tasks.compute_rollup import ComputeRollupParams

    assert ComputeRollupParams().lookback_minutes == 1440
    _, wm = _run_main(monkeypatch, _FakeCore())
    assert "c.completed_at >= now()" in wm.sql
    assert "started_at" not in wm.sql
    assert wm.args == ("1440",)


def test_one_failing_job_does_not_stop_the_rest(monkeypatch):
    core = _FakeCore(failing={"b"})
    summary, _ = _run_main(monkeypatch, core)
    assert [j for _, j in core.calls] == ["a", "c", "d"]
    assert summary["charged"] == 3
    assert summary["failed"] == 1
    assert summary["considered"] == 4
    assert core.tx_open == 0


def test_unique_violation_means_already_charged_not_failed(monkeypatch):
    core = _FakeCore(duplicates={"a", "c"})
    summary, _ = _run_main(monkeypatch, core)
    assert summary["charged"] == 2
    assert summary["failed"] == 0
    assert summary["skipped"] == 2


def test_dry_run_charges_nothing(monkeypatch):
    from goatlib.tasks.compute_rollup import ComputeRollupParams

    core = _FakeCore()
    summary, _ = _run_main(monkeypatch, core, ComputeRollupParams(dry_run=True))
    assert core.calls == []
    assert summary["charged"] == 0
    assert summary["failed"] == 0
