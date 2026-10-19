# backend/gemini_study_helper.py
import json
import os
import re
import threading
import time

from google import genai
from google.genai import types


# The first model is used normally. If it is busy, out of quota or
# not available, the next one is tried automatically.
# You can put your own first choice in the GEMINI_MODEL setting
# on Render.
MODEL_NAMES = [
    name
    for name in dict.fromkeys(
        [
            os.environ.get("GEMINI_MODEL", "").strip(),
            "gemini-3.5-flash-lite",
            "gemini-2.5-flash-lite",
            "gemini-2.5-flash",
        ]
    )
    if name
]

# Prefix such as "A. ", "b) " or "C: " at the start of a choice.
_CHOICE_PREFIX = re.compile(r"^\s*[A-Ha-h][.):]\s+")

_LETTERS = "ABCDEFGHIJKLMNOPQRST"

# ------------------------------------------------------------
# TIME LIMITS (NEW)
# The extension gives up on a backend request after 25 seconds
# and starts it again. So the backend must finish BEFORE that.
#   - One Gemini call waits at most 10 seconds.
#   - No new Gemini call starts after 12 seconds in total.
# ------------------------------------------------------------
_CALL_TIMEOUT_MS = 10000
_NO_NEW_CALL_AFTER_SECONDS = 12

# A model that does not exist is skipped for 10 minutes, so we
# do not waste time asking it again and again.
_dead_models: dict = {}
_DEAD_SECONDS = 600

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
            try:
                _client = genai.Client(
                    api_key=api_key,
                    http_options=types.HttpOptions(
                        timeout=_CALL_TIMEOUT_MS
                    ),
                )
            except Exception:
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


def _error_code(exc: Exception):
    code = getattr(exc, "code", None)

    return code if isinstance(code, int) else None


def _is_config_error(exc: Exception) -> bool:
    return _error_code(exc) == 400 or "thinking" in str(exc).lower()


def _is_missing_model_error(exc: Exception) -> bool:
    text = str(exc).lower()

    return _error_code(exc) == 404 or "not found" in text


def _is_busy_error(exc: Exception) -> bool:
    text = str(exc).lower()

    return (
        _error_code(exc) in (429, 500, 502, 503, 504)
        or "unavailable" in text
        or "overloaded" in text
        or "timed out" in text
        or "timeout" in text
    )


def _call_model(client, model: str, prompt: str, config, started: float):
    """One Gemini call. A busy server is tried once more (if time allows)."""
    for attempt in range(2):
        try:
            return client.models.generate_content(
                model=model,
                contents=prompt,
                config=config,
            )
        except Exception as exc:
            too_late = (
                time.monotonic() - started
                > _NO_NEW_CALL_AFTER_SECONDS - 3
            )

            if (
                attempt == 0
                and not too_late
                and _is_busy_error(exc)
                and not _is_config_error(exc)
            ):
                time.sleep(0.5)
                continue

            raise


def _generate(client, prompt: str, max_tokens: int, json_mode: bool = False):
    """
    Call Gemini with the fastest config that the model accepts.
    If a model is busy, out of quota or missing, the next model in
    MODEL_NAMES is used. Stops early when time is almost up.
    """
    global _variant_index

    started = time.monotonic()
    last_error = None

    for model in MODEL_NAMES:
        # Skip a model we already know does not exist.
        dead_until = _dead_models.get(model, 0)

        if dead_until > time.time():
            continue

        variants = _config_variants(max_tokens, json_mode)

        start = min(_variant_index, len(variants) - 1)

        for i in range(start, len(variants)):
            if time.monotonic() - started > _NO_NEW_CALL_AFTER_SECONDS:
                raise last_error or RuntimeError(
                    "Gemini took too long to answer."
                )

            try:
                response = _call_model(
                    client, model, prompt, variants[i], started
                )
            except Exception as exc:
                last_error = exc

                if _is_missing_model_error(exc):
                    _dead_models[model] = time.time() + _DEAD_SECONDS
                    print(f"Gemini model {model} not found. Skipping it.")
                    break

                if _is_config_error(exc):
                    # This setting does not suit the model.
                    _variant_index = i + 1
                    continue

                # Busy or out of quota: try the next model.
                print(
                    f"Gemini model {model} failed:",
                    type(exc).__name__,
                    getattr(exc, "code", "no code"),
                )
                break

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

    match = re.match(r"^\W*([A-Za-z])\s*(?:[.):]|$)", raw)

    if not match or match.group(1).upper() not in valid:
        match = re.search(r"\b([A-T])\b", raw)

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


# The extension adds this line to "Select one or more" questions
# (see MULTI_HINT in content.js).
_MULTI_RE = re.compile(r"select one or more", re.IGNORECASE)


def _is_multi(question: str, choices: list[str]) -> bool:
    return bool(choices) and bool(_MULTI_RE.search(question or ""))


def _multi_choice_result(choices: list[str], raw: str) -> dict:
    """Gemini may name SEVERAL letters, for example "A, C, D"."""
    valid = _LETTERS[: len(choices)]

    words = re.findall(r"[A-Za-z]+", raw)

    letters = [
        word.upper()
        for word in words
        if len(word) == 1 and word.upper() in valid
    ]

    # Only trust it when the reply is made of letters (and "and").
    only_letters = all(
        len(word) == 1 or word.lower() == "and" for word in words
    )

    if not letters or not only_letters:
        # Not a clean list of letters. Return the text and let the
        # extension try to match it with the choices.
        return _open_result(raw)

    indexes = sorted({valid.index(letter) for letter in letters})

    return {
        "answer": "\n".join(choices[i] for i in indexes),
        "answers": [choices[i] for i in indexes],
        "choice_index": indexes[0],
        "choice_indexes": indexes,
        "choice_label": valid[indexes[0]],
        "choice_labels": [valid[i] for i in indexes],
        "source_type": "gemini_model_knowledge",
        "sources": [],
        "disclaimer": _DISCLAIMER,
    }


def _pick_result(question: str, choices: list[str], raw: str) -> dict:
    if _is_multi(question, choices):
        return _multi_choice_result(choices, raw)

    return _choice_result(choices, raw)


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
    multi = _is_multi(question, choices)

    if multi:
        instructions = (
            "- This question can have MORE THAN ONE correct choice.\n"
            "- Pick ALL the correct choices.\n"
            "- Reply with ONLY the letters, separated by commas "
            "(for example: A, C, D).\n"
            "- Do not explain."
        )
    else:
        instructions = (
            "- Pick the single best choice.\n"
            "- Reply with ONLY the letter (for example: B).\n"
            "- Do not explain."
        )

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
{instructions}
"""

    response = _generate(
        client, prompt, max_tokens=30 if multi else 8
    )

    raw = (response.text or "").strip()

    if not raw:
        raise RuntimeError("Gemini returned an empty answer.")

    return _pick_result(question, choices, raw)


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
                _pick_result(question, choices, raw)
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
- If the question says "Select one or more", more than one choice can
  be correct. Then "answer" is ALL the correct letters separated by
  commas, for example "A, C, D".
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