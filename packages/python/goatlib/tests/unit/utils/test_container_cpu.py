"""Thread counts follow the container's CPU limit, not the host's cores."""

import os
from pathlib import Path

import pytest
from goatlib.utils import container_cpu
from goatlib.utils.container_cpu import container_cpu_count


def _cgroup(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    v2: str | None = None,
    v1: tuple[str, str] | None = None,
    cpus: int = 16,
) -> None:
    v2_file = tmp_path / "cpu.max"
    quota_file = tmp_path / "cpu.cfs_quota_us"
    period_file = tmp_path / "cpu.cfs_period_us"
    if v2 is not None:
        v2_file.write_text(v2 + "\n")
    if v1 is not None:
        quota_file.write_text(v1[0] + "\n")
        period_file.write_text(v1[1] + "\n")
    monkeypatch.setattr(container_cpu, "CGROUP_CPU_MAX", v2_file)
    monkeypatch.setattr(container_cpu, "CGROUP_V1_CPU_QUOTA", quota_file)
    monkeypatch.setattr(container_cpu, "CGROUP_V1_CPU_PERIOD", period_file)
    monkeypatch.setattr(os, "sched_getaffinity", lambda _pid: set(range(cpus)))


@pytest.mark.unit
@pytest.mark.parametrize(
    ("quota", "expected"),
    [("200000 100000", 2), ("150000 100000", 2), ("50000 100000", 1)],
)
def test_a_cgroup_v2_quota_is_rounded_up(
    monkeypatch, tmp_path, quota, expected
) -> None:
    _cgroup(monkeypatch, tmp_path, v2=quota)
    assert container_cpu_count() == expected


@pytest.mark.unit
def test_a_cgroup_v1_quota_is_read(monkeypatch, tmp_path) -> None:
    _cgroup(monkeypatch, tmp_path, v1=("300000", "100000"))
    assert container_cpu_count() == 3


@pytest.mark.unit
@pytest.mark.parametrize(
    ("v2", "v1"),
    [("max 100000", None), (None, ("-1", "100000")), (None, None)],
)
def test_without_a_quota_the_usable_cpus_count(monkeypatch, tmp_path, v2, v1) -> None:
    _cgroup(monkeypatch, tmp_path, v2=v2, v1=v1, cpus=6)
    assert container_cpu_count() == 6


@pytest.mark.unit
def test_the_quota_never_exceeds_the_usable_cpus(monkeypatch, tmp_path) -> None:
    _cgroup(monkeypatch, tmp_path, v2="800000 100000", cpus=4)
    assert container_cpu_count() == 4
