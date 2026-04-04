from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
import os
import time
from urllib.parse import urlparse, urlunparse

import uvicorn

try:
    from .image import search_images
    from .ocr import run_ocr, run_ocr_overlay
    from .translation import lookup_dictionary, quick_convert, translate
    from .engines import HTTP_TIMEOUT, SESSION, fallback_translate_api
except ImportError:
    from image import search_images
    from ocr import run_ocr, run_ocr_overlay
    from translation import lookup_dictionary, quick_convert, translate
    from engines import HTTP_TIMEOUT, SESSION, fallback_translate_api


SUPPORTED_SOURCE_LANGS = {
    "auto",
    "vi",
    "en",
    "zh-CN",
    "ja",
    "ko",
    "ru",
    "de",
    "fr",
    "fi",
}
SUPPORTED_TARGET_LANGS = {"vi", "en", "zh-CN", "ja", "ko", "ru", "de", "fr", "fi"}


class TranslateRequest(BaseModel):
    text: str = Field(min_length=0)
    source: str = Field(default="auto")
    target: str = Field(default="en")

    @field_validator("source")
    @classmethod
    def validate_source(cls, value: str) -> str:
        if value not in SUPPORTED_SOURCE_LANGS:
            raise ValueError("unsupported source language")
        return value

    @field_validator("target")
    @classmethod
    def validate_target(cls, value: str) -> str:
        if value not in SUPPORTED_TARGET_LANGS:
            raise ValueError("unsupported target language")
        return value


class LookupRequest(BaseModel):
    word: str = Field(min_length=1)
    source_lang: str = Field(default="en")

    @field_validator("source_lang")
    @classmethod
    def validate_source_lang(cls, value: str) -> str:
        if value not in SUPPORTED_SOURCE_LANGS:
            raise ValueError("unsupported source language")
        return value


class QuickConvertRequest(BaseModel):
    text: str = Field(min_length=0)
    source: str = Field(default="auto")
    target: str = Field(default="en")

    @field_validator("source")
    @classmethod
    def validate_source(cls, value: str) -> str:
        if value not in SUPPORTED_SOURCE_LANGS:
            raise ValueError("unsupported source language")
        return value

    @field_validator("target")
    @classmethod
    def validate_target(cls, value: str) -> str:
        if value not in SUPPORTED_TARGET_LANGS:
            raise ValueError("unsupported target language")
        return value


class ImageSearchRequest(BaseModel):
    query: str = Field(min_length=0)
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=12, ge=1, le=24)


class OcrRequest(BaseModel):
    image_base64: str = Field(min_length=1)
    source: str = Field(default="auto")
    target: str = Field(default="en")

    @field_validator("source")
    @classmethod
    def validate_ocr_source(cls, value: str) -> str:
        if value not in SUPPORTED_SOURCE_LANGS:
            raise ValueError("unsupported source language")
        return value

    @field_validator("target")
    @classmethod
    def validate_ocr_target(cls, value: str) -> str:
        if value not in SUPPORTED_TARGET_LANGS:
            raise ValueError("unsupported target language")
        return value


class WarmupRequest(BaseModel):
    source: str = Field(default="auto")
    target: str = Field(default="en")

    @field_validator("source")
    @classmethod
    def validate_warmup_source(cls, value: str) -> str:
        if value not in SUPPORTED_SOURCE_LANGS:
            raise ValueError("unsupported source language")
        return value

    @field_validator("target")
    @classmethod
    def validate_warmup_target(cls, value: str) -> str:
        if value not in SUPPORTED_TARGET_LANGS:
            raise ValueError("unsupported target language")
        return value


app = FastAPI(title="DictOver Sidecar", version="0.1.0")
TTS_PROXY_RETRY_COUNT = 1
TTS_PROXY_RETRY_DELAY_SECONDS = 0.2
TTS_PROXY_TIMEOUT_SECONDS = 8


def _is_allowed_tts_host(hostname: str) -> bool:
    normalized = (hostname or "").strip().lower()
    return normalized in {"translate.google.com", "translate.googleapis.com"}


def _looks_like_mpeg_payload(payload: bytes) -> bool:
    if not payload:
        return False
    head = payload[:64]
    if len(head) >= 3 and head[0] == 0x49 and head[1] == 0x44 and head[2] == 0x33:
        return True
    for index in range(0, max(0, len(head) - 1)):
        if head[index] == 0xFF and (head[index + 1] & 0xE0) == 0xE0:
            return True
    return False


def _swap_google_tts_host(url: str) -> str | None:
    try:
        parsed = urlparse(url)
    except Exception:
        return None

    host = (parsed.hostname or "").strip().lower()
    if host == "translate.google.com":
        next_host = "translate.googleapis.com"
    elif host == "translate.googleapis.com":
        next_host = "translate.google.com"
    else:
        return None

    netloc = next_host
    if parsed.port:
        netloc = f"{next_host}:{parsed.port}"
    if parsed.username and parsed.password:
        netloc = f"{parsed.username}:{parsed.password}@{netloc}"
    elif parsed.username:
        netloc = f"{parsed.username}@{netloc}"

    swapped = parsed._replace(netloc=netloc)
    return urlunparse(swapped)


def _warmup_probe_word(lang: str) -> str:
    probes = {
        "vi": "xin chao",
        "en": "hello",
        "zh-CN": "你好",
        "ja": "こんにちは",
        "ko": "안녕하세요",
        "ru": "привет",
        "de": "hallo",
        "fr": "bonjour",
        "fi": "hei",
    }
    return probes.get(lang, "hello")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/translate")
async def translate_endpoint(req: TranslateRequest) -> dict[str, str]:
    try:
        result = translate(req.text, req.source, req.target)
        return {
            "result": result.result,
            "engine": result.engine,
            "mode": result.mode,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/lookup")
async def lookup_endpoint(req: LookupRequest) -> dict:
    try:
        return lookup_dictionary(req.word, req.source_lang)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/quick-convert")
async def quick_convert_endpoint(req: QuickConvertRequest) -> dict:
    try:
        return quick_convert(req.text, req.source, req.target)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/warmup")
async def warmup_endpoint(req: WarmupRequest) -> dict:
    source = req.source if req.source != "auto" else "en"
    target = req.target
    probe = _warmup_probe_word(source)
    dictionary_probe = _warmup_probe_word(target)

    status: dict[str, dict[str, str | int]] = {}

    try:
        translated = translate(probe, source, target)
        status["argos_translate"] = {
            "ok": 1,
            "engine": translated.engine,
            "mode": translated.mode,
        }
    except Exception as exc:
        status["argos_translate"] = {"ok": 0, "error": str(exc)}

    try:
        fallback = fallback_translate_api(probe, source, target)
        status["api_translate"] = {
            "ok": 1,
            "engine": fallback.engine,
            "mode": fallback.mode,
        }
    except Exception as exc:
        status["api_translate"] = {"ok": 0, "error": str(exc)}

    try:
        quick = quick_convert(probe, source, target)
        status["quick_convert"] = {
            "ok": 1,
            "kind": str(quick.get("kind") or "text"),
        }
    except Exception as exc:
        status["quick_convert"] = {"ok": 0, "error": str(exc)}

    try:
        lookup = lookup_dictionary(dictionary_probe, target)
        status["lookup"] = {
            "ok": 1,
            "provider": str(lookup.get("provider") or "unknown"),
        }
    except Exception as exc:
        status["lookup"] = {"ok": 0, "error": str(exc)}

    required_checks = (
        status.get("argos_translate"),
        status.get("api_translate"),
        status.get("quick_convert"),
        status.get("lookup"),
    )
    ready = all(
        isinstance(item, dict) and int(item.get("ok") or 0) == 1
        for item in required_checks
    )

    return {
        "source": source,
        "target": target,
        "ready": ready,
        "status": status,
    }


@app.get("/tts-proxy")
async def tts_proxy_endpoint(
    url: str = Query(min_length=1, max_length=2048),
) -> Response:
    try:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not _is_allowed_tts_host(parsed.hostname or ""):
            raise HTTPException(status_code=400, detail="unsupported tts host")

        candidates = [url]
        swapped = _swap_google_tts_host(url)
        if swapped and swapped not in candidates:
            candidates.append(swapped)

        errors: list[str] = []

        for candidate in candidates:
            for attempt in range(TTS_PROXY_RETRY_COUNT + 1):
                try:
                    upstream = SESSION.get(
                        candidate,
                        timeout=TTS_PROXY_TIMEOUT_SECONDS,
                        headers={
                            "Accept": "*/*",
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                            "Referer": "https://translate.google.com/",
                        },
                    )
                except Exception as exc:
                    errors.append(
                        f"candidate={candidate} attempt={attempt} request-failed:{exc}"
                    )
                    if attempt < TTS_PROXY_RETRY_COUNT:
                        time.sleep(TTS_PROXY_RETRY_DELAY_SECONDS * (attempt + 1))
                    continue

                if not upstream.ok:
                    errors.append(
                        f"candidate={candidate} attempt={attempt} status={upstream.status_code}"
                    )
                    if attempt < TTS_PROXY_RETRY_COUNT:
                        time.sleep(TTS_PROXY_RETRY_DELAY_SECONDS * (attempt + 1))
                    continue

                content = upstream.content
                if not content:
                    errors.append(
                        f"candidate={candidate} attempt={attempt} empty-payload"
                    )
                    if attempt < TTS_PROXY_RETRY_COUNT:
                        time.sleep(TTS_PROXY_RETRY_DELAY_SECONDS * (attempt + 1))
                    continue

                raw_media_type = (upstream.headers.get("content-type") or "").strip()
                is_audio_content_type = raw_media_type.lower().startswith("audio/")
                is_mpeg_payload = _looks_like_mpeg_payload(content)

                if not is_audio_content_type and not is_mpeg_payload:
                    snippet = (
                        content[:160]
                        .decode("utf-8", errors="ignore")
                        .replace("\n", " ")
                    )
                    errors.append(
                        "candidate={} attempt={} non-audio ct={} snippet={}".format(
                            candidate,
                            attempt,
                            raw_media_type or "unknown",
                            snippet[:80],
                        )
                    )
                    if attempt < TTS_PROXY_RETRY_COUNT:
                        time.sleep(TTS_PROXY_RETRY_DELAY_SECONDS * (attempt + 1))
                    continue

                media_type = "audio/mpeg"
                if is_audio_content_type:
                    media_type = raw_media_type.split(";", 1)[0] or "audio/mpeg"

                return Response(
                    content=content,
                    media_type=media_type,
                    headers={"Cache-Control": "public, max-age=86400"},
                )

        raise HTTPException(
            status_code=502,
            detail=f"upstream tts failed: {' | '.join(errors[:4])}",
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"tts proxy failed: {exc}") from exc


@app.post("/images")
async def image_search_endpoint(req: ImageSearchRequest) -> dict:
    try:
        return search_images(req.query, req.page, req.page_size)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/ocr")
async def ocr_endpoint(req: OcrRequest) -> dict[str, str]:
    try:
        return {"text": run_ocr(req.image_base64, req.source, req.target)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/ocr-overlay")
async def ocr_overlay_endpoint(req: OcrRequest) -> dict[str, str]:
    try:
        return run_ocr_overlay(req.image_base64, req.source, req.target)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    host = os.getenv("SIDECAR_HOST", "127.0.0.1")
    port = int(os.getenv("SIDECAR_PORT", "49152"))
    uvicorn.run(app, host=host, port=port, log_level="warning")
