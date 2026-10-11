from __future__ import annotations

import re
from pathlib import Path

import requests
from bs4 import BeautifulSoup


URL = (
    "https://jennysonline.blogspot.com/"
    "2021/09/load-testing.html"
)

OUTPUT_FILE = (
    Path(__file__).resolve().parent
    / "load_testing_page.html"
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Safari/537.36"
)


def main() -> None:

    print("=" * 70)
    print("SOURCE INSPECTOR")
    print("=" * 70)

    response = requests.get(
        URL,
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

    OUTPUT_FILE.write_text(
        response.text,
        encoding="utf-8",
    )

    print()
    print("HTTP STATUS:")
    print(response.status_code)

    print()
    print("HTML LENGTH:")
    print(len(response.text))

    print()
    print("TITLE:")

    if soup.title:
        print(
            soup.title.get_text(
                " ",
                strip=True,
            )
        )
    else:
        print("No title")

    # ========================================================
    # IFRAMES
    # ========================================================

    print()
    print("=" * 70)
    print("IFRAMES")
    print("=" * 70)

    iframes = soup.find_all("iframe")

    print(
        f"Found {len(iframes)} iframe(s)."
    )

    for index, iframe in enumerate(
        iframes,
        start=1,
    ):

        src = iframe.get(
            "src"
        )

        title = iframe.get(
            "title"
        )

        print()
        print(
            f"IFRAME #{index}"
        )

        print(
            "src:",
            src,
        )

        print(
            "title:",
            title,
        )

    # ========================================================
    # TABLES
    # ========================================================

    print()
    print("=" * 70)
    print("TABLES")
    print("=" * 70)

    tables = soup.find_all("table")

    print(
        f"Found {len(tables)} table(s)."
    )

    for table_index, table in enumerate(
        tables,
        start=1,
    ):

        print()
        print(
            f"TABLE #{table_index}"
        )

        rows = table.find_all("tr")

        for row_index, row in enumerate(
            rows,
            start=1,
        ):

            cells = row.find_all(
                ["th", "td"]
            )

            values = [
                clean(
                    cell.get_text(
                        " ",
                        strip=True,
                    )
                )
                for cell in cells
            ]

            values = [
                value
                for value in values
                if value
            ]

            if values:

                print(
                    f"Row {row_index}:",
                    values
                )

    # ========================================================
    # LINKS
    # ========================================================

    print()
    print("=" * 70)
    print("INTERESTING LINKS")
    print("=" * 70)

    links = soup.find_all("a")

    found_links = set()

    for link in links:

        href = link.get("href")

        text = clean(
            link.get_text(
                " ",
                strip=True,
            )
        )

        if not href:
            continue

        href_lower = href.lower()

        interesting = (
            "docs.google.com" in href_lower
            or "drive.google.com" in href_lower
            or "forms.google.com" in href_lower
            or "sheets" in href_lower
            or "quiz" in href_lower
            or "answer" in href_lower
        )

        if interesting:

            item = (
                text,
                href,
            )

            if item not in found_links:

                found_links.add(item)

                print()
                print(
                    "TEXT:",
                    text
                )

                print(
                    "URL:",
                    href
                )

    # ========================================================
    # MAIN CONTENT
    # ========================================================

    print()
    print("=" * 70)
    print("MAIN PAGE TEXT")
    print("=" * 70)

    post = (
        soup.select_one(".post-body")
        or soup.select_one("article")
        or soup.body
    )

    if post:

        text = post.get_text(
            "\n",
            strip=True,
        )

        lines = [
            clean(line)
            for line in text.splitlines()
        ]

        lines = [
            line
            for line in lines
            if line
        ]

        for index, line in enumerate(
            lines[:50],
            start=1,
        ):

            print(
                f"{index:03}: {line}"
            )

    print()
    print("=" * 70)
    print("DONE")
    print("=" * 70)

    print()
    print(
        "Saved HTML:"
    )

    print(
        OUTPUT_FILE
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


if __name__ == "__main__":
    main()