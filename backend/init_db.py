from __future__ import annotations

import re
import sqlite3
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "questions.db"


SUBJECTS = [
    (
        "Load Testing",
        "load-testing",
        "https://jennysonline.blogspot.com/2021/09/load-testing.html",
    ),
    (
        "Software Engineering 1",
        "software-engineering-1",
        "https://jennysonline.blogspot.com/2021/03/software-engineering-1.html",
    ),
    (
        "Capstone 2",
        "capstone-2",
        "https://jennysonline.blogspot.com/2023/07/it-capstone-project-2.html",
        "https://amauoed.com/courses/it/it-capstone-project-1-6398-it"
    ),
    (
        "Art Appreciation",
        "art-appreciation",
        "https://jennysonline.blogspot.com/2020/12/art-appreciation.html",
    ),
    (
        "Cloud Computing and Internet of Things",
        "cloud-computing-and-internet-of-things",
        "https://jennysonline.blogspot.com/2021/03/cloud-computing-and-internet-of-things.html",
    ),
    (
        "Readings in the Philippine History",
        "readings-in-the-philippine-history",
        "https://jennysonline.blogspot.com/2021/03/readings-in-philippine-history.html",
    ),
    (
        "Technopreneurship",
        "https://amauoed.com/courses/ite/technopreneurship-6301-ite",
    ),
]


def main() -> None:

    with sqlite3.connect(DB_PATH) as conn:

        conn.execute(
            "PRAGMA foreign_keys = ON"
        )

        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS subjects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,

                name TEXT NOT NULL UNIQUE,

                slug TEXT NOT NULL UNIQUE,

                source_url TEXT
            );


            CREATE TABLE IF NOT EXISTS questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,

                subject_id INTEGER NOT NULL,

                question_text TEXT NOT NULL,

                normalized_question TEXT NOT NULL,

                answer_text TEXT NOT NULL,

                source_url TEXT,

                created_at TEXT NOT NULL
                    DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY(subject_id)
                    REFERENCES subjects(id)
                    ON DELETE CASCADE,

                UNIQUE(
                    subject_id,
                    normalized_question
                )
            );
            """
        )

        ensure_source_url_column(conn)

        for name, slug, source_url in SUBJECTS:

            conn.execute(
                """
                INSERT INTO subjects(
                    name,
                    slug,
                    source_url
                )
                VALUES (?, ?, ?)

                ON CONFLICT(name)
                DO UPDATE SET
                    slug = excluded.slug,
                    source_url = excluded.source_url
                """,
                (
                    name,
                    slug,
                    source_url,
                ),
            )

        conn.commit()

    print(
        f"Database ready: {DB_PATH}"
    )


def ensure_source_url_column(
    conn: sqlite3.Connection,
) -> None:

    columns = conn.execute(
        "PRAGMA table_info(subjects)"
    ).fetchall()

    column_names = {
        row[1]
        for row in columns
    }

    if "source_url" not in column_names:

        conn.execute(
            """
            ALTER TABLE subjects
            ADD COLUMN source_url TEXT
            """
        )


if __name__ == "__main__":
    main()