from pathlib import Path
from typing import Any

import pytest
from goatlib.tools.base import SimpleToolRunner, ToolSettings

MB = 1024 * 1024


class FakeS3:
    def __init__(self, size: int) -> None:
        self.size = size
        self.downloads: list[tuple[str, str, str]] = []

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        return {"ContentLength": self.size}

    def download_file(self, **kwargs: str) -> None:
        self.downloads.append((kwargs["Bucket"], kwargs["Key"], kwargs["Filename"]))


def make_runner(limit: int) -> SimpleToolRunner:
    runner = SimpleToolRunner()
    runner.init(
        ToolSettings(
            postgres_server="localhost",
            postgres_port=5432,
            postgres_user="test",
            postgres_password="test",
            postgres_db="test",
            ducklake_postgres_uri="postgresql://test:test@localhost:5432/test",
            ducklake_catalog_schema="ducklake",
            ducklake_data_dir="/tmp/ducklake",
            s3_bucket_name="goat",
            max_upload_dataset_file_size=limit,
        )
    )
    return runner


@pytest.mark.unit
def test_downloads_objects_within_the_limit(tmp_path: Path) -> None:
    runner = make_runner(limit=10 * MB)
    client = FakeS3(size=10 * MB)

    runner.download_uploaded_object(
        "users/u1/data.gpkg", tmp_path / "d.gpkg", client=client
    )

    assert client.downloads == [
        ("goat", "users/u1/data.gpkg", str(tmp_path / "d.gpkg"))
    ]


@pytest.mark.unit
def test_rejects_objects_above_the_limit_before_downloading(tmp_path: Path) -> None:
    runner = make_runner(limit=10 * MB)
    client = FakeS3(size=10 * MB + 1)

    with pytest.raises(ValueError, match="limit is 10 MB"):
        runner.download_uploaded_object(
            "users/u1/big.gpkg", tmp_path / "b.gpkg", client=client
        )

    assert client.downloads == []


@pytest.mark.unit
def test_limit_defaults_to_five_gigabytes() -> None:
    assert (
        make_runner(limit=5 * 1024 * MB).settings.max_upload_dataset_file_size
        == 5 * 1024 * MB
    )
