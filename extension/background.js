// extension/background.js
"use strict";

// URL of your FastAPI backend (hosted on Render).
const API_BASE = "https://automatic-answering-system.onrender.com";

// Render's free plan puts the server to sleep. The first request
// after a sleep can take about a minute. Chrome stops an extension
// background script when ONE web request takes longer than 30
// seconds, so each try waits at most 25 seconds and then tries
// again. The server keeps waking up between the tries.
const REQUEST_TIMEOUT_MS = 25000;
const MAX_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);


chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {

        if (message?.type === "GET_SUBJECTS") {
            reply(getSubjects(), "subjects", sendResponse);
            return true;
        }

        if (message?.type === "MATCH_QUESTION") {
            reply(matchQuestion(message.payload), "result", sendResponse);
            return true;
        }

        // Request an AI-generated study suggestion (ONE question).
        if (message?.type === "STUDY_HELP") {
            reply(getStudyHelp(message.payload), "result", sendResponse);
            return true;
        }

        // Request AI suggestions for MANY questions at once.
        if (message?.type === "STUDY_HELP_BATCH") {
            reply(getStudyHelpBatch(message.payload), "result", sendResponse);
            return true;
        }

        if (message?.type === "PING_BACKEND") {
            reply(requestJson("/health"), "data", sendResponse);
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


// Sends { ok: true, [key]: value } or { ok: false, error }.
function reply(promise, key, sendResponse) {
    promise
        .then((value) => {
            sendResponse({
                ok: true,
                [key]: value
            });
        })
        .catch((error) => {
            sendResponse({
                ok: false,
                error: error?.message || String(error)
            });
        });
}


function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


async function buildHttpError(response) {
    const body = await response.text();

    let detail = body;

    try {
        const parsed = JSON.parse(body);
        detail = parsed.detail || body;

        if (typeof detail !== "string") {
            detail = JSON.stringify(detail);
        }
    } catch {
        // Keep the original response text.
    }

    const error = new Error(
        `Request failed (${response.status}): ${String(detail).slice(0, 400)}`
    );

    error.status = response.status;

    return error;
}


// Calls the backend. Tries up to 4 times when the server is
// waking up, busy, or the network drops for a moment.
async function requestJson(path, options = {}) {
    // Keeps Chrome from stopping this background script while we
    // wait for a slow server.
    const keepAlive = setInterval(() => {
        try {
            chrome.runtime.getPlatformInfo(() => {});
        } catch {
            // Not important.
        }
    }, 20000);

    let lastError = null;

    try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const controller = new AbortController();

            const timer = setTimeout(
                () => controller.abort(),
                REQUEST_TIMEOUT_MS
            );

            try {
                const response = await fetch(
                    `${API_BASE}${path}`,
                    {
                        ...options,
                        signal: controller.signal
                    }
                );

                if (response.ok) {
                    return await response.json();
                }

                throw await buildHttpError(response);

            } catch (error) {
                const timedOut = error?.name === "AbortError";

                lastError = timedOut
                    ? new Error(
                        "The backend is slow to respond. " +
                        "It may still be waking up."
                    )
                    : error;

                // TypeError = network problem ("Failed to fetch").
                const retryable =
                    timedOut ||
                    error instanceof TypeError ||
                    RETRYABLE_STATUS.has(error?.status);

                if (!retryable || attempt === MAX_ATTEMPTS) {
                    throw lastError;
                }

                await sleep(1000 * attempt);

            } finally {
                clearTimeout(timer);
            }
        }
    } finally {
        clearInterval(keepAlive);
    }

    throw lastError || new Error("Request failed.");
}


async function getSubjects() {
    return requestJson("/subjects");
}


function cleanChoices(choices) {
    return Array.isArray(choices)
        ? choices
            .filter((choice) => typeof choice === "string")
            .slice(0, 20)
        : [];
}


async function matchQuestion(payload) {
    if (
        !payload ||
        typeof payload.subject !== "string" ||
        typeof payload.question !== "string"
    ) {
        throw new Error(
            "The subject or question is missing."
        );
    }

    return requestJson("/match", {
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

    if (items.length === 0) {
        throw new Error(
            "None of the questions could be sent."
        );
    }

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