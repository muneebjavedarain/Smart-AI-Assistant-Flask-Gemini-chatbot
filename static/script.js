const $ = (id) => document.getElementById(id);

const chatForm = $("chatForm");
const messageInput = $("messageInput");
const messages = $("messages");
const welcomeScreen = $("welcomeScreen");
const sendBtn = $("sendBtn");
const newChatBtn = $("newChatBtn");
const personaSelect = $("personaSelect");
const docBar = $("docBar");
const fileInput = $("fileInput");
const attachBtn = $("attachBtn");
const micBtn = $("micBtn");
const voiceLang = $("voiceLang");
const themeBtn = $("themeBtn");
const autoReadBtn = $("autoReadBtn");
const logoutBtn = $("logoutBtn");
const editBanner = $("editBanner");
const sidebarSection = document.querySelector(".sidebar-section");

const JSON_HEADERS = { "Content-Type": "application/json" };

let isSending = false;
let currentController = null;
let currentConversationId = null;
let conversationList = [];
let markdownReady = false;
let editingEl = null;
let autoRead = false;

// ---------------- HELPERS ----------------

async function api(url, options = {}) {
    const response = await fetch(url, options);
    let data = {};

    try {
        data = await response.json();
    } catch (_) {
        // Response had no JSON body.
    }

    if (response.status === 401) {
        window.location.href = "/login";
        throw new Error("Please log in.");
    }

    if (!response.ok) {
        throw new Error(data.error || "Request failed.");
    }

    return data;
}

function toast(text) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

function autoResize() {
    messageInput.style.height = "auto";
    messageInput.style.height =
        Math.min(messageInput.scrollHeight, 150) + "px";
}

function scrollToBottom() {
    const chatArea = $("chatArea");

    if (chatArea) {
        chatArea.scrollTo({
            top: chatArea.scrollHeight,
            behavior: "smooth"
        });
    }
}

// ---------------- THEME ----------------

function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    themeBtn.textContent = theme === "dark" ? "\u2600" : "\u263E";

    try {
        localStorage.setItem("theme", theme);
    } catch (_) {
        // Storage may be blocked; ignore.
    }
}

applyTheme(document.documentElement.getAttribute("data-theme") || "light");

themeBtn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
});

// ---------------- MARKDOWN LIBRARIES ----------------

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.async = true;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

function loadStylesheet(href) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
}

async function loadMarkdownLibraries() {
    try {
        loadStylesheet(
            "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css"
        );

        await loadScript(
            "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"
        );
        await loadScript(
            "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.6/purify.min.js"
        );
        await loadScript(
            "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"
        );

        if (window.marked && window.DOMPurify && window.hljs) {
            window.marked.setOptions({ gfm: true, breaks: true });
            markdownReady = true;
        }
    } catch (error) {
        console.warn("Markdown libraries could not load.", error);
    }
}

// ---------------- SIDEBAR HISTORY ELEMENTS ----------------

const historyHeading = document.createElement("p");
historyHeading.className = "section-label history-heading";
historyHeading.textContent = "CHAT HISTORY";

const historyList = document.createElement("div");
historyList.id = "historyList";
historyList.className = "history-list";

if (sidebarSection) {
    sidebarSection.insertAdjacentElement("afterend", historyHeading);
    historyHeading.insertAdjacentElement("afterend", historyList);
}

// ---------------- MARKDOWN RENDERING ----------------

function renderAssistantContent(content, text) {
    content.dataset.rawText = text;
    content.setAttribute("dir", "auto");

    if (!markdownReady) {
        content.textContent = text;
        return;
    }

    try {
        const html = window.marked.parse(text);

        content.innerHTML = window.DOMPurify.sanitize(html, {
            USE_PROFILES: { html: true }
        });

        // Each block gets its own direction (Urdu paragraph next to English code).
        content
            .querySelectorAll("p, li, h1, h2, h3, h4, blockquote, ul, ol")
            .forEach((el) => el.setAttribute("dir", "auto"));

        content.querySelectorAll("pre").forEach((pre) => {
            const code = pre.querySelector("code");

            if (code && window.hljs && !code.dataset.highlighted) {
                window.hljs.highlightElement(code);
            }

            if (pre.querySelector(".copy-code-btn")) {
                return;
            }

            const copyButton = document.createElement("button");
            copyButton.type = "button";
            copyButton.className = "copy-code-btn";
            copyButton.textContent = "Copy code";

            copyButton.addEventListener("click", async () => {
                const codeText = code ? code.textContent : pre.textContent;

                try {
                    await navigator.clipboard.writeText(codeText);
                    copyButton.textContent = "Copied!";
                } catch (_) {
                    copyButton.textContent = "Copy failed";
                }

                setTimeout(() => {
                    copyButton.textContent = "Copy code";
                }, 1500);
            });

            pre.appendChild(copyButton);
        });
    } catch (error) {
        console.error("Markdown rendering error:", error);
        content.textContent = text;
    }
}

// ---------------- VOICE OUTPUT ----------------

function cleanForSpeech(text) {
    return text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/[#*_>~]/g, "")
        .trim();
}

function stopSpeaking() {
    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }
}

function speak(text) {
    if (!("speechSynthesis" in window)) {
        toast("Voice output is not supported in this browser.");
        return;
    }

    const clean = cleanForSpeech(text);

    if (!clean) {
        return;
    }

    window.speechSynthesis.cancel();

    const hasUrduScript = /[\u0600-\u06FF]/.test(clean);
    const lang = hasUrduScript
        ? "ur-PK"
        : (voiceLang.value.startsWith("en") ? voiceLang.value : "en-US");

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = lang;

    const voice = window.speechSynthesis
        .getVoices()
        .find((item) => item.lang.toLowerCase().startsWith(lang.slice(0, 2)));

    if (voice) {
        utterance.voice = voice;
    }

    window.speechSynthesis.speak(utterance);
}

function setAutoRead(value) {
    autoRead = value;
    autoReadBtn.classList.toggle("active", autoRead);

    try {
        localStorage.setItem("autoRead", autoRead ? "1" : "0");
    } catch (_) {
        // Ignore storage errors.
    }

    if (!autoRead) {
        stopSpeaking();
    }
}

try {
    setAutoRead(localStorage.getItem("autoRead") === "1");
} catch (_) {
    setAutoRead(false);
}

autoReadBtn.addEventListener("click", () => setAutoRead(!autoRead));

// ---------------- MESSAGES ----------------

function actionButton(label, title, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "msg-action";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", handler);
    return button;
}

function buildActions(sender, messageEl, content) {
    const actions = document.createElement("div");
    actions.className = "message-actions";

    if (sender === "assistant") {
        const copy = actionButton("Copy", "Copy answer", async () => {
            try {
                await navigator.clipboard.writeText(content.dataset.rawText || "");
                copy.textContent = "Copied";
            } catch (_) {
                copy.textContent = "Failed";
            }
            setTimeout(() => { copy.textContent = "Copy"; }, 1500);
        });

        const listen = actionButton("Listen", "Read aloud", () => {
            if (window.speechSynthesis && window.speechSynthesis.speaking) {
                stopSpeaking();
                return;
            }
            speak(content.dataset.rawText || "");
        });

        const regen = actionButton("Regenerate", "Generate a new answer", regenerate);
        regen.classList.add("regen");

        actions.append(copy, listen, regen);
    } else {
        actions.append(
            actionButton("Edit", "Edit this message", () => startEdit(messageEl))
        );
    }

    return actions;
}

function addMessage(text, sender, id) {
    const message = document.createElement("div");
    message.className = `message ${sender}`;

    if (id) {
        message.dataset.id = id;
    }

    if (sender === "assistant") {
        const avatar = document.createElement("div");
        avatar.className = "message-avatar";
        avatar.textContent = "\u2726";
        message.appendChild(avatar);
    }

    const body = document.createElement("div");
    body.className = "message-body";

    const content = document.createElement("div");
    content.className = "message-content";

    if (sender === "assistant") {
        content.classList.add("markdown-content");
        renderAssistantContent(content, text);
    } else {
        content.textContent = text;
        content.dataset.rawText = text;
        content.setAttribute("dir", "auto");
    }

    body.append(content, buildActions(sender, message, content));
    message.appendChild(body);
    messages.appendChild(message);

    scrollToBottom();

    return { message, content };
}

function showTyping() {
    const typing = document.createElement("div");
    typing.className = "typing";
    typing.setAttribute("role", "status");
    typing.textContent = "\u2726 Smart AI is thinking";
    messages.appendChild(typing);
    scrollToBottom();
    return typing;
}

function showWelcome() {
    welcomeScreen.style.display = "";
    messages.replaceChildren();
}

function hideWelcome() {
    welcomeScreen.style.display = "none";
}

// ---------------- EDIT / REGENERATE ----------------

function clearEdit() {
    editingEl = null;
    editBanner.hidden = true;
}

function startEdit(messageEl) {
    if (isSending) {
        return;
    }

    const content = messageEl.querySelector(".message-content");

    editingEl = messageEl;
    editBanner.hidden = false;

    messageInput.value = content.dataset.rawText || "";
    autoResize();
    messageInput.focus();
}

$("cancelEditBtn").addEventListener("click", () => {
    clearEdit();
    messageInput.value = "";
    autoResize();
});

function regenerate() {
    if (isSending) {
        return;
    }

    const userMessages = messages.querySelectorAll(".message.user");
    const last = userMessages[userMessages.length - 1];

    if (!last) {
        return;
    }

    const text = last.querySelector(".message-content").dataset.rawText;

    sendMessage(text, {
        truncateFromId: last.dataset.id ? Number(last.dataset.id) : null,
        replaceFrom: last
    });
}

// ---------------- DOCUMENTS (PDF Q&A) ----------------

function renderDocs(docs) {
    docBar.replaceChildren();
    docBar.hidden = !docs || docs.length === 0;

    (docs || []).forEach((doc) => {
        const chip = document.createElement("div");
        chip.className = "doc-chip";

        const name = document.createElement("span");
        name.textContent = "\uD83D\uDCC4 " + doc.filename;
        name.title = doc.filename;

        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "\u00D7";
        remove.title = "Remove document";
        remove.setAttribute("aria-label", "Remove document");

        remove.addEventListener("click", async () => {
            try {
                const data = await api(`/api/documents/${doc.id}`, {
                    method: "DELETE"
                });
                renderDocs(data.documents);
            } catch (error) {
                toast(error.message);
            }
        });

        chip.append(name, remove);
        docBar.appendChild(chip);
    });
}

attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";

    if (!file) {
        return;
    }

    attachBtn.disabled = true;
    toast("Reading " + file.name + "...");

    try {
        await ensureConversation();

        const form = new FormData();
        form.append("file", file);

        const data = await api(
            `/api/conversations/${encodeURIComponent(currentConversationId)}/documents`,
            { method: "POST", body: form }
        );

        renderDocs(data.documents);
        toast("Document ready. Ask a question about it.");
    } catch (error) {
        toast(error.message);
    } finally {
        attachBtn.disabled = false;
    }
});

// ---------------- PERSONAS ----------------

async function loadPersonas() {
    try {
        const data = await api("/api/personas");

        personaSelect.replaceChildren();

        data.personas.forEach((persona) => {
            const option = document.createElement("option");
            option.value = persona.id;
            option.textContent = persona.label;
            personaSelect.appendChild(option);
        });
    } catch (error) {
        console.error(error);
    }
}

personaSelect.addEventListener("change", async () => {
    if (!currentConversationId) {
        return;
    }

    try {
        await api(
            `/api/conversations/${encodeURIComponent(currentConversationId)}`,
            {
                method: "PATCH",
                headers: JSON_HEADERS,
                body: JSON.stringify({ persona: personaSelect.value })
            }
        );

        toast("Role changed: " + personaSelect.selectedOptions[0].textContent);
    } catch (error) {
        toast(error.message);
    }
});

// ---------------- HISTORY SIDEBAR ----------------

function renderConversationList() {
    historyList.replaceChildren();

    if (conversationList.length === 0) {
        const empty = document.createElement("p");
        empty.className = "history-empty";
        empty.textContent = "No conversations yet";
        historyList.appendChild(empty);
        return;
    }

    conversationList.forEach((conversation) => {
        const item = document.createElement("div");
        item.className = "history-item";

        if (conversation.id === currentConversationId) {
            item.classList.add("active");
        }

        const title = conversation.title || "New conversation";

        const openButton = document.createElement("button");
        openButton.type = "button";
        openButton.className = "history-open";
        openButton.textContent = title;
        openButton.title = title;
        openButton.setAttribute("dir", "auto");
        openButton.addEventListener("click", () => openConversation(conversation.id));

        const renameButton = document.createElement("button");
        renameButton.type = "button";
        renameButton.className = "history-rename";
        renameButton.textContent = "\u270E";
        renameButton.title = "Rename conversation";
        renameButton.setAttribute("aria-label", "Rename conversation");
        renameButton.addEventListener("click", () => renameConversation(conversation));

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "history-delete";
        deleteButton.textContent = "\u00D7";
        deleteButton.title = "Delete conversation";
        deleteButton.setAttribute("aria-label", "Delete conversation");
        deleteButton.addEventListener("click", () => deleteConversation(conversation.id));

        item.append(openButton, renameButton, deleteButton);
        historyList.appendChild(item);
    });
}

async function refreshHistory() {
    try {
        const data = await api("/api/conversations");
        conversationList = data.conversations || [];
        renderConversationList();
    } catch (error) {
        console.error("History loading error:", error);
    }
}

async function renameConversation(conversation) {
    const input = window.prompt(
        "Rename conversation",
        conversation.title || ""
    );

    if (input === null || !input.trim()) {
        return;
    }

    try {
        await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, {
            method: "PATCH",
            headers: JSON_HEADERS,
            body: JSON.stringify({ title: input.trim() })
        });

        await refreshHistory();
    } catch (error) {
        toast(error.message);
    }
}

// ---------------- CONVERSATIONS ----------------

async function ensureConversation() {
    if (currentConversationId) {
        return;
    }

    const created = await api("/api/conversations", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ persona: personaSelect.value })
    });

    currentConversationId = created.id;
}

async function createNewConversation() {
    if (isSending) {
        return;
    }

    try {
        const data = await api("/api/conversations", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ persona: personaSelect.value })
        });

        currentConversationId = data.id;

        showWelcome();
        renderDocs([]);
        clearEdit();

        messageInput.value = "";
        autoResize();
        messageInput.focus();

        await refreshHistory();
    } catch (error) {
        toast(error.message || "Could not create a new conversation.");
    }
}

async function loadConversation(conversationId) {
    const data = await api(
        `/api/conversations/${encodeURIComponent(conversationId)}`
    );

    currentConversationId = conversationId;
    messages.replaceChildren();

    const items = data.messages || [];

    if (items.length === 0) {
        welcomeScreen.style.display = "";
    } else {
        welcomeScreen.style.display = "none";

        items.forEach((item) => {
            if (item.role === "user" || item.role === "assistant") {
                addMessage(item.content, item.role, item.id);
            }
        });
    }

    personaSelect.value = data.conversation.persona || "general";
    renderDocs(data.documents || []);
    clearEdit();

    messageInput.value = "";
    autoResize();

    renderConversationList();
}

async function openConversation(conversationId) {
    if (isSending) {
        return;
    }

    try {
        await loadConversation(conversationId);
        messageInput.focus();
    } catch (error) {
        toast(error.message || "Could not open conversation.");
    }
}

async function deleteConversation(conversationId) {
    if (isSending) {
        return;
    }

    const conversation = conversationList.find((c) => c.id === conversationId);
    const title = conversation?.title || "New conversation";

    if (!window.confirm(`Delete "${title}"?\n\nThis action cannot be undone.`)) {
        return;
    }

    try {
        await api(`/api/conversations/${encodeURIComponent(conversationId)}`, {
            method: "DELETE"
        });

        if (currentConversationId === conversationId) {
            currentConversationId = null;
            showWelcome();
            renderDocs([]);
            clearEdit();
            messageInput.value = "";
            autoResize();
        }

        await refreshHistory();

        if (conversationList.length === 0) {
            await createNewConversation();
        } else if (currentConversationId === null) {
            await openConversation(conversationList[0].id);
        } else {
            renderConversationList();
        }
    } catch (error) {
        toast(error.message || "Could not delete conversation.");
    }
}

// ---------------- STREAMING CHAT ----------------

function setSendingUI(sending) {
    // While sending, the send button becomes a Stop button.
    sendBtn.innerHTML = sending ? "&#9632;" : "&#8593;";
    sendBtn.classList.toggle("stop", sending);
    sendBtn.setAttribute(
        "aria-label",
        sending ? "Stop generating" : "Send message"
    );
    newChatBtn.disabled = sending;
}

async function sendMessage(text, options = {}) {
    const messageText = text.trim();

    if (!messageText || isSending) {
        return;
    }

    stopSpeaking();

    // Editing a previous message?
    if (editingEl) {
        options = {
            truncateFromId: editingEl.dataset.id
                ? Number(editingEl.dataset.id)
                : null,
            replaceFrom: editingEl
        };
        clearEdit();
    }

    try {
        await ensureConversation();
    } catch (error) {
        toast(error.message || "Could not create a conversation.");
        return;
    }

    // Remove the old message (and all after it) from the screen.
    if (options.replaceFrom) {
        let node = options.replaceFrom;

        while (node) {
            const next = node.nextElementSibling;
            node.remove();
            node = next;
        }
    }

    hideWelcome();

    const userEl = addMessage(messageText, "user").message;

    messageInput.value = "";
    autoResize();

    isSending = true;
    currentController = new AbortController();
    setSendingUI(true);

    const typingIndicator = showTyping();

    let assistantMessage = null;
    let receivedText = "";
    let streamError = null;
    let aborted = false;
    let completed = false;

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: JSON_HEADERS,
            signal: currentController.signal,
            body: JSON.stringify({
                message: messageText,
                conversation_id: currentConversationId,
                truncate_from_id: options.truncateFromId || null
            })
        });

        if (response.status === 401) {
            window.location.href = "/login";
            return;
        }

        if (!response.ok) {
            let errorMessage = "Something went wrong.";

            try {
                const data = await response.json();
                errorMessage = data.error || errorMessage;
            } catch (_) {
                // Keep default message.
            }

            throw new Error(errorMessage);
        }

        if (!response.body) {
            throw new Error("Streaming is not supported by this browser.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        function processEvent(eventText) {
            const line = eventText
                .split("\n")
                .find((item) => item.startsWith("data: "));

            if (!line) {
                return;
            }

            let event;

            try {
                event = JSON.parse(line.slice(6));
            } catch (_) {
                return;
            }

            if (event.type === "start") {
                if (event.conversation_id) {
                    currentConversationId = event.conversation_id;
                }
                if (event.user_message_id) {
                    userEl.dataset.id = event.user_message_id;
                }
            }

            if (event.type === "chunk") {
                if (!assistantMessage) {
                    typingIndicator.remove();
                    assistantMessage = addMessage("", "assistant");
                    assistantMessage.message.classList.add("streaming");
                }

                receivedText += event.text;
                renderAssistantContent(assistantMessage.content, receivedText);
                scrollToBottom();
            }

            if (event.type === "done") {
                completed = true;

                if (assistantMessage && event.assistant_message_id) {
                    assistantMessage.message.dataset.id =
                        event.assistant_message_id;
                }
            }

            if (event.type === "error") {
                streamError = event.message || "AI response failed.";
            }
        }

        while (true) {
            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            const events = buffer.split("\n\n");
            buffer = events.pop() || "";

            events.forEach(processEvent);
        }

        buffer += decoder.decode();

        if (buffer.trim()) {
            processEvent(buffer);
        }

        if (streamError) {
            if (receivedText && assistantMessage) {
                renderAssistantContent(
                    assistantMessage.content,
                    receivedText + "\n\n[Notice: " + streamError + "]"
                );
            } else {
                throw new Error(streamError);
            }
        } else if (!receivedText) {
            throw new Error("No response received. Please try again.");
        }
    } catch (error) {
        if (error.name === "AbortError") {
            aborted = true;
        } else if (assistantMessage && receivedText) {
            renderAssistantContent(
                assistantMessage.content,
                receivedText +
                "\n\n[Notice: " +
                (error.message || "Connection interrupted.") +
                "]"
            );
        } else {
            typingIndicator.remove();

            addMessage(
                error.message ||
                "Unable to connect to the AI. Please try again.",
                "assistant"
            );
        }
    } finally {
        typingIndicator.remove();

        if (assistantMessage) {
            assistantMessage.message.classList.remove("streaming");
        }

        isSending = false;
        currentController = null;
        setSendingUI(false);

        await refreshHistory();

        if (aborted) {
            // The server saved the partial answer; reload to get real ids.
            setTimeout(() => {
                if (!isSending && currentConversationId) {
                    loadConversation(currentConversationId).catch(() => {});
                }
            }, 700);
        } else if (completed && autoRead && receivedText) {
            speak(receivedText);
        }

        messageInput.focus();
    }
}

// ---------------- VOICE INPUT ----------------

const SpeechRecognitionAPI =
    window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let listening = false;

if (!SpeechRecognitionAPI) {
    micBtn.disabled = true;
    micBtn.title = "Voice input needs Chrome or Edge";
}

micBtn.addEventListener("click", () => {
    if (!SpeechRecognitionAPI) {
        return;
    }

    if (listening && recognition) {
        recognition.stop();
        return;
    }

    recognition = new SpeechRecognitionAPI();
    recognition.lang = voiceLang.value;
    recognition.interimResults = true;
    recognition.continuous = false;

    const base = messageInput.value ? messageInput.value.trimEnd() + " " : "";

    recognition.onstart = () => {
        listening = true;
        micBtn.classList.add("listening");
    };

    recognition.onresult = (event) => {
        let transcript = "";

        for (let i = 0; i < event.results.length; i++) {
            transcript += event.results[i][0].transcript;
        }

        messageInput.value = base + transcript;
        autoResize();
    };

    recognition.onerror = (event) => {
        if (event.error === "not-allowed") {
            toast("Microphone permission was denied.");
        } else if (event.error !== "aborted" && event.error !== "no-speech") {
            toast("Voice input error: " + event.error);
        }
    };

    recognition.onend = () => {
        listening = false;
        micBtn.classList.remove("listening");
        messageInput.focus();
    };

    recognition.start();
});

// ---------------- CHAT EXPORT: TXT AND MARKDOWN ----------------

function exportConversation(format) {
    const messageElements = messages.querySelectorAll(".message");

    if (messageElements.length === 0) {
        toast("There is no conversation to export yet.");
        return;
    }

    const isMarkdown = format === "md";
    const exportedMessages = [];

    messageElements.forEach((message) => {
        const content = message.querySelector(".message-content");

        if (!content) {
            return;
        }

        const role = message.classList.contains("user") ? "You" : "Smart AI";
        const rawText = (content.dataset.rawText ?? content.innerText).trim();

        if (!rawText) {
            return;
        }

        if (isMarkdown) {
            exportedMessages.push(`### ${role}\n\n${rawText}`);
        } else {
            const plainText = rawText
                .replace(/```[\w-]*\n?/g, "")
                .replace(/```/g, "")
                .replace(/^#{1,6}\s+/gm, "")
                .replace(/\*\*(.*?)\*\*/g, "$1")
                .replace(/__(.*?)__/g, "$1")
                .replace(/`([^`]+)`/g, "$1");

            exportedMessages.push(
                `${role}\n${"-".repeat(role.length)}\n\n${plainText}`
            );
        }
    });

    if (exportedMessages.length === 0) {
        toast("No message content found to export.");
        return;
    }

    const output = isMarkdown
        ? "# Smart AI Assistant Conversation\n\n" +
          exportedMessages.join("\n\n---\n\n") + "\n"
        : "SMART AI ASSISTANT CONVERSATION\n\n" +
          exportedMessages.join("\n\n==============================\n\n") + "\n";

    const blob = new Blob(["\uFEFF", output], {
        type: `${isMarkdown ? "text/markdown" : "text/plain"};charset=utf-8`
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `smart-ai-conversation.${isMarkdown ? "md" : "txt"}`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("exportTxtBtn").addEventListener("click", () => exportConversation("txt"));
$("exportMdBtn").addEventListener("click", () => exportConversation("md"));

// ---------------- LOGOUT ----------------

logoutBtn.addEventListener("click", async () => {
    try {
        await fetch("/api/logout", { method: "POST" });
    } finally {
        window.location.href = "/login";
    }
});

// ---------------- INPUT EVENTS ----------------

chatForm.addEventListener("submit", (event) => {
    event.preventDefault();

    // The send button turns into "Stop" while an answer is streaming.
    if (isSending) {
        if (currentController) {
            currentController.abort();
        }
        return;
    }

    sendMessage(messageInput.value);
});

messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();

        if (!isSending) {
            chatForm.requestSubmit();
        }
    }
});

messageInput.addEventListener("input", autoResize);

document.querySelectorAll(".suggestion-card").forEach((card) => {
    card.addEventListener("click", () => {
        const prompt = card.dataset.prompt;

        if (prompt) {
            sendMessage(prompt);
        }
    });
});

newChatBtn.addEventListener("click", createNewConversation);

// ---------------- STARTUP ----------------

async function initializeChat() {
    await Promise.all([loadMarkdownLibraries(), loadPersonas()]);
    await refreshHistory();

    if (conversationList.length > 0) {
        await openConversation(conversationList[0].id);
    } else {
        await createNewConversation();
    }
}

initializeChat();
