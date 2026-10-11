from __future__ import annotations

import sqlite3
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "questions.db"


def main() -> None:
    with sqlite3.connect(DB_PATH) as conn:

        cursor = conn.execute(
            "DELETE FROM questions"
        )

        conn.commit()

        print(
            f"Removed {cursor.rowcount} question records."
        )


if __name__ == "__main__":
    main()