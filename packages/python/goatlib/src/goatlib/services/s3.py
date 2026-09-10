from __future__ import annotations

import hashlib
import logging
import posixpath
from typing import BinaryIO, Dict, Optional, Self

import boto3
from botocore.exceptions import ClientError

from goatlib.config import settings
from goatlib.storage.s3_config import boto_client_kwargs

logger = logging.getLogger(__name__)


class S3Service:
    """Direct S3 helper that can talk to AWS or S3‑compatible providers."""

    def __init__(self: Self) -> None:
        io_cfg = settings.io
        extra = boto_client_kwargs(
            endpoint_url=io_cfg.s3_endpoint_url,
            provider=io_cfg.s3_provider,
            force_path_style=io_cfg.s3_force_path_style,
        )

        self.client = boto3.client(
            "s3",
            aws_access_key_id=io_cfg.s3_access_key_id,
            aws_secret_access_key=io_cfg.s3_secret_access_key,
            aws_session_token=io_cfg.s3_session_token,
            region_name=io_cfg.s3_region,
            **extra,
        )

        # Create a separate client for public URL signing (if different from internal)
        self._public_client = None
        if (
            io_cfg.s3_public_endpoint_url
            and io_cfg.s3_public_endpoint_url != io_cfg.s3_endpoint_url
        ):
            public_extra = dict(extra)
            public_extra["endpoint_url"] = io_cfg.s3_public_endpoint_url
            self._public_client = boto3.client(
                "s3",
                aws_access_key_id=io_cfg.s3_access_key_id,
                aws_secret_access_key=io_cfg.s3_secret_access_key,
                aws_session_token=io_cfg.s3_session_token,
                region_name=io_cfg.s3_region,
                **public_extra,
            )

    # ------------------------------ utilities -------------------------

    @staticmethod
    def build_key(*parts: str) -> str:
        """Normalize and join S3 key parts."""
        return posixpath.join(*(p.strip("/") for p in parts if p))

    @staticmethod
    def sha256_bytes(content: bytes) -> str:
        return hashlib.sha256(content).hexdigest()

    # ------------------------------ core ops --------------------------

    def upload_file(
        self: Self,
        fileobj: BinaryIO,
        key: str,
        bucket: Optional[str] = None,
        content_type: str = "application/octet-stream",
    ) -> str:
        b = bucket or settings.io.s3_bucket_name
        try:
            self.client.upload_fileobj(
                fileobj, b, key, ExtraArgs={"ContentType": content_type}
            )
            return f"s3://{b}/{key}"
        except ClientError as e:
            logger.exception("Upload failed")
            raise RuntimeError(f"S3 upload error: {e}")

    def delete_file(self: Self, key: str, bucket: Optional[str] = None) -> None:
        b = bucket or settings.io.s3_bucket_name
        try:
            self.client.delete_object(Bucket=b, Key=key)
        except ClientError as e:
            logger.exception("Delete failed")
            raise RuntimeError(f"S3 delete error: {e}")

    def generate_presigned_post(
        self: Self,
        key: str,
        content_type: str,
        max_size: int,
        expires_in: int = 300,
        bucket: Optional[str] = None,
    ) -> Dict[str, str]:
        b = bucket or settings.io.s3_bucket_name
        try:
            return self.client.generate_presigned_post(
                Bucket=b,
                Key=key,
                Fields={"Content-Type": content_type},
                Conditions=[
                    {"Content-Type": content_type},
                    ["content-length-range", 0, max_size],
                ],
                ExpiresIn=expires_in,
            )
        except ClientError as e:
            logger.exception("Presigned post failed")
            raise RuntimeError(f"S3 presigned POST error: {e}")

    def generate_presigned_get(
        self: Self,
        key: str,
        bucket: Optional[str] = None,
        expires_in: int = 3600,
        use_public_url: bool = True,
    ) -> str:
        b = bucket or settings.io.s3_bucket_name
        try:
            # Use public client if available and requested, to sign with correct endpoint
            client = (
                self._public_client
                if (use_public_url and self._public_client)
                else self.client
            )
            url = client.generate_presigned_url(
                "get_object", Params={"Bucket": b, "Key": key}, ExpiresIn=expires_in
            )
            return url
        except ClientError as e:
            logger.exception("Presigned GET failed")
            raise RuntimeError(f"S3 presigned GET error: {e}")
