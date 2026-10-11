from __future__ import annotations

import csv
import io
import re
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup


BLOG_URL = (
    "https://jennysonline.blogspot.com/"
    "2021/09/load-testing.html"
)

OUTPUT_DIR = (
    Path(__file__).resolve().parent
    / "inspected_sources"
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Safari/537.36"
)


def main() -> None:

    OUTPUT_DIR.mkdir(
        exist_ok=True
    )

    print("=" * 70)
    print("EMBEDDED SOURCE INSPECTOR")
    print("=" * 70)

    # --------------------------------------------------------
    # STEP 1: Download Jenny's page
    # --------------------------------------------------------

    print()
    print("Downloading Blogspot page...")

    response = requests.get(
        BLOG_URL,
        headers={
            "User-Agent": USER_AGENT
        },
        timeout=30,
    )

    response.raise_for_status()

    print(
        f"Blogspot status: {response.status_code}"
    )

    soup = BeautifulSoup(
        response.text,
        "lxml",
    )

    # --------------------------------------------------------
    # STEP 2: Find iframe
    # --------------------------------------------------------

    iframe = soup.find(
        "iframe"
    )

    if iframe is None:

        print()
        print(
            "No iframe was found."
        )

        return

    iframe_url = iframe.get(
        "src"
    )

    if not iframe_url:

        print()
        print(
            "Iframe does not contain a src URL."
        )

        return

    iframe_url = urljoin(
        BLOG_URL,
        iframe_url,
    )

    print()
    print("Embedded source:")
    print(iframe_url)

    # --------------------------------------------------------
    # STEP 3: Download iframe
    # --------------------------------------------------------

    print()
    print("Downloading embedded source...")

    embedded_response = requests.get(
        iframe_url,
        headers={
            "User-Agent": USER_AGENT
        },
        timeout=30,
    )

    embedded_response.raise_for_status()

    print(
        "Embedded status:",
        embedded_response.status_code,
    )

    print(
        "Embedded content type:",
        embedded_response.headers.get(
            "content-type"
        ),
    )

    print(
        "Embedded HTML size:",
        len(
            embedded_response.text
        ),
    )

    # Save the embedded HTML.
    embedded_file = (
        OUTPUT_DIR
        / "embedded_source.html"
    )

    embedded_file.write_text(
        embedded_response.text,
        encoding="utf-8",
    )

    print(
        "Saved embedded HTML:"
    )

    print(
        embedded_file
    )

    # --------------------------------------------------------
    # STEP 4: Inspect HTML
    # --------------------------------------------------------

    embedded_soup = BeautifulSoup(
        embedded_response.text,
        "lxml",
    )

    title = (
        embedded_soup.title.get_text(
            " ",
            strip=True,
        )
        if embedded_soup.title
        else "No title"
    )

    print()
    print("Embedded title:")
    print(title)

    tables = embedded_soup.find_all(
        "table"
    )

    print()
    print(
        "HTML tables found:",
        len(tables),
    )

    # --------------------------------------------------------
    # STEP 5: Show table rows
    # --------------------------------------------------------

    for table_number, table in enumerate(
        tables,
        start=1,
    ):

        print()
        print(
            "=" * 70
        )

        print(
            f"TABLE #{table_number}"
        )

        print(
            "=" * 70
        )

        rows = table.find_all(
            "tr"
        )

        print(
            f"Rows: {len(rows)}"
        )

        for row_number, row in enumerate(
            rows[:20],
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
                    f"{row_number:03}:",
                    values,
                )

    # --------------------------------------------------------
    # STEP 6: Try published CSV
    # --------------------------------------------------------

    csv_url = build_csv_url(
        iframe_url
    )

    print()
    print("=" * 70)
    print("PUBLISHED CSV TEST")
    print("=" * 70)

    print()
    print("CSV URL:")
    print(csv_url)

    try:

        csv_response = requests.get(
            csv_url,
            headers={
                "User-Agent":
                    USER_AGENT
            },
            timeout=30,
        )

        print()
        print(
            "CSV status:",
            csv_response.status_code,
        )

        print(
            "CSV content type:",
            csv_response.headers.get(
                "content-type"
            ),
        )

        print(
            "CSV size:",
            len(csv_response.content),
        )

        if csv_response.ok:

            csv_file = (
                OUTPUT_DIR
                / "embedded_source.csv"
            )

            csv_file.write_bytes(
                csv_response.content
            )

            print()
            print(
                "CSV saved:"
            )

            print(
                csv_file
            )

            inspect_csv(
                csv_response.text
            )

    except requests.RequestException as error:

        print()
        print(
            "CSV request failed:"
        )

        print(
            error
        )

    print()
    print("=" * 70)
    print("INSPECTION COMPLETE")
    print("=" * 70)


def build_csv_url(
    published_url: str,
) -> str:

    # Google Sheets published HTML:
    #
    # /pubhtml?widget=true&headers=false
    #
    # becomes:
    #
    # /pub?output=csv

    if "/pubhtml" in published_url:

        base_url = published_url.split(
            "/pubhtml",
            1,
        )[0]

        return (
            base_url
            + "/pub?output=csv"
        )

    if "/pub?" in published_url:

        base_url = published_url.split(
            "/pub?",
            1,
        )[0]

        return (
            base_url
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


def inspect_csv(
    csv_text: str,
) -> None:

    print()
    print("=" * 70)
    print("CSV PREVIEW")
    print("=" * 70)

    reader = csv.reader(
        io.StringIO(
            csv_text
        )
    )

    for index, row in enumerate(
        reader,
        start=1,
    ):

        if not row:
            continue

        cleaned = [
            clean(value)
            for value in row
        ]

        print(
            f"{index:03}:",
            cleaned,
        )

        if index >= 30:
            break


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