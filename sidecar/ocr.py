from __future__ import annotations

import base64
import os
import re
from dataclasses import dataclass
from io import BytesIO
from typing import Dict, Tuple

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    import easyocr
except ImportError as exc:
    raise RuntimeError(
        "EasyOCR is not installed. Run pip install -r sidecar/requirements.txt"
    ) from exc

try:
    from .engines import translate
except ImportError:
    from engines import translate


_OCR_READERS: Dict[Tuple[str, ...], easyocr.Reader] = {}
_FONT_CACHE: Dict[Tuple[str, int], ImageFont.FreeTypeFont] = {}


@dataclass
class OcrBlock:
    polygon: np.ndarray
    text: str
    left: int
    top: int
    right: int
    bottom: int


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


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value)).strip()


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


def _decode_image(image_base64: str) -> Image.Image | None:
    if not image_base64:
        return None

    try:
        image_bytes = base64.b64decode(image_base64, validate=True)
    except Exception:
        return None

    try:
        with Image.open(BytesIO(image_bytes)) as image:
            return image.convert("RGB")
    except Exception:
        return None


def _extract_blocks(results: list) -> list[OcrBlock]:
    blocks: list[OcrBlock] = []
    for item in results:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue

        raw_points = item[0]
        text = _normalize_text(item[1])
        if not text:
            continue

        points = np.array(raw_points, dtype=np.float32)
        if points.ndim != 2 or points.shape[0] < 3 or points.shape[1] != 2:
            continue

        polygon = np.rint(points).astype(np.int32)
        left = int(np.min(polygon[:, 0]))
        right = int(np.max(polygon[:, 0]))
        top = int(np.min(polygon[:, 1]))
        bottom = int(np.max(polygon[:, 1]))
        if right - left < 4 or bottom - top < 4:
            continue

        blocks.append(
            OcrBlock(
                polygon=polygon,
                text=text,
                left=left,
                top=top,
                right=right,
                bottom=bottom,
            )
        )

    blocks.sort(key=lambda block: (block.top, block.left))
    return blocks


def _font_candidates() -> list[str]:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.getenv("DICTOVER_OCR_FONT", "").strip()
    return [
        env_path,
        os.path.join(base_dir, "fonts", "NotoSansCJK-Regular.ttc"),
        os.path.join(base_dir, "NotoSansCJK-Regular.ttc"),
        os.path.join(base_dir, "NotoSansCJK-Regular.otf"),
        "C:/Windows/Fonts/arial.ttf",
    ]


def _load_font(size: int) -> ImageFont.ImageFont:
    for path in _font_candidates():
        if not path:
            continue
        key = (path, size)
        cached = _FONT_CACHE.get(key)
        if cached is not None:
            return cached
        try:
            font = ImageFont.truetype(path, size)
            _FONT_CACHE[key] = font
            return font
        except Exception:
            continue
    return ImageFont.load_default()


def _measure_text(
    draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont
) -> tuple[int, int]:
    if not text:
        return (0, 0)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    return (right - left, bottom - top)


def _wrap_text(
    draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int
) -> list[str]:
    normalized = _normalize_text(text)
    if not normalized:
        return []

    token_joiner = " " if " " in normalized else ""
    tokens = normalized.split(" ") if token_joiner == " " else list(normalized)
    lines: list[str] = []
    current = ""

    for token in tokens:
        candidate = token if not current else f"{current}{token_joiner}{token}"
        width, _ = _measure_text(draw, candidate, font)
        if width <= max_width or not current:
            current = candidate
            continue
        lines.append(current)
        current = token

    if current:
        lines.append(current)

    return [line for line in lines if line]


def _fit_text_lines(
    draw: ImageDraw.ImageDraw,
    text: str,
    max_width: int,
    max_height: int,
) -> tuple[list[str], ImageFont.ImageFont, int]:
    width_limit = max(8, max_width)
    height_limit = max(10, max_height)
    size_max = max(14, min(54, int(height_limit * 0.75)))

    for font_size in range(size_max, 11, -2):
        font = _load_font(font_size)
        lines = _wrap_text(draw, text, font, width_limit)
        if not lines:
            continue

        _, sample_h = _measure_text(draw, "Ag", font)
        line_height = max(12, sample_h + 2)
        total_height = line_height * len(lines)
        widest = max((_measure_text(draw, line, font)[0] for line in lines), default=0)
        if total_height <= height_limit and widest <= width_limit:
            return (lines, font, line_height)

    fallback_font = _load_font(12)
    fallback_lines = _wrap_text(draw, text, fallback_font, width_limit)
    if not fallback_lines:
        fallback_lines = [_normalize_text(text)]
    _, fallback_h = _measure_text(draw, "Ag", fallback_font)
    return (fallback_lines, fallback_font, max(12, fallback_h + 2))


def _estimate_text_color(
    rgb_array: np.ndarray, block: OcrBlock
) -> tuple[int, int, int]:
    height, width = rgb_array.shape[:2]
    left = max(0, min(width - 1, block.left))
    top = max(0, min(height - 1, block.top))
    right = max(left + 1, min(width, block.right))
    bottom = max(top + 1, min(height, block.bottom))

    roi = rgb_array[top:bottom, left:right]
    if roi.size == 0:
        return (20, 28, 42)

    gray = cv2.cvtColor(roi, cv2.COLOR_RGB2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    bright_mask = binary == 255
    dark_mask = ~bright_mask
    bright_count = int(np.count_nonzero(bright_mask))
    dark_count = int(np.count_nonzero(dark_mask))

    if bright_count == 0 and dark_count == 0:
        return (20, 28, 42)

    if bright_count == 0:
        text_mask = dark_mask
    elif dark_count == 0:
        text_mask = bright_mask
    else:
        # Text usually occupies less area than background in OCR boxes.
        text_mask = bright_mask if bright_count < dark_count else dark_mask

    text_pixels = roi[text_mask]
    if text_pixels.size == 0:
        return (20, 28, 42)

    color = np.median(text_pixels, axis=0)
    return (int(color[0]), int(color[1]), int(color[2]))


def _translate_text(text: str, source: str, target: str) -> str:
    normalized = _normalize_text(text)
    if not normalized:
        return ""

    translated = normalized
    try:
        result = translate(normalized, source, target)
        translated = _normalize_text(result.result) or normalized
    except Exception:
        translated = normalized

    if translated != normalized:
        return translated

    if source != "auto":
        try:
            retry = translate(normalized, "auto", target)
            retried = _normalize_text(retry.result) or normalized
            if retried:
                return retried
        except Exception:
            return translated

    return translated


def _render_overlay_image(
    rgb_image: Image.Image, blocks: list[OcrBlock], texts: list[str]
) -> str:
    rgb_array = np.array(rgb_image)
    bgr = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)

    mask = np.zeros((bgr.shape[0], bgr.shape[1]), dtype=np.uint8)
    for block in blocks:
        cv2.fillPoly(mask, [block.polygon], 255)
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=1)
    inpainted = cv2.inpaint(bgr, mask, 3, cv2.INPAINT_TELEA)
    inpainted_rgb = cv2.cvtColor(inpainted, cv2.COLOR_BGR2RGB)

    canvas = Image.fromarray(inpainted_rgb)
    draw = ImageDraw.Draw(canvas)

    for block, translated_text in zip(blocks, texts):
        content = _normalize_text(translated_text) or block.text
        text_color = _estimate_text_color(rgb_array, block)
        box_width = max(10, block.right - block.left - 4)
        box_height = max(10, block.bottom - block.top - 4)
        lines, font, line_height = _fit_text_lines(draw, content, box_width, box_height)
        total_height = line_height * len(lines)
        y = block.top + max(1, (block.bottom - block.top - total_height) // 2)

        for line in lines:
            line_width, _ = _measure_text(draw, line, font)
            x = block.left + max(1, (block.right - block.left - line_width) // 2)
            draw.text((x, y), line, font=font, fill=text_color)
            y += line_height

    buffer = BytesIO()
    canvas.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def run_ocr(image_base64: str, source: str = "auto", target: str = "en") -> str:
    rgb = _decode_image(image_base64)
    if rgb is None:
        return ""

    ocr_input = np.array(rgb)
    reader = _get_reader(source, target)
    lines = reader.readtext(ocr_input, detail=0, paragraph=True)
    if not lines:
        return ""

    return "\n".join(str(line).strip() for line in lines if str(line).strip()).strip()


def run_ocr_overlay(
    image_base64: str,
    source: str = "auto",
    target: str = "en",
) -> dict[str, str]:
    rgb = _decode_image(image_base64)
    if rgb is None:
        return {
            "text": "",
            "translated_text": "",
            "image_base64": "",
            "error": "decode-image-failed",
        }

    try:
        reader = _get_reader(source, target)
        results = reader.readtext(np.array(rgb), detail=1, paragraph=False)
    except Exception as exc:
        return {
            "text": "",
            "translated_text": "",
            "image_base64": image_base64,
            "error": f"ocr-read-failed: {exc}",
        }

    blocks = _extract_blocks(results)
    if not blocks:
        return {
            "text": "",
            "translated_text": "",
            "image_base64": image_base64,
            "error": "no-text-blocks",
        }

    translated_blocks: list[str] = []
    for block in blocks:
        translated_blocks.append(_translate_text(block.text, source, target))

    original_text = "\n".join(block.text for block in blocks)
    translated_text = "\n".join(
        _normalize_text(text) for text in translated_blocks if _normalize_text(text)
    )

    output_image_base64 = image_base64
    overlay_error = ""
    try:
        output_image_base64 = _render_overlay_image(rgb, blocks, translated_blocks)
    except Exception as exc:
        overlay_error = f"render-overlay-failed: {exc}"

    return {
        "text": original_text,
        "translated_text": translated_text,
        "image_base64": output_image_base64,
        "error": overlay_error,
    }
