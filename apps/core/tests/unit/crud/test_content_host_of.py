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


def test_names_a_tile_address_after_its_host_less_the_subdomain() -> None:
    # `{s}` stands for a, b or c, `{switch:...}` lists the subdomains itself.
    assert (
        _host_of("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png")
        == "tile.openstreetmap.org"
    )
    assert (
        _host_of("https://{switch:a,b,c}.tiles.example.org/{z}/{x}/{-y}.png")
        == "tiles.example.org"
    )


def test_names_a_placeholder_inside_a_label_by_the_first_host() -> None:
    assert (
        _host_of("https://mt{switch:0,1,2,3}.google.com/vt?x={x}&y={y}&z={z}")
        == "mt0.google.com"
    )
    assert (
        _host_of("https://tile{s}.example.org/{z}/{x}/{y}.png") == "tilea.example.org"
    )
    assert _host_of("https://{s}/{z}/{x}/{y}.png") == "a"
    # A placeholder followed by no label is the host itself, not a label to drop.
    assert _host_of("https://{s}.:8080/{z}/{x}/{y}.png") == "a."
    assert _host_of("https://{s}./{z}/{x}/{y}.png") == "a."


def test_names_a_tile_address_from_its_first_address_alone() -> None:
    """Only the first of the addresses a subdomain list stands for is built."""
    import tracemalloc

    listed = ",".join(str(i) for i in range(16))
    url = f"https://mt{{switch:{listed}}}.example.org/{'p' * 200_000}"
    tracemalloc.start()
    try:
        assert _host_of(url) == "mt0.example.org"
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    # The address a few times over, not once per subdomain.
    assert peak < 6 * len(url), peak


def test_names_no_host_for_a_subdomain_list_no_layer_may_have() -> None:
    listed = ",".join(str(i) for i in range(2000))
    assert (
        _host_of(f"https://mt{{switch:{listed}}}.example.org/{{z}}/{{x}}/{{y}}") is None
    )
