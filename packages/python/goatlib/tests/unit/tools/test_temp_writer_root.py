"""A temp layer is written under the temp root as it is when the writer is
made: the root the readers of the folder (base runner, If step, finalize)
look it up in when they run."""

from pathlib import Path

import pytest
from goatlib.tools import temp_writer
from goatlib.tools.temp_writer import TempLayerWriter

pytestmark = pytest.mark.unit


def test_the_writer_reads_the_root_when_it_is_made(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(temp_writer, "TEMP_DATA_ROOT", tmp_path)
    writer = TempLayerWriter(user_id="u-1", workflow_id="w-1", node_id="n1")
    assert writer.base_path == tmp_path / "user_u1" / "w_w1" / "n_n1"


def test_a_root_given_to_the_writer_wins(tmp_path: Path) -> None:
    writer = TempLayerWriter(
        user_id="u", workflow_id="w", node_id="n", temp_data_root=tmp_path / "own"
    )
    assert writer.base_path == tmp_path / "own" / "user_u" / "w_w" / "n_n"
