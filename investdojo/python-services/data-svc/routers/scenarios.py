"""场景接口"""
from __future__ import annotations

from fastapi import APIRouter, Query

from common import get_logger
from common.supabase_client import get_supabase_client
from common_utils import ErrorCode, api_error

logger = get_logger(__name__)
router = APIRouter()


@router.get("/scenarios", summary="场景列表")
async def list_scenarios(
    category: str | None = Query(None, description="场景类别"),
    difficulty: str | None = Query(
        None, pattern="^(easy|medium|hard)$"
    ),
):
    filters: dict[str, str] = {}
    if category:
        filters["category"] = f"eq.{category}"
    if difficulty:
        filters["difficulty"] = f"eq.{difficulty}"

    client = get_supabase_client()
    rows = client.select(
        "scenarios",
        columns="id,name,description,category,difficulty,date_start,date_end,"
        "symbols,initial_capital,tags,cover_image",
        filters=filters,
        order="date_start.desc",
    )
    return {"data": rows}


@router.get("/scenarios/{scenario_id}", summary="场景详情")
async def get_scenario(scenario_id: str):
    client = get_supabase_client()
    rows = client.select(
        "scenarios",
        filters={"id": f"eq.{scenario_id}"},
        limit=1,
    )
    if not rows:
        raise api_error(
            ErrorCode.NOT_FOUND,
            f"Scenario not found: {scenario_id}",
            status=404,
        )
    return {"data": rows[0]}
