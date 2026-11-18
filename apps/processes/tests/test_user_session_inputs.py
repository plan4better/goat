"""Jobs that act as the user who started them. print_report renders the web
app with the user's token (and refreshes it); project_import uploads icons and
images through core with the access token; project_export reads them from
core's public route and needs no token. The server sets the token and core's
address; what the caller sent under those names is replaced."""

from processes.services.user_session import user_session_inputs

CORE = "http://core:8000"


def test_print_report_gets_the_token_and_keeps_its_refresh_token() -> None:
    inputs = user_session_inputs("print_report", {"refresh_token": "r"}, "tok", CORE)
    assert inputs == {"refresh_token": "r", "access_token": "tok"}


def test_project_export_gets_cores_address_only() -> None:
    inputs = user_session_inputs(
        "project_export", {"project_id": "p", "refresh_token": "r"}, "tok", CORE
    )
    assert inputs == {"project_id": "p", "core_url": CORE}


def test_project_import_gets_the_access_token_and_cores_address() -> None:
    inputs = user_session_inputs(
        "project_import", {"s3_key": "k", "refresh_token": "r"}, "tok", CORE
    )
    assert inputs == {"s3_key": "k", "access_token": "tok", "core_url": CORE}


def test_the_server_says_where_core_is() -> None:
    inputs = user_session_inputs(
        "project_import",
        {"core_url": "http://elsewhere.example", "access_token": "theirs"},
        "tok",
        CORE,
    )
    assert (inputs["core_url"], inputs["access_token"]) == (CORE, "tok")


def test_no_core_address_configured_leaves_none() -> None:
    inputs = user_session_inputs(
        "project_import", {"core_url": "http://elsewhere.example"}, None, ""
    )
    assert "core_url" not in inputs and "access_token" not in inputs


def test_other_tools_get_neither_and_lose_what_the_caller_sent() -> None:
    inputs = user_session_inputs(
        "buffer",
        {
            "distance": 5,
            "core_url": "http://x",
            "access_token": "x",
            "refresh_token": "r",
        },
        "tok",
        CORE,
    )
    assert inputs == {"distance": 5}
