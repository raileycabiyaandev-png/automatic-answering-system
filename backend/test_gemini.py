
import os
from google import genai


def main():
    if not os.getenv("GEMINI_API_KEY"):
        print("ERROR: GEMINI_API_KEY is missing.")
        return

    try:
        client = genai.Client()

        response = client.models.generate_content(
            model="gemini-3.8-flash",
            contents=(
                "Answer in one to five words only: "
                "What is software engineering?"
            ),
        )

        answer = (response.text or "").strip()

        if not answer:
            print("ERROR: Gemini returned an empty answer.")
            return

        print("SUCCESS: Gemini connection works.")
        print("Answer:", answer)

    except Exception as error:
        print("Gemini request failed.")
        print("Error type:", type(error).__name__)
        print("Check the API key, internet connection, "
              "model access, and usage limits.")


if __name__ == "__main__":
    main()