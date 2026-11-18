"""
Centralized model pricing and cost calculation.

Prices are application-side estimates expressed in USD per 1 million tokens.
Review these rates against the official AWS invoice and pricing agreement
before using them for financial reporting.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelPricing:
    """Per-million-token model pricing by modality."""

    text_input_per_million: float = 0.0
    text_output_per_million: float = 0.0
    audio_input_per_million: float = 0.0
    audio_output_per_million: float = 0.0
    currency: str = "USD"


@dataclass(frozen=True)
class CostBreakdown:
    """Calculated cost for one model invocation or session."""

    text_input_cost: float
    text_output_cost: float
    audio_input_cost: float
    audio_output_cost: float
    total_cost: float
    currency: str


# IMPORTANT:
# These are application-side estimated rates.
# Verify them against official AWS pricing and your contract before release.
MODEL_PRICING: dict[str, ModelPricing] = {
    "amazon.nova-2-sonic-v1:0": ModelPricing(
        text_input_per_million=0.33,
        text_output_per_million=2.75,
        audio_input_per_million=3.00,
        audio_output_per_million=12.00,
        currency="USD",
    ),
    # TODO: replace with actual Azure gpt-realtime pricing once confirmed.
    "gpt-realtime": ModelPricing(
        text_input_per_million=0.0,
        text_output_per_million=0.0,
        audio_input_per_million=0.0,
        audio_output_per_million=0.0,
        currency="USD",
    ),
}


DEFAULT_PRICING = ModelPricing()


def get_model_pricing(model: str) -> ModelPricing:
    """Return configured pricing for a model, or zero pricing if unknown."""
    return MODEL_PRICING.get(model, DEFAULT_PRICING)


def calculate_model_cost(
    *,
    model: str,
    text_input_tokens: int = 0,
    text_output_tokens: int = 0,
    audio_input_tokens: int = 0,
    audio_output_tokens: int = 0,
) -> CostBreakdown:
    """Calculate estimated cost using modality-specific token counts."""
    pricing = get_model_pricing(model)

    safe_text_input = max(int(text_input_tokens or 0), 0)
    safe_text_output = max(int(text_output_tokens or 0), 0)
    safe_audio_input = max(int(audio_input_tokens or 0), 0)
    safe_audio_output = max(int(audio_output_tokens or 0), 0)

    text_input_cost = (
        safe_text_input / 1_000_000
    ) * pricing.text_input_per_million

    text_output_cost = (
        safe_text_output / 1_000_000
    ) * pricing.text_output_per_million

    audio_input_cost = (
        safe_audio_input / 1_000_000
    ) * pricing.audio_input_per_million

    audio_output_cost = (
        safe_audio_output / 1_000_000
    ) * pricing.audio_output_per_million

    total_cost = (
        text_input_cost
        + text_output_cost
        + audio_input_cost
        + audio_output_cost
    )

    return CostBreakdown(
        text_input_cost=round(text_input_cost, 10),
        text_output_cost=round(text_output_cost, 10),
        audio_input_cost=round(audio_input_cost, 10),
        audio_output_cost=round(audio_output_cost, 10),
        total_cost=round(total_cost, 10),
        currency=pricing.currency,
    )