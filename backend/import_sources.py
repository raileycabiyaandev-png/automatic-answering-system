from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import requests
from bs4 import BeautifulSoup


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "questions.db"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Safari/537.36"
)


@dataclass
class Record:
    clue: str
    answer: str
    source_url: str


def main() -> None:

    subjects = get_subjects()

    total_saved = 0

    print("=" * 70)
    print("DIAGNOSTIC QUESTION SOURCE IMPORTER")
    print("=" * 70)

    for subject in subjects:

        print()
        print("=" * 70)
        print(f"SUBJECT: {subject['name']}")
        print(f"URL: {subject['source_url']}")
        print("=" * 70)

        try:

            records = extract_records(
                subject["source_url"]
            )

            print(
                f"Possible records found: {len(records)}"
            )

            valid_records = []

            for index, record in enumerate(
                records,
                start=1,
            ):

                if not is_valid_record(record):

                    print(
                        f"[REJECTED {index}] "
                        f"{record.clue[:100]}"
                    )

                    continue

                valid_records.append(
                    record
                )

            print(
                f"Valid records: {len(valid_records)}"
            )

            saved = save_records(
                subject_id=subject["id"],
                records=valid_records,
            )

            print(
                f"Saved to database: {saved}"
            )

            total_saved += saved

        except Exception as error:

            print(
                f"ERROR: {error}"
            )

    print()
    print("=" * 70)
    print(
        f"TOTAL SAVED: {total_saved}"
    )
    print("=" * 70)


def get_connection() -> sqlite3.Connection:

    conn = sqlite3.connect(
        DB_PATH
    )

    conn.row_factory = sqlite3.Row

    return conn


def get_subjects():

    with get_connection() as conn:

        return conn.execute(
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


def extract_records(
    url: str,
) -> list[Record]:

    response = requests.get(
        url,
        headers={
            "User-Agent": USER_AGENT
        },
        timeout=30,
    )

    response.raise_for_status()

    soup = BeautifulSoup(
        response.text,
        "lxml",
    )

    records: list[Record] = []

    # --------------------------------------------------------
    # TABLES
    # --------------------------------------------------------

    for table in soup.find_all("table"):

        rows = table.find_all("tr")

        for row in rows:

            cells = row.find_all(
                ["td", "th"]
            )

            texts = [
                clean(
                    cell.get_text(
                        " ",
                        strip=True,
                    )
                )
                for cell in cells
            ]

            texts = [
                text
                for text in texts
                if text
            ]

            if len(texts) >= 2:

                records.append(
                    Record(
                        clue=texts[0],
                        answer=texts[1],
                        source_url=url,
                    )
                )

    # --------------------------------------------------------
    # POST CONTENT
    # --------------------------------------------------------

    post = (
        soup.select_one(".post-body")
        or soup.select_one(
            ".entry-content"
        )
        or soup.select_one("article")
    )

    if post:

        elements = post.find_all(
            ["p", "li"]
        )

        for element in elements:

            text = clean(
                element.get_text(
                    " ",
                    strip=True,
                )
            )

            if not text:
                continue

            # Look for:
            #
            # Question
            # Answer
            #
            next_element = (
                element.find_next(
                    ["p", "li"]
                )
            )

            if next_element:

                answer = clean(
                    next_element.get_text(
                        " ",
                        strip=True,
                    )
                )

                if (
                    answer
                    and answer != text
                ):

                    records.append(
                        Record(
                            clue=text,
                            answer=answer,
                            source_url=url,
                        )
                    )

    return remove_duplicates(
        records
    )


def is_valid_record(
    record: Record,
) -> bool:

    clue = clean(
        record.clue
    )

    answer = clean(
        record.answer
    )

    if not clue or not answer:
        return False

    if len(clue) < 10:
        return False

    if len(clue) > 1000:
        return False

    if len(answer) > 1000:
        return False

    if is_blog_noise(
        clue
    ):
        return False

    if is_blog_noise(
        answer
    ):
        return False

    # Ignore navigation.
    blocked = [
        "home",
        "older posts",
        "newer posts",
        "comments",
        "subscribe",
        "follow us",
        "blog archive",
    ]

    clue_lower = clue.lower()

    for word in blocked:

        if clue_lower == word:
            return False

    # The clue and answer should not be
    # exactly identical.
    if normalize(clue) == normalize(answer):
        return False

    return True


def is_blog_noise(
    value: str,
) -> bool:

    value = value.lower()

    noise = [
        "what do you think of this blog",
        "#sarcasticgamer",
        "#sarcasticreview",
        "powered by blogger",
    ]

    return any(
        item in value
        for item in noise
    )


def save_records(
    subject_id: int,
    records: list[Record],
) -> int:

    saved = 0

    with get_connection() as conn:

        for record in records:

            clue = clean(
                record.clue
            )

            answer = clean(
                record.answer
            )

            normalized = normalize(
                clue
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
                    clue,
                    normalized,
                    answer,
                    record.source_url,
                ),
            )

            if cursor.rowcount == 1:

                saved += 1

        conn.commit()

    return saved


def remove_duplicates(
    records: list[Record],
) -> list[Record]:

    unique = {}

    for record in records:

        key = (
            normalize(record.clue)
            +
            "::"
            +
            normalize(record.answer)
        )

        unique.setdefault(
            key,
            record,
        )

    return list(
        unique.values()
    )


def clean(
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

    value = clean(
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


if __name__ == "__main__":
    main()