from __future__ import annotations

try:
    from .dictionary import lookup_dictionary
    from .engines import (
        TranslationResult,
        detect_language,
        is_single_word_text,
        normalize_lang,
        query_datamuse_word,
        translate,
    )
except ImportError:
    from dictionary import lookup_dictionary
    from engines import (
        TranslationResult,
        detect_language,
        is_single_word_text,
        normalize_lang,
        query_datamuse_word,
        translate,
    )


def quick_convert(text: str, source: str, target: str) -> dict:
    cleaned = (text or "").strip()
    if not cleaned:
        return {
            "kind": "text",
            "result": "",
            "engine": "none",
            "mode": "empty",
            "fallback_used": False,
            "word_data": None,
        }

    if is_single_word_text(cleaned):
        datamuse = query_datamuse_word(cleaned)
        synonyms = datamuse.get("synonyms") or []
        related = datamuse.get("related") or []
        sounds_like = datamuse.get("sounds_like") or []
        if synonyms or related or sounds_like:
            summary = synonyms[:3] or related[:3] or sounds_like[:3]
            result = ", ".join(summary)
            return {
                "kind": "word",
                "result": result,
                "engine": "datamuse",
                "mode": "single-word",
                "fallback_used": False,
                "word_data": {
                    "input": cleaned,
                    "synonyms": synonyms,
                    "related": related,
                    "sounds_like": sounds_like,
                },
            }

        fallback = translate(cleaned, source, target)
        return {
            "kind": "text",
            "result": fallback.result,
            "engine": fallback.engine,
            "mode": f"{fallback.mode}+word-fallback",
            "fallback_used": True,
            "word_data": {
                "input": cleaned,
                "synonyms": [],
                "related": [],
                "sounds_like": [],
            },
        }

    translated = translate(cleaned, source, target)
    return {
        "kind": "text",
        "result": translated.result,
        "engine": translated.engine,
        "mode": translated.mode,
        "fallback_used": False,
        "word_data": None,
    }


__all__ = [
    "TranslationResult",
    "detect_language",
    "lookup_dictionary",
    "normalize_lang",
    "quick_convert",
    "translate",
]
