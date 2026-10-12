// extension/popup.js
"use strict";

const $ = (id) => document.getElementById(id);

const subjectSelect = $("subject");
const backendStatus = $("backendStatus");
const message = $("message");
const startButton = $("start");
const stopButton = $("stop");

const autoAnswerToggle = $("autoAnswer");
const autoScrollToggle = $("autoScroll");
const speedSelect = $("answerSpeed");

const ALLOWED_SPEEDS = ["0", "0.25", "0.5", "1", "2", "3", "5"];
const DEFAULT_SPEED = "0";

// Tell the developer (in the popup's console) if an element that
// popup.html should have is missing, instead of crashing.
for (const [id, element] of Object.entries({
    subject: subjectSelect,
    backendStatus,
    message,
    start: startButton,
    stop: stopButton,
    autoAnswer: autoAnswerToggle,
    autoScroll: autoScrollToggle,
    answerSpeed: speedSelect
})) {
    if (!element) {
        console.warn(`popup.html has no element with id="${id}"`);
    }
}

function setMessage(text) {
    if (message) {
        message.textContent = text;
    }
}

function on(element, type, handler) {
    if (element) {
        element.addEventListener(type, handler);
    }
}

init();

on(startButton, "click", async () => {
    const subject = subjectSelect ? subjectSelect.value : "";

    if (!subject) {
        setMessage("Select a subject first.");
        return;
    }

    const settings = {
        subject,
        ...readAutomationSettings()
    };

    try {
        // Remember the choices for next time.
        await chrome.storage.local.set(settings);

        // Start ONLY the page (tab) that is open right now.
        const response = await sendToActiveTab({
            type: "QAA_START",
            settings
        });

        if (!response?.ok) {
            setMessage(
                response?.error || "Could not start on this page."
            );
            return;
        }

        setMessage(
            settings.autoAnswer
                ? "Started on this page. Auto-answer is ON."
                : "Started on this page. Watching for questions."
        );
    } catch (error) {
        setMessage(error.message);
    }
});

on(stopButton, "click", async () => {
    try {
        await sendToActiveTab({ type: "QAA_STOP" });
        setMessage("Stopped on this page.");
    } catch (error) {
        setMessage(error.message);
    }
});

on(autoAnswerToggle, "change", saveAutomationSettings);
on(autoScrollToggle, "change", saveAutomationSettings);
on(speedSelect, "change", saveAutomationSettings);

async function init() {
    // Check the backend and load the subjects at the SAME time.
    // (If the server was asleep, it starts waking up right away.)
    await Promise.all([
        loadSubjects(),
        checkBackend()
    ]);

    await restoreState();
}

// The popup talks directly to the page you are looking at.


async function sendToActiveTab(payload) {
    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    if (!tab || tab.id === undefined) {
        throw new Error("No active tab was found.");
    }

    try {
        return await chrome.tabs.sendMessage(tab.id, payload);
    } catch (error) {
        const details = {
            tabUrl: tab.url ?? "Unknown URL",
            messageType: payload?.type ?? "Unknown message",
            error: error?.message ?? String(error)
        };

        console.error(
            "Content script communication failed:", 
            JSON.stringify(details, null, 2)
        );

        throw new Error(
            `Could not contact the page script. ` +
            `Message: ${details.messageType}. ` +
            `Cause: ${details.error}`
        );
    }
}



function readAutomationSettings() {
    const speedValue = speedSelect ? speedSelect.value : DEFAULT_SPEED;

    const speed = ALLOWED_SPEEDS.includes(speedValue)
        ? Number(speedValue)
        : Number(DEFAULT_SPEED);

    return {
        autoAnswer: Boolean(autoAnswerToggle && autoAnswerToggle.checked),
        autoScroll: Boolean(autoScrollToggle && autoScrollToggle.checked),
        answerSpeed: speed
    };
}

async function saveAutomationSettings() {
    try {
        await chrome.storage.local.set(readAutomationSettings());
        setMessage("Settings saved.");
    } catch (error) {
        setMessage(`Could not save settings: ${error.message}`);
    }
}

async function loadSubjects() {
    if (!subjectSelect) {
        return;
    }

    subjectSelect.innerHTML =
        "<option value=''>Loading subjects...</option>";

    try {
        const response = await chrome.runtime.sendMessage({
            type: "GET_SUBJECTS"
        });

        if (!response?.ok) {
            subjectSelect.innerHTML =
                "<option value=''>Backend unavailable</option>";
            setMessage(
                response?.error ||
                "Could not load the subjects. Close and open this popup to try again."
            );
            return;
        }

        subjectSelect.innerHTML =
            "<option value=''>Select a subject</option>";

        for (const subject of response.subjects || []) {
            const option = document.createElement("option");
            option.value = subject.name;
            option.textContent = subject.name;
            subjectSelect.appendChild(option);
        }
    } catch (error) {
        subjectSelect.innerHTML =
            "<option value=''>Backend unavailable</option>";
    }
}

// Updates the status pill (dot + text) in the popup header.
function setBackendStatus(text, state, detail = "") {
    if (!backendStatus) {
        return;
    }

    const label = backendStatus.querySelector(".status-text");

    if (label) {
        label.textContent = text;
    } else {
        backendStatus.textContent = text;
    }

    backendStatus.classList.remove("ok", "error");

    if (state) {
        backendStatus.classList.add(state);
    }

    // Hover the pill to see the technical reason.
    backendStatus.title = detail;
}

async function checkBackend() {
    setBackendStatus(
        "Connecting...",
        "",
        "The server can take up to a minute to wake up."
    );

    try {
        const response = await chrome.runtime.sendMessage({
            type: "PING_BACKEND"
        });

        if (response?.ok) {
            setBackendStatus("Connected", "ok");
        } else {
            setBackendStatus(
                "Disconnected",
                "error",
                response?.error || ""
            );
        }
    } catch (error) {
        setBackendStatus("Disconnected", "error", error.message);
    }
}

async function restoreState() {
    const state = await chrome.storage.local.get([
        "subject",
        "autoAnswer",
        "autoScroll",
        "answerSpeed"
    ]);

    if (state.subject && subjectSelect) {
        subjectSelect.value = state.subject;
    }

    if (autoAnswerToggle) {
        autoAnswerToggle.checked = Boolean(state.autoAnswer);
    }

    if (autoScrollToggle) {
        autoScrollToggle.checked = Boolean(state.autoScroll);
    }

    if (speedSelect) {
        speedSelect.value = ALLOWED_SPEEDS.includes(
            String(state.answerSpeed)
        )
            ? String(state.answerSpeed)
            : DEFAULT_SPEED;
    }

    // Ask THIS page whether it is running.
    try {
        const status = await sendToActiveTab({ type: "QAA_STATUS" });

        setMessage(
            status?.enabled
                ? "Running on this page."
                : "Not running. Press Start."
        );
    } catch (error) {
        setMessage(
            "Not running. Refresh the page if Start does not work."
        );
    }
}