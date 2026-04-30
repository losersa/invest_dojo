"""monitor-svc 单元测试"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SVC_DIR = Path(__file__).parent.parent / "monitor-svc"


def _load_module(path: Path, name: str):
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_cu = _load_module(SVC_DIR / "common_utils.py", "monitor_svc_common_utils")

get_registered_services = _cu.get_registered_services
summarize_status = _cu.summarize_status
ServiceEntry = _cu.ServiceEntry


# ──────────────────────────────────────────
# 注册表契约
# ──────────────────────────────────────────
def test_registered_services_count():
    """MVP 应注册 5 个兄弟 svc"""
    svcs = get_registered_services()
    names = [s.name for s in svcs]
    expected = {"data-svc", "feature-svc", "train-svc", "infer-svc", "backtest-svc"}
    assert set(names) == expected


def test_registered_services_unique_ports():
    svcs = get_registered_services()
    ports = [s.port for s in svcs]
    assert len(ports) == len(set(ports))


def test_registered_services_all_have_role():
    for s in get_registered_services():
        assert s.role and len(s.role) > 0


# ──────────────────────────────────────────
# summarize_status
# ──────────────────────────────────────────
def test_summary_all_ok():
    infra = {
        "redis": {"status": "ok"},
        "minio": {"status": "ok"},
        "supabase": {"status": "ok"},
    }
    services = [
        {"name": "data-svc", "status": "ok"},
        {"name": "feature-svc", "status": "ok"},
    ]
    s = summarize_status(infra, services)
    assert s["overall"] == "ok"
    assert s["services_ok"] == 2
    assert s["services_total"] == 2
    assert s["services_down"] == []
    assert s["infra_down"] == []


def test_summary_service_down_is_degraded():
    infra = {"redis": {"status": "ok"}, "minio": {"status": "ok"}, "supabase": {"status": "ok"}}
    services = [
        {"name": "data-svc", "status": "ok"},
        {"name": "train-svc", "status": "down"},
    ]
    s = summarize_status(infra, services)
    assert s["overall"] == "degraded"
    assert s["services_down"] == ["train-svc"]
    assert s["services_ok"] == 1


def test_summary_infra_partial_down_is_degraded():
    """部分 infra down → degraded（而不是 down）"""
    infra = {
        "redis": {"status": "ok"},
        "minio": {"status": "down"},
        "supabase": {"status": "ok"},
    }
    services = [{"name": "data-svc", "status": "ok"}]
    s = summarize_status(infra, services)
    assert s["overall"] == "degraded"
    assert "minio" in s["infra_down"]


def test_summary_all_infra_down_is_down():
    """全部 infra down → down"""
    infra = {
        "redis": {"status": "down"},
        "minio": {"status": "down"},
        "supabase": {"status": "down"},
    }
    services = [{"name": "data-svc", "status": "ok"}]
    s = summarize_status(infra, services)
    assert s["overall"] == "down"
    assert len(s["infra_down"]) == 3


def test_summary_multiple_services_down():
    infra = {"redis": {"status": "ok"}, "minio": {"status": "ok"}, "supabase": {"status": "ok"}}
    services = [
        {"name": "a", "status": "ok"},
        {"name": "b", "status": "down"},
        {"name": "c", "status": "timeout"},
        {"name": "d", "status": "ok"},
    ]
    s = summarize_status(infra, services)
    assert s["overall"] == "degraded"
    assert set(s["services_down"]) == {"b", "c"}
    assert s["services_ok"] == 2
    assert s["services_total"] == 4


def test_service_entry_fields():
    """MVP 契约：每个条目必须有 name/url/port/role"""
    svc = ServiceEntry(name="x", url="http://localhost:1234", port=1234, role="test")
    assert svc.name == "x"
    assert svc.url == "http://localhost:1234"
    assert svc.port == 1234
    assert svc.role == "test"
