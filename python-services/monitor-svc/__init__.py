"""monitor-svc · 监控聚合服务

职责（MVP / T-2.05）：
- `/metrics` · Prometheus 指标（由 common/app.py 自动挂载）
- `/api/v1/monitor/overview` · 系统总览（健康 + 业务数量一锅端）
- `/api/v1/monitor/services` · 各微服务健康检查聚合
- `/api/v1/monitor/stats` · 业务指标（实时 count）
- `/api/v1/monitor/ping` · 自身快速活性检查

Epic 5（T-5.xx）接 Grafana Dashboard / Loki 日志聚合。

对应架构：
- docs/architecture/00_系统总览.md §3.2 监控 Prometheus+Grafana+Loki
"""
