from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator
import os

import uvicorn

try:
    from .image import search_images
    from .ocr import run_ocr, run_ocr_overlay
    from .translation import lookup_dictionary, quick_convert, translate
except ImportError:
    from image import search_images
    from ocr import run_ocr, run_ocr_overlay
    from translation import lookup_dictionary, quick_convert, translate


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


app = FastAPI(title="DictOver Sidecar", version="0.1.0")


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
