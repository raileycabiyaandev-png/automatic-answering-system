// extension/content.js
"use strict";
console.log(
    "[QAA DEBUG] content.js loaded:",
    window.location.href
);

// ============================================================
// ALLOWED SITES  (THIS IS THE MOST IMPORTANT SETTING)
//
// Auto-answer, auto-scroll and auto-Next only work on the sites
// in this list. On any other site the extension only SHOWS the
// answer. This is why your real quiz site could not auto-answer.
//
// TO FIX: add the address of YOUR quiz site below.
// Use only the domain name (no https://, no slash).
// Example:  "myquiz.example.com"
//
// Also add the same site to "matches" in manifest.json.
// ============================================================
const ALLOWED_HOSTS = [
    "localhost",
    "127.0.0.1",
    "automatic-answering-system.onrender.com",
    "semestral.amaes.com",
    "semestralexam.amaes.com",
];

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
// 0 = INSTANT (default). Other speeds pause between steps:
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

// State for pages that show MANY questions.
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

// When a lookup fails, the same question is tried again a few
// times, with a pause that grows each time.
const MAX_LOOKUP_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1500;
const failureCounts = new Map();
let retryTimer = null;
const runnerFailures = new WeakMap();
let applySkipCount = 0;

// The backend (Render free plan) can need about a minute to wake up.
const BACKGROUND_TIMEOUT_MS = 120000;

// After 8 seconds of waiting we tell the person why it is slow.
const SLOW_NOTICE_MS = 8000;

// ------------------------------------------------------------
// Keep going after the page changes.
// When "Next page" reloads the page, the extension starts again
// by itself, but ONLY if it was the extension that clicked Next
// less than a minute ago. A normal refresh does NOT start it.
// ------------------------------------------------------------
const RESUME_KEY = "qaa_resume_time";
const RESUME_MAX_AGE_MS = 60000;


function markResume() {
    try {
        sessionStorage.setItem(RESUME_KEY, String(Date.now()));
    } catch {
        // Not important.
    }
}

function clearResume() {
    try {
        sessionStorage.removeItem(RESUME_KEY);
    } catch {
        // Not important.
    }
}

function shouldResume() {
    try {
        const time = Number(sessionStorage.getItem(RESUME_KEY) || 0);

        sessionStorage.removeItem(RESUME_KEY);

        return time > 0 && Date.now() - time < RESUME_MAX_AGE_MS;
    } catch {
        return false;
    }
}


// Send a message to background.js. Never waits forever and gives a
// clear message if the extension was reloaded.
function sendToBackground(message, timeoutMs = BACKGROUND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let finished = false;

        const timer = setTimeout(() => {
            if (finished) {
                return;
            }

            finished = true;
            reject(new Error(
                "The extension took too long to respond."
            ));
        }, timeoutMs);

        const fail = (error) => {
            if (finished) {
                return;
            }

            finished = true;
            clearTimeout(timer);

            const text = String(error?.message || error || "");

            reject(new Error(
                /context invalidated/i.test(text)
                    ? "The extension was reloaded. Refresh this page."
                    : text || "The extension could not be reached."
            ));
        };

        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (finished) {
                    return;
                }

                const lastError = chrome.runtime.lastError;

                if (lastError) {
                    fail(lastError);
                    return;
                }

                finished = true;
                clearTimeout(timer);
                resolve(response);
            });
        } catch (error) {
            fail(error);
        }
    });
}

// Containers that hold exactly ONE question.
// ".que" is the question box used by Moodle quiz sites.
const SPECIFIC_QUESTION_SELECTOR =
    "fieldset, [role='radiogroup'], [data-question], " +
    ".que, .question-container, .quiz-question, .question, .quiz-item";

init();


async function init() {
    try {
        // Nothing starts by itself. The old saved "enabled" flag
        // is deleted. Only the Start button (or a Next click made
        // by this extension a moment ago) can turn it on.
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
            autoScroll,
            allowedSite: isLocalPracticePage()
        });

        startObserver();

        // Continue after the extension's own "Next page" click.
        if (shouldResume() && subject) {
            console.log("[QAA DEBUG] Continuing after Next page.");

            startAssistant({
                subject,
                autoAnswer,
                autoScroll,
                answerSpeed: state.answerSpeed
            });
        }
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

    clearTimeout(retryTimer);
    retryTimer = null;
    failureCounts.clear();
    resolutions.clear();
    applySkipCount = 0;

    answeredElements = new WeakSet();
    lastQuestionKey = "";
    lastDisplayedKey = "";
    doneShown = false;
    incompleteRetries = 0;

    enabled = true;

    // Wake the backend up right away (it may be asleep).
    sendToBackground({ type: "PING_BACKEND" }).catch(() => {});

    // Tell the person clearly when auto-answer is blocked.
    const blocked = (autoAnswer || autoScroll) && !isLocalPracticePage();

    if (blocked) {
        const host = location.hostname;

        showOverlay(
            [
                "AUTO-ANSWER IS BLOCKED ON THIS WEBSITE",
                "",
                `Website: ${host}`,
                "",
                "The extension will only SHOW answers here.",
                "",
                "To allow auto-answer, open extension/content.js and",
                `add "${host}" to ALLOWED_HOSTS.`,
                "Then reload the extension in chrome://extensions."
            ].join("\n"),
            "warning"
        );
    } else {
        showOverlay(
            "Assistant started.\nLooking for questions...",
            "info"
        );
    }

    scheduleDetection();

    if (blocked) {
        return {
            ok: false,
            error:
                `Started, but auto-answer is blocked on "${location.hostname}". ` +
                "Add this site to ALLOWED_HOSTS in content.js."
        };
    }

    return { ok: true };
}


function stopAssistant() {
    enabled = false;

    clearTimeout(detectionTimer);
    clearTimeout(answerTimer);
    clearTimeout(followUpTimer);
    clearTimeout(scrollTimer);
    clearTimeout(retryTimer);

    answerTimer = null;
    followUpTimer = null;
    retryTimer = null;

    clearResume();

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


// On a scrolling page, look at the page again after scrolling.
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
    const hasChoiceInputs = realChoiceInputs(candidate.element).length > 0;

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

    // If the server is slow, say so (instead of looking frozen).
    const slowTimer = setTimeout(() => {
        if (enabled && lastQuestionKey === questionKey) {
            showOverlay(
                [
                    "QUESTION DETECTED",
                    candidate.question,
                    "",
                    "Still looking for the answer...",
                    "The server may be waking up.",
                    "Please wait. This can take up to 1 minute."
                ].join("\n"),
                "info"
            );
        }
    }, SLOW_NOTICE_MS);

    try {
        await lookupAndShow(candidate);
        failureCounts.delete(questionKey);
    } catch (error) {
        handleLookupFailure(candidate, questionKey, error);
    } finally {
        clearTimeout(slowTimer);
        requestInProgress = false;
    }

    // The page may have moved to another question while we were
    // waiting. Look again (does nothing if it is the same one).
    if (enabled) {
        scheduleDetection();
    }
}


// Database first, then Gemini. Throws when no answer could be
// obtained, so the caller can try again.
async function lookupAndShow(candidate) {
    // CHANGED: uses lookupDatabase, which also tries the text
    // before / after an answer box.
    const match = await lookupDatabase(candidate);

    // The user pressed Stop while we were waiting.
    if (!enabled) {
        return;
    }

    if (!match) {
        throw new Error(
            "The backend returned no matching result."
        );
    }

    // The database found an answer AND we can pick a choice
    // (or there are no choices to pick from).
    if (match.matched && answerFitsChoices(candidate, match)) {
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

    // No usable database answer: try Gemini.
    await requestStudyHelp(candidate);
}


// A database answer is only useful if it points to one of
// the choices on the page. If not, we ask Gemini instead.
function answerFitsChoices(candidate, match) {
    if (!candidate.choices || candidate.choices.length === 0) {
        return true;
    }

    return choiceIndexFor(
        candidate.choices,
        match.answer,
        match
    ) !== -1;
}


// A lookup failed. Try the same question again after a pause.
function handleLookupFailure(candidate, questionKey, error) {
    console.error("Question lookup failed:", error);

    if (!enabled) {
        return;
    }

    const tries = (failureCounts.get(questionKey) || 0) + 1;
    failureCounts.set(questionKey, tries);

    if (tries > MAX_LOOKUP_RETRIES) {
        showOverlay(
            [
                "QUESTION DETECTED",
                candidate.question,
                "",
                "Could not get an answer after several tries.",
                error.message,
                "",
                "Press Start in the popup to try again."
            ].join("\n"),
            "error"
        );
        return;
    }

    const delay = RETRY_BASE_DELAY_MS * tries;

    showOverlay(
        [
            "QUESTION DETECTED",
            candidate.question,
            "",
            `Could not get an answer yet (try ${tries} of ${MAX_LOOKUP_RETRIES}).`,
            error.message,
            "",
            `Trying again in ${Math.round(delay / 1000)} seconds...`
        ].join("\n"),
        "warning"
    );

    clearTimeout(retryTimer);

    retryTimer = setTimeout(() => {
        retryTimer = null;

        // Only retry if the page still shows this same question.
        if (enabled && lastQuestionKey === questionKey) {
            lastQuestionKey = "";
            scheduleDetection();
        }
    }, delay);
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
// Throws when Gemini cannot answer, so the caller can try again.
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

    const response = await sendToBackground({
        type: "STUDY_HELP",
        payload: {
            subject,
            question: candidate.question,
            choices: candidate.choices
        }
    });

    if (!response || !response.ok) {
        throw new Error(
            response?.error || "The AI request failed."
        );
    }

    if (!enabled) {
        return;
    }

    if (!validAiResult(response.result)) {
        throw new Error("Gemini did not return an answer.");
    }

    displayStudyHelpResult(
        candidate,
        response.result
    );
}


// A question box that sits INSIDE a Moodle ".que" box is part
// of that question. We only use the whole ".que" box.
function insideMoodleQuestion(element) {
    const box = element.closest(".que");

    return Boolean(box) && box !== element;
}


// ============================================================
// MATCHING QUESTIONS (a table of rows, each with a
// drop-down list). Moodle's "match" question type.
//
// Each ROW is treated as its own multiple choice question:
//   question = the text on the left of the row
//   choices  = the options of the drop-down (without "Choose...")
// This way the database / Gemini lookup works with no change
// in the backend.
// ============================================================

// The first option of a Moodle drop-down ("Choose...") has the
// value 0 (or is empty). It is not a real answer.
function isMatchPlaceholder(option) {
    return option.value === "" || option.value === "0";
}


// The real options of a drop-down, in page order.
function matchOptions(select) {
    return Array.from(select.options).filter(
        (option) => !isMatchPlaceholder(option)
    );
}


// All table rows (inside a quiz question) that have a drop-down.
function matchRows(root) {
    return Array.from(
        root.querySelectorAll(".que tr, table.answer tr")
    ).filter((row) => row.querySelector("select"));
}


// A container that is a matching question (it has drop-down rows
// and no radio buttons or checkboxes of its own).
function isMatchContainer(element) {
    return (
        matchRows(element).length > 0 &&
        realChoiceInputs(element).length === 0
    );
}


// Build a question out of ONE row of a matching question.
function buildMatchRowCandidate(row) {
    const select = row.querySelector("select");

    if (!select || select.disabled) {
        return null;
    }

    const promptCell =
        row.querySelector("td.text") || row.querySelector("td");

    // The text cell must not be the cell that holds the drop-down,
    // or the options would be read as the question.
    if (!promptCell || promptCell.contains(select)) {
        return null;
    }

    const question = clean(
        promptCell.innerText || promptCell.textContent || ""
    );

    if (question.length < 2) {
        return null;
    }

    const options = matchOptions(select);

    if (options.length < 2) {
        return null;
    }

    // Not made unique on purpose: the position of each choice must
    // stay the same as the position of its option.
    const choices = options.map((option) =>
        clean(option.textContent || "")
    );

    let score = 30;

    if (question.length >= 10 && question.length <= 500) {
        score += 10;
    }

    return {
        question: question.slice(0, 1500),
        choices,
        element: row,
        select,
        score
    };
}


// Pick the option in the drop-down that the answer points to.
function selectMatchingOption(candidate, answer, result) {
    const select = candidate.select;

    if (!select || !select.isConnected || select.disabled) {
        return null;
    }

    const options = matchOptions(select);

    const choices = options.map((option) =>
        clean(option.textContent || "")
    );

    const index = choiceIndexFor(choices, answer, result);

    if (index === -1 || !options[index]) {
        return null;
    }

    const option = options[index];

    select.value = option.value;
    option.selected = true;

    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));

    if (select.value !== option.value) {
        return null;
    }

    return clean(option.textContent || "") || String(answer);
}


// ============================================================
// NEW: ITEMS WITH AN ANSWER BOX (identification / fill in the
// blank). The database is also searched with the text that sits
// right BEFORE the box and the text that sits right AFTER it,
// because the stored question may only match one of those parts.
// ============================================================

// The text boxes of a question that can really be filled in.
function visibleTextFields(root) {
    return Array.from(
        root.querySelectorAll(
            "input:not([type]), input[type='text'], " +
            "input[type='search'], textarea"
        )
    ).filter((field) =>
        !field.disabled &&
        !field.readOnly &&
        isVisible(field)
    );
}


// Readable text of a piece of the page. Hidden helper text
// (screen reader labels), inputs and drop-downs are removed.
function cleanFragmentText(node) {
    const box = document.createElement("div");

    box.appendChild(node);

    box.querySelectorAll(
        ".accesshide, .sr-only, script, style, " +
        "input, select, textarea, option"
    ).forEach((item) => item.remove());

    // Keep words from touching each other between paragraphs.
    box.querySelectorAll("p, br, div, li, tr, td").forEach((item) => {
        item.after(" ");
    });

    return clean(
        (box.textContent || "").replace(/_{2,}/g, " ")
    );
}


// Text before and text after a box, inside one container.
function textAround(scope, field) {
    const beforeRange = document.createRange();
    beforeRange.setStart(scope, 0);
    beforeRange.setEndBefore(field);

    const afterRange = document.createRange();
    afterRange.setStartAfter(field);
    afterRange.setEnd(scope, scope.childNodes.length);

    return [
        cleanFragmentText(beforeRange.cloneContents()),
        cleanFragmentText(afterRange.cloneContents())
    ];
}


function splitSentences(text) {
    return String(text || "")
        .split(/(?<=[.!?])\s+/)
        .map(clean)
        .filter(Boolean);
}


// Search phrases for an item with an answer box, best first:
//   1. the sentence right before the box
//   2. the first sentence before the box
//   3. all the text before the box
//   4. the sentence right after the box
//   5. the last sentence after the box
//   6. all the text after the box
function buildBlankQueries(element) {
    const field = visibleTextFields(element)[0];

    if (!field) {
        return [];
    }

    let before = "";
    let after = "";

    const textBoxes = element.querySelectorAll(
        ".qtext, .question-text"
    );

    if (textBoxes.length === 1) {
        const box = textBoxes[0];

        if (box.contains(field)) {
            // The box is INSIDE the sentence (fill in the blank).
            [before, after] = textAround(box, field);
        } else {
            // The box is under the question text.
            before = cleanFragmentText(box.cloneNode(true));
        }
    } else {
        [before, after] = textAround(element, field);
    }

    const beforeSentences = splitSentences(before);
    const afterSentences = splitSentences(after);

    const phrases = [
        beforeSentences[beforeSentences.length - 1],
        beforeSentences[0],
        before,
        afterSentences[0],
        afterSentences[afterSentences.length - 1],
        after
    ];

    return phrases
        .map((phrase) => clean(phrase || "").slice(0, 500))
        .filter((phrase) => phrase.length >= 4);
}


// The question itself first, then the extra search phrases.
// Duplicates are removed.
function questionVariants(candidate) {
    const all = [
        candidate.question,
        ...(candidate.altQuestions || [])
    ];

    const seen = new Set();
    const result = [];

    for (const text of all) {
        const key = normalize(text);

        if (!key || seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(text);
    }

    return result;
}


// Collect possible question containers from the page.
function findBestQuestionCandidate() {
    const selectors = [
        "fieldset",
        "[role='radiogroup']",
        "[role='group']",
        "[data-question]",
        ".que",
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

            if (insideMoodleQuestion(element)) {
                continue;
            }

            // Matching questions are handled row by row.
            if (isMatchContainer(element)) {
                continue;
            }

            const candidate = buildCandidate(element);

            if (candidate) {
                if (
                    selector === "fieldset" ||
                    selector === "[role='radiogroup']" ||
                    selector === "[data-question]" ||
                    selector === ".que"
                ) {
                    candidate.score += 40;
                }

                candidates.push(candidate);
            }
        }
    }

    // Every row of a matching question is a candidate.
    for (const row of matchRows(document)) {
        if (
            row.closest(`#${OVERLAY_ID}`) ||
            !isVisible(row)
        ) {
            continue;
        }

        const candidate = buildMatchRowCandidate(row);

        if (candidate) {
            candidate.score += 40;
            candidates.push(candidate);
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
    // A table row with a drop-down is a matching question row.
    if (element.matches && element.matches("tr")) {
        return buildMatchRowCandidate(element);
    }

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

    const candidate = {
        question,
        choices,
        element,
        score
    };

    // NEW: an item with an answer box also gets extra search
    // phrases (the text before / after the box).
    if (choices.length === 0) {
        candidate.altQuestions = buildBlankQueries(element);
    }

    return candidate;
}


// Extract the question from the container's visible text.
function extractQuestion(element) {
    // Moodle (and similar sites) put the question text in a
    // box called "qtext". Use it when this container has exactly one.
    const textBoxes = element.querySelectorAll(
        ".qtext, .question-text"
    );

    if (textBoxes.length === 1) {
        const text = removeQuestionNumber(
            clean(
                textBoxes[0].innerText ||
                textBoxes[0].textContent ||
                ""
            )
        );

        if (text.length >= 3) {
            return text.slice(0, 1500);
        }
    }

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


// Radio buttons and checkboxes that are really answer
// choices. Moodle has a hidden "Flag question" checkbox that
// must NOT be counted as a choice.
function isRealChoice(input) {
    const name = input.getAttribute("name") || "";

    return !(
        /:flagged$/.test(name) ||
        input.classList.contains("questionflagcheckbox") ||
        input.closest(".questionflag") ||
        // Moodle's hidden "Clear my choice" radio button.
        input.closest(".qtype_multichoice_clearchoice") ||
        (input.type === "radio" && input.value === "-1")
    );
}


function realChoiceInputs(root) {
    return Array.from(
        root.querySelectorAll(
            "input[type='radio'], input[type='checkbox']"
        )
    ).filter(isRealChoice);
}


// Extract choices from labels or text such as "A. Example".
function extractChoices(element) {
    const choices = [];

    for (const input of realChoiceInputs(element)) {
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

    // Moodle's multiple choice uses aria-labelledby that
    // points to a <div> instead of a <label>.
    const labelledBy = input.getAttribute("aria-labelledby");

    if (labelledBy) {
        for (const labelId of labelledBy.split(/\s+/)) {
            const element = document.getElementById(labelId);

            if (element) {
                return element;
            }
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

    const lines = [
        "QUESTION DETECTED",
        candidate.question,
        "",
        "MATCHED ANSWER",
        result.answer || "(empty answer)",
        choice,
        `Confidence: ${Math.round(result.confidence * 100)}%`
    ];

    // NEW: tell which part of the question found the answer.
    if (result.searched_text) {
        lines.push("", "Found using:", result.searched_text);
    }

    lines.push(
        "",
        "Source:",
        result.source_url || "Local question database"
    );

    showOverlay(lines.join("\n"), "success");

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

    const lines = [
        "QUESTION DETECTED",
        candidate.question,
        "",
        "CHOICES",
        choicesText
    ];

    // NEW: show the extra search phrases for items with a box.
    const extra = questionVariants(candidate).slice(1);

    if (extra.length > 0) {
        lines.push(
            "",
            "ALSO SEARCHING WITH",
            ...extra.map((text, index) => `${index + 1}. ${text}`)
        );
    }

    return lines.join("\n");
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


// True only on the sites listed in ALLOWED_HOSTS (at the top of
// this file). Subdomains of an allowed site also count.
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
//  1. Find every question block on the page.
//  2. Look up the answers for the next few questions AT THE SAME
//     TIME (database first, Gemini only when needed).
//  3. Go through the questions in order: scroll to it, answer it,
//     wait a moment, move on.
//  4. When all are answered, click "Next page" (if the
//     Auto-scroll switch is ON).
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
// a .que / .question / .quiz-question style container.
function findBlocksFromContainers() {
    const found = [];

    for (const element of document.querySelectorAll(
        SPECIFIC_QUESTION_SELECTOR
    )) {
        if (
            element.closest(`#${OVERLAY_ID}`) ||
            !isVisible(element) ||
            insideMoodleQuestion(element)
        ) {
            continue;
        }

        // A matching question is not one block. Its ROWS are.
        if (isMatchContainer(element)) {
            continue;
        }

        const candidate = buildCandidate(element);

        if (candidate && hasAnswerArea(candidate)) {
            found.push(candidate);
        }
    }

    // Every row of every matching question is a block.
    for (const row of matchRows(document)) {
        if (
            row.closest(`#${OVERLAY_ID}`) ||
            !isVisible(row)
        ) {
            continue;
        }

        const candidate = buildMatchRowCandidate(row);

        if (candidate) {
            found.push(candidate);
        }
    }

    // Keep the blocks in the same order as on the page.
    found.sort((a, b) => {
        if (a.element === b.element) {
            return 0;
        }

        const position = a.element.compareDocumentPosition(b.element);

        return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    return removeNestedBlocks(found);
}


// Way 2: pages without special classes. Every group of radio
// buttons (same name) is treated as one question.
function findBlocksFromChoiceGroups() {
    const inputs = realChoiceInputs(document).filter((input) =>
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
// CHANGED: for items with an answer box it tries the full question
// first, then the text before / after the box. It stops at the
// first phrase that gives a usable match.
async function lookupDatabase(candidate) {
    const variants = questionVariants(candidate);

    let firstResult = null;

    for (let index = 0; index < variants.length; index++) {
        const text = variants[index];
        let result;

        try {
            const response = await sendToBackground({
                type: "MATCH_QUESTION",
                payload: {
                    subject,
                    question: text,
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

            result = response.result;
        } catch (error) {
            // A problem with the FIRST request is a real failure
            // (the caller will try again). Later phrases that fail
            // are simply skipped.
            if (index === 0) {
                throw error;
            }

            continue;
        }

        if (result.match_type === "subject_not_found") {
            return result;
        }

        if (result.matched && answerFitsChoices(candidate, result)) {
            return index === 0
                ? result
                : { ...result, searched_text: text };
        }

        if (!firstResult) {
            firstResult = result;
        }

        // The user pressed Stop: do not search any further.
        if (!enabled) {
            break;
        }
    }

    return firstResult;
}


// Send a message. If the AI service is busy, try again quickly.
async function sendWithRetry(message) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await sendToBackground(message);

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

        // The database answer must point to a choice on the page.
        if (match.matched && answerFitsChoices(candidate, match)) {
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
        prefetchAhead(blocks, 0, blocks.length);

        showOverlay(
            [
                `Found ${blocks.length} questions.`,
                "Looking up the answers...",
                "",
                "The first request can take up to a minute if the",
                "backend was asleep."
            ].join("\n"),
            "info"
        );

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

                    // Go to the next page (only once).
                    if (autoScroll) {
                        const nextButton = findNextButton();

                        if (nextButton) {
                            if (NEXT_DELAY_MS > 0) {
                                await sleep(NEXT_DELAY_MS);
                            }

                            if (enabled && autoAnswer && autoScroll) {
                                // CHANGED: different text for the
                                // "Finish attempt" button.
                                const goingText = isFinishButton(nextButton)
                                    ? "Opening the summary page (Finish attempt).\n" +
                                      "Nothing is submitted. Press\n" +
                                      "\"Submit all and finish\" yourself."
                                    : "Going to the next page...";

                                showOverlay(
                                    `ALL QUESTIONS ANSWERED\n\n${goingText}`,
                                    "success"
                                );

                                clickNext(nextButton);
                            }
                        }
                    }
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

            // A failed lookup (backend asleep, AI busy) is tried
            // again a few times before the question is skipped.
            if (resolution.kind === "error") {
                const failures =
                    (runnerFailures.get(target.element) || 0) + 1;

                runnerFailures.set(target.element, failures);

                if (failures <= MAX_LOOKUP_RETRIES) {
                    showOverlay(
                        [
                            `QUESTION ${number} OF ${total}`,
                            target.question,
                            "",
                            `Could not get an answer yet (try ${failures} of ${MAX_LOOKUP_RETRIES}).`,
                            resolution.error || "",
                            "",
                            "Trying again..."
                        ].join("\n"),
                        "warning"
                    );

                    await sleep(RETRY_BASE_DELAY_MS * failures);
                    continue;
                }
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


// Select a choice, pick a drop-down option, or type into a text box.
function performAnswer(candidate, answer, result) {
    // A row of a matching question (drop-down list).
    if (candidate.select) {
        return selectMatchingOption(candidate, answer, result);
    }

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
    const wanted = normalize(candidate.question);
    let latest = null;

    // First look at the same part of the page again.
    if (candidate.element.isConnected) {
        const rebuilt = buildCandidate(candidate.element);

        if (rebuilt && normalize(rebuilt.question) === wanted) {
            latest = rebuilt;
        }
    }

    // The page may have re-drawn itself: search the page again.
    if (!latest) {
        const best = findBestQuestionCandidate();

        if (best && normalize(best.question) === wanted) {
            latest = best;
        }
    }

    if (!latest) {
        showOverlay(
            [
                "ANSWER SKIPPED",
                "",
                "The question on the page changed before the",
                "answer could be applied. Nothing was selected."
            ].join("\n"),
            "warning"
        );

        // Look at the page again instead of getting stuck.
        applySkipCount++;

        if (applySkipCount <= 3) {
            lastQuestionKey = "";
            scheduleDetection();
        }

        return;
    }

    applySkipCount = 0;

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


// Click a "Next" button. The page may reload, so we leave a
// small note that lets the extension continue by itself.
// CHANGED: "Finish attempt" is allowed (it only opens the summary
// page). A button that SUBMITS the quiz is never clicked.
function clickNext(button) {
    if (isSubmitButton(button)) {
        console.warn("[QAA DEBUG] Refused to click a Submit button.");
        return;
    }

    if (isFinishButton(button)) {
        // The summary page has no questions. Do not resume there.
        clearResume();
        stopAfterFinish();
        button.click();
        return;
    }

    markResume();

    // If the page did not reload, remove the note again.
    setTimeout(clearResume, 8000);

    button.click();
}


// After "Finish attempt" the assistant stops by itself, so it
// does nothing on the summary page.
function stopAfterFinish() {
    enabled = false;

    clearTimeout(detectionTimer);
    clearTimeout(answerTimer);
    clearTimeout(followUpTimer);
    clearTimeout(scrollTimer);
    clearTimeout(retryTimer);

    answerTimer = null;
    followUpTimer = null;
    retryTimer = null;
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

            clickNext(nextButton);

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

        // Other pages: use ordinary scrolling.
        scrollToNextQuestion(currentElement);

        setTimeout(() => {
            if (enabled) {
                scheduleDetection();
            }
        }, AFTER_CLICK_MS);

    }, NEXT_DELAY_MS);
}


function isDisabledElement(element) {
    return (
        element.disabled === true ||
        element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true"
    );
}


function buttonLabel(element) {
    const raw = element instanceof HTMLInputElement
        ? element.value
        : element.textContent;

    return clean(raw || "");
}


// "Finish attempt ..." only opens the summary page in Moodle.
// It does NOT submit the answers, so it may be clicked.
function isFinishButton(element) {
    return /\bfinish\b/i.test(buttonLabel(element)) &&
        !isSubmitButton(element);
}


// A button that really submits the quiz ("Submit all and finish").
// The extension never clicks it.
function isSubmitButton(element) {
    return /\bsubmit\b/i.test(buttonLabel(element));
}


// Find the "Next" button.
function findNextButton() {
    // Your practice page's own button, and the Moodle one.
    // On the last Moodle page the Moodle button says
    // "Finish attempt ..." and is allowed.
    const known = document.querySelector(
        "#next-question, #mod_quiz-next-nav"
    );

    if (
        known &&
        !isDisabledElement(known) &&
        isVisible(known) &&
        !isSubmitButton(known)
    ) {
        return known;
    }

    // Other pages: a button whose whole text is "Next",
    // "Next Question", "Next Page" or "Continue".
    // Buttons such as "Submit" are never clicked.
    const elements = Array.from(
        document.querySelectorAll(
            "button, input[type='button'], input[type='submit'], " +
            "a[role='button'], [role='button']"
        )
    );

    return elements.find((element) => {
        if (
            element.closest(`#${OVERLAY_ID}`) ||
            isDisabledElement(element) ||
            !isVisible(element)
        ) {
            return false;
        }

        const label = buttonLabel(element).replace(
            /\s*[>\u00BB\u2192\u203A]+\s*$/,
            ""
        );

        return /^(next|next question|next page|continue)$/i.test(label);
    }) || null;
}


// ============================================================
// MULTIPLE CHOICE
// ============================================================

// Finds WHICH choice the answer points to. Returns -1 when
// no choice fits.
function choiceIndexFor(choices, answer, result) {
    result = result || {};

    if (!choices || choices.length === 0) {
        return -1;
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

            // Last resort: the choice that shares the most words
            // with the answer (only when there is one clear winner).
            if (choiceIndex === -1) {
                choiceIndex = bestWordOverlapChoice(
                    normalizedAnswer,
                    choices
                );
            }
        }
    }

    return choiceIndex;
}


// Tick a radio button or checkbox in the safest way.
function checkInput(input) {
    if (input.checked) {
        return true;
    }

    input.click();

    if (input.checked) {
        return true;
    }

    // Some sites need the click on the label.
    const label = findLabel(input);

    if (label) {
        label.click();
    }

    if (input.checked || !input.isConnected) {
        return true;
    }

    // Last try: set it ourselves and tell the page.
    input.checked = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    return input.checked;
}


function selectMatchingChoice(candidate, answer, result) {
    const choices = candidate.choices || [];

    if (choices.length === 0) {
        return null;
    }

    const choiceIndex = choiceIndexFor(choices, answer, result);

    if (choiceIndex === -1) {
        return null;
    }

    const chosenText = choices[choiceIndex];
    const wantedText = normalize(stripChoicePrefix(chosenText));

    const inputs = realChoiceInputs(candidate.element)
        .filter((input) => !input.disabled);

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
        const ok = checkInput(input);

        // If the page re-drew the radio button, the old one is no
        // longer on the page. That is not a failure.
        if (!ok && input.isConnected) {
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


function bestWordOverlapChoice(normalizedAnswer, choices) {
    const toWords = (text) =>
        new Set(
            normalize(text)
                .split(" ")
                .filter((word) => word.length > 2)
        );

    const answerWords = toWords(normalizedAnswer);

    if (answerWords.size === 0) {
        return -1;
    }

    let bestIndex = -1;
    let bestScore = 0;
    let tie = false;

    choices.forEach((choice, index) => {
        const words = toWords(stripChoicePrefix(choice));

        if (words.size === 0) {
            return;
        }

        let shared = 0;

        for (const word of words) {
            if (answerWords.has(word)) {
                shared++;
            }
        }

        const score = shared / Math.max(words.size, answerWords.size);

        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
            tie = false;
        } else if (score === bestScore && score > 0) {
            tie = true;
        }
    });

    return bestScore >= 0.6 && !tie ? bestIndex : -1;
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
        /^\s*[A-Ha-h]\s*[.):\-]\s*/,
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

    const fields = visibleTextFields(container);

    if (fields.length === 0) {
        return null;
    }

    // Safety: only type when we are sure these boxes belong to
    // THIS question.
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

    if (next) {
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