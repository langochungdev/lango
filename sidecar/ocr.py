from __future__ import annotations

import base64
from io import BytesIO
from typing import Dict, Tuple

import numpy as np
from PIL import Image

try:
    import easyocr
except ImportError as exc:
    raise RuntimeError(
        "EasyOCR is not installed. Run pip install -r sidecar/requirements.txt"
    ) from exc


_OCR_READERS: Dict[Tuple[str, ...], easyocr.Reader] = {}

LANGUAGE_MAP = {
    "auto": "",
    "en": "en",
    "vi": "vi",
    "zh-CN": "ch_sim",
    "ja": "ja",
    "ko": "ko",
    "ru": "ru",
    "de": "de",
    "fr": "fr",
    "fi": "fi",
}

SUPPORTED_EASYOCR = {
    "en",
    "vi",
    "ch_sim",
    "ja",
    "ko",
    "ru",
    "de",
    "fr",
    "fi",
}


def _resolve_ocr_lang(source: str, target: str) -> Tuple[str, ...]:
    source_lang = LANGUAGE_MAP.get(source, "")
    target_lang = LANGUAGE_MAP.get(target, "")

    ordered: list[str] = []
    for code in (source_lang, target_lang, "en"):
        if code and code in SUPPORTED_EASYOCR and code not in ordered:
            ordered.append(code)

    if not ordered:
        ordered = ["en"]

    return tuple(ordered)


def _get_reader(source: str, target: str) -> easyocr.Reader:
    lang_key = _resolve_ocr_lang(source, target)
    reader = _OCR_READERS.get(lang_key)
    if reader is not None:
        return reader

    reader = easyocr.Reader(list(lang_key), gpu=False)
    _OCR_READERS[lang_key] = reader
    return reader


def run_ocr(image_base64: str, source: str = "auto", target: str = "en") -> str:
    if not image_base64:
        return ""

    try:
        image_bytes = base64.b64decode(image_base64, validate=True)
    except Exception:
        return ""

    try:
        with Image.open(BytesIO(image_bytes)) as image:
            rgb = image.convert("RGB")
    except Exception:
        return ""

    ocr_input = np.array(rgb)
    reader = _get_reader(source, target)
    lines = reader.readtext(ocr_input, detail=0, paragraph=True)
    if not lines:
        return ""

    return "\n".join(str(line).strip() for line in lines if str(line).strip()).strip()
