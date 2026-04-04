from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import requests

try:
    from langdetect import detect
except Exception:
    detect = None

try:
    from opencc import OpenCC
except Exception:
    OpenCC = None


HTTP_TIMEOUT = 12
SESSION = requests.Session()
SESSION.headers.update(
    {
        "User-Agent": "DictOver-Sidecar/0.1",
        "Accept": "application/json,text/plain,*/*",
    }
)

LANG_ALIAS = {"zh-CN": "zh", "zh": "zh"}
T2S_CONVERTER = OpenCC("t2s") if OpenCC is not None else None


def normalize_lang(lang: str) -> str:
    return LANG_ALIAS.get(lang, lang)


def normalize_chinese_script(text: str, target: str) -> str:
    if not text or not target:
        return text
    normalized_target = target.strip().lower().replace("_", "-")
    if not normalized_target.startswith("zh"):
        return text
    if T2S_CONVERTER is None:
        return text
    try:
        return T2S_CONVERTER.convert(text)
    except Exception:
        return text


@dataclass
class TranslationResult:
    result: str
    engine: str
    mode: str


class ArgosRuntime:
    def __init__(self) -> None:
        self.available = False
        self.error: str | None = None
        self._translate_module: Any = None
        self._direct_pairs: set[tuple[str, str]] = set()
        try:
            import argostranslate.package as apkg
            import argostranslate.translate as atranslate

            self._translate_module = atranslate
            for pkg in apkg.get_installed_packages():
                self._direct_pairs.add((pkg.from_code, pkg.to_code))
            self.available = True
        except Exception as exc:
            self.error = str(exc)

    def supports_direct(self, source: str, target: str) -> bool:
        return (normalize_lang(source), normalize_lang(target)) in self._direct_pairs

    def supports_pivot(self, source: str, target: str) -> bool:
        src = normalize_lang(source)
        tgt = normalize_lang(target)
        return (src, "en") in self._direct_pairs and ("en", tgt) in self._direct_pairs

    def translate(self, text: str, source: str, target: str) -> TranslationResult:
        if not self.available:
            raise RuntimeError(self.error or "Argos unavailable")
        src = normalize_lang(source)
        tgt = normalize_lang(target)
        if src == tgt:
            return TranslationResult(text, "argos", "identity")
        if self.supports_direct(src, tgt):
            output = self._translate_module.translate(text, src, tgt)
            return TranslationResult(output, "argos", "direct")
        if self.supports_pivot(src, tgt):
            step1 = self._translate_module.translate(text, src, "en")
            step2 = self._translate_module.translate(step1, "en", tgt)
            return TranslationResult(step2, "argos", "pivot")
        raise RuntimeError(f"Pair not installed: {src}->{tgt}")


ARGOS = ArgosRuntime()


def detect_language(text: str) -> str:
    if not text.strip():
        return "en"
    if detect is None:
        return "en"
    try:
        code = detect(text)
    except Exception:
        return "en"
    return "zh-CN" if code.startswith("zh") else code


def fallback_translate_api(text: str, source: str, target: str) -> TranslationResult:
    src = normalize_lang(source)
    tgt = normalize_lang(target)
    params = {"q": text, "langpair": f"{src}|{tgt}"}
    response = SESSION.get(
        "https://api.mymemory.translated.net/get", params=params, timeout=HTTP_TIMEOUT
    )
    payload = response.json()
    translated = ((payload.get("responseData") or {}).get("translatedText")) or text
    return TranslationResult(translated, "mymemory", "api-fallback")


def is_single_word_text(text: str) -> bool:
    cleaned = " ".join(text.split()).strip()
    if not cleaned:
        return False
    return len(cleaned.split(" ")) == 1


def _collect_datamuse_words(query: str, limit: int) -> list[str]:
    response = SESSION.get(
        f"https://api.datamuse.com/words?{query}",
        timeout=HTTP_TIMEOUT,
    )
    if not response.ok:
        return []
    payload = response.json()
    if not isinstance(payload, list):
        return []
    words: list[str] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        word = item.get("word")
        if isinstance(word, str):
            normalized = word.strip()
            if normalized and normalized not in words:
                words.append(normalized)
        if len(words) >= limit:
            break
    return words


def query_datamuse_word(word: str) -> dict[str, list[str]]:
    cleaned = " ".join(word.split()).strip()
    if not cleaned:
        return {"synonyms": [], "related": [], "sounds_like": []}

    encoded = quote(cleaned)
    try:
        synonyms = _collect_datamuse_words(f"rel_syn={encoded}&max=8", 8)
    except Exception:
        synonyms = []
    try:
        related = _collect_datamuse_words(f"ml={encoded}&max=8", 8)
    except Exception:
        related = []
    try:
        sounds_like = _collect_datamuse_words(f"sl={encoded}&max=8", 8)
    except Exception:
        sounds_like = []

    return {
        "synonyms": synonyms,
        "related": related,
        "sounds_like": sounds_like,
    }


def translate(text: str, source: str, target: str) -> TranslationResult:
    if not text.strip():
        return TranslationResult("", "argos", "empty")
    src = detect_language(text) if source == "auto" else source
    tgt = target or "en"
    try:
        result = ARGOS.translate(text, src, tgt)
    except Exception:
        result = fallback_translate_api(text, src, tgt)

    normalized_result = normalize_chinese_script(result.result, tgt)
    if normalized_result == result.result:
        return result
    return TranslationResult(normalized_result, result.engine, f"{result.mode}+t2s")
