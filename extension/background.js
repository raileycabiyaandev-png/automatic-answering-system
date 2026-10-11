// extension/background.js
"use strict";

// URL of your local FastAPI backend.
const API_BASE = "http://127.0.0.1:8000";


chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {

        if (message?.type === "GET_SUBJECTS") {
            getSubjects()
                .then((subjects) => {
                    sendResponse({
                        ok: true,
                        subjects
                    });
                })
                .catch((error) => {
                    sendResponse({
                        ok: false,
                        error: error.message
                    });
                });

            return true;
        }

        if (message?.type === "MATCH_QUESTION") {
            matchQuestion(message.payload)
                .then((result) => {
                    sendResponse({
                        ok: true,
                        result
                    });
                })
                .catch((error) => {
                    sendResponse({
                        ok: false,
                        error: error.message
                    });
                });

            return true;
        }

        // Request an AI-generated study suggestion (ONE question).
        if (message?.type === "STUDY_HELP") {
            getStudyHelp(message.payload)
                .then((result) => {
                    sendResponse({
                        ok: true,
                        result
                    });
                })
                .catch((error) => {
                    sendResponse({
                        ok: false,
                        error: error.message
                    });
                });

            return true;
        }

        // NEW: request AI suggestions for MANY questions at once.
        if (message?.type === "STUDY_HELP_BATCH") {
            getStudyHelpBatch(message.payload)
                .then((result) => {
                    sendResponse({
                        ok: true,
                        result
                    });
                })
                .catch((error) => {
                    sendResponse({
                        ok: false,
                        error: error.message
                    });
                });

            return true;
        }

        if (message?.type === "PING_BACKEND") {
            requestJson("/health")
                .then((data) => {
                    sendResponse({
                        ok: true,
                        data
                    });
                })
                .catch((error) => {
                    sendResponse({
                        ok: false,
                        error: error.message
                    });
                });

            return true;
        }

        // Kept for compatibility. The extension no longer uses
        // a saved "enabled" flag to start itself.
        if (message?.type === "SET_ENABLED") {
            chrome.storage.local.set(
                {
                    enabled: Boolean(message.enabled),
                    subject: message.subject || ""
                },
                () => {
                    const error = chrome.runtime.lastError;

                    sendResponse(
                        error
                            ? {
                                ok: false,
                                error: error.message
                            }
                            : { ok: true }
                    );
                }
            );

            return true;
        }

        return false;
    }
);


async function requestJson(path, options = {}) {
    const response = await fetch(
        `${API_BASE}${path}`,
        options
    );

    if (!response.ok) {
        const body = await response.text();

        let detail = body;

        try {
            const parsed = JSON.parse(body);
            detail = parsed.detail || body;
        } catch {
            // Keep the original response text.
        }

        throw new Error(
            `Request failed (${response.status}): ${String(detail).slice(0, 400)}`
        );
    }

    return response.json();
}


async function getSubjects() {
    return requestJson("/subjects");
}


async function matchQuestion(payload) {
    return requestJson("/match", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });
}


function cleanChoices(choices) {
    return Array.isArray(choices)
        ? choices
            .filter((choice) => typeof choice === "string")
            .slice(0, 20)
        : [];
}


// Call the Gemini backup endpoint (one question).
async function getStudyHelp(payload) {
    if (
        !payload ||
        typeof payload.subject !== "string" ||
        typeof payload.question !== "string"
    ) {
        throw new Error(
            "The subject or question is missing."
        );
    }

    return requestJson("/study-help", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            subject: payload.subject,
            question: payload.question,
            choices: cleanChoices(payload.choices)
        })
    });
}


// Call the Gemini backup endpoint (many questions, one request).
async function getStudyHelpBatch(payload) {
    if (
        !payload ||
        typeof payload.subject !== "string" ||
        !Array.isArray(payload.items) ||
        payload.items.length === 0
    ) {
        throw new Error(
            "The subject or the questions are missing."
        );
    }

    const items = payload.items
        .filter((item) =>
            item &&
            Number.isInteger(item.id) &&
            typeof item.question === "string"
        )
        .slice(0, 40)
        .map((item) => ({
            id: item.id,
            question: item.question,
            choices: cleanChoices(item.choices)
        }));

    return requestJson("/study-help-batch", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            subject: payload.subject,
            items
        })
    });
}