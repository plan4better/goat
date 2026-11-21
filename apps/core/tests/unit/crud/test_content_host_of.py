from core.crud.crud_content import _host_of


def test_names_the_host_of_a_web_address_only() -> None:
    assert (
        _host_of("https://www.wms.nrw.de/geobasis/wms?key=secret") == "www.wms.nrw.de"
    )
    assert _host_of("HTTP://Example.org/a.tif") == "example.org"


def test_names_no_host_for_a_storage_path_or_another_scheme() -> None:
    # The feed's Source row reads a host as "drawn from a web address": a
    # bucket or a file path must not pass for one.
    assert _host_of("s3://goat-bucket/users/1/t_abc.tif") is None
    assert _host_of("file:///data/a.tif") is None
    assert _host_of("ftp://example.org/a.tif") is None
    assert _host_of("/data/layers/a.tif") is None
    assert _host_of(None) is None
    assert _host_of("") is None
