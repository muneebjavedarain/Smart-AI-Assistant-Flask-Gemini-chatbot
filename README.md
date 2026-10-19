# Smart AI Assistant

A multi-user AI chatbot built with **Flask** and the **Google Gemini API**. It streams answers in real time, can answer questions about uploaded PDFs, supports Urdu / Roman Urdu with voice input and output, and ships with switchable assistant roles.

## Features

- Real-time token streaming (Server-Sent Events) with a **Stop** button
- **Regenerate** the last answer and **edit** any earlier message
- **Assistant roles** (system prompts): general, customer support, tutor, sales, programming mentor
- **PDF / TXT Q&A**: upload a document and ask questions (BM25 retrieval over text chunks)
- **User accounts** (Flask-Login, hashed passwords); every user sees only their own chats
- **Rate limiting** (Flask-Limiter) and input validation
- Automatic **multi-model fallback** when a model is unavailable or over quota
- SQLite chat history, **rename / delete** conversations, export to TXT or Markdown
- Markdown rendering, syntax highlighting, copy-code buttons
- **Dark / light mode**
- **Urdu / RTL** text support (`dir="auto"`)
- **Voice input and read-aloud** (Web Speech API, Chrome or Edge)

## Tech stack

Python, Flask, Flask-Login, Flask-Limiter, SQLite, Google Gemini (`google-genai`), pypdf, vanilla JavaScript.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
copy .env.example .env        # then edit .env and add your keys
python app.py
```

Open http://127.0.0.1:5000 and create an account.

Run `python check_models.py` to list the Gemini models your key can use, then put them in `GEMINI_MODELS`.

## Notes

- The first account created takes ownership of any chats made before login existed.
- Voice input needs Chrome or Edge and works on `localhost` or HTTPS.
- Scanned (image-only) PDFs are not supported because no OCR is included.

## Screenshots

Add screenshots or a short GIF here.
