from __future__ import annotations

import csv
import io
import re
import sqlite3
from pathlib import Path
from statistics import mean
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup


# ============================================================
# CONFIGURATION
# ============================================================

BASE_DIR = Path(__file__).resolve().parent

DB_PATH = BASE_DIR / "questions.db"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Safari/537.36"
)

TIMEOUT = 30


# ============================================================
# MAIN
# ============================================================

def main() -> None:

    print("=" * 70)
    print("GOOGLE SHEETS QUESTION IMPORTER")
    print("=" * 70)

    subjects = get_subjects()

    total_saved = 0

    for subject in subjects:

        print()
        print("-" * 70)
        print(
            f"SUBJECT: {subject['name']}"
        )
        print(
            f"SOURCE:  {subject['source_url']}"
        )
        print("-" * 70)

        try:

            csv_url = find_google_sheet_csv(
                subject["source_url"]
            )

            if not csv_url:

                print(
                    "No Google Sheet source found."
                )

                continue

            print(
                "CSV:",
                csv_url,
            )

            rows = download_csv(
                csv_url
            )

            print(
                f"CSV rows found: {len(rows)}"
            )

            records = convert_rows_to_records(
                rows=rows,
                source_url=subject["source_url"],
            )

            print(
                f"Valid records: {len(records)}"
            )

            saved = save_records(
                subject_id=subject["id"],
                records=records,
            )

            print(
                f"New records saved: {saved}"
            )

            total_saved += saved

        except Exception as error:

            print(
                "IMPORT ERROR:",
                error,
            )

    print()
    print("=" * 70)
    print(
        f"TOTAL NEW RECORDS: {total_saved}"
    )
    print("=" * 70)


# ============================================================
# DATABASE
# ============================================================

def get_connection() -> sqlite3.Connection:

    conn = sqlite3.connect(
        DB_PATH
    )

    conn.row_factory = sqlite3.Row

    return conn


def get_subjects():

    with get_connection() as conn:

        rows = conn.execute(
            """
            SELECT
                id,
                name,
                source_url
            FROM subjects
            WHERE source_url IS NOT NULL
              AND source_url != ''
            ORDER BY name
            """
        ).fetchall()

    return rows


# ============================================================
# FIND GOOGLE SHEET
# ============================================================

def find_google_sheet_csv(
    blog_url: str,
) -> str | None:

    response = requests.get(
        blog_url,
        headers={
            "User-Agent": USER_AGENT
        },
        timeout=TIMEOUT,
    )

    response.raise_for_status()

    soup = BeautifulSoup(
        response.text,
        "lxml",
    )

    # --------------------------------------------------------
    # First: look for iframe
    # --------------------------------------------------------

    for iframe in soup.find_all(
        "iframe"
    ):

        src = iframe.get(
            "src"
        )

        if not src:
            continue

        src = urljoin(
            blog_url,
            src,
        )

        if (
            "docs.google.com/spreadsheets"
            in src.lower()
        ):

            return convert_to_csv_url(
                src
            )

    # --------------------------------------------------------
    # Second: look for direct links
    # --------------------------------------------------------

    for link in soup.find_all(
        "a"
    ):

        href = link.get(
            "href"
        )

        if not href:
            continue

        href = urljoin(
            blog_url,
            href,
        )

        if (
            "docs.google.com/spreadsheets"
            in href.lower()
        ):

            return convert_to_csv_url(
                href
            )

    return None


def convert_to_csv_url(
    published_url: str,
) -> str:

    # Example:
    #
    # /pubhtml?widget=true&headers=false
    #
    # becomes:
    #
    # /pub?output=csv

    if "/pubhtml" in published_url:

        base = published_url.split(
            "/pubhtml",
            1,
        )[0]

        return (
            base
            + "/pub?output=csv"
        )

    if "/pub?" in published_url:

        base = published_url.split(
            "/pub?",
            1,
        )[0]

        return (
            base
            + "/pub?output=csv"
        )

    if published_url.endswith(
        "/pub"
    ):

        return (
            published_url
            + "?output=csv"
        )

    return published_url


# ============================================================
# DOWNLOAD CSV
# ============================================================

def download_csv(
    csv_url: str,
) -> list[list[str]]:

    response = requests.get(
        csv_url,
        headers={
            "User-Agent": USER_AGENT
        },
        timeout=TIMEOUT,
    )

    response.raise_for_status()

    text = response.content.decode(
        "utf-8-sig",
        errors="replace",
    )

    reader = csv.reader(
        io.StringIO(text)
    )

    rows = []

    for row in reader:

        cleaned = [
            clean_text(cell)
            for cell in row
        ]

        cleaned = [
            cell
            for cell in cleaned
            if cell
        ]

        if cleaned:

            rows.append(
                cleaned
            )

    return rows


# ============================================================
# CONVERT CSV ROWS
# ============================================================

def convert_rows_to_records(
    rows: list[list[str]],
    source_url: str,
) -> list[dict[str, str]]:

    if not rows:

        return []

    question_index, answer_index = (
        detect_columns(rows)
    )

    print()
    print(
        "Detected columns:"
    )

    print(
        f"Answer column: {answer_index}"
    )

    print(
        f"Clue column:   {question_index}"
    )

    records = []

    # --------------------------------------------------------
    # Start from all rows.
    #
    # We intentionally do not blindly skip row 1 because
    # some sheets have no header.
    # --------------------------------------------------------

    for row in rows:

        if len(row) <= max(
            question_index,
            answer_index,
        ):
            continue

        clue = clean_text(
            row[question_index]
        )

        answer = clean_text(
            row[answer_index]
        )

        if not is_valid_record(
            clue=clue,
            answer=answer,
        ):
            continue

        records.append(
            {
                "question": clue,
                "answer": answer,
                "source_url": source_url,
            }
        )

    return remove_duplicates(
        records
    )


# ============================================================
# COLUMN DETECTION
# ============================================================

def detect_columns(
    rows: list[list[str]],
) -> tuple[int, int]:

    # --------------------------------------------------------
    # Look for an obvious header first.
    # --------------------------------------------------------

    first_row = [
        normalize(
            cell
        )
        for cell in rows[0]
    ]

    question_keywords = {
        "question",
        "questions",
        "clue",
        "statement",
        "description",
        "item",
    }

    answer_keywords = {
        "answer",
        "answers",
        "correct answer",
        "key",
        "response",
    }

    question_index = None
    answer_index = None

    for index, value in enumerate(
        first_row
    ):

        if value in question_keywords:

            question_index = index

        if value in answer_keywords:

            answer_index = index

    if (
        question_index is not None
        and answer_index is not None
    ):

        return (
            question_index,
            answer_index,
        )

    # --------------------------------------------------------
    # Most of Jenny's sheets use:
    #
    # Column 1 = Answer
    # Column 2 = Question/Clue
    #
    # We verify this rather than blindly assuming it.
    # --------------------------------------------------------

    two_column_rows = [
        row
        for row in rows
        if len(row) >= 2
    ]

    if two_column_rows:

        first_lengths = [
            len(row[0])
            for row in two_column_rows
        ]

        second_lengths = [
            len(row[1])
            for row in two_column_rows
        ]

        first_average = mean(
            first_lengths
        )

        second_average = mean(
            second_lengths
        )

        # The first column is usually the short
        # answer and the second column is the
        # longer clue.
        if (
            first_average
            < second_average
        ):

            return (
                1,  # clue
                0,  # answer
            )

        # If second column is shorter,
        # assume:
        #
        # Column 1 = clue
        # Column 2 = answer
        return (
            0,
            1,
        )

    return (
        1,
        0,
    )


# ============================================================
# RECORD VALIDATION
# ============================================================

def is_valid_record(
    clue: str,
    answer: str,
) -> bool:

    if not clue:
        return False

    if not answer:
        return False

    if len(clue) < 3:
        return False

    if len(clue) > 5000:
        return False

    if len(answer) > 2000:
        return False

    # Ignore obvious sheet headers.
    header_values = {
        "question",
        "questions",
        "answer",
        "answers",
        "clue",
        "description",
        "correct answer",
    }

    if (
        normalize(clue)
        in header_values
    ):

        return False

    if (
        normalize(answer)
        in header_values
    ):

        return False

    # Ignore common blog/footer noise.
    noise = [
        "what do you think of this blog",
        "#sarcasticgamer",
        "#sarcasticreview",
        "powered by blogger",
        "subscribe",
        "comments",
    ]

    clue_lower = clue.lower()
    answer_lower = answer.lower()

    for item in noise:

        if item in clue_lower:
            return False

        if item in answer_lower:
            return False

    # Prevent duplicate clue/answer values.
    if normalize(clue) == normalize(answer):
        return False

    return True


# ============================================================
# DATABASE SAVE
# ============================================================

def save_records(
    subject_id: int,
    records: list[dict[str, str]],
) -> int:

    saved = 0

    with get_connection() as conn:

        for record in records:

            question = clean_text(
                record["question"]
            )

            answer = clean_text(
                record["answer"]
            )

            normalized_question = (
                normalize(question)
            )

            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO questions(
                    subject_id,
                    question_text,
                    normalized_question,
                    answer_text,
                    source_url
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    subject_id,
                    question,
                    normalized_question,
                    answer,
                    record["source_url"],
                ),
            )

            if cursor.rowcount == 1:

                saved += 1

        conn.commit()

    return saved


# ============================================================
# DUPLICATE REMOVAL
# ============================================================

def remove_duplicates(
    records: list[dict[str, str]],
) -> list[dict[str, str]]:

    unique = {}

    for record in records:

        key = (
            normalize(
                record["question"]
            )
        )

        if not key:
            continue

        unique.setdefault(
            key,
            record,
        )

    return list(
        unique.values()
    )


# ============================================================
# TEXT UTILITIES
# ============================================================

def clean_text(
    value: str,
) -> str:

    value = value.replace(
        "\u00a0",
        " ",
    )

    value = re.sub(
        r"\s+",
        " ",
        value,
    )

    return value.strip()


def normalize(
    value: str,
) -> str:

    value = clean_text(
        value
    ).lower()

    value = re.sub(
        r"[^a-z0-9\s]",
        " ",
        value,
    )

    value = re.sub(
        r"\s+",
        " ",
        value,
    )

    return value.strip()


# ============================================================
# PROGRAM ENTRY
# ============================================================

if __name__ == "__main__":
    main()