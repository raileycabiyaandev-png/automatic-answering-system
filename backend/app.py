# backend/app.py
from __future__ import annotations

import re
import sqlite3
import threading
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from local_fallback import find_local_fallback_match
from gemini_study_helper import get_study_help, get_study_help_batch


# ============================================================
# CONFIGURATION
# ============================================================

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "questions.db"


app = FastAPI(
    title="Question Answer Assistant API",
    version="0.3.0",
    description=(
        "Question matching backend for the "
        "Question Answer Assistant."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500",
    ],
    # NEW: also allow the Chrome extension itself.
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ============================================================
# GEMINI (AI BACKUP) ROUTES
# ============================================================

class StudyHelpRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    question: str = Field(min_length=3, max_length=2000)
    choices: list[str] = Field(default_factory=list, max_length=20)


@app.post("/study-help")
def study_help(payload: StudyHelpRequest) -> dict[str, Any]:
    try:
        return get_study_help(
            subject=payload.subject,
            question=payload.question,
            choices=payload.choices,
        )

    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        print("Gemini request failed:", type(exc).__name__)
        print("Error code:", getattr(exc, "code", "not provided"))
        print("Error status:", getattr(exc, "status", "not provided"))
        print("Error message:", getattr(exc, "message", str(exc)[:500]))

        raise HTTPException(
            status_code=502,
            detail="Gemini request failed. Check the backend terminal.",
        ) from exc


class StudyHelpBatchItem(BaseModel):
    id: int
    question: str = Field(min_length=3, max_length=2000)
    choices: list[str] = Field(default_factory=list, max_length=20)


class StudyHelpBatchRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    items: list[StudyHelpBatchItem] = Field(min_length=1, max_length=40)


@app.post("/study-help-batch")
def study_help_batch(payload: StudyHelpBatchRequest) -> dict[str, Any]:
    try:
        results = get_study_help_batch(
            subject=payload.subject,
            items=[item.model_dump() for item in payload.items],
        )

        return {"results": results}

    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        print("Gemini batch request failed:", type(exc).__name__)
        print("Error code:", getattr(exc, "code", "not provided"))
        print("Error status:", getattr(exc, "status", "not provided"))
        print("Error message:", getattr(exc, "message", str(exc)[:500]))

        raise HTTPException(
            status_code=502,
            detail="Gemini request failed. Check the backend terminal.",
        ) from exc


# ============================================================
# DATA MODELS
# ============================================================

class MatchRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=200)

    question: str = Field(min_length=3, max_length=5000)

    choices: list[str] = Field(default_factory=list, max_length=20)


class MatchResponse(BaseModel):
    matched: bool

    confidence: float

    match_type: str

    question: str | None = None

    answer: str | None = None

    matched_question: str | None = None

    source_url: str | None = None

    choice_index: int | None = None

    choice_label: str | None = None


# ============================================================
# BASIC ROUTES
# ============================================================

@app.get("/")
def home() -> dict[str, str]:
    return {
        "name": "Question Answer Assistant API",
        "status": "running",
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# ============================================================
# SUBJECTS
# ============================================================

@app.get("/subjects")
def subjects() -> list[dict[str, Any]]:

    with get_connection() as conn:

        rows = conn.execute(
            """
            SELECT
                id,
                name,
                slug,
                source_url
            FROM subjects
            ORDER BY name
            """
        ).fetchall()

    return [dict(row) for row in rows]


# ============================================================
# DATABASE STATISTICS
# ============================================================

@app.get("/stats")
def stats() -> dict[str, object]:

    with get_connection() as conn:

        subject_count = conn.execute(
            "SELECT COUNT(*) FROM subjects"
        ).fetchone()[0]

        question_count = conn.execute(
            "SELECT COUNT(*) FROM questions"
        ).fetchone()[0]

        rows = conn.execute(
            """
            SELECT
                subjects.name,
                COUNT(questions.id) AS question_count
            FROM subjects
            LEFT JOIN questions
                ON questions.subject_id = subjects.id
            GROUP BY subjects.id
            ORDER BY subjects.name
            """
        ).fetchall()

    return {
        "subjects": subject_count,
        "questions": question_count,
        "breakdown": [
            {
                "subject": row["name"],
                "questions": row["question_count"],
            }
            for row in rows
        ],
    }


# ============================================================
# QUESTION VIEWER
# ============================================================

@app.get("/questions")
def questions(
    subject: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=20, ge=1, le=200),
) -> list[dict[str, Any]]:

    with get_connection() as conn:

        if subject:

            subject_row = conn.execute(
                """
                SELECT id
                FROM subjects
                WHERE lower(name) = lower(?)
                   OR slug = ?
                """,
                (subject.strip(), slugify(subject)),
            ).fetchone()

            if subject_row is None:
                return []

            rows = conn.execute(
                """
                SELECT
                    questions.id,
                    questions.question_text,
                    questions.answer_text,
                    questions.source_url
                FROM questions
                WHERE questions.subject_id = ?
                ORDER BY questions.id
                LIMIT ?
                """,
                (subject_row["id"], limit),
            ).fetchall()

        else:

            rows = conn.execute(
                """
                SELECT
                    questions.id,
                    subjects.name AS subject,
                    questions.question_text,
                    questions.answer_text,
                    questions.source_url
                FROM questions
                INNER JOIN subjects
                    ON subjects.id = questions.subject_id
                ORDER BY questions.id
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

    return [dict(row) for row in rows]


# ============================================================
# QUESTION MATCHING
# ============================================================

# NEW: remember answers we already found. The same question is
# then answered instantly (no slow text comparing again).
_match_cache: dict = {}
_match_cache_lock = threading.Lock()
_MATCH_CACHE_LIMIT = 2000


@app.post(
    "/match",
    response_model=MatchResponse,
)
def match_question(payload: MatchRequest) -> MatchResponse:

    cleaned_question = clean_text(payload.question)

    if not cleaned_question:
        raise HTTPException(
            status_code=400,
            detail="Question is empty after cleaning.",
        )

    normalized_input = normalize_for_matching(cleaned_question)

    if not normalized_input:
        raise HTTPException(
            status_code=400,
            detail="Question contains no usable text.",
        )

    cache_key = (
        payload.subject.strip().lower(),
        normalized_input,
        tuple(payload.choices),
    )

    with _match_cache_lock:
        cached = _match_cache.get(cache_key)

    if cached is not None:
        return cached.model_copy()

    response = _find_match(payload, cleaned_question, normalized_input)

    # Only remember real results (not "subject not found").
    if response.match_type != "subject_not_found":
        with _match_cache_lock:
            if len(_match_cache) >= _MATCH_CACHE_LIMIT:
                _match_cache.clear()

            _match_cache[cache_key] = response.model_copy()

    return response


def _find_match(
    payload: MatchRequest,
    cleaned_question: str,
    normalized_input: str,
) -> MatchResponse:

    input_type = detect_input_type(cleaned_question)

    with get_connection() as conn:

        subject_row = conn.execute(
            """
            SELECT id
            FROM subjects
            WHERE lower(name) = lower(?)
               OR slug = ?
            """,
            (
                payload.subject.strip(),
                slugify(payload.subject),
            ),
        ).fetchone()

        if subject_row is None:
            return MatchResponse(
                matched=False,
                confidence=0.0,
                match_type="subject_not_found",
                question=cleaned_question,
            )

        rows = conn.execute(
            """
            SELECT
                question_text,
                normalized_question,
                answer_text,
                source_url
            FROM questions
            WHERE subject_id = ?
            """,
            (subject_row["id"],),
        ).fetchall()

    if not rows:
        return MatchResponse(
            matched=False,
            confidence=0.0,
            match_type="no_questions",
            question=cleaned_question,
        )

    # ========================================================
    # DIFFERENT MATCHING STRATEGY FOR DIFFERENT INPUT TYPES
    # ========================================================

    best_row = None
    best_score = 0.0
    best_type = "no_match"

    if input_type == "direct_question":

        # Example: "What is load testing?"
        # We mainly search the ANSWER, because the answer
        # itself is usually the subject being asked about.
        concept = extract_question_concept(cleaned_question)

        for row in rows:

            score = answer_concept_score(concept, row["answer_text"])

            if score > best_score:
                best_score = score
                best_row = row
                best_type = "answer_match"

    else:

        # Definition / clue. Search the stored CLUE instead.
        for row in rows:

            score = clue_similarity_score(
                normalized_input,
                row["normalized_question"],
                best_score,
            )

            if score > best_score:
                best_score = score
                best_row = row
                best_type = "clue_match"

    # ========================================================
    # LOCAL FALLBACK
    # ========================================================

    used_local_fallback = False

    # Use the fallback only if the original matcher
    # did not produce its normal high-confidence match.
    if best_row is None or best_score < 0.92:

        if input_type == "direct_question":
            fallback_query = extract_question_concept(cleaned_question)
        else:
            fallback_query = normalized_input

        fallback_result = find_local_fallback_match(
            query=fallback_query,
            input_type=input_type,
            rows=rows,
        )

        if fallback_result is not None:
            best_row, fallback_score = fallback_result

            best_score = fallback_score
            best_type = "local_fallback"

            used_local_fallback = True

    # ========================================================
    # CONFIDENCE
    # ========================================================

    if best_row is None:
        return MatchResponse(
            matched=False,
            confidence=0.0,
            match_type="no_match",
            question=cleaned_question,
        )

    # A fallback result has already passed its own
    # minimum-score and ambiguity checks.
    if used_local_fallback:
        matched = True

    elif best_score >= 0.92:
        matched = True

    elif best_score >= 0.75:
        matched = False
        best_type = "review"

    else:
        matched = False
        best_type = "no_match"

    # ========================================================
    # CHOICE MATCHING
    # ========================================================

    choice_index = None
    choice_label = None

    if matched:
        choice_index, choice_label = find_matching_choice(
            answer=best_row["answer_text"],
            choices=payload.choices,
        )

    return MatchResponse(
        matched=matched,
        confidence=round(best_score, 4),
        match_type=best_type,
        question=cleaned_question,
        answer=(best_row["answer_text"] if matched else None),
        matched_question=best_row["question_text"],
        source_url=best_row["source_url"],
        choice_index=choice_index,
        choice_label=choice_label,
    )


# ============================================================
# DATABASE
# ============================================================

def get_connection() -> sqlite3.Connection:

    conn = sqlite3.connect(DB_PATH)

    conn.row_factory = sqlite3.Row

    return conn


# ============================================================
# TEXT CLEANING
# ============================================================

def clean_text(value: str) -> str:

    value = value.replace(" ", " ")

    # Remove repeated whitespace.
    value = re.sub(r"\s+", " ", value)

    return value.strip()


def normalize_for_matching(value: str) -> str:

    value = clean_text(value).lower()

    # Remove common question-number prefixes.
    # Examples: "1. What is...", "Q27: What is..."
    value = re.sub(
        r"^\s*(?:q(?:uestion)?\s*)?\d+\s*[\.\):\-]?\s*",
        "",
        value,
        flags=re.IGNORECASE,
    )

    # Remove punctuation.
    value = re.sub(r"[^a-z0-9\s]", " ", value)

    # Remove duplicate whitespace again.
    value = re.sub(r"\s+", " ", value)

    return value.strip()


def slugify(value: str) -> str:

    value = normalize_for_matching(value)

    return re.sub(r"\s+", "-", value)


_STOP_WORDS = {
    "what", "is", "are", "the", "a", "an", "of", "to", "in", "on",
    "for", "and", "or", "does", "do", "did", "was", "were", "be",
    "being", "been", "can", "could", "would", "should", "this",
    "that", "these", "those", "which", "who", "when", "where",
    "why", "how", "about", "from", "by", "with",
}


def get_important_tokens(value: str) -> list[str]:

    tokens = []

    for token in value.split():

        if token in _STOP_WORDS:
            continue

        if len(token) <= 1:
            continue

        # Ignore pure numbers.
        if token.isdigit():
            continue

        tokens.append(token)

    return tokens


def detect_input_type(question: str) -> str:

    normalized = normalize_for_matching(question)

    # Direct question patterns.
    direct_patterns = [
        r"^what is ",
        r"^what are ",
        r"^what does ",
        r"^what do ",
        r"^define ",
        r"^what is meant by ",
        r"^what are meant by ",
        r"^who is ",
        r"^who are ",
        r"^when did ",
        r"^where is ",
        r"^which is ",
    ]

    for pattern in direct_patterns:
        if re.search(pattern, normalized):
            return "direct_question"

    # If it ends in a question mark, treat it as a direct question.
    if question.strip().endswith("?"):
        return "direct_question"

    return "definition"


def extract_question_concept(question: str) -> str:

    normalized = normalize_for_matching(question)

    patterns = [
        r"^what is (.+)$",
        r"^what are (.+)$",
        r"^what does (.+)$",
        r"^what do (.+)$",
        r"^define (.+)$",
        r"^what is meant by (.+)$",
        r"^what are meant by (.+)$",
        r"^who is (.+)$",
        r"^who are (.+)$",
        r"^which is (.+)$",
    ]

    for pattern in patterns:

        match = re.search(pattern, normalized)

        if match:
            return clean_text(match.group(1))

    return normalized


def answer_concept_score(concept: str, answer: str) -> float:

    concept = normalize_for_matching(concept)
    answer = normalize_for_matching(answer)

    if not concept or not answer:
        return 0.0

    # Exact matches are reliable.
    if concept == answer:
        return 1.0

    # Accept the complete concept inside a longer answer.
    if concept in answer:
        return 0.95

    concept_tokens = set(get_important_tokens(concept))
    answer_tokens = set(get_important_tokens(answer))

    if not concept_tokens or not answer_tokens:
        return 0.0

    # Measure the overlap between meaningful words.
    return (
        len(concept_tokens & answer_tokens)
        / len(concept_tokens | answer_tokens)
    )


def clue_similarity_score(
    question: str,
    clue: str,
    best_so_far: float = 0.0,
) -> float:
    """
    How alike are the question and a stored clue? (0 to 1)

    NEW: "best_so_far" makes this faster. If a quick check shows
    this clue can not beat the best one found so far, the slow
    check is skipped. The final winner is the same as before.
    """

    if not question or not clue:
        return 0.0

    if question == clue:
        return 1.0

    question_tokens = set(get_important_tokens(question))
    clue_tokens = set(get_important_tokens(clue))

    if not question_tokens or not clue_tokens:
        token_score = 0.0
    else:
        token_score = (
            len(question_tokens & clue_tokens)
            / len(question_tokens | clue_tokens)
        )

    matcher = SequenceMatcher(None, question, clue)

    if best_so_far > 0:
        # Quick upper limits. The real score is never higher.
        if (
            matcher.real_quick_ratio() * 0.65 + token_score * 0.35
            <= best_so_far
        ):
            return 0.0

        if (
            matcher.quick_ratio() * 0.65 + token_score * 0.35
            <= best_so_far
        ):
            return 0.0

    return matcher.ratio() * 0.65 + token_score * 0.35


# ============================================================
# CHOICE MATCHING
# ============================================================

def split_choice(choice: str) -> tuple[str | None, str]:
    cleaned = clean_text(choice)

    match = re.match(
        r"^([A-Ha-h])\s*(?:[.):]|\s-)\s*(.+)$",
        cleaned,
    )

    if match:
        return match.group(1).upper(), clean_text(match.group(2))

    return None, cleaned


def find_matching_choice(
    answer: str,
    choices: list[str],
) -> tuple[int | None, str | None]:

    normalized_answer = normalize_for_matching(answer)

    if not normalized_answer:
        return None, None

    parsed = []

    for choice in choices:
        label, text = split_choice(choice)
        parsed.append(
            (label, text, normalize_for_matching(text))
        )

    # Pass 1: the answer exactly equals a choice's text.
    for index, (label, text, normalized_text) in enumerate(parsed):
        if normalized_text and normalized_answer == normalized_text:
            return index, label or text

    # Pass 2: the database answer is just the letter (example: "C").
    for index, (label, text, normalized_text) in enumerate(parsed):
        if label and normalized_answer == label.lower():
            return index, label

    # Pass 3: partial text match (ignore very short texts).
    for index, (label, text, normalized_text) in enumerate(parsed):
        if (
            len(normalized_text) >= 3
            and len(normalized_answer) >= 3
            and (
                normalized_answer in normalized_text
                or normalized_text in normalized_answer
            )
        ):
            return index, label or text

    return None, None