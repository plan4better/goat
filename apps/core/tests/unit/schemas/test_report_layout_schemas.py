from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

from core.schemas.report_layout import ReportLayoutRead


def test_layout_read_carries_the_row_timestamps():
    """A layout lists with its dates, so clients can show when it last changed."""
    updated = datetime(2026, 9, 15, 2, 24, tzinfo=timezone.utc)
    row = SimpleNamespace(
        id=uuid4(),
        project_id=uuid4(),
        name="Single map",
        description=None,
        is_default=False,
        config={},
        is_predefined=False,
        thumbnail_url=None,
        revision=1,
        created_at=datetime(2026, 6, 5, 14, 37, tzinfo=timezone.utc),
        updated_at=updated,
    )

    layout = ReportLayoutRead.model_validate(row)

    assert layout.updated_at == updated
    assert layout.model_dump(mode="json")["updated_at"] == "2026-09-15T02:24:00Z"
