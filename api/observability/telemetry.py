"""
Model usage telemetry persistence and OpenTelemetry emission.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from api.core.config import (
    AZURE_REALTIME_MODEL_ID,
    LLM_MODEL,
    LLM_TELEMETRY_ENABLED,
    NOVA_MODEL_ID,
    REALTIME_PROVIDER,
)
from api.observability.pricing import calculate_model_cost
from api.repositories.telemetry_repository import TelemetryRepository
from shared_logger import get_logger


logger = get_logger(__name__)

_repository = TelemetryRepository()

_meter = None
_token_counter = None
_cost_counter = None
_session_counter = None
_duration_histogram = None


def _ensure_otel_instruments() -> None:
    """Create OpenTelemetry instruments lazily."""
    global _meter
    global _token_counter
    global _cost_counter
    global _session_counter
    global _duration_histogram

    if _meter is not None:
        return

    try:
        from opentelemetry import metrics

        _meter = metrics.get_meter("sales-coach-api")

        _token_counter = _meter.create_counter(
            "gen_ai.client.token.usage",
            description="Model token usage",
        )

        _cost_counter = _meter.create_counter(
            "gen_ai.client.estimated_cost",
            description="Estimated model cost",
        )

        _session_counter = _meter.create_counter(
            "sales_coach.realtime.sessions",
            description="Realtime model session count",
        )

        _duration_histogram = _meter.create_histogram(
            "sales_coach.realtime.duration",
            description="Realtime model session duration in seconds",
        )

    except Exception:
        _meter = False


def _record_otel_metrics(
    *,
    model: str,
    provider: str,
    feature: str,
    status: str,
    text_input_tokens: int,
    text_output_tokens: int,
    audio_input_tokens: int,
    audio_output_tokens: int,
    total_cost: float,
    currency: str,
    duration_seconds: float,
) -> None:
    """Best-effort OpenTelemetry metrics."""
    try:
        _ensure_otel_instruments()

        if not _meter:
            return

        base_attributes = {
            "gen_ai.provider.name": provider,
            "gen_ai.request.model": model,
            "sales_coach.feature": feature,
            "sales_coach.status": status,
        }

        token_values = (
            ("text_input", text_input_tokens),
            ("text_output", text_output_tokens),
            ("audio_input", audio_input_tokens),
            ("audio_output", audio_output_tokens),
        )

        for token_type, token_count in token_values:
            if token_count > 0:
                _token_counter.add(
                    token_count,
                    {
                        **base_attributes,
                        "gen_ai.token.type": token_type,
                    },
                )

        _cost_counter.add(
            total_cost,
            {
                **base_attributes,
                "currency": currency,
            },
        )

        _session_counter.add(1, base_attributes)
        _duration_histogram.record(
            duration_seconds,
            base_attributes,
        )

    except Exception:
        logger.exception("Failed to emit OpenTelemetry model metrics")


def persist_nova_session_usage(client: Any) -> bool:
    """
    Persist one consolidated Nova usage record for a completed session.

    Telemetry failures never affect the WebSocket request flow.
    """
    if not LLM_TELEMETRY_ENABLED:
        return False

    if getattr(client, "telemetry_persisted", False):
        return False

    try:
        usage = client.nova_usage
        session_provider = getattr(client, "provider", REALTIME_PROVIDER)
        if session_provider == "devnagri":
            model, provider = LLM_MODEL, "devnagri-cascaded"
        elif session_provider == "azure":
            model, provider = AZURE_REALTIME_MODEL_ID, "azure-openai"
        else:
            model, provider = NOVA_MODEL_ID, "aws-bedrock"

        if client.nova_usage_events <= 0 and usage.total_tokens <= 0:
            logger.warning(
                "No Nova usage event captured | session=%s",
                client.id,
            )
            return False

        modality_available = any(
            (
                usage.text_input_tokens,
                usage.text_output_tokens,
                usage.audio_input_tokens,
                usage.audio_output_tokens,
            )
        )

        cost = calculate_model_cost(
            model=model,
            text_input_tokens=usage.text_input_tokens,
            text_output_tokens=usage.text_output_tokens,
            audio_input_tokens=usage.audio_input_tokens,
            audio_output_tokens=usage.audio_output_tokens,
        )

        completed_at = datetime.now(timezone.utc)
        duration_seconds = max(
            completed_at.timestamp() - client.created_at,
            0.0,
        )

        inserted = _repository.save_usage(
            event_id=f"nova-session:{client.id}",
            timestamp=datetime.fromtimestamp(
                client.created_at,
                tz=timezone.utc,
            ).isoformat(),
            completed_at=completed_at.isoformat(),
            username=client.user_email or None,
            session_id=client.id,
            request_id=None,
            provider=provider,
            model=model,
            feature="nova_realtime_voice",
            text_input_tokens=usage.text_input_tokens,
            text_output_tokens=usage.text_output_tokens,
            audio_input_tokens=usage.audio_input_tokens,
            audio_output_tokens=usage.audio_output_tokens,
            prompt_tokens=max(
                (
                    usage.text_input_tokens
                    + usage.audio_input_tokens
                ),
                usage.generic_input_tokens,
            ),
            completion_tokens=max(
                (
                    usage.text_output_tokens
                    + usage.audio_output_tokens
                ),
                usage.generic_output_tokens,
            ),
            total_tokens=usage.total_tokens,
            reasoning_tokens=0,
            text_input_cost=cost.text_input_cost,
            text_output_cost=cost.text_output_cost,
            audio_input_cost=cost.audio_input_cost,
            audio_output_cost=cost.audio_output_cost,
            total_cost=cost.total_cost,
            currency=cost.currency,
            latency_ms=None,
            duration_seconds=round(duration_seconds, 3),
            status=client.telemetry_status,
            error_type=client.telemetry_error_type,
            usage_source="nova_usage_event",
            voice_id=client.voice_id,
            metadata={
                "usage_events_received": client.nova_usage_events,
                "usage_mode": usage.mode,
                "provider_event_id": usage.provider_event_id,
                "generic_input_tokens": usage.generic_input_tokens,
                "generic_output_tokens": usage.generic_output_tokens,
                "modality_breakdown_available": modality_available,
                "cost_status": (
                    "calculated"
                    if modality_available
                    else "unavailable"
                ),
                "input_audio_chunks": client.input_audio_chunks,
                "input_audio_bytes": client.input_audio_bytes,
                "output_audio_chunks": client.output_audio_chunks,
                "output_audio_bytes": client.output_audio_bytes,
            },
        )

        # The DB operation completed successfully. The row either was
        # inserted now or already existed because of event_id uniqueness.
        client.telemetry_persisted = True

        # Emit OTel metrics only for a newly inserted accounting record.
        if inserted:
            _record_otel_metrics(
                model=model,
                provider=provider,
                feature="nova_realtime_voice",
                status=client.telemetry_status,
                text_input_tokens=usage.text_input_tokens,
                text_output_tokens=usage.text_output_tokens,
                audio_input_tokens=usage.audio_input_tokens,
                audio_output_tokens=usage.audio_output_tokens,
                total_cost=cost.total_cost,
                currency=cost.currency,
                duration_seconds=duration_seconds,
            )

        return inserted

    except Exception:
        logger.exception(
            "Failed to persist Nova usage | session=%s",
            getattr(client, "id", "unknown"),
        )
        return False