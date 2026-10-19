import json
import math
import os
import re
import sqlite3
import uuid
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone

from dotenv import load_dotenv
from flask import (
    Flask, Response, jsonify, redirect, render_template,
    request, stream_with_context, url_for
)
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_login import (
    LoginManager, UserMixin, current_user,
    login_required, login_user, logout_user
)
from google import genai
from google.genai import errors, types
from pypdf import PdfReader
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()

# ---------------- APP CONFIG ----------------

app = Flask(__name__)

app.config["SECRET_KEY"] = os.getenv("SECRET_KEY") or "dev-only-change-me"
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10 MB uploads
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

DEBUG = os.getenv("FLASK_DEBUG", "0") == "1"

API_KEY = os.getenv("GEMINI_API_KEY", "").strip()

MODEL_NAMES = [
    model.strip()
    for model in os.getenv(
        "GEMINI_MODELS",
        "gemini-3.8-flash,gemini-3.7-flash,"
        "gemini-3.6-flash,gemini-3.5-flash,gemini-2.5-flash"
    ).split(",")
    if model.strip()
]

client = genai.Client(api_key=API_KEY) if API_KEY else None

DATABASE = os.path.join(app.root_path, "smart_ai.db")

MAX_MESSAGE_LENGTH = 4000
MAX_DOCS_PER_CONVERSATION = 5
MAX_PDF_PAGES = 300
ALLOWED_UPLOAD_EXTENSIONS = {".pdf", ".txt"}

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,30}$")

# ---------------- PERSONAS (system instructions) ----------------

LANGUAGE_RULE = (
    "Always reply in the same language and script the user writes in "
    "(English, Urdu script, or Roman Urdu). Use Markdown when it helps."
)

PERSONAS = {
    "general": {
        "label": "General Assistant",
        "prompt": (
            "You are Smart AI, a helpful, accurate and friendly assistant. "
            "Be clear and concise."
        ),
    },
    "support": {
        "label": "Customer Support Agent",
        "prompt": (
            "You are a polite, patient customer support agent. Understand "
            "the customer's problem, ask for missing details, give clear "
            "step-by-step solutions, and stay calm and empathetic. If you "
            "do not know something, say so and suggest contacting a human "
            "agent instead of guessing."
        ),
    },
    "tutor": {
        "label": "Study Tutor",
        "prompt": (
            "You are an encouraging tutor. Explain concepts step by step "
            "using simple language and examples. Check understanding with "
            "a short question at the end when appropriate."
        ),
    },
    "sales": {
        "label": "Sales Assistant",
        "prompt": (
            "You are a friendly, honest sales assistant. Find out the "
            "customer's needs, recommend suitable options, explain "
            "benefits clearly, and handle objections respectfully without "
            "being pushy or making false claims."
        ),
    },
    "coder": {
        "label": "Programming Mentor",
        "prompt": (
            "You are a senior software engineer mentoring a developer. "
            "Give correct, practical code with short explanations, point "
            "out bugs and better practices, and keep answers focused."
        ),
    },
}


def system_prompt_for(persona_id):
    persona = PERSONAS.get(persona_id) or PERSONAS["general"]
    return f"{persona['prompt']}\n\n{LANGUAGE_RULE}"


# ---------------- DATABASE ----------------

@contextmanager
def db():
    conn = sqlite3.connect(DATABASE, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def column_exists(conn, table, column):
    return any(
        row["name"] == column
        for row in conn.execute(f"PRAGMA table_info({table})")
    )


def init_db():
    with db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                title TEXT NOT NULL,
                persona TEXT NOT NULL DEFAULT 'general',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id)
                    REFERENCES conversations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id)
                    REFERENCES conversations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER NOT NULL,
                conversation_id TEXT NOT NULL,
                page INTEGER NOT NULL,
                content TEXT NOT NULL,
                FOREIGN KEY (document_id)
                    REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conv
                ON messages(conversation_id, id);
            CREATE INDEX IF NOT EXISTS idx_chunks_conv
                ON chunks(conversation_id);
        """)

        # Upgrade an older database that was created before multi-user.
        if not column_exists(conn, "conversations", "user_id"):
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN user_id INTEGER"
            )
        if not column_exists(conn, "conversations", "persona"):
            conn.execute(
                "ALTER TABLE conversations "
                "ADD COLUMN persona TEXT NOT NULL DEFAULT 'general'"
            )


def now_iso():
    return datetime.now(timezone.utc).isoformat()


init_db()


# ---------------- AUTH SETUP ----------------

class User(UserMixin):
    def __init__(self, user_id, username):
        self.id = str(user_id)
        self.username = username


login_manager = LoginManager(app)


@login_manager.user_loader
def load_user(user_id):
    try:
        numeric_id = int(user_id)
    except (TypeError, ValueError):
        return None

    with db() as conn:
        row = conn.execute(
            "SELECT id, username FROM users WHERE id = ?", (numeric_id,)
        ).fetchone()

    return User(row["id"], row["username"]) if row else None


@login_manager.unauthorized_handler
def unauthorized():
    if request.path.startswith("/api/"):
        return jsonify({"error": "Please log in."}), 401
    return redirect(url_for("login_page"))


def uid():
    return int(current_user.id)


# ---------------- RATE LIMITING ----------------

def rate_key():
    if current_user.is_authenticated:
        return f"user:{current_user.id}"
    return get_remote_address()


limiter = Limiter(
    rate_key,
    app=app,
    default_limits=["120 per minute"],
    storage_uri="memory://",
)


@app.errorhandler(429)
def too_many_requests(_error):
    return jsonify({
        "error": "Too many requests. Please wait a moment and try again."
    }), 429


@app.errorhandler(413)
def too_large(_error):
    return jsonify({"error": "File is too large. Maximum 10 MB."}), 413


# ---------------- CONVERSATION HELPERS ----------------

def create_conversation(user_id, persona="general", title="New conversation"):
    if persona not in PERSONAS:
        persona = "general"

    conversation_id = str(uuid.uuid4())
    timestamp = now_iso()

    with db() as conn:
        conn.execute(
            """
            INSERT INTO conversations
                (id, user_id, title, persona, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (conversation_id, user_id, title, persona, timestamp, timestamp)
        )

    return conversation_id


def get_owned_conversation(conn, conversation_id):
    return conn.execute(
        "SELECT * FROM conversations WHERE id = ? AND user_id = ?",
        (conversation_id, uid())
    ).fetchone()


def save_message(conversation_id, role, content):
    if not content:
        return None

    timestamp = now_iso()

    with db() as conn:
        cursor = conn.execute(
            """
            INSERT INTO messages (conversation_id, role, content, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (conversation_id, role, content, timestamp)
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (timestamp, conversation_id)
        )
        return cursor.lastrowid


def update_conversation_title(conversation_id, message):
    title = " ".join(message.split())[:55] or "New conversation"

    with db() as conn:
        conn.execute(
            """
            UPDATE conversations SET title = ?
            WHERE id = ? AND title = 'New conversation'
            """,
            (title, conversation_id)
        )


def get_recent_messages(conversation_id, limit=20):
    with db() as conn:
        rows = conn.execute(
            """
            SELECT role, content FROM messages
            WHERE conversation_id = ?
            ORDER BY id DESC LIMIT ?
            """,
            (conversation_id, limit)
        ).fetchall()

    return list(reversed([dict(row) for row in rows]))


def documents_for(conn, conversation_id):
    rows = conn.execute(
        """
        SELECT id, filename, created_at FROM documents
        WHERE conversation_id = ? ORDER BY id
        """,
        (conversation_id,)
    ).fetchall()
    return [dict(row) for row in rows]


def send_event(event_type, **data):
    payload = {"type": event_type, **data}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


# ---------------- DOCUMENT Q&A (RAG with BM25) ----------------

STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "of", "to", "in", "and",
    "or", "for", "on", "with", "what", "how", "this", "that", "it", "me",
    "kya", "hai", "hain", "ka", "ki", "ke", "ko", "se", "mein", "men",
    "aur", "yeh", "ye", "wo", "woh", "is", "iss", "kaise", "batao",
}
TOKEN_RE = re.compile(r"\w+", re.UNICODE)


def tokenize(text):
    return [
        word for word in TOKEN_RE.findall(text.lower())
        if len(word) > 1 and word not in STOPWORDS
    ]


def chunk_text(text, size=900, overlap=150):
    text = re.sub(r"\s+", " ", text).strip()
    chunks = []
    start = 0

    while start < len(text):
        end = min(start + size, len(text))

        if end < len(text):
            cut = text.rfind(" ", start + size // 2, end)
            if cut > start:
                end = cut

        piece = text[start:end].strip()
        if len(piece) > 20:
            chunks.append(piece)

        if end >= len(text):
            break

        start = max(end - overlap, start + 1)

    return chunks


def extract_pages(file_storage, extension):
    if extension == ".txt":
        text = file_storage.read().decode("utf-8", errors="ignore")
        return [(1, text)]

    reader = PdfReader(file_storage.stream)

    if reader.is_encrypted:
        try:
            unlocked = reader.decrypt("")
        except Exception:
            unlocked = 0
        if not unlocked:
            raise ValueError("This PDF is password-protected.")

    pages = []
    for number, page in enumerate(reader.pages[:MAX_PDF_PAGES], start=1):
        pages.append((number, page.extract_text() or ""))
    return pages


def retrieve_excerpts(conversation_id, query, k=4):
    """Return the k most relevant chunks using BM25 keyword ranking."""
    with db() as conn:
        rows = conn.execute(
            """
            SELECT c.content, c.page, d.filename
            FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE c.conversation_id = ?
            ORDER BY c.id
            """,
            (conversation_id,)
        ).fetchall()

    if not rows:
        return []

    docs = [tokenize(row["content"]) for row in rows]
    query_terms = set(tokenize(query))
    total = len(docs)
    avg_len = (sum(len(d) for d in docs) / total) or 1

    doc_freq = Counter()
    for tokens in docs:
        doc_freq.update(set(tokens))

    k1, b = 1.5, 0.75
    scored = []

    for index, tokens in enumerate(docs):
        freq = Counter(tokens)
        length = len(tokens) or 1
        score = 0.0

        for term in query_terms:
            f = freq.get(term, 0)
            if not f:
                continue
            idf = math.log(
                1 + (total - doc_freq[term] + 0.5) / (doc_freq[term] + 0.5)
            )
            score += idf * (f * (k1 + 1)) / (
                f + k1 * (1 - b + b * length / avg_len)
            )

        scored.append((score, index))

    scored.sort(reverse=True)

    if scored[0][0] == 0:
        # Generic questions ("summarize this") -> use the document start.
        top = sorted(index for _, index in scored)[:k]
    else:
        top = [index for score, index in scored[:k] if score > 0]

    return [dict(rows[index]) for index in top]


def build_prompt(message, excerpts):
    if not excerpts:
        return message

    context = "\n\n".join(
        f"[{number}] ({item['filename']}, page {item['page']})\n"
        f"{item['content']}"
        for number, item in enumerate(excerpts, start=1)
    )

    return (
        "Use the document excerpts below to answer the question. If the "
        "answer is not in the excerpts, say so clearly instead of "
        "guessing. Mention the source number like [1] when you use it.\n\n"
        f"DOCUMENT EXCERPTS:\n{context}\n\n"
        f"QUESTION:\n{message}"
    )


# ---------------- PAGES ----------------

@app.route("/")
@login_required
def home():
    return render_template("index.html", username=current_user.username)


@app.route("/login")
def login_page():
    if current_user.is_authenticated:
        return redirect(url_for("home"))
    return render_template("auth.html")


# ---------------- AUTH API ----------------

@app.route("/api/register", methods=["POST"])
@limiter.limit("10 per hour", key_func=get_remote_address)
def api_register():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))

    if not USERNAME_RE.match(username):
        return jsonify({
            "error": "Username must be 3-30 characters: letters, numbers, "
                     "dot, dash or underscore."
        }), 400

    if not 8 <= len(password) <= 128:
        return jsonify({
            "error": "Password must be 8 to 128 characters."
        }), 400

    try:
        with db() as conn:
            is_first_user = conn.execute(
                "SELECT COUNT(*) FROM users"
            ).fetchone()[0] == 0

            cursor = conn.execute(
                """
                INSERT INTO users (username, password_hash, created_at)
                VALUES (?, ?, ?)
                """,
                (username, generate_password_hash(password), now_iso())
            )
            user_id = cursor.lastrowid

            # Chats created before login existed go to the first account.
            if is_first_user:
                conn.execute(
                    "UPDATE conversations SET user_id = ? "
                    "WHERE user_id IS NULL",
                    (user_id,)
                )
    except sqlite3.IntegrityError:
        return jsonify({"error": "This username is already taken."}), 409

    login_user(User(user_id, username), remember=True)
    return jsonify({"success": True}), 201


@app.route("/api/login", methods=["POST"])
@limiter.limit("10 per minute", key_func=get_remote_address)
def api_login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))

    with db() as conn:
        row = conn.execute(
            "SELECT id, username, password_hash FROM users "
            "WHERE username = ?",
            (username,)
        ).fetchone()

    if row is None or not check_password_hash(row["password_hash"], password):
        return jsonify({"error": "Invalid username or password."}), 401

    login_user(User(row["id"], row["username"]), remember=True)
    return jsonify({"success": True})


@app.route("/api/logout", methods=["POST"])
@login_required
def api_logout():
    logout_user()
    return jsonify({"success": True})


# ---------------- PERSONAS API ----------------

@app.route("/api/personas", methods=["GET"])
@login_required
def list_personas():
    return jsonify({
        "personas": [
            {"id": key, "label": value["label"]}
            for key, value in PERSONAS.items()
        ]
    })


# ---------------- CONVERSATION API ----------------

@app.route("/api/conversations", methods=["GET"])
@login_required
def list_conversations():
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, title, persona, created_at, updated_at
            FROM conversations WHERE user_id = ?
            ORDER BY updated_at DESC
            """,
            (uid(),)
        ).fetchall()

    return jsonify({"conversations": [dict(row) for row in rows]})


@app.route("/api/conversations", methods=["POST"])
@login_required
def new_conversation():
    data = request.get_json(silent=True) or {}
    persona = data.get("persona", "general")
    conversation_id = create_conversation(uid(), persona)

    return jsonify({
        "id": conversation_id,
        "title": "New conversation"
    }), 201


@app.route("/api/conversations/<conversation_id>", methods=["GET"])
@login_required
def get_conversation(conversation_id):
    with db() as conn:
        conversation = get_owned_conversation(conn, conversation_id)

        if conversation is None:
            return jsonify({"error": "Conversation not found."}), 404

        messages = conn.execute(
            """
            SELECT id, role, content, created_at FROM messages
            WHERE conversation_id = ? ORDER BY id ASC
            """,
            (conversation_id,)
        ).fetchall()

        documents = documents_for(conn, conversation_id)

    return jsonify({
        "conversation": dict(conversation),
        "messages": [dict(row) for row in messages],
        "documents": documents,
    })


@app.route("/api/conversations/<conversation_id>", methods=["PATCH"])
@login_required
def update_conversation(conversation_id):
    data = request.get_json(silent=True) or {}

    with db() as conn:
        if get_owned_conversation(conn, conversation_id) is None:
            return jsonify({"error": "Conversation not found."}), 404

        if "title" in data:
            title = " ".join(str(data["title"]).split())[:80]
            if not title:
                return jsonify({"error": "Title cannot be empty."}), 400
            conn.execute(
                "UPDATE conversations SET title = ? WHERE id = ?",
                (title, conversation_id)
            )

        if "persona" in data:
            if data["persona"] not in PERSONAS:
                return jsonify({"error": "Unknown persona."}), 400
            conn.execute(
                "UPDATE conversations SET persona = ? WHERE id = ?",
                (data["persona"], conversation_id)
            )

    return jsonify({"success": True})


@app.route("/api/conversations/<conversation_id>", methods=["DELETE"])
@login_required
def delete_conversation(conversation_id):
    with db() as conn:
        cursor = conn.execute(
            "DELETE FROM conversations WHERE id = ? AND user_id = ?",
            (conversation_id, uid())
        )

        if cursor.rowcount == 0:
            return jsonify({"error": "Conversation not found."}), 404

    return jsonify({"success": True})


# ---------------- DOCUMENT API ----------------

@app.route("/api/conversations/<conversation_id>/documents",
           methods=["POST"])
@login_required
@limiter.limit("15 per hour")
def upload_document(conversation_id):
    with db() as conn:
        if get_owned_conversation(conn, conversation_id) is None:
            return jsonify({"error": "Conversation not found."}), 404

        if len(documents_for(conn, conversation_id)) >= \
                MAX_DOCS_PER_CONVERSATION:
            return jsonify({
                "error": f"Maximum {MAX_DOCS_PER_CONVERSATION} documents "
                         "per conversation."
            }), 400

    file = request.files.get("file")

    if file is None or not file.filename:
        return jsonify({"error": "No file selected."}), 400

    filename = os.path.basename(file.filename)[:100]
    extension = os.path.splitext(filename)[1].lower()

    if extension not in ALLOWED_UPLOAD_EXTENSIONS:
        return jsonify({"error": "Only PDF and TXT files are supported."}), 400

    try:
        pages = extract_pages(file, extension)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception:
        app.logger.exception("Could not read uploaded file")
        return jsonify({"error": "Could not read this file."}), 400

    chunk_rows = []
    for page_number, text in pages:
        for piece in chunk_text(text):
            chunk_rows.append((page_number, piece))

    if not chunk_rows:
        return jsonify({
            "error": "No readable text found. Scanned PDFs (images) are "
                     "not supported."
        }), 400

    with db() as conn:
        cursor = conn.execute(
            """
            INSERT INTO documents
                (conversation_id, user_id, filename, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (conversation_id, uid(), filename, now_iso())
        )
        document_id = cursor.lastrowid

        conn.executemany(
            """
            INSERT INTO chunks (document_id, conversation_id, page, content)
            VALUES (?, ?, ?, ?)
            """,
            [
                (document_id, conversation_id, page, content)
                for page, content in chunk_rows
            ]
        )

        documents = documents_for(conn, conversation_id)

    return jsonify({"documents": documents}), 201


@app.route("/api/documents/<int:document_id>", methods=["DELETE"])
@login_required
def delete_document(document_id):
    with db() as conn:
        row = conn.execute(
            "SELECT conversation_id FROM documents "
            "WHERE id = ? AND user_id = ?",
            (document_id, uid())
        ).fetchone()

        if row is None:
            return jsonify({"error": "Document not found."}), 404

        conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))
        documents = documents_for(conn, row["conversation_id"])

    return jsonify({"documents": documents})


# ---------------- STREAMING CHAT API ----------------

@app.route("/api/chat", methods=["POST"])
@login_required
@limiter.limit("20 per minute; 400 per day")
def chat():
    if client is None:
        return jsonify({"error": "GEMINI_API_KEY is missing in .env"}), 500

    data = request.get_json(silent=True) or {}
    message = data.get("message", "")
    conversation_id = data.get("conversation_id")
    truncate_from_id = data.get("truncate_from_id")

    if not isinstance(message, str) or not message.strip():
        return jsonify({"error": "Please enter a message."}), 400

    message = message.strip()

    if len(message) > MAX_MESSAGE_LENGTH:
        return jsonify({
            "error": f"Message is too long. Maximum {MAX_MESSAGE_LENGTH} "
                     "characters."
        }), 400

    if conversation_id is None:
        conversation_id = create_conversation(
            uid(), data.get("persona", "general")
        )
        persona = data.get("persona", "general")
    else:
        if not isinstance(conversation_id, str):
            return jsonify({"error": "Conversation not found."}), 404

        with db() as conn:
            conversation = get_owned_conversation(conn, conversation_id)

        if conversation is None:
            return jsonify({"error": "Conversation not found."}), 404

        persona = conversation["persona"]

    # Edit / regenerate: remove that message and everything after it.
    if truncate_from_id is not None:
        try:
            truncate_from_id = int(truncate_from_id)
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid message id."}), 400

        with db() as conn:
            conn.execute(
                "DELETE FROM messages WHERE conversation_id = ? AND id >= ?",
                (conversation_id, truncate_from_id)
            )

    # Load earlier messages BEFORE saving the new one.
    previous_messages = get_recent_messages(conversation_id, limit=20)

    user_message_id = save_message(conversation_id, "user", message)
    update_conversation_title(conversation_id, message)

    excerpts = retrieve_excerpts(conversation_id, message)

    contents = [
        {
            "role": "user" if item["role"] == "user" else "model",
            "parts": [{"text": item["content"]}]
        }
        for item in previous_messages
    ]
    contents.append({
        "role": "user",
        "parts": [{"text": build_prompt(message, excerpts)}]
    })

    config = types.GenerateContentConfig(
        system_instruction=system_prompt_for(persona)
    )

    @stream_with_context
    def generate():
        yield send_event(
            "start",
            conversation_id=conversation_id,
            user_message_id=user_message_id
        )

        def interrupted(parts):
            partial = "".join(parts)
            if partial:
                save_message(conversation_id, "assistant", partial)
            return send_event(
                "error",
                message=(
                    "Connection interrupted while generating the answer. "
                    "Partial response was saved."
                ),
                conversation_id=conversation_id
            )

        for model_name in MODEL_NAMES:
            answer_parts = []

            try:
                app.logger.info("Trying streaming model: %s", model_name)

                stream = client.models.generate_content_stream(
                    model=model_name,
                    contents=contents,
                    config=config
                )

                for chunk in stream:
                    chunk_text_value = chunk.text or ""

                    if chunk_text_value:
                        answer_parts.append(chunk_text_value)
                        yield send_event(
                            "chunk",
                            text=chunk_text_value,
                            model=model_name
                        )

                answer = "".join(answer_parts)

                if not answer:
                    app.logger.warning("Model %s returned nothing", model_name)
                    continue

                assistant_id = save_message(
                    conversation_id, "assistant", answer
                )

                yield send_event(
                    "done",
                    model=model_name,
                    conversation_id=conversation_id,
                    assistant_message_id=assistant_id
                )
                return

            except GeneratorExit:
                # User pressed "Stop": keep what was generated so far.
                partial = "".join(answer_parts)
                if partial:
                    save_message(conversation_id, "assistant", partial)
                raise

            except errors.APIError as e:
                app.logger.warning(
                    "Model %s failed: %s %s", model_name, e.code, e.message
                )

                if answer_parts:
                    yield interrupted(answer_parts)
                    return

                if e.code not in (404, 429, 500, 502, 503, 504):
                    yield send_event(
                        "error",
                        message=(
                            f"Gemini API error ({e.code}). "
                            "Check your API key and permissions."
                        ),
                        conversation_id=conversation_id
                    )
                    return

            except Exception:
                app.logger.exception("Streaming error with %s", model_name)

                if answer_parts:
                    yield interrupted(answer_parts)
                    return

        yield send_event(
            "error",
            message=(
                "All configured models failed. "
                "Check model availability or quota."
            ),
            conversation_id=conversation_id
        )

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


if __name__ == "__main__":
    app.run(debug=DEBUG, threaded=True)
