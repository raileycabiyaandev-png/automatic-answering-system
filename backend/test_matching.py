from __future__ import annotations

import json
import requests


API_URL = "http://127.0.0.1:8000"


TESTS = [
    {
        "name": "Direct question",
        "subject": "Load Testing",
        "question": "What is load testing?",
        "choices": [],
        "expected_answer": "Load testing",
        "should_match": True,
    },
    {
        "name": "Definition",
        "subject": "Load Testing",
        "question": (
            "This is a type of performance testing "
            "conducted to evaluate the behavior of a "
            "system at increasing workload."
        ),
        "choices": [],
        "expected_answer": "Load Testing",
        "should_match": True,
    },
    {
        "name": "Software Engineering",
        "subject": "Software Engineering 1",
        "question": "What is software engineering?",
        "choices": [],
        "expected_answer": "Software engineering",
        "should_match": True,
    },
    {
        "name": "Cloud Computing",
        "subject": "Cloud Computing and Internet of Things",
        "question": "What is cloud computing?",
        "choices": [],
        "expected_answer": "cloud computing",
        "should_match": True,
    },
    {
        "name": "Multiple Choice",
        "subject": "Load Testing",
        "question": "What is load testing?",
        "choices": [
            "A. Security Testing",
            "B. Load Testing",
            "C. Unit Testing",
            "D. Stress Testing",
        ],
        "expected_answer": "Load testing",
        "expected_choice": "B",
        "should_match": True,
    },
    {
        "name": "Unknown Question",
        "subject": "Load Testing",
        "question": "What is database normalization?",
        "choices": [],
        "expected_answer": None,
        "should_match": False,
    },
]


def main() -> None:

    print("=" * 70)
    print("MATCHING ENGINE FINAL TEST")
    print("=" * 70)

    passed = 0
    failed = 0

    for number, test in enumerate(
        TESTS,
        start=1,
    ):

        print()
        print("-" * 70)
        print(f"TEST #{number}: {test['name']}")
        print("-" * 70)

        print(
            "Subject:",
            test["subject"],
        )

        print(
            "Question:",
            test["question"],
        )

        try:

            response = requests.post(
                f"{API_URL}/match",
                json={
                    "subject": test["subject"],
                    "question": test["question"],
                    "choices": test["choices"],
                },
                timeout=10,
            )

            response.raise_for_status()

            result = response.json()

            print(
                "\nResult:"
            )

            print(
                json.dumps(
                    result,
                    indent=2,
                )
            )

            test_passed = True

            # ------------------------------------------------
            # Check whether match/no-match is correct.
            # ------------------------------------------------

            if (
                result["matched"]
                != test["should_match"]
            ):

                test_passed = False

                print(
                    "\nFAIL:"
                    " Unexpected matched value."
                )

            # ------------------------------------------------
            # Check expected answer.
            # ------------------------------------------------

            expected_answer = (
                test["expected_answer"]
            )

            actual_answer = (
                result["answer"]
            )

            if expected_answer:

                if (
                    actual_answer is None
                    or actual_answer.lower()
                    != expected_answer.lower()
                ):

                    test_passed = False

                    print(
                        "\nFAIL:"
                        " Wrong answer."
                    )

            # ------------------------------------------------
            # Check expected multiple-choice option.
            # ------------------------------------------------

            expected_choice = (
                test.get(
                    "expected_choice"
                )
            )

            if expected_choice:

                actual_choice = (
                    result["choice_label"]
                )

                if (
                    actual_choice
                    != expected_choice
                ):

                    test_passed = False

                    print(
                        "\nFAIL:"
                        " Wrong choice."
                    )

            # ------------------------------------------------
            # Final test result.
            # ------------------------------------------------

            if test_passed:

                passed += 1

                print(
                    "\nPASS"
                )

            else:

                failed += 1

                print(
                    "\nFAIL"
                )

        except requests.RequestException as error:

            failed += 1

            print(
                "\nREQUEST ERROR:",
                error,
            )

    print()
    print("=" * 70)

    print(
        f"PASSED: {passed}"
    )

    print(
        f"FAILED: {failed}"
    )

    print("=" * 70)

    if failed == 0:

        print(
            "ALL MATCHING TESTS PASSED."
        )

    else:

        print(
            "SOME MATCHING TESTS FAILED."
        )


if __name__ == "__main__":
    main()