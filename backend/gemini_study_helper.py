# backend/gemini_study_helper.py
import json
import os
import re
import threading

from google import genai
from google.genai import types


MODEL_NAME = "gemini-3.5-flash-lite"

# Prefix such as "A. ", "b) " or "C: " at the start of a choice.
_CHOICE_PREFIX = re.compile(r"^\s*[A-Ha-h][.):]\s+")

_LETTERS = "ABCDEFGHIJKLMNOPQRST"

# ------------------------------------------------------------
# SPEED-UPS
#   1. One shared Gemini client (keeps the connection open).
#   2. "Thinking" turned off and a small output limit.
#   3. A memory cache, so the same question is instant next time.
#   4. BATCH: many questions are answered in ONE Gemini request.
# ------------------------------------------------------------
_client = None
_client_lock = threading.Lock()

_variant_index = 0          # remembers which config works
_cache: dict = {}
_CACHE_LIMIT = 1000


def _get_client():
    global _client

    api_key = os.environ.get("GEMINI_API_KEY")

    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not configured."
        )

    with _client_lock:
        if _client is None:
            _client = genai.Client(api_key=api_key)

        return _client


def _config_variants(max_tokens: int, json_mode: bool = False) -> list:
    """Fastest settings first, plain settings last (safe fallback)."""
    variants = []

    for thinking in (
        {"thinking_budget": 0},
        {"thinking_level": "minimal"},
        None,
    ):
        try:
            kwargs = {"temperature": 0}

            if json_mode:
                kwargs["response_mime_type"] = "application/json"

            if thinking is not None:
                kwargs["max_output_tokens"] = max_tokens
                kwargs["thinking_config"] = types.ThinkingConfig(**thinking)

            variants.append(types.GenerateContentConfig(**kwargs))
        except Exception:
            # This SDK version does not know that option. Skip it.
            continue

    return variants


def _is_config_error(exc: Exception) -> bool:
    code = getattr(exc, "code", None)
    return code == 400 or "thinking" in str(exc).lower()


def _generate(client, prompt: str, max_tokens: int, json_mode: bool = False):
    """Call Gemini with the fastest config that the model accepts."""
    global _variant_index

    variants = _config_variants(max_tokens, json_mode)
    last_error = None

    start = min(_variant_index, len(variants) - 1)

    for i in range(start, len(variants)):
        try:
            response = client.models.generate_content(
                model=MODEL_NAME,
                contents=prompt,
                config=variants[i],
            )
        except Exception as exc:
            if not _is_config_error(exc):
                raise

            last_error = exc
            _variant_index = i + 1
            continue

        text = (response.text or "").strip()

        # Empty text with a small limit means this config does not
        # suit the model. Move on to the next one.
        if not text and i < len(variants) - 1:
            last_error = RuntimeError("Gemini returned an empty answer.")
            _variant_index = i + 1
            continue

        _variant_index = i
        return response

    raise last_error or RuntimeError("Gemini request failed.")


def _strip_prefix(text: str) -> str:
    return _CHOICE_PREFIX.sub("", text).strip()


def _clean_choices(choices) -> list[str]:
    return [
        _strip_prefix(choice)
        for choice in (choices or [])
        if isinstance(choice, str) and choice.strip()
    ]


def _cache_key(subject: str, question: str, choices: list[str]):
    return (
        subject.strip().lower(),
        re.sub(r"\s+", " ", question).strip().lower(),
        tuple(choice.strip().lower() for choice in choices),
    )


def _store(key, result: dict) -> None:
    if len(_cache) >= _CACHE_LIMIT:
        _cache.clear()

    _cache[key] = dict(result)


_DISCLAIMER = (
    "AI-generated answer. "
    "No live web search was performed."
)


# ------------------------------------------------------------
# Turning Gemini's text into the result the extension expects.
# ------------------------------------------------------------
def _choice_result(choices: list[str], raw: str) -> dict:
    valid = _LETTERS[: len(choices)]

    match = re.match(r"^\W*([A-Za-z])\b", raw)

    if not match or match.group(1).upper() not in valid:
        match = re.search(r"\b([A-Za-z])\b", raw)

    letter = match.group(1).upper() if match else None

    if letter and letter in valid:
        index = valid.index(letter)

        return {
            "answer": choices[index],
            "choice_index": index,
            "choice_label": letter,
            "source_type": "gemini_model_knowledge",
            "sources": [],
            "disclaimer": _DISCLAIMER,
        }

    # Gemini did not give a clean letter. Return its text and let
    # the extension try to match it with the choices.
    return _open_result(raw)


def _open_result(answer: str) -> dict:
    return {
        "answer": answer.strip(),
        "source_type": "gemini_model_knowledge",
        "sources": [],
        "disclaimer": _DISCLAIMER,
    }


# ------------------------------------------------------------
# ONE question
# ------------------------------------------------------------
def get_study_help(
    subject: str,
    question: str,
    choices: list[str] | None = None,
) -> dict:
    """Generate a short answer using Gemini's model knowledge."""

    client = _get_client()

    clean_choices = _clean_choices(choices)

    key = _cache_key(subject, question, clean_choices)

    cached = _cache.get(key)

    if cached is not None:
        return dict(cached)

    if clean_choices:
        result = _answer_multiple_choice(
            client, subject, question, clean_choices
        )
    else:
        result = _answer_open_question(client, subject, question)

    _store(key, result)

    return result


def _answer_multiple_choice(client, subject, question, choices):
    choice_lines = "\n".join(
        f"{_LETTERS[i]}. {text}"
        for i, text in enumerate(choices)
    )

    prompt = f"""
Subject: {subject}

Question:
{question}

Choices:
{choice_lines}

Instructions:
- Pick the single best choice.
- Reply with ONLY the letter (for example: B).
- Do not explain.
"""

    response = _generate(client, prompt, max_tokens=8)

    raw = (response.text or "").strip()

    if not raw:
        raise RuntimeError("Gemini returned an empty answer.")

    return _choice_result(choices, raw)


def _answer_open_question(client, subject, question):
    prompt = f"""
Subject: {subject}

Question:
{question}

Instructions:
- Give the shortest accurate answer possible.
- For a term or identification question, reply with only the word
  or short phrase. No full sentence.
- If the question asks you to list or enumerate several items,
  write one item per line. No numbers, no bullets, no extra text.
- For an explanation question, use one or two sentences.
- Do not invent sources or claim to have searched the web.
- Always give your best answer, even if you are not fully sure.
"""

    response = _generate(client, prompt, max_tokens=300)

    answer = (response.text or "").strip()

    if not answer:
        raise RuntimeError(
            "Gemini returned an empty answer."
        )

    return _open_result(answer)


# ------------------------------------------------------------
# MANY questions in ONE request (for scrolling pages)
# ------------------------------------------------------------
def get_study_help_batch(subject: str, items: list[dict]) -> list[dict]:
    """
    items: [{"id": 0, "question": "...", "choices": [...]}, ...]
    Returns a list of {"id": ..., "answer": ..., ...}.
    Questions that Gemini skipped are left out, and the extension
    asks for them one by one.
    """

    client = _get_client()

    results: dict = {}
    todo = []

    for item in items:
        item_id = item.get("id")
        question = str(item.get("question") or "")
        choices = _clean_choices(item.get("choices"))

        if item_id is None or not question.strip():
            continue

        key = _cache_key(subject, question, choices)
        cached = _cache.get(key)

        if cached is not None:
            results[item_id] = dict(cached)
        else:
            todo.append((item_id, question, choices, key))

    if todo:
        answers = _ask_batch(client, subject, todo)

        for item_id, question, choices, key in todo:
            raw = answers.get(item_id)

            if not raw:
                continue

            result = (
                _choice_result(choices, raw)
                if choices
                else _open_result(raw)
            )

            _store(key, result)
            results[item_id] = result

    return [
        {"id": item_id, **result}
        for item_id, result in results.items()
    ]


def _ask_batch(client, subject, todo) -> dict:
    blocks = []

    for item_id, question, choices, _key in todo:
        lines = [f"[{item_id}] {question}"]

        for i, text in enumerate(choices):
            lines.append(f"{_LETTERS[i]}. {text}")

        blocks.append("\n".join(lines))

    questions_text = "\n\n".join(blocks)

    prompt = f"""
Subject: {subject}

Answer every numbered question below.

Return ONLY a JSON array. No markdown. No explanation.
Each element must look like: {{"id": 1, "answer": "..."}}

Rules for "answer":
- If the question has lettered choices, "answer" is ONLY the letter
  of the best choice, for example "B".
- Otherwise "answer" is the shortest accurate answer (a word or a
  short phrase).
- If the question asks to list or enumerate several items, put all
  the items in ONE string, separated by new lines (\\n).
- Always give your best answer, even if you are not fully sure.

Questions:

{questions_text}
"""

    max_tokens = min(8000, 80 * len(todo) + 300)

    response = _generate(
        client, prompt, max_tokens=max_tokens, json_mode=True
    )

    return _parse_batch_json((response.text or "").strip())


def _parse_batch_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())

    try:
        data = json.loads(text)
    except Exception:
        match = re.search(r"\[.*\]", text, re.S)

        if not match:
            return {}

        try:
            data = json.loads(match.group(0))
        except Exception:
            return {}

    if isinstance(data, dict):
        for name in ("answers", "results", "items"):
            if isinstance(data.get(name), list):
                data = data[name]
                break
        else:
            data = [data]

    answers: dict = {}

    if not isinstance(data, list):
        return answers

    for entry in data:
        if not isinstance(entry, dict):
            continue

        try:
            item_id = int(entry.get("id"))
        except (TypeError, ValueError):
            continue

        answer = entry.get("answer")

        if isinstance(answer, list):
            answer = "\n".join(str(part) for part in answer)

        if answer is None:
            continue

        answer = str(answer).strip()

        if answer:
            answers[item_id] = answer

    return answers