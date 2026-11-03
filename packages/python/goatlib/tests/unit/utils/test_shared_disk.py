"""Waiting for a file another pod has just written to the shared volume."""

import threading
import time
from pathlib import Path

from goatlib.utils.shared_disk import wait_for


def test_a_file_already_there_is_returned_at_once(tmp_path: Path) -> None:
    path = tmp_path / "t_a.parquet"
    path.write_bytes(b"x")
    start = time.monotonic()
    assert wait_for(lambda: path if path.exists() else None, timeout=5) == path
    assert time.monotonic() - start < 0.5


def test_a_file_that_appears_later_is_waited_for(tmp_path: Path) -> None:
    path = tmp_path / "t_a.parquet"
    threading.Timer(0.1, path.write_bytes, args=(b"x",)).start()
    assert (
        wait_for(lambda: path if path.exists() else None, timeout=5, interval=0.01)
        == path
    )


def test_a_file_that_never_appears_gives_up(tmp_path: Path) -> None:
    path = tmp_path / "t_a.parquet"
    start = time.monotonic()
    assert wait_for(lambda: path if path.exists() else None, timeout=0.1) is None
    assert time.monotonic() - start < 1
