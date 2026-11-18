"""
Repository for LLM and realtime model usage telemetry.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from api.core.database import db_connection
from shared_logger import get_logger


logger = get_logger(__name__)


class TelemetryRepository:
    """Database operations for model usage and cost records."""

    def save_usage(
        self,
        *,
        event_id: str,
        timestamp: str,
        completed_at: Optional[str],
        username: Optional[str],
        session_id: Optional[str],
        request_id: Optional[str],
        provider: str,
        model: str,
        feature: str,
        text_input_tokens: int,
        text_output_tokens: int,
        audio_input_tokens: int,
        audio_output_tokens: int,
        prompt_tokens: int,
        completion_tokens: int,
        total_tokens: int,
        reasoning_tokens: int,
        text_input_cost: float,
        text_output_cost: float,
        audio_input_cost: float,
        audio_output_cost: float,
        total_cost: float,
        currency: str,
        latency_ms: Optional[float],
        duration_seconds: Optional[float],
        status: str,
        error_type: Optional[str],
        usage_source: str,
        voice_id: Optional[str],
        metadata: Optional[dict[str, Any]] = None,
    ) -> bool:
        """
        Insert one usage record.

        event_id is UNIQUE, so duplicate session persistence is ignored.
        """
        metadata_json = (
            json.dumps(metadata, ensure_ascii=False)
            if metadata
            else None
        )

        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO llm_usage (
                    event_id,
                    timestamp,
                    completed_at,
                    username,
                    session_id,
                    request_id,
                    provider,
                    model,
                    feature,
                    text_input_tokens,
                    text_output_tokens,
                    audio_input_tokens,
                    audio_output_tokens,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    reasoning_tokens,
                    text_input_cost,
                    text_output_cost,
                    audio_input_cost,
                    audio_output_cost,
                    total_cost,
                    currency,
                    latency_ms,
                    duration_seconds,
                    status,
                    error_type,
                    usage_source,
                    voice_id,
                    metadata_json
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT (event_id) DO NOTHING
                """,
                (
                    event_id,
                    timestamp,
                    completed_at,
                    username,
                    session_id,
                    request_id,
                    provider,
                    model,
                    feature,
                    max(int(text_input_tokens or 0), 0),
                    max(int(text_output_tokens or 0), 0),
                    max(int(audio_input_tokens or 0), 0),
                    max(int(audio_output_tokens or 0), 0),
                    max(int(prompt_tokens or 0), 0),
                    max(int(completion_tokens or 0), 0),
                    max(int(total_tokens or 0), 0),
                    max(int(reasoning_tokens or 0), 0),
                    float(text_input_cost or 0),
                    float(text_output_cost or 0),
                    float(audio_input_cost or 0),
                    float(audio_output_cost or 0),
                    float(total_cost or 0),
                    currency,
                    latency_ms,
                    duration_seconds,
                    status,
                    error_type,
                    usage_source,
                    voice_id,
                    metadata_json,
                ),
            )
            conn.commit()

            inserted = cursor.rowcount > 0

        if inserted:
            logger.info(
                "Saved model usage | user=%s | model=%s | feature=%s "
                "| tokens=%d | cost=%.8f %s",
                username,
                model,
                feature,
                total_tokens,
                total_cost,
                currency,
            )

        return inserted

    def get_usage_overview(self) -> dict[str, Any]:
        """Get global usage and cost totals."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT
                    COUNT(*) AS total_calls,
                    COALESCE(SUM(text_input_tokens), 0) AS text_input_tokens,
                    COALESCE(SUM(text_output_tokens), 0) AS text_output_tokens,
                    COALESCE(SUM(audio_input_tokens), 0) AS audio_input_tokens,
                    COALESCE(SUM(audio_output_tokens), 0) AS audio_output_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(total_cost), 0) AS total_cost,
                    COALESCE(AVG(duration_seconds), 0) AS average_duration_seconds
                FROM llm_usage
                """
            )
            row = cursor.fetchone()
            return dict(row) if row else {}

    def get_usage_by_user(self) -> list[dict[str, Any]]:
        """Get aggregate usage grouped by username."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT
                    COALESCE(username, 'unknown') AS username,
                    COUNT(*) AS total_calls,
                    COALESCE(SUM(text_input_tokens), 0) AS text_input_tokens,
                    COALESCE(SUM(text_output_tokens), 0) AS text_output_tokens,
                    COALESCE(SUM(audio_input_tokens), 0) AS audio_input_tokens,
                    COALESCE(SUM(audio_output_tokens), 0) AS audio_output_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(total_cost), 0) AS total_cost,
                    MAX(currency) AS currency
                FROM llm_usage
                GROUP BY COALESCE(username, 'unknown')
                ORDER BY total_cost DESC
                """
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_usage_by_model(self) -> list[dict[str, Any]]:
        """Get aggregate usage grouped by model."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT
                    model,
                    provider,
                    COUNT(*) AS total_calls,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(total_cost), 0) AS total_cost,
                    MAX(currency) AS currency
                FROM llm_usage
                GROUP BY model, provider
                ORDER BY total_cost DESC
                """
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_usage_by_feature(self) -> list[dict[str, Any]]:
        """Get aggregate usage grouped by application feature."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT
                    feature,
                    COUNT(*) AS total_calls,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(total_cost), 0) AS total_cost,
                    MAX(currency) AS currency
                FROM llm_usage
                GROUP BY feature
                ORDER BY total_cost DESC
                """
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_recent_usage(
        self,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Return recent individual usage records."""
        with db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT *
                FROM llm_usage
                ORDER BY timestamp DESC, id DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = []

            for row in cursor.fetchall():
                item = dict(row)
                metadata_json = item.pop("metadata_json", None)

                if metadata_json:
                    try:
                        item["metadata"] = json.loads(metadata_json)
                    except (json.JSONDecodeError, TypeError):
                        item["metadata"] = None
                else:
                    item["metadata"] = None

                rows.append(item)

            return rows