
import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY", "").strip()

if not api_key:
    print("ERROR: .env file mein GEMINI_API_KEY nahi mili.")
    raise SystemExit(1)

try:
    client = genai.Client(api_key=api_key)

    print("\nChecking models available to your API key...\n")

    count = 0

    for model in client.models.list():
        supported_actions = getattr(model, "supported_actions", []) or []

        if "generateContent" in supported_actions:
            name = getattr(model, "name", "")
            print(f"Available: {name}")
            count += 1

    print(f"\nTotal models supporting generateContent: {count}")

except Exception as e:
    print("\nCould not retrieve models.")
    print("Error:", str(e))
