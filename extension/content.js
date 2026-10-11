// extension/content.js
"use strict";
console.log(
    "[QAA DEBUG] content.js loaded:",
    window.location.href
);

let enabled = false;
let subject = "";

let lastQuestionKey = "";
let detectionTimer = null;
let observer = null;
let requestInProgress = false;

let autoAnswer = false;
let autoScroll = false;

// ============================================================
// SPEED SETTINGS
// The popup lets you choose how many seconds to pause per
// question. 0 = INSTANT (the default): no waiting at all. The
// extension answers the moment an answer is found, so a whole
// page is finished in a few seconds.
// For other speeds the pause is split like this:
//   40%  wait, then answer
//   40%  wait, then go to the next question
// ============================================================
const ALLOWED_SPEEDS = [0, 0.25, 0.5, 1, 2, 3, 5];
let DETECTION_DELAY_MS = 40;
let AFTER_CLICK_MS = 40;
let ANSWER_DELAY_MS = 0;
let NEXT_DELAY_MS = 0;
let SMOOTH_SCROLL = false;

function applySpeed(value) {
    const requested = Number(value);

    const seconds = ALLOWED_SPEEDS.includes(requested)
        ? requested
        : 0;

    const pause = Math.round(seconds * 1000 * 0.4);

    ANSWER_DELAY_MS = pause;
    NEXT_DELAY_MS = pause;
    DETECTION_DELAY_MS = seconds === 0 ? 40 : 100;
    AFTER_CLICK_MS = seconds === 0 ? 40 : 100;
    SMOOTH_SCROLL = seconds >= 1;
}

function scrollBehavior() {
    return SMOOTH_SCROLL ? "smooth" : "auto";
}

// Scrolling pages: how many answers to look up at the same time,
// and how many questions ahead to look up in advance.
const MAX_PARALLEL_REQUESTS = 8;
const PREFETCH_COUNT = 6;

let answerTimer = null;
let followUpTimer = null;

// State for pages that show MANY questions (scrolling pages).
let multiQuestionPage = false;
let runnerActive = false;
let answeredElements = new WeakSet();
let lastDisplayedKey = "";
let doneShown = false;
let scrollTimer = null;
let activeRequests = 0;
const waitingForSlot = [];
const resolutions = new Map();

// AI answers for many questions are collected for a very short
// moment and sent to Gemini together as ONE request.
const AI_BATCH_WINDOW_MS = 150;
const AI_BATCH_MAX = 20;
let aiQueue = [];
let aiFlushTimer = null;
let pendingMatches = 0;

// Used when a question is only half drawn on the page.
let incompleteRetries = 0;

const OVERLAY_ID = "qa-assistant-overlay";

// Containers that hold exactly ONE question.
const SPECIFIC_QUESTION_SELECTOR =
    "fieldset, [role='radiogroup'], [data-question], " +
    ".question-container, .quiz-question, .question, .quiz-item";

init();


async function init() {
    try {
        // IMPORTANT: nothing starts by itself. The old saved
        // "enabled" flag is deleted, and "enabled" always begins
        // as false every time a page loads or refreshes.
        // Only the Start button in the popup can turn it on.
        await chrome.storage.local.remove("enabled");

        const state = await chrome.storage.local.get([
            "subject",
            "autoAnswer",
            "autoScroll",
            "answerSpeed"
        ]);

        subject = state.subject || "";
        autoAnswer = Boolean(state.autoAnswer);
        autoScroll = Boolean(state.autoScroll);
        applySpeed(state.answerSpeed);

        console.log("[QAA DEBUG] Ready. Waiting for the Start button.", {
            subject,
            autoAnswer,
            autoScroll
        });

        startObserver();
    } catch (error) {
        console.error(
            "Question Assistant initialization failed:",
            error
        );
    }
}


// The popup talks to THIS page directly. That way Start and Stop
// only affect the tab you are looking at.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "QAA_START") {
        sendResponse(startAssistant(message.settings || {}));
    } else if (message?.type === "QAA_STOP") {
        stopAssistant();
        sendResponse({ ok: true });
    } else if (message?.type === "QAA_STATUS") {
        sendResponse({ ok: true, enabled });
    }
});


function startAssistant(settings) {
    const chosenSubject = String(settings.subject || subject || "");

    if (!chosenSubject) {
        return { ok: false, error: "Select a subject first." };
    }

    subject = chosenSubject;
    autoAnswer = Boolean(settings.autoAnswer);
    autoScroll = Boolean(settings.autoScroll);
    applySpeed(settings.answerSpeed);

    clearTimeout(answerTimer);
    clearTimeout(followUpTimer);
    answerTimer = null;
    followUpTimer = null;

    answeredElements = new WeakSet();
    lastQuestionKey = "";
    lastDisplayedKey = "";
    doneShown = false;
    incompleteRetries = 0;

    enabled = true;

    showOverlay(
        "Assistant started.\nLooking for questions...",
        "info"
    );

    scheduleDetection();

    return { ok: true };
}


function stopAssistant() {
    enabled = false;

    clearTimeout(detectionTimer);
    clearTimeout(answerTimer);
    clearTimeout(followUpTimer);
    clearTimeout(scrollTimer);

    answerTimer = null;
    followUpTimer = null;

    showOverlay("Assistant paused.", "info");
}


// Watch for questions appearing or changing on the page.
function startObserver() {
    if (observer || !document.documentElement) {
        return;
    }

    observer = new MutationObserver((mutations) => {
        if (!enabled || !hasRelevantChanges(mutations)) {
            return;
        }

        scheduleDetection();
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
    });
}


function hasRelevantChanges(mutations) {
    return mutations.some((mutation) => {
        const target = mutation.target;

        // Text nodes do not have closest(), so use their parent.
        const element = target instanceof Element
            ? target
            : target.parentElement;

        if (element && element.closest(`#${OVERLAY_ID}`)) {
            return false;
        }

        return true;
    });
}


// Wait briefly before scanning, because webpages can change
// several times while displaying a question.
function scheduleDetection() {
    clearTimeout(detectionTimer);

    detectionTimer = setTimeout(() => {
        detectCurrentQuestion();
    }, DETECTION_DELAY_MS);
}


// On a scrolling page, look at the page again after the user
// (or the extension) scrolls.
document.addEventListener(
    "scroll",
    (event) => {
        if (!enabled || !multiQuestionPage) {
            return;
        }

        const target = event.target;

        if (
            target instanceof Element &&
            target.closest(`#${OVERLAY_ID}`)
        ) {
            return;
        }

        clearTimeout(scrollTimer);

        scrollTimer = setTimeout(() => {
            scheduleDetection();
        }, 150);
    },
    { capture: true, passive: true }
);


// React when a setting changes in the popup.
// (Start and Stop do NOT come through here any more.)
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
        return;
    }

    let needsRescan = false;

    if (changes.subject) {
        subject = changes.subject.newValue || "";

        // Answers belong to a subject, so start fresh.
        resolutions.clear();
        answeredElements = new WeakSet();
        lastDisplayedKey = "";
        doneShown = false;
        needsRescan = true;
    }

    if (changes.autoAnswer) {
        autoAnswer = Boolean(changes.autoAnswer.newValue);

        if (!autoAnswer) {
            clearTimeout(answerTimer);
            clearTimeout(followUpTimer);
            answerTimer = null;
            followUpTimer = null;
        }

        needsRescan = true;
    }

    if (changes.autoScroll) {
        autoScroll = Boolean(changes.autoScroll.newValue);

        if (!autoScroll) {
            clearTimeout(followUpTimer);
            followUpTimer = null;
        }

        needsRescan = true;
    }

    if (changes.answerSpeed) {
        applySpeed(changes.answerSpeed.newValue);
    }

    if (!enabled || !needsRescan) {
        return;
    }

    lastQuestionKey = "";
    scheduleDetection();
});


async function detectCurrentQuestion() {
    if (!enabled || !subject) {
        return;
    }

    // A page with many questions (a scrolling page) is handled
    // separately. Your one-question-at-a-time practice page
    // (the one with #next-question) always uses the normal way.
    if (!document.querySelector("#next-question")) {
        const blocks = findQuestionBlocks();

        if (blocks.length >= 2) {
            multiQuestionPage = true;
            handleMultiQuestionPage(blocks);
            return;
        }
    }

    multiQuestionPage = false;

    if (requestInProgress) {
        return;
    }

    const candidate = findBestQuestionCandidate();

    if (!candidate) {
        showOverlay(
            "No question detected on this page.",
            "warning"
        );
        return;
    }

    const questionKey = normalize(candidate.question);

    if (!questionKey || questionKey === lastQuestionKey) {
        return;
    }

    // The page may still be drawing the choices. Look again very
    // soon (at most 3 times) instead of using half a question.
    const hasChoiceInputs = candidate.element.querySelector(
        "input[type='radio'], input[type='checkbox']"
    );

    if (
        hasChoiceInputs &&
        candidate.choices.length < 2 &&
        incompleteRetries < 3
    ) {
        incompleteRetries++;
        scheduleDetection();
        return;
    }

    incompleteRetries = 0;
    lastQuestionKey = questionKey;

    showOverlay(
        formatDetectedQuestion(candidate),
        "info"
    );

    requestInProgress = true;

    try {
        // First, try the existing database and local matcher.
        const response = await chrome.runtime.sendMessage({
            type: "MATCH_QUESTION",
            payload: {
                subject,
                question: candidate.question,
                choices: candidate.choices
            }
        });

        if (!response || !response.ok) {
            throw new Error(
                response?.error || "Database matching failed."
            );
        }

        // The user pressed Stop while we were waiting.
        if (!enabled) {
            return;
        }

        const match = response.result;

        if (!match) {
            throw new Error(
                "The backend returned no matching result."
            );
        }

        // The existing matcher found a reliable result.
        if (match.matched) {
            displayMatchResult(candidate, match);
            return;
        }

        // A wrong subject selection should be fixed by the user.
        if (match.match_type === "subject_not_found") {
            showOverlay(
                [
                    "SUBJECT NOT FOUND",
                    `Selected subject: ${subject}`,
                    "",
                    "Choose a valid subject in the extension popup.",
                    "No AI request was made."
                ].join("\n"),
                "warning"
            );
            return;
        }

        // No reliable database/local match: try Gemini.
        await requestStudyHelp(candidate);

    } catch (error) {
        console.error(
            "Question matching failed:",
            error
        );

        showOverlay(
            [
                "QUESTION DETECTED",
                candidate.question,
                "",
                "Could not complete database matching.",
                error.message,
                "",
                "Check that the backend is running."
            ].join("\n"),
            "error"
        );

    } finally {
        requestInProgress = false;
    }
}


function displayStudyHelpResult(candidate, result, allowAuto = true) {
    if (
        !result ||
        typeof result.answer !== "string" ||
        !result.answer.trim()
    ) {
        showOverlay(
            "Gemini did not return an answer.",
            "warning"
        );
        return;
    }

    // Prefer the choice that the backend already picked.
    let suggestedChoice = null;

    if (
        Number.isInteger(result.choice_index) &&
        candidate.choices[result.choice_index]
    ) {
        suggestedChoice = candidate.choices[result.choice_index];
    } else {
        suggestedChoice = findChoiceForAnswer(
            result.answer,
            candidate.choices
        );
    }

    const choiceText = suggestedChoice
        ? `Likely matching choice: ${suggestedChoice}`
        : "No clear choice match. Review the options manually.";

    const sources = Array.isArray(result.sources)
        ? result.sources.slice(0, 3)
        : [];

    const sourceText = sources.length
        ? sources.map((source, index) =>
            `${index + 1}. ${source.title || source.url || "Web source"}\n${source.url || ""}`
        ).join("\n\n")
        : "No source URLs were returned.";

    showOverlay(
        [
            "QUESTION DETECTED",
            candidate.question,
            "",
            "AI-GENERATED SUGGESTION",
            result.answer,
            "",
            candidate.choices.length ? choiceText : "",
            "",
            "Source type:",
            result.source_type || "AI-generated",
            "",
            "SOURCES",
            sourceText,
            "",
            result.disclaimer ||
                "AI-generated answer. Verify important facts."
        ].join("\n"),
        "info"
    );

    if (allowAuto) {
        autoAnswerCandidate(candidate, result.answer, result);
    }
}


function findChoiceForAnswer(answer, choices) {
    const normalizedAnswer = normalize(answer);

    if (!normalizedAnswer) {
        return null;
    }

    for (const choice of choices) {
        const match = choice.match(
            /^\s*([A-H])\s*[\.\):\-]?\s*(.*)$/i
        );

        const letter = match ? match[1].toUpperCase() : null;
        const text = match ? match[2] : choice;
        const normalizedChoice = normalize(text);

        if (!normalizedChoice) {
            continue;
        }

        const answerPadded = ` ${normalizedAnswer} `;
        const choicePadded = ` ${normalizedChoice} `;

        if (
            answerPadded.includes(choicePadded) ||
            choicePadded.includes(answerPadded)
        ) {
            return letter
                ? `${letter}. ${text}`
                : text;
        }
    }

    return null;
}


// Request Gemini only after an unsuccessful match.
async function requestStudyHelp(candidate) {
    showOverlay(
        [
            "QUESTION DETECTED",
            candidate.question,
            "",
            "No reliable database match.",
            "Requesting an AI-generated study suggestion..."
        ].join("\n"),
        "info"
    );

    try {
        const response = await chrome.runtime.sendMessage({
            type: "STUDY_HELP",
            payload: {
                subject,
                question: candidate.question,
                // Gemini also sees the choices.
                choices: candidate.choices
            }
        });

        if (!response || !response.ok) {
            throw new Error(
                response?.error || "The AI request failed."
            );
        }

        displayStudyHelpResult(
            candidate,
            response.result
        );

    } catch (error) {
        console.error(
            "Gemini fallback failed:",
            error
        );

        showOverlay(
            [
                "NO RELIABLE DATABASE MATCH",
                candidate.question,
                "",
                "The AI backup could not provide a result.",
                error.message,
                "",
                "Check the backend terminal and Gemini availability."
            ].join("\n"),
            "warning"
        );
    }
}


// Collect possible question containers from the page.
function findBestQuestionCandidate() {
    const selectors = [
        "fieldset",
        "[role='radiogroup']",
        "[role='group']",
        "[data-question]",
        ".question-container",
        ".quiz-question",
        ".question",
        ".quiz-item",
        "form",
        "main",
        "article",
        "section"
    ];

    const candidates = [];

    for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);

        for (const element of elements) {
            if (!isVisible(element)) {
                continue;
            }

            if (element.closest(`#${OVERLAY_ID}`)) {
                continue;
            }

            const candidate = buildCandidate(element);

            if (candidate) {
                if (
                    selector === "fieldset" ||
                    selector === "[role='radiogroup']" ||
                    selector === "[data-question]"
                ) {
                    candidate.score += 40;
                }

                candidates.push(candidate);
            }
        }
    }

    const uniqueCandidates = deduplicateCandidates(candidates);

    uniqueCandidates.sort((a, b) => {
        const scoreDifference = b.score - a.score;

        if (scoreDifference !== 0) {
            return scoreDifference;
        }

        if (autoAnswer && autoScroll && isLocalPracticePage()) {
            return viewportCenterDistance(a.element) -
                viewportCenterDistance(b.element);
        }

        return 0;
    });

    return uniqueCandidates[0] || null;
}


function buildCandidate(element) {
    const question = extractQuestion(element);

    if (!question) {
        return null;
    }

    const choices = extractChoices(element);

    let score = 0;

    if (question.endsWith("?")) {
        score += 20;
    }

    if (choices.length >= 2) {
        score += 30;
    }

    if (question.length >= 10 && question.length <= 500) {
        score += 10;
    }

    return {
        question,
        choices,
        element,
        score
    };
}


// Extract the question from the container's visible text.
function extractQuestion(element) {
    const lines = getTextLines(element);

    // First, look for a normal question.
    const questionLine = lines.find((line) =>
        line.length >= 5 &&
        line.length <= 500 &&
        line.endsWith("?")
    );

    if (questionLine) {
        return removeQuestionNumber(questionLine);
    }

    // Next, look for a question that starts with a question word.
    const questionStartPattern =
        /^(what|which|who|when|where|why|how|define|identify|explain|describe)\b/i;

    const keywordLine = lines.find((line) =>
        line.length >= 10 &&
        line.length <= 500 &&
        questionStartPattern.test(line)
    );

    if (keywordLine) {
        return removeQuestionNumber(keywordLine);
    }

    // Otherwise, treat the longest suitable non-choice line
    // as a definition statement.
    const definitionCandidates = lines.filter((line) => {
        if (line.length < 30 || line.length > 700) {
            return false;
        }

        // Ignore answer choices such as "A. Load Testing".
        if (/^[A-H]\s*[\.\):\-]/i.test(line)) {
            return false;
        }

        // Ignore the test heading and source label.
        if (/^question\s+\d+\s+of\s+\d+/i.test(line)) {
            return false;
        }

        if (/^(source\s*:|database test|ai backup test)\b/i.test(line)) {
            return false;
        }

        return true;
    });

    definitionCandidates.sort(
        (a, b) => b.length - a.length
    );

    return definitionCandidates[0] || "";
}


// Extract choices from labels or text such as "A. Example".
function extractChoices(element) {
    const choices = [];

    const inputs = element.querySelectorAll(
        "input[type='radio'], input[type='checkbox']"
    );

    for (const input of inputs) {
        const label = findLabel(input);

        if (!label) {
            continue;
        }

        const text = clean(
            label.innerText || label.textContent || ""
        );

        if (text) {
            choices.push(text);
        }
    }

    if (choices.length >= 2) {
        return unique(choices).slice(0, 20);
    }

    // Fallback for questions that use plain text instead
    // of radio buttons or checkbox labels.
    for (const line of getTextLines(element)) {
        if (/^[A-H]\s*[\.\):\-]/i.test(line)) {
            choices.push(line);
        }
    }

    return unique(choices).slice(0, 20);
}


function findLabel(input) {
    const parentLabel = input.closest("label");

    if (parentLabel) {
        return parentLabel;
    }

    const id = input.getAttribute("id");

    if (id) {
        const label = document.querySelector(
            `label[for="${CSS.escape(id)}"]`
        );

        if (label) {
            return label;
        }
    }

    return null;
}


function getTextLines(element) {
    // Read the webpage text without removing its line breaks.
    const text = element.innerText || "";

    if (!text.trim()) {
        return [];
    }

    // Split the text into separate lines first.
    return unique(
        text
            .split(/\r?\n+/)
            .map((line) => line.replace(/[ \t]+/g, " ").trim())
            .filter((line) =>
                line.length > 0 &&
                line.length <= 1000
            )
    );
}


function removeQuestionNumber(text) {
    return clean(
        text.replace(
            /^\s*(?:question\s*)?\d+\s*[\.\):\-]\s*/i,
            ""
        )
    );
}


function deduplicateCandidates(candidates) {
    const result = new Map();

    for (const candidate of candidates) {
        const key = normalize(candidate.question);
        const current = result.get(key);

        if (!current || candidate.score > current.score) {
            result.set(key, candidate);
        }
    }

    return Array.from(result.values());
}


function displayMatchResult(candidate, result, allowAuto = true) {
    if (!result) {
        showOverlay(
            "Question detected, but the backend returned no result.",
            "error"
        );
        return;
    }

    if (!result.matched) {
        showOverlay(
            [
                "QUESTION DETECTED",
                candidate.question,
                "",
                "No reliable match found.",
                `Confidence: ${Math.round(result.confidence * 100)}%`
            ].join("\n"),
            "warning"
        );

        return;
    }

    const choice = result.choice_label
        ? `Choice: ${result.choice_label}`
        : "No matching choice identified.";

    showOverlay(
        [
            "QUESTION DETECTED",
            candidate.question,
            "",
            "MATCHED ANSWER",
            result.answer || "(empty answer)",
            choice,
            `Confidence: ${Math.round(result.confidence * 100)}%`,
            "",
            "Source:",
            result.source_url || "Local question database"
        ].join("\n"),
        "success"
    );

    if (allowAuto) {
        autoAnswerCandidate(candidate, result.answer, result);
    }
}


function formatDetectedQuestion(candidate) {
    const choicesText = candidate.choices.length
        ? candidate.choices
            .map((choice, index) => `${index + 1}. ${choice}`)
            .join("\n")
        : "No choices detected.";

    return [
        "QUESTION DETECTED",
        candidate.question,
        "",
        "CHOICES",
        choicesText
    ].join("\n");
}


function showOverlay(message, type) {
    let box = document.getElementById(OVERLAY_ID);

    if (!box) {
        box = document.createElement("div");
        box.id = OVERLAY_ID;

        Object.assign(box.style, {
            position: "fixed",
            right: "16px",
            bottom: "16px",
            zIndex: "2147483647",
            width: "380px",
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "50vh",
            overflowY: "auto",
            boxSizing: "border-box",
            padding: "14px",
            borderRadius: "10px",
            borderLeft: "5px solid #60a5fa",
            background: "#111827",
            color: "#ffffff",
            font: "13px/1.5 Arial, sans-serif",
            overflowWrap: "anywhere",
            boxShadow: "0 8px 30px rgba(0, 0, 0, 0.25)"
        });

        // Header containing the extension name and close button.
        const header = document.createElement("div");

        Object.assign(header.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px"
        });

        const title = document.createElement("strong");
        title.textContent = "Question Answer Assistant";

        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.textContent = "\u00D7";
        closeButton.setAttribute("aria-label", "Close answer overlay");
        closeButton.title = "Close";

        Object.assign(closeButton.style, {
            border: "none",
            background: "transparent",
            color: "#ffffff",
            fontSize: "24px",
            cursor: "pointer",
            padding: "0 4px",
            lineHeight: "1"
        });

        closeButton.addEventListener("click", () => {
            box.remove();
        });

        header.append(title, closeButton);

        // Use a text element so webpage content is not treated as HTML.
        const messageBox = document.createElement("pre");
        messageBox.dataset.qaMessage = "true";

        Object.assign(messageBox.style, {
            margin: "12px 0 0",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            font: "13px/1.5 Arial, sans-serif",
            color: "#ffffff"
        });

        box.append(header, messageBox);
        document.documentElement.appendChild(box);
    }

    const messageBox = box.querySelector("[data-qa-message]");

    if (messageBox) {
        messageBox.textContent = message;
    }

    box.dataset.type = type;

    // A colored left border indicates the result status.
    const statusColors = {
        success: "#22c55e",
        warning: "#f59e0b",
        error: "#ef4444",
        info: "#60a5fa"
    };

    box.style.borderLeft =
        `5px solid ${statusColors[type] || "#6b7280"}`;
}


function isVisible(element) {
    const style = getComputedStyle(element);

    return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        element.getClientRects().length > 0
    );
}


function isInViewport(element) {
    const rect = element.getBoundingClientRect();

    return rect.bottom > 0 && rect.top < window.innerHeight;
}


function clean(value) {
    return String(value)
        .replace(/\s+/g, " ")
        .trim();
}


function normalize(value) {
    return clean(value)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}


function unique(values) {
    return [...new Set(values)];
}


function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


function isLocalPracticePage() {
    const host = location.hostname;

    return (
        ["http:", "https:"].includes(location.protocol) &&
        ALLOWED_HOSTS.some(
            (allowed) =>
                host === allowed || host.endsWith("." + allowed)
        )
    );
}


function viewportCenterDistance(element) {
    const rect = element.getBoundingClientRect();
    const elementCenter = (rect.top + rect.bottom) / 2;

    return Math.abs(elementCenter - window.innerHeight / 2);
}


// ============================================================
// SCROLLING PAGES (many questions on one page)
//
// How it works, in simple words:
//  1. Find every question block on the page.
//  2. Look up the answers for the next few questions AT THE SAME
//     TIME (database first, Gemini only when needed). So the slow
//     AI wait happens once, not once per question.
//  3. Go through the questions in order: scroll to it, answer it,
//     wait a moment, move on.
// ============================================================

// Find every question block on the page, in page order.
function findQuestionBlocks() {
    let blocks = findBlocksFromContainers();

    if (blocks.length >= 2) {
        return blocks;
    }

    blocks = findBlocksFromChoiceGroups();

    return blocks.length >= 2 ? blocks : [];
}


// Way 1: pages that wrap each question in a fieldset or in
// a .question / .quiz-question / .quiz-item style container.
function findBlocksFromContainers() {
    const found = [];

    for (const element of document.querySelectorAll(
        SPECIFIC_QUESTION_SELECTOR
    )) {
        if (
            element.closest(`#${OVERLAY_ID}`) ||
            !isVisible(element)
        ) {
            continue;
        }

        const candidate = buildCandidate(element);

        if (candidate && hasAnswerArea(candidate)) {
            found.push(candidate);
        }
    }

    return removeNestedBlocks(found);
}


// Way 2: pages without special classes. Every group of radio
// buttons (same name) is treated as one question.
function findBlocksFromChoiceGroups() {
    const inputs = Array.from(
        document.querySelectorAll(
            "input[type='radio'], input[type='checkbox']"
        )
    ).filter((input) =>
        !input.disabled &&
        !input.closest(`#${OVERLAY_ID}`)
    );

    const groups = new Map();

    for (const input of inputs) {
        const key = input.name || "__no_name__";

        if (!groups.has(key)) {
            groups.set(key, []);
        }

        groups.get(key).push(input);
    }

    if (groups.size < 2) {
        return [];
    }

    const blocks = [];

    for (const group of groups.values()) {
        const members = new Set(group);

        // Climb up as far as possible while the parent still
        // contains ONLY this question's choices.
        let node = group[0].parentElement;
        let best = null;

        while (
            node &&
            node !== document.body &&
            node !== document.documentElement
        ) {
            const hasOtherInputs = inputs.some(
                (input) => node.contains(input) && !members.has(input)
            );

            if (hasOtherInputs) {
                break;
            }

            best = node;
            node = node.parentElement;
        }

        if (!best || !isVisible(best)) {
            continue;
        }

        const candidate = buildCandidate(best);

        if (candidate && candidate.choices.length >= 2) {
            blocks.push(candidate);
        }
    }

    return blocks;
}


// A real question block has choices or a text box to fill in.
function hasAnswerArea(candidate) {
    if (candidate.choices.length >= 2) {
        return true;
    }

    return Array.from(
        candidate.element.querySelectorAll(
            "input:not([type]), input[type='text'], textarea"
        )
    ).some((field) =>
        !field.disabled &&
        !field.readOnly &&
        isVisible(field)
    );
}


// Remove big wrappers that hold several questions, and remove
// inner pieces that belong to the same question as their parent.
function removeNestedBlocks(blocks) {
    const innerCount = (outer) =>
        blocks.filter((other) =>
            other !== outer &&
            outer.element.contains(other.element)
        ).length;

    return blocks.filter((block) => {
        // A wrapper around several questions is not a question.
        if (innerCount(block) >= 2) {
            return false;
        }

        // An inner piece of ONE question: keep the parent only.
        const insideOneQuestion = blocks.some((other) =>
            other !== block &&
            other.element.contains(block.element) &&
            innerCount(other) === 1
        );

        return !insideOneQuestion;
    });
}


// Decide what to do on a page with many questions.
function handleMultiQuestionPage(blocks) {
    if (autoAnswer && isLocalPracticePage()) {
        startRunner();
    } else {
        showCenteredQuestion(blocks);
    }
}


// ------------------------------------------------------------
// Looking up answers (several at the same time)
// ------------------------------------------------------------

function resolutionKey(candidate) {
    return [
        subject,
        normalize(candidate.question),
        candidate.choices.join("|")
    ].join("||");
}


// Allow only a few requests at once so the backend is not flooded.
async function withRequestSlot(task) {
    if (activeRequests < MAX_PARALLEL_REQUESTS) {
        activeRequests++;
    } else {
        // A finished request hands its slot straight to us.
        await new Promise((resolve) => waitingForSlot.push(resolve));
    }

    try {
        return await task();
    } finally {
        const next = waitingForSlot.shift();

        if (next) {
            next();
        } else {
            activeRequests--;
        }
    }
}


// Ask the database (fast).
async function lookupDatabase(candidate) {
    const response = await chrome.runtime.sendMessage({
        type: "MATCH_QUESTION",
        payload: {
            subject,
            question: candidate.question,
            choices: candidate.choices
        }
    });

    if (!response || !response.ok) {
        throw new Error(
            response?.error || "Database matching failed."
        );
    }

    if (!response.result) {
        throw new Error(
            "The backend returned no matching result."
        );
    }

    return response.result;
}


// Send a message. If the AI service is busy, try again quickly.
async function sendWithRetry(message) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await chrome.runtime.sendMessage(message);

        if (response && response.ok) {
            return response;
        }

        const reason = response?.error || "The AI request failed.";
        const busy = /\b(429|502|503|504)\b/.test(reason);

        if (!busy || attempt === 2) {
            throw new Error(reason);
        }

        await sleep(400 * (attempt + 1));
    }

    throw new Error("The AI request failed.");
}


function validAiResult(result) {
    return (
        result &&
        typeof result.answer === "string" &&
        result.answer.trim()
    );
}


// Ask Gemini about ONE question.
async function askAiSingle(item) {
    try {
        const response = await withRequestSlot(() =>
            sendWithRetry({
                type: "STUDY_HELP",
                payload: {
                    subject,
                    question: item.candidate.question,
                    choices: item.candidate.choices
                }
            })
        );

        if (!validAiResult(response.result)) {
            throw new Error("Gemini did not return an answer.");
        }

        item.resolve(response.result);
    } catch (error) {
        item.reject(error);
    }
}


// Ask Gemini about SEVERAL questions in ONE request.
async function askAiBatch(items) {
    if (items.length === 1) {
        askAiSingle(items[0]);
        return;
    }

    try {
        const response = await sendWithRetry({
            type: "STUDY_HELP_BATCH",
            payload: {
                subject,
                items: items.map((item, index) => ({
                    id: index,
                    question: item.candidate.question,
                    choices: item.candidate.choices
                }))
            }
        });

        const list = Array.isArray(response.result?.results)
            ? response.result.results
            : [];

        const byId = new Map(list.map((entry) => [entry.id, entry]));

        items.forEach((item, index) => {
            const entry = byId.get(index);

            if (validAiResult(entry)) {
                item.resolve(entry);
            } else {
                // Gemini skipped this one: ask for it alone.
                askAiSingle(item);
            }
        });
    } catch (error) {
        console.error("Batch AI request failed:", error);

        // Fall back to asking one by one.
        items.forEach((item) => askAiSingle(item));
    }
}


function flushAiQueue() {
    clearTimeout(aiFlushTimer);
    aiFlushTimer = null;

    const items = aiQueue.splice(0, aiQueue.length);

    for (let i = 0; i < items.length; i += AI_BATCH_MAX) {
        askAiBatch(items.slice(i, i + AI_BATCH_MAX));
    }
}


// Questions that need the AI wait here for a moment so that they
// can travel together in one request.
function requestAiAnswer(candidate) {
    return new Promise((resolve, reject) => {
        aiQueue.push({ candidate, resolve, reject });

        if (!aiFlushTimer) {
            aiFlushTimer = setTimeout(
                flushAiQueue,
                AI_BATCH_WINDOW_MS
            );
        }
    });
}


// Database first. Gemini only when the database has no answer.
async function resolveQuestion(candidate) {
    pendingMatches++;
    let counted = true;

    // When every database lookup has finished, send the waiting
    // AI questions straight away (no need to wait any longer).
    const finishMatch = () => {
        if (!counted) {
            return;
        }

        counted = false;
        pendingMatches--;

        if (pendingMatches === 0 && aiQueue.length > 0) {
            flushAiQueue();
        }
    };

    try {
        const match = await withRequestSlot(
            () => lookupDatabase(candidate)
        );

        if (match.matched) {
            finishMatch();

            return {
                kind: "database",
                answer: match.answer,
                result: match
            };
        }

        if (match.match_type === "subject_not_found") {
            finishMatch();
            return { kind: "subject_missing" };
        }

        // Join the AI queue first, then report that our database
        // lookup is finished.
        const aiPromise = requestAiAnswer(candidate);
        finishMatch();

        const aiResult = await aiPromise;

        return {
            kind: "ai",
            answer: aiResult.answer,
            result: aiResult
        };

    } catch (error) {
        finishMatch();
        console.error("Answer lookup failed:", error);

        return {
            kind: "error",
            error: error.message
        };
    }
}


// Start a lookup once, then reuse the same answer.
function getResolution(candidate) {
    const key = resolutionKey(candidate);

    let promise = resolutions.get(key);

    if (!promise) {
        promise = resolveQuestion(candidate).then((resolution) => {
            // Do not remember failures, so they can be retried.
            if (resolution.kind === "error") {
                resolutions.delete(key);
            }

            return resolution;
        });

        resolutions.set(key, promise);
    }

    return promise;
}


// Start looking up answers before we need them.
function prefetchAhead(blocks, startIndex, count = PREFETCH_COUNT) {
    const end = Math.min(blocks.length, startIndex + count);

    for (let i = Math.max(0, startIndex); i < end; i++) {
        if (!answeredElements.has(blocks[i].element)) {
            getResolution(blocks[i]);
        }
    }
}


// ------------------------------------------------------------
// Automatic answering, question by question
// ------------------------------------------------------------

async function startRunner() {
    if (runnerActive) {
        return;
    }

    runnerActive = true;
    let answeredAny = false;

    try {
        let blocks = findQuestionBlocks();

        // Start looking up ALL the answers right now, together.
        // The database answers in a moment, and every question
        // that needs the AI travels in ONE request.
        prefetchAhead(blocks, 0, blocks.length);

        while (
            enabled &&
            autoAnswer &&
            isLocalPracticePage()
        ) {
            if (blocks.length < 2) {
                break;
            }

            // The page rebuilt itself: look at it again.
            if (blocks.some((block) => !block.element.isConnected)) {
                blocks = findQuestionBlocks();
                prefetchAhead(blocks, 0, blocks.length);
                continue;
            }

            const pending = blocks.filter(
                (block) => !answeredElements.has(block.element)
            );

            if (pending.length === 0) {
                // Maybe more questions appeared (a lazy page).
                const fresh = findQuestionBlocks();

                if (
                    fresh.some(
                        (block) => !answeredElements.has(block.element)
                    )
                ) {
                    blocks = fresh;
                    prefetchAhead(blocks, 0, blocks.length);
                    continue;
                }

                if (!doneShown) {
                    doneShown = true;

                    showOverlay(
                        [
                            "ALL QUESTIONS ANSWERED",
                            "",
                            `Answered ${blocks.length} questions.`,
                            "The form has not been submitted.",
                            "Review your answers before submitting."
                        ].join("\n"),
                        "success"
                    );
                }

                break;
            }

            doneShown = false;

            // Scrolling on: go in page order.
            // Scrolling off: only answer what is on the screen.
            const target = autoScroll
                ? pending[0]
                : pending.find((block) => isInViewport(block.element));

            if (!target) {
                break;
            }

            const number = blocks.indexOf(target) + 1;
            const total = blocks.length;

            if (autoScroll) {
                target.element.scrollIntoView({
                    behavior: scrollBehavior(),
                    block: "center"
                });
            }

            const resolution = await getResolution(target);

            if (!enabled || !autoAnswer) {
                break;
            }

            if (ANSWER_DELAY_MS > 0) {
                await sleep(ANSWER_DELAY_MS);

                if (!enabled || !autoAnswer) {
                    break;
                }
            }

            // The page rebuilt itself: look at it again.
            if (!target.element.isConnected) {
                blocks = findQuestionBlocks();
                prefetchAhead(blocks, 0, blocks.length);
                continue;
            }

            if (resolution.kind === "subject_missing") {
                showOverlay(
                    [
                        "SUBJECT NOT FOUND",
                        `Selected subject: ${subject}`,
                        "",
                        "Choose a valid subject in the extension popup."
                    ].join("\n"),
                    "warning"
                );
                break;
            }

            // Mark it as done first, so a problem can never
            // make the extension repeat the same question forever.
            answeredElements.add(target.element);

            if (resolution.kind === "error") {
                showOverlay(
                    [
                        `QUESTION ${number} OF ${total}`,
                        target.question,
                        "",
                        "Could not get an answer. Skipped.",
                        resolution.error || ""
                    ].join("\n"),
                    "warning"
                );
            } else {
                const fresh = buildCandidate(target.element);

                if (
                    !fresh ||
                    normalize(fresh.question) !==
                        normalize(target.question)
                ) {
                    showOverlay(
                        [
                            `QUESTION ${number} OF ${total}`,
                            "",
                            "The question changed on the page. Skipped."
                        ].join("\n"),
                        "warning"
                    );
                } else {
                    const actionResult = performAnswer(
                        fresh,
                        resolution.answer,
                        resolution.result
                    );

                    const sourceLabel = resolution.kind === "database"
                        ? "Database"
                        : "AI (Gemini) - verify this answer";

                    if (actionResult) {
                        answeredAny = true;

                        showOverlay(
                            [
                                `ANSWER APPLIED (${number} OF ${total})`,
                                target.question,
                                "",
                                `Answer: ${actionResult}`,
                                `Source: ${sourceLabel}`,
                                "",
                                "The form has not been submitted."
                            ].join("\n"),
                            "success"
                        );
                    } else {
                        showOverlay(
                            [
                                `QUESTION ${number} OF ${total}`,
                                target.question,
                                "",
                                "Answer found, but no matching choice or",
                                "text box could be filled safely.",
                                `Answer: ${resolution.answer}`,
                                `Source: ${sourceLabel}`
                            ].join("\n"),
                            "warning"
                        );
                    }
                }
            }

            // Instant mode: do not wait at all. Other speeds pause.
            if (NEXT_DELAY_MS > 0) {
                await sleep(NEXT_DELAY_MS);
            } else {
                await sleep(0);
            }
        }
    } catch (error) {
        console.error("Automatic answering stopped:", error);
    } finally {
        runnerActive = false;
    }

    // Something changed on the page while we worked. Look once more.
    if (answeredAny && enabled && autoAnswer) {
        scheduleDetection();
    }
}


// ------------------------------------------------------------
// Automatic answering OFF: just show the answer for the
// question that is in the middle of the screen.
// ------------------------------------------------------------

function nearestBlockIndex(blocks) {
    let bestIndex = 0;
    let bestDistance = Infinity;

    blocks.forEach((block, index) => {
        const distance = viewportCenterDistance(block.element);

        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });

    return bestIndex;
}


async function showCenteredQuestion(blocks) {
    const index = nearestBlockIndex(blocks);
    const block = blocks[index];

    if (!block) {
        return;
    }

    prefetchAhead(blocks, index);

    const key = resolutionKey(block);

    if (key === lastDisplayedKey) {
        return;
    }

    lastDisplayedKey = key;

    showOverlay(
        [
            `QUESTION ${index + 1} OF ${blocks.length}`,
            block.question,
            "",
            "Looking up the answer..."
        ].join("\n"),
        "info"
    );

    const resolution = await getResolution(block);

    if (!enabled || lastDisplayedKey !== key) {
        return;
    }

    if (resolution.kind === "error") {
        lastDisplayedKey = "";
    }

    showResolution(block, resolution);
}


function showResolution(block, resolution) {
    if (resolution.kind === "database") {
        displayMatchResult(block, resolution.result, false);
    } else if (resolution.kind === "ai") {
        displayStudyHelpResult(block, resolution.result, false);
    } else if (resolution.kind === "subject_missing") {
        showOverlay(
            [
                "SUBJECT NOT FOUND",
                `Selected subject: ${subject}`,
                "",
                "Choose a valid subject in the extension popup."
            ].join("\n"),
            "warning"
        );
    } else {
        showOverlay(
            [
                "QUESTION DETECTED",
                block.question,
                "",
                "Could not get an answer.",
                resolution.error || ""
            ].join("\n"),
            "warning"
        );
    }
}


// ============================================================
// AUTOMATIC ANSWERING (one question at a time pages)
// ============================================================

// Step 1: wait a moment, then apply the answer.
function autoAnswerCandidate(candidate, answer, result = {}) {
    if (
        !enabled ||
        !autoAnswer ||
        !isLocalPracticePage() ||
        !String(answer || "").trim()
    ) {
        return;
    }

    clearTimeout(answerTimer);
    clearTimeout(followUpTimer);

    answerTimer = setTimeout(() => {
        answerTimer = null;
        applyAnswer(candidate, answer, result);
    }, ANSWER_DELAY_MS);
}


// Select a choice or type into a text box.
function performAnswer(candidate, answer, result) {
    if (candidate.choices.length > 0) {
        // Multiple choice.
        return selectMatchingChoice(candidate, answer, result);
    }

    // Identification and enumeration.
    return typeIntoQuestionField(candidate, answer);
}


// Step 2: re-check the page, then select or type the answer.
function applyAnswer(candidate, answer, result) {
    if (
        !enabled ||
        !autoAnswer ||
        !isLocalPracticePage()
    ) {
        return;
    }

    // Do not apply an old answer to a different question.
    // We also use the NEWEST copy of the question, because the
    // page may have rebuilt its elements during the delay.
    const latest = findBestQuestionCandidate();

    if (
        !latest ||
        normalize(latest.question) !== normalize(candidate.question)
    ) {
        showOverlay(
            [
                "ANSWER SKIPPED",
                "",
                "The question on the page changed before the",
                "answer could be applied. Nothing was selected."
            ].join("\n"),
            "warning"
        );
        return;
    }

    const actionResult = performAnswer(latest, answer, result);

    if (!actionResult) {
        showOverlay(
            [
                "Answer found, but the extension could not safely",
                "identify a matching choice or text field.",
                "Review the answer manually.",
                "",
                `Answer: ${answer}`
            ].join("\n"),
            "warning"
        );
        return;
    }

    showOverlay(
        [
            "AUTOMATIC ANSWER APPLIED",
            latest.question,
            "",
            `Answer: ${actionResult}`,
            "",
            "The form has not been submitted."
        ].join("\n"),
        "success"
    );

    if (autoScroll) {
        scheduleNextQuestion(latest.element);
    }
}


// Wait until something is ready (checked every few milliseconds).
async function waitFor(check, timeoutMs, stepMs) {
    const end = Date.now() + timeoutMs;

    while (Date.now() < end) {
        const value = check();

        if (value) {
            return value;
        }

        await sleep(stepMs);
    }

    return check();
}


function canContinue() {
    return (
        enabled &&
        autoAnswer &&
        autoScroll &&
        isLocalPracticePage()
    );
}


// Step 3: go to the next question.
function scheduleNextQuestion(currentElement) {
    clearTimeout(followUpTimer);

    followUpTimer = setTimeout(async () => {
        followUpTimer = null;

        if (!canContinue()) {
            return;
        }

        let nextButton = findNextButton();

        // The button exists but is not ready yet (the page may
        // enable it a moment after the answer is chosen).
        if (!nextButton && document.querySelector("#next-question")) {
            nextButton = await waitFor(findNextButton, 1500, 25);

            if (!canContinue()) {
                return;
            }
        }

        if (nextButton) {
            const keyBeforeClick = lastQuestionKey;

            nextButton.click();

            // Give the page a moment to show the next question.
            setTimeout(() => {
                if (!enabled) {
                    return;
                }

                // Only if the new question has NOT been read yet
                // (for example it has the same text), read again.
                if (lastQuestionKey === keyBeforeClick) {
                    lastQuestionKey = "";
                }

                const questionText =
                    document.querySelector("#question-text");

                if (questionText) {
                    questionText.scrollIntoView({
                        behavior: scrollBehavior(),
                        block: "center"
                    });
                }

                scheduleDetection();
            }, AFTER_CLICK_MS);

            return;
        }

        // Other local practice pages: use ordinary scrolling.
        scrollToNextQuestion(currentElement);

        setTimeout(() => {
            if (enabled) {
                scheduleDetection();
            }
        }, AFTER_CLICK_MS);

    }, NEXT_DELAY_MS);
}


// Find the "Next Question" button on the practice page.
function findNextButton() {
    // Your practice page's own button.
    // NOTE: a <button> with no type="" counts as "submit" in
    // browsers, so we do NOT check the type for this one.
    const own = document.querySelector("#next-question");

    if (
        own instanceof HTMLButtonElement &&
        !own.disabled &&
        isVisible(own)
    ) {
        return own;
    }

    // Other pages: a plain "Next" button that is not a submit button.
    const buttons = Array.from(document.querySelectorAll("button"));

    return buttons.find((button) =>
        button.type === "button" &&
        !button.disabled &&
        isVisible(button) &&
        !button.closest(`#${OVERLAY_ID}`) &&
        /^next( question)?$/i.test(clean(button.textContent))
    ) || null;
}


// ============================================================
// MULTIPLE CHOICE
// ============================================================

function selectMatchingChoice(candidate, answer, result) {
    const choices = candidate.choices || [];

    if (choices.length === 0) {
        return null;
    }

    let choiceIndex = -1;

    // 1. The backend told us the exact choice number.
    if (
        Number.isInteger(result.choice_index) &&
        result.choice_index >= 0 &&
        result.choice_index < choices.length
    ) {
        choiceIndex = result.choice_index;
    }

    // 2. The backend gave a letter such as "B".
    if (choiceIndex === -1) {
        const labelMatch = String(result.choice_label || "").match(
            /^\s*([A-H])(?:[.)\s:\-]|$)/i
        );

        if (labelMatch) {
            const index = labelMatch[1].toUpperCase().charCodeAt(0) - 65;

            if (index >= 0 && index < choices.length) {
                choiceIndex = index;
            }
        }
    }

    // 3. The answer itself is just a letter.
    if (choiceIndex === -1) {
        const answerLetter = String(answer).trim().match(
            /^(?:option\s+)?([A-H])$/i
        );

        if (answerLetter) {
            const index = answerLetter[1].toUpperCase().charCodeAt(0) - 65;

            if (index >= 0 && index < choices.length) {
                choiceIndex = index;
            }
        }
    }

    // 4. Compare the answer text with each choice text.
    if (choiceIndex === -1) {
        const normalizedAnswer = normalize(answer);

        if (normalizedAnswer.length >= 3) {
            // Exact match first.
            choiceIndex = choices.findIndex((choice) =>
                normalize(stripChoicePrefix(choice)) === normalizedAnswer
            );

            // Then partial match.
            if (choiceIndex === -1) {
                choiceIndex = choices.findIndex((choice) => {
                    const normalizedChoice =
                        normalize(stripChoicePrefix(choice));

                    return (
                        normalizedChoice.length >= 3 &&
                        (
                            normalizedAnswer.includes(normalizedChoice) ||
                            normalizedChoice.includes(normalizedAnswer)
                        )
                    );
                });
            }
        }
    }

    if (choiceIndex === -1) {
        return null;
    }

    const chosenText = choices[choiceIndex];
    const wantedText = normalize(stripChoicePrefix(chosenText));

    const inputs = Array.from(
        candidate.element.querySelectorAll(
            "input[type='radio'], input[type='checkbox']"
        )
    ).filter((input) => !input.disabled);

    let input = inputs.find((item) => {
        const label = findLabel(item);
        const labelText = label
            ? label.innerText || label.textContent || ""
            : item.value || "";

        return normalize(stripChoicePrefix(labelText)) === wantedText;
    });

    if (!input && inputs[choiceIndex]) {
        input = inputs[choiceIndex];
    }

    if (input) {
        if (!input.checked) {
            input.click();
        }

        if (!input.checked) {
            return null;
        }

        return clean(stripChoicePrefix(chosenText)) || String(answer);
    }

    // No radio/checkbox found: the page may use buttons or
    // clickable boxes for its choices.
    const clickable = findClickableChoice(
        candidate.element,
        wantedText
    );

    if (clickable) {
        clickable.click();
        return clean(stripChoicePrefix(chosenText)) || String(answer);
    }

    return null;
}


function findClickableChoice(container, wantedText) {
    if (!wantedText) {
        return null;
    }

    const elements = Array.from(
        container.querySelectorAll(
            "button, [role='radio'], [role='option'], label, li"
        )
    );

    return elements.find((element) => {
        if (
            element.closest(`#${OVERLAY_ID}`) ||
            element.disabled ||
            !isVisible(element)
        ) {
            return false;
        }

        const text = normalize(
            stripChoicePrefix(
                element.innerText || element.textContent || ""
            )
        );

        return text === wantedText;
    }) || null;
}


function stripChoicePrefix(value) {
    return String(value || "").replace(
        /^\s*[A-H]\s*[.):\-]\s*/,
        ""
    ).trim();
}


// ============================================================
// IDENTIFICATION AND ENUMERATION (typing into text boxes)
// ============================================================

function countVisibleQuestionContainers() {
    return Array.from(
        document.querySelectorAll(SPECIFIC_QUESTION_SELECTOR)
    ).filter((element) =>
        isVisible(element) &&
        !element.closest(`#${OVERLAY_ID}`)
    ).length;
}


function typeIntoQuestionField(candidate, answer) {
    const container = candidate.element;

    const fields = Array.from(
        container.querySelectorAll(
            "input:not([type]), input[type='text'], " +
            "input[type='search'], textarea"
        )
    ).filter((field) => {
        return (
            !field.disabled &&
            !field.readOnly &&
            isVisible(field)
        );
    });

    if (fields.length === 0) {
        return null;
    }

    // Safety: only type when we are sure these boxes belong to
    // THIS question.
    //  - the container holds exactly one question, OR
    //  - there is only one text box, OR
    //  - the page has no separate question containers at all
    //    (one question shown at a time).
    const isSpecific = container.matches(SPECIFIC_QUESTION_SELECTOR);
    const isSafe =
        isSpecific ||
        fields.length === 1 ||
        countVisibleQuestionContainers() === 0;

    if (!isSafe) {
        return null;
    }

    const text = String(answer).trim();

    // Identification (or enumeration in one box).
    if (fields.length === 1) {
        const field = fields[0];
        let value = text;

        if (field instanceof HTMLTextAreaElement) {
            // A textarea can keep separate lines.
            value = splitAnswerItems(text).join("\n") || text;
        } else {
            // A one-line box: join list items with commas
            // and remove a final period.
            const items = splitAnswerItems(text);
            value = (items.length > 1 ? items.join(", ") : text)
                .replace(/\.\s*$/, "");
        }

        setFieldValue(field, value);
        return value;
    }

    // Enumeration with several boxes: one item per box.
    const items = splitAnswerItems(text);

    if (items.length === 0) {
        return null;
    }

    const count = Math.min(items.length, fields.length);

    for (let i = 0; i < count; i++) {
        setFieldValue(fields[i], items[i].replace(/\.\s*$/, ""));
    }

    return items.slice(0, count).join(", ") +
        (count < fields.length
            ? ` (filled ${count} of ${fields.length} boxes)`
            : "");
}


// Turn "1. Apple\n2. Banana" or "Apple, Banana" into a list.
function splitAnswerItems(text) {
    const removeMarker = (line) =>
        line.replace(
            /^\s*(?:[-*\u2022]|\(?\d+[.)]|\(?[A-Za-z][.)])\s+/,
            ""
        ).trim();

    let parts = String(text)
        .split(/\r?\n+/)
        .map(removeMarker)
        .filter(Boolean);

    if (parts.length <= 1) {
        parts = String(text)
            .split(/\s*[;,]\s*/)
            .map(removeMarker)
            .filter(Boolean);
    }

    return parts;
}


// Works for normal pages and for React/Vue pages.
function setFieldValue(field, value) {
    const prototype = field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const setter = Object.getOwnPropertyDescriptor(
        prototype,
        "value"
    )?.set;

    if (setter) {
        setter.call(field, value);
    } else {
        field.value = value;
    }

    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
}


// ============================================================
// SCROLLING (fallback for one-question-at-a-time pages)
// ============================================================

function scrollToNextQuestion(currentElement) {
    const containers = Array.from(
        document.querySelectorAll(SPECIFIC_QUESTION_SELECTOR)
    ).filter((element) => {
        return (
            isVisible(element) &&
            !element.closest(`#${OVERLAY_ID}`)
        );
    });

    const current = currentElement.matches(SPECIFIC_QUESTION_SELECTOR)
        ? currentElement
        : currentElement.closest(SPECIFIC_QUESTION_SELECTOR);

    let next = null;

    if (current) {
        const currentIndex = containers.indexOf(current);

        if (currentIndex !== -1) {
            next = containers.slice(currentIndex + 1).find((element) => {
                // Ignore nested containers belonging to the same question.
                return (
                    !current.contains(element) &&
                    !element.contains(current)
                );
            }) || null;
        }
    }

    if (next) {http://127.0.0.1:8000
        next.scrollIntoView({
            behavior: scrollBehavior(),
            block: "center"
        });
    } else {
        // Fallback for pages that do not use recognizable question containers.
        window.scrollBy({
            top: Math.max(300, Math.round(window.innerHeight * 0.75)),
            behavior: scrollBehavior()
        });
    }
}