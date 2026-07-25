"""MinIO 对象存储客户端"""

from io import BytesIO

from minio import Minio
from minio.error import S3Error

from common.config import settings
from common.logging import get_logger

logger = get_logger(__name__)


_client: Minio | None = None


def get_minio() -> Minio:
    """MinIO 客户端（单例）"""
    global _client
    if _client is None:
        _client = Minio(
            endpoint=settings.minio_host,
            access_key=settings.minio_root_user,
            secret_key=settings.minio_root_password,
            secure=settings.minio_secure,
            region=settings.minio_region,
        )
        logger.info("minio.connected", endpoint=settings.minio_endpoint)
    return _client


def minio_health_check() -> bool:
    """MinIO 健康检查"""
    try:
        client = get_minio()
        # 列出 bucket 作为 liveness 检查
        list(client.list_buckets())
        return True
    except Exception as e:
        logger.warning("minio.health_check.failed", error=str(e))
        return False


def ensure_bucket(bucket: str | None = None) -> None:
    """确保 bucket 存在"""
    bucket = bucket or settings.minio_bucket
    client = get_minio()
    try:
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)
            logger.info("minio.bucket.created", bucket=bucket)
    except S3Error as e:
        logger.error("minio.bucket.ensure_failed", bucket=bucket, error=str(e))
        raise


def upload_bytes(
    object_name: str,
    data: bytes,
    *,
    bucket: str | None = None,
    content_type: str = "application/octet-stream",
) -> str:
    """上传字节流，返回对象路径"""
    bucket = bucket or settings.minio_bucket
    client = get_minio()

    client.put_object(
        bucket_name=bucket,
        object_name=object_name,
        data=BytesIO(data),
        length=len(data),
        content_type=content_type,
    )
    logger.debug("minio.uploaded", bucket=bucket, object=object_name, size=len(data))
    return f"{bucket}/{object_name}"


def download_bytes(object_name: str, *, bucket: str | None = None) -> bytes:
    """下载对象为字节"""
    bucket = bucket or settings.minio_bucket
    client = get_minio()

    resp = client.get_object(bucket, object_name)
    try:
        return resp.read()
    finally:
        resp.close()
        resp.release_conn()


def get_presigned_url(
    object_name: str,
    *,
    bucket: str | None = None,
    expires_seconds: int = 600,
    method: str = "GET",
) -> str:
    """获取预签名 URL（默认 10 分钟有效）"""
    from datetime import timedelta

    bucket = bucket or settings.minio_bucket
    client = get_minio()
    expires = timedelta(seconds=expires_seconds)

    if method == "GET":
        return client.presigned_get_object(bucket, object_name, expires=expires)
    elif method == "PUT":
        return client.presigned_put_object(bucket, object_name, expires=expires)
    else:
        raise ValueError(f"Unsupported method: {method}")


# MinIO 对象路径约定（参考 architecture/01_数据层 §9.1）
class MinioPath:
    """对象路径约定"""

    @staticmethod
    def platform_model(category: str, version: str, filename: str) -> str:
        """官方模型：models/platform/{category}/{version}/{filename}"""
        return f"models/platform/{category}/{version}/{filename}"

    @staticmethod
    def user_model(user_id: str, model_id: str, version: str, filename: str) -> str:
        """用户模型：models/users/{user_id}/{model_id}/v{version}/{filename}"""
        return f"models/users/{user_id}/{model_id}/v{version}/{filename}"

    @staticmethod
    def backtest_report(backtest_id: str, filename: str) -> str:
        """回测报告：backtests/{backtest_id}/{filename}"""
        return f"backtests/{backtest_id}/{filename}"

    @staticmethod
    def notebook(user_id: str, notebook_id: str) -> str:
        """Notebook：notebooks/{user_id}/{notebook_id}.ipynb"""
        return f"notebooks/{user_id}/{notebook_id}.ipynb"

    @staticmethod
    def klines_archive(year: int, month: int, symbol: str) -> str:
        """K 线归档：klines_archive/{year}/{month:02d}/{symbol}.parquet"""
        return f"klines_archive/{year}/{month:02d}/{symbol}.parquet"
