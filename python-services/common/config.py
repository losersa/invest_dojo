"""统一配置

从环境变量读取配置，配置项源头：
- python-services/.env（本地开发）
- 环境变量（生产）

约定：所有配置项在这里集中声明，不允许在代码里直接读 os.environ。
"""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """全局配置单例"""

    model_config = SettingsConfigDict(
        env_file=[
            Path(__file__).parent.parent / ".env",  # python-services/.env
            Path(__file__).parent.parent.parent
            / "apps"
            / "server"
            / ".env",  # 复用主项目的 .env
        ],
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── 运行环境 ──
    env: str = Field(default="development", description="development/staging/production")
    service_name: str = Field(default="unknown", description="当前服务名（启动时注入）")
    log_level: str = Field(default="INFO")
    log_format: str = Field(default="pretty", description="pretty/json")

    # ── 直连 PostgreSQL（Python 微服务）──
    # 与 infra 的 db 容器共用同一套凭据（POSTGRES_PASSWORD）。
    # 服务运行在本机，通过 localhost:5432 连接；容器内则用 db:5432。
    pg_host: str = Field(default="localhost", description="PG 主机（本机 localhost / 容器内 db）")
    pg_port: int = Field(default=5432)
    pg_user: str = Field(default="postgres")
    pg_password: str = Field(default="", description="与 infra db 的 POSTGRES_PASSWORD 一致")
    pg_database: str = Field(default="postgres", description="数据库名")

    # ── Redis ──
    redis_url: str = Field(default="redis://localhost:6379/0")
    redis_host: str = Field(default="localhost")
    redis_port: int = Field(default=6379)

    # ── MinIO ──
    minio_endpoint: str = Field(default="http://localhost:9000")
    minio_root_user: str = Field(default="investdojo")
    minio_root_password: str = Field(default="investdojo_dev_only")
    minio_bucket: str = Field(default="investdojo")
    minio_region: str = Field(default="us-east-1")

    # ── 服务端口 ──
    data_svc_port: int = Field(default=8006)
    feature_svc_port: int = Field(default=8001)
    train_svc_port: int = Field(default=8002)
    infer_svc_port: int = Field(default=8003)
    backtest_svc_port: int = Field(default=8004)
    monitor_svc_port: int = Field(default=8005)

    # ── 自建鉴权模块（替代原 Supabase Auth）──
    # JWT 签名密钥；生产务必通过环境变量 AUTH_JWT_SECRET 覆盖
    auth_jwt_secret: str = Field(default="investdojo-dev-jwt-secret-v1")
    auth_session_cookie: str = Field(default="id_session")
    auth_token_ttl_seconds: int = Field(default=86400)

    # ── 安全/限制 ──
    request_timeout_seconds: int = Field(default=30)
    max_concurrent_jobs: int = Field(default=5)

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def minio_host(self) -> str:
        """MinIO SDK 需要的 host:port（不含 protocol）"""
        return self.minio_endpoint.replace("http://", "").replace("https://", "")

    @property
    def minio_secure(self) -> bool:
        return self.minio_endpoint.startswith("https://")


@lru_cache
def get_settings() -> Settings:
    """单例获取配置"""
    return Settings()


# 便捷导出
settings = get_settings()
