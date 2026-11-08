"""Thread counts derived from the container's CPU limit.

Programs that size their thread pools by the machine's cores (manby, unless
TIPPECANOE_MAX_THREADS says otherwise) start one thread per core of a big node
in a container that may use two of them: each thread costs memory, and the
quota throttles them anyway.
"""

import math
import os
from pathlib import Path

# cgroup v2: "<quota> <period>", or "max <period>" without a limit.
CGROUP_CPU_MAX = Path("/sys/fs/cgroup/cpu.max")
# cgroup v1: the quota (-1 without a limit) and its period, in microseconds.
CGROUP_V1_CPU_QUOTA = Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
CGROUP_V1_CPU_PERIOD = Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us")


def _cpu_quota() -> float | None:
    """The container's CPU quota in CPUs, or None when it has none."""
    try:
        quota, period = CGROUP_CPU_MAX.read_text().split()
        return None if quota == "max" else int(quota) / int(period)
    except (OSError, ValueError):
        pass
    try:
        quota_us = int(CGROUP_V1_CPU_QUOTA.read_text())
        period_us = int(CGROUP_V1_CPU_PERIOD.read_text())
    except (OSError, ValueError):
        return None
    return quota_us / period_us if quota_us > 0 and period_us > 0 else None


def container_cpu_count() -> int:
    """How many CPUs this process may use: the container's CPU quota rounded
    up, at most the CPUs it may run on, and at least 1."""
    if hasattr(os, "sched_getaffinity"):
        usable = len(os.sched_getaffinity(0))
    else:  # macOS
        usable = os.cpu_count() or 1
    quota = _cpu_quota()
    if quota is None:
        return max(usable, 1)
    return max(1, min(usable, math.ceil(quota)))
