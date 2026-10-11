
from __future__ import annotations

import re
import sqlite3
from difflib import SequenceMatcher
from typing import Sequence


STOP_WORDS = {
    "what", "is", "are", "the", "a", "an", "of",
    "to", "in", "on", "for", "and", "or", "does",
    "do", "did", "was", "were", "be", "this", "that",
    "which", "who", "when", "where", "why", "how",
    "with", "from", "by"
}


def normalize_text(value: str | None) -> str:
    """Convert text into a consistent format for comparison."""
    text = str(value or "").lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def important_tokens(value: str) -> set[str]:
    """Remove common words that add little meaning."""
    return {
        word
        for word in normalize_text(value).split()
        if len(word) > 1 and word not in STOP_WORDS
    }


def similarity_score(query: str, candidate: str) -> float:
    """
    Compare two text strings using character similarity
    and the overlap between important words.

    This is text matching, not a generative AI model.
    """
    query = normalize_text(query)
    candidate = normalize_text(candidate)

    if not query or not candidate:
        return 0.0

    if query == candidate:
        return 1.0

    character_score = SequenceMatcher(
        None, query, candidate
    ).ratio()

    query_tokens = important_tokens(query)
    candidate_tokens = important_tokens(candidate)

    if not query_tokens or not candidate_tokens:
        return character_score

    intersection = query_tokens & candidate_tokens
    union = query_tokens | candidate_tokens

    word_overlap = len(intersection) / len(union)
    query_coverage = len(intersection) / len(query_tokens)

    token_score = (
        word_overlap * 0.65
        + query_coverage * 0.35
    )

    return min(1.0, max(character_score, token_score))


def find_local_fallback_match(
    query: str,
    input_type: str,
    rows: Sequence[sqlite3.Row],
) -> tuple[sqlite3.Row, float] | None:
    """
    Look for a related record within the selected subject.

    Direct questions are compared against stored answers.
    Definition-style questions are compared against stored clues.

    Ambiguous or weak results are rejected.
    """
    if input_type == "direct_question":
        minimum_score = 0.78
        comparison_field = "answer_text"
    else:
        minimum_score = 0.72
        comparison_field = "normalized_question"

    candidates: list[tuple[float, sqlite3.Row]] = []

    for row in rows:
        stored_text = row[comparison_field]

        score = similarity_score(query, stored_text)

        candidates.append((score, row))

    if not candidates:
        return None

    candidates.sort(
        key=lambda item: item[0],
        reverse=True,
    )

    best_score, best_row = candidates[0]

    if best_score < minimum_score:
        return None

    # Reject close matches that suggest different answers.
    if len(candidates) > 1:
        second_score, second_row = candidates[1]

        best_answer = normalize_text(
            best_row["answer_text"]
        )

        second_answer = normalize_text(
            second_row["answer_text"]
        )

        same_answer = best_answer == second_answer

        if (
            not same_answer
            and best_score - second_score < 0.06
        ):
            return None

    return best_row, round(best_score, 4)