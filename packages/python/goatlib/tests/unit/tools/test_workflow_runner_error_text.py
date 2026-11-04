"""A failed workflow step's error text carries neither usernames nor
credentials."""

from goatlib.tools.workflow_runner import _step_error


def test_a_step_error_carries_no_credentials() -> None:
    error = {
        "name": "IOException",
        "message": "IO Error: Unable to connect to Postgres at "
        '"postgresql://goat:hunter2@db:5432/goat": connection refused',
    }

    step = _step_error("tool-1", error)

    assert step["node_id"] == "tool-1"
    assert "hunter2" not in step["message"]
    assert "connection refused" in step["message"]


def test_a_cancellation_does_not_name_who_cancelled() -> None:
    step = _step_error("tool-1", {"message": "Job cancelled by admin@example.com"})

    assert step["message"] == "Job cancelled"
