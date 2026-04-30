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
            / ".env",  # 复用主项目的 Supabase key
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

    # ── Supabase ──
    supabase_url: str = Field(default="https://adqznqsciqtepzimcvsg.supabase.co")
    supabase_service_role_key: str = Field(default="", description="服务端 key，绕过 RLS")
    supabase_anon_key: str = Field(default="", description="公开 key，遵守 RLS")

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
    feature_svc_port: int = Field(default=8001)
    train_svc_port: int = Field(default=8002)
    infer_svc_port: int = Field(default=8003)
    backtest_svc_port: int = Field(default=8004)
    monitor_svc_port: int = Field(default=8005)

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
