"""Semantic search helpers: Ollama embeddings, cosine similarity and a keyword fallback."""
from __future__ import annotations

import json
import math
import os
import re
import urllib.error
import urllib.request

OLLAMA_URL = os.getenv("BUGREPLAY_OLLAMA_URL", "http://localhost:11434").rstrip("/")
EMBED_MODEL = os.getenv("BUGREPLAY_EMBED_MODEL", "nomic-embed-text")
TIMEOUT_SECONDS = float(os.getenv("BUGREPLAY_OLLAMA_TIMEOUT", "30"))
MAX_EMBED_CHARS = 4000
# With nomic-embed-text, an unrelated query scored about 0.34, real matches 0.6-0.75, and other
# incidents on loosely related topics about 0.5. Require a solid absolute score and stay close to the best match.
MIN_RELEVANCE = float(os.getenv("BUGREPLAY_MIN_RELEVANCE", "0.5"))
RELEVANCE_WINDOW = float(os.getenv("BUGREPLAY_RELEVANCE_WINDOW", "0.1"))
# A match must beat the library's median similarity by this much. Real matches cleared 0.139; error-like
# text that matched nothing stayed at or below about 0.12 (measured on a 10-incident library).
MIN_MARGIN = float(os.getenv("BUGREPLAY_MIN_MARGIN", "0.13"))
MIN_LIBRARY_FOR_MARGIN = 5
# Once a conversation has been answered with general advice, only a strong match may pull in a team incident
# on a follow-up. Topic-level neighbours (for example any "docker" incident) are not a real match.
FOLLOWUP_RELEVANCE = float(os.getenv("BUGREPLAY_FOLLOWUP_RELEVANCE", "0.7"))
# Share of the query's words that must appear in an incident for a plain text match to count.
KEYWORD_MATCH = float(os.getenv("BUGREPLAY_KEYWORD_MATCH", "0.6"))


class EmbeddingUnavailable(Exception):
    """Ollama could not be reached or did not return an embedding."""


def _post_with_timeout(path: str, payload: dict, timeout: float) -> dict:
    request = urllib.request.Request(
        f"{OLLAMA_URL}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _post(path: str, payload: dict) -> dict:
    return _post_with_timeout(path, payload, TIMEOUT_SECONDS)


def embed_text(text: str) -> list[float]:
    text = text.strip()[:MAX_EMBED_CHARS]
    if not text:
        raise EmbeddingUnavailable("Nothing to embed")
    try:
        try:
            result = _post("/api/embed", {"model": EMBED_MODEL, "input": text})
            vector = (result.get("embeddings") or [None])[0]
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            # Older Ollama releases only expose the legacy endpoint.
            vector = _post("/api/embeddings", {"model": EMBED_MODEL, "prompt": text}).get("embedding")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise EmbeddingUnavailable(str(error)) from error
    if not vector:
        raise EmbeddingUnavailable("Ollama returned an empty embedding")
    return [float(value) for value in vector]


def incident_text(title: str, symptoms: str, cause: str, tags: list[str]) -> str:
    return f"{title}\n{symptoms}\n{cause}\n{' '.join(tags)}"


def cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def _words(text: str) -> set[str]:
    return {word for word in re.split(r"[^a-z0-9]+", text.lower()) if len(word) > 2}


def keyword_score(query: str, text: str) -> float:
    """Fraction of query words found in the text, used when embeddings are unavailable."""
    words = _words(query)
    if not words:
        return 0.0
    return len(words & _words(text)) / len(words)
