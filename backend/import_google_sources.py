# backend/import_google_sources.py
"""
Imports questions + answers from the Google Sheets embedded in the
Jenny's Blogspot posts listed in subjects.source_url.

SAFE: nothing is deleted. A backup copy of questions.db is made
first, and only rows that do not exist yet are added.

Usage:
    python import_google_sources.py --dry-run     (shows what would be added)
    python import_google_sources.py               (adds the missing rows)
    python import_google_sources.py --subject "Load Testing"
"""
from __future__ import annotations

import argparse
import csv
import io
import re
import shutil
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "questions.db"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Safari/537.36"
)
TIMEOUT = 30

SHEET_RE = re.compile(
    r"https?://docs\.google\.com/spreadsheets/d/"
    r"(e/[\w-]+|[\w-]+)([^\s\"'<>\\]*)",
    re.IGNORECASE,
)

HEADER_WORDS = {
    "question", "questions", "answer", "answers", "clue", "clues",
    "description", "correct answer", "statement", "item", "key",
    "response", "definition", "term",
}
QUESTION_HEADERS = {
    "question", "questions", "clue", "clues", "statement",
    "description", "item", "definition",
}
ANSWER_HEADERS = {
    "answer", "answers", "correct answer", "key", "response", "term",
}

# Only real blog/footer noise. (Single words such as "comments"
# are NOT here, because real questions can contain them.)
NOISE_PHRASES = [
    "what do you think of this blog",
    "#sarcasticgamer",
    "#sarcasticreview",
    "powered by blogger",
]

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})


# ============================================================
# MAIN
# ============================================================

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--subject", default="")
    args = parser.parse_args()

    print("=" * 70)
    print("GOOGLE SHEETS QUESTION IMPORTER" +
          ("  (DRY RUN - nothing is written)" if args.dry_run else ""))
    print("=" * 70)

    subjects = get_subjects()

    if args.subject:
        subjects = [
            s for s in subjects
            if s["name"].lower() == args.subject.strip().lower()
        ]

    if not args.dry_run:
        backup_database()

    summary = []

    for subject in subjects:
        print()
        print("-" * 70)
        print(f"SUBJECT: {subject['name']}")
        print(f"SOURCE:  {subject['source_url']}")
        print("-" * 70)

        try:
            records = collect_records(subject["source_url"])
            print(f"Valid records found online: {len(records)}")

            added, existing, blocked = save_records(
                subject["id"], records, dry_run=args.dry_run
            )

            print(f"Already in database: {existing}")
            print(
                f"{'Would add' if args.dry_run else 'Added'}: {added}"
            )

            if blocked:
                print(
                    f"Refused by a database UNIQUE rule: {blocked} "
                    "(see the note about the schema)"
                )

            summary.append((subject["name"], len(records), added))

        except Exception as error:  # keep going with other subjects
            print("IMPORT ERROR:", error)
            summary.append((subject["name"], 0, 0))

    print()
    print("=" * 70)
    print(f"{'SUBJECT':45} {'ONLINE':>8} {'NEW':>6}")

    for name, found, added in summary:
        print(f"{name[:45]:45} {found:>8} {added:>6}")

    print(f"TOTAL NEW: {sum(item[2] for item in summary)}")
    print("=" * 70)


# ============================================================
# DATABASE
# ============================================================

def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def backup_database() -> None:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = DB_PATH.with_name(f"questions.backup-{stamp}.db")
    shutil.copy2(DB_PATH, target)
    print(f"Backup saved: {target.name}")


def get_subjects():
    with get_connection() as conn:
        return conn.execute(
            """
            SELECT id, name, source_url
            FROM subjects
            WHERE source_url IS NOT NULL AND source_url != ''
            ORDER BY name
            """
        ).fetchall()


def save_records(subject_id: int, records: list[dict], dry_run: bool):
    added = existing_count = blocked = 0

    with get_connection() as conn:
        known = {
            (normalize(row["question_text"]), normalize(row["answer_text"]))
            for row in conn.execute(
                "SELECT question_text, answer_text FROM questions "
                "WHERE subject_id = ?",
                (subject_id,),
            )
        }

        for record in records:
            key = (
                normalize(record["question"]),
                normalize(record["answer"]),
            )

            if key in known:
                existing_count += 1
                continue

            known.add(key)

            if dry_run:
                added += 1
                continue

            try:
                conn.execute(
                    """
                    INSERT INTO questions(
                        subject_id, question_text, normalized_question,
                        answer_text, source_url
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        subject_id,
                        record["question"],
                        key[0],
                        record["answer"],
                        record["source_url"],
                    ),
                )
                added += 1
            except sqlite3.IntegrityError:
                blocked += 1

        conn.commit()

    return added, existing_count, blocked


# ============================================================
# FINDING THE SHEETS
# ============================================================

def get_text(url: str, retries: int = 3) -> str:
    last_error = None

    for attempt in range(retries):
        try:
            response = SESSION.get(url, timeout=TIMEOUT)
            response.raise_for_status()
            return response.content.decode("utf-8-sig", errors="replace")
        except requests.RequestException as error:
            last_error = error
            time.sleep(1.5 * (attempt + 1))

    raise last_error  # type: ignore[misc]


def find_sheets(blog_url: str) -> dict[str, set[str]]:
    """All Google Sheets on the page: {sheet id: {known gids}}."""
    html = get_text(blog_url)
    soup = BeautifulSoup(html, "lxml")

    blobs = []

    for tag in soup.find_all(["iframe", "a"]):
        link = tag.get("src") or tag.get("href")

        if link:
            blobs.append(urljoin(blog_url, link))

    blobs.append(html)

    sheets: dict[str, set[str]] = {}

    for blob in blobs:
        text = blob.replace("\\/", "/").replace("&amp;", "&")

        for match in SHEET_RE.finditer(text):
            sheet_id = match.group(1)
            gids = sheets.setdefault(sheet_id, set())

            found = re.search(r"gid=(\d+)", match.group(2))

            if found:
                gids.add(found.group(1))

    return sheets


def sheet_tabs(sheet_id: str, known: set[str]) -> list[str | None]:
    """Every tab (gid) of a published sheet."""
    gids = set(known)

    try:
        html = get_text(
            f"https://docs.google.com/spreadsheets/d/{sheet_id}/pubhtml"
        ).replace("&amp;", "&")
        gids |= set(re.findall(r"gid=(\d+)", html))
    except requests.RequestException:
        pass

    return sorted(gids, key=int) if gids else [None]


def csv_candidates(sheet_id: str, gid: str | None) -> list[str]:
    base = f"https://docs.google.com/spreadsheets/d/{sheet_id}"
    query = f"gid={gid}&single=true&" if gid is not None else ""

    urls = [f"{base}/pub?{query}output=csv"]

    if not sheet_id.startswith("e/"):
        suffix = f"&gid={gid}" if gid is not None else ""
        urls.append(f"{base}/export?format=csv{suffix}")

    return urls


def download_rows(sheet_id: str, gid: str | None) -> list[list[str]]:
    for url in csv_candidates(sheet_id, gid):
        try:
            text = get_text(url)
        except requests.RequestException:
            continue

        if re.match(r"\s*<(!doctype|html)", text, re.IGNORECASE):
            continue

        rows = []

        for row in csv.reader(io.StringIO(text)):
            cells = [clean_text(cell) for cell in row]

            if any(cells):
                rows.append(cells)

        if rows:
            return rows

    return []


# ============================================================
# CONVERTING ROWS
# ============================================================

def collect_records(blog_url: str) -> list[dict]:
    sheets = find_sheets(blog_url)

    if not sheets:
        print("No Google Sheet found on this page.")
        return []

    records: list[dict] = []

    for sheet_id, known in sheets.items():
        for gid in sheet_tabs(sheet_id, known):
            rows = download_rows(sheet_id, gid)
            label = f"{sheet_id[:14]}... tab {gid}"
            print(f"  {label}: {len(rows)} rows")

            if rows:
                records.extend(rows_to_records(rows, blog_url))

            time.sleep(0.3)

    return remove_duplicates(records)


def detect_layout(rows: list[list[str]]):
    """
    Returns (question_index, answer_index) when the sheet has a
    header row, otherwise (None, answer_first).
    """
    header = [normalize(cell) for cell in rows[0]]

    q_index = next(
        (i for i, v in enumerate(header) if v in QUESTION_HEADERS), None
    )
    a_index = next(
        (i for i, v in enumerate(header) if v in ANSWER_HEADERS), None
    )

    if q_index is not None and a_index is not None:
        return q_index, a_index

    # No header: vote row by row. The answer is usually the SHORTER
    # cell, the clue the longer one.
    votes_answer_first = votes_clue_first = 0

    for row in rows:
        cells = [c for c in row if c][:2]

        if len(cells) < 2:
            continue

        if len(cells[0]) < len(cells[1]):
            votes_answer_first += 1
        elif len(cells[0]) > len(cells[1]):
            votes_clue_first += 1

    return None, votes_answer_first >= votes_clue_first


def rows_to_records(rows: list[list[str]], source_url: str) -> list[dict]:
    q_index, second = detect_layout(rows)
    records = []

    for row in rows:
        if q_index is not None:
            a_index = second

            if len(row) <= max(q_index, a_index):
                continue

            clue, answer = row[q_index], row[a_index]
        else:
            # Empty cells are skipped only to find the first TWO
            # filled cells (the rest of the row is ignored).
            cells = [c for c in row if c][:2]

            if len(cells) < 2:
                continue

            answer, clue = (cells if second else cells[::-1])

        if is_valid_record(clue, answer):
            records.append(
                {"question": clue, "answer": answer,
                 "source_url": source_url}
            )

    return records


def is_valid_record(clue: str, answer: str) -> bool:
    if not clue or not answer:
        return False

    if len(clue) < 3 or len(clue) > 5000 or len(answer) > 2000:
        return False

    if normalize(clue) in HEADER_WORDS or normalize(answer) in HEADER_WORDS:
        return False

    low = f"{clue} {answer}".lower()

    if any(phrase in low for phrase in NOISE_PHRASES):
        return False

    return normalize(clue) != normalize(answer)


def remove_duplicates(records: list[dict]) -> list[dict]:
    """Same clue with a DIFFERENT answer is kept (both are useful)."""
    unique: dict = {}

    for record in records:
        key = (normalize(record["question"]), normalize(record["answer"]))

        if key[0] and key[1]:
            unique.setdefault(key, record)

    return list(unique.values())


# ============================================================
# TEXT UTILITIES (same rules as backend/app.py)
# ============================================================

def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\u00a0", " ")).strip()


def normalize(value: str) -> str:
    value = clean_text(value).lower()

    value = re.sub(
        r"^\s*(?:q(?:uestion)?\s*)?\d+\s*[\.\):\-]?\s*", "", value
    )
    value = re.sub(r"[^a-z0-9\s]", " ", value)

    return re.sub(r"\s+", " ", value).strip()


if __name__ == "__main__":
    main()