"""OpenAI-compatible LLM client with secure defaults."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx
from fastapi import HTTPException
from openai import OpenAI

from shared_logger import get_logger

logger = get_logger(__name__)


class OpenAICompatibleLlmClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: int,
        verify_ssl: bool,
    ) -> None:
        if not base_url:
            raise HTTPException(
                status_code=503,
                detail="LLM service is not configured. Set OLLAMA_BASE_URL.",
            )
        self._model = model
        logger.info(
            "Initializing LLM client | base_url=%s | model=%s | verify_ssl=%s | api_key_present=%s",
            base_url,
            model,
            verify_ssl,
            bool(api_key),
        )
        self._http_client = httpx.Client(verify=verify_ssl, timeout=timeout_seconds)
        self._client = OpenAI(
            base_url=base_url,
            api_key=api_key or "not-needed",
            timeout=timeout_seconds,
            max_retries=0,
            http_client=self._http_client,
        )

    def chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.3,
        max_tokens: Optional[int] = None,
    ) -> str:
        kwargs: Dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens

        logger.info(
            "Sending chat completion request | model=%s | messages=%d | temperature=%s | max_tokens=%s",
            self._model,
            len(messages),
            temperature,
            max_tokens,
        )

        try:
            response = self._client.chat.completions.create(**kwargs)

            logger.info(
                "Chat completion successful | model=%s | choices=%d",
                self._model,
                len(response.choices),
            )

        except Exception as e:
            logger.exception("Chat completion failed")
            logger.error("Exception type: %s", type(e).__name__)
            logger.error("Exception repr: %r", e)

            if getattr(e, "__cause__", None):
                logger.error("Root cause: %r", e.__cause__)

            raise
        content = response.choices[0].message.content
        if content is None:
            raise ValueError("Empty response from LLM")
        return content.strip()
