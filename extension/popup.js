// extension/popup.js
"use strict";

const subjectSelect = document.getElementById("subject");
const backendStatus = document.getElementById("backendStatus");
const message = document.getElementById("message");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");

const autoAnswerToggle = document.getElementById("autoAnswer");
const autoScrollToggle = document.getElementById("autoScroll");
const speedSelect = document.getElementById("answerSpeed");

const ALLOWED_SPEEDS = ["0", "0.25", "0.5", "1", "2", "3", "5"];
const DEFAULT_SPEED = "0";

init();

startButton.addEventListener("click", async () => {
    const subject = subjectSelect.value;

    if (!subject) {
        message.textContent = "Select a subject first.";
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
            message.textContent =
                response?.error || "Could not start on this page.";
            return;
        }

        message.textContent = settings.autoAnswer
            ? "Started on this page. Auto-answer is ON."
            : "Started on this page. Watching for questions.";
    } catch (error) {
        message.textContent = error.message;
    }
});

stopButton.addEventListener("click", async () => {
    try {
        await sendToActiveTab({ type: "QAA_STOP" });
        message.textContent = "Stopped on this page.";
    } catch (error) {
        message.textContent = error.message;
    }
});

autoAnswerToggle.addEventListener("change", saveAutomationSettings);
autoScrollToggle.addEventListener("change", saveAutomationSettings);
speedSelect.addEventListener("change", saveAutomationSettings);

async function init() {
    await loadSubjects();
    await checkBackend();
    await restoreState();
}

// The popup talks directly to the page you are looking at.
async function sendToActiveTab(payload) {
    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    if (!tab || tab.id === undefined) {
        throw new Error("No active page was found.");
    }

    try {
        return await chrome.tabs.sendMessage(tab.id, payload);
    } catch (error) {
        throw new Error(
            "This page is not ready. Refresh the page, then press Start."
        );
    }
}

function readAutomationSettings() {
    const speed = ALLOWED_SPEEDS.includes(speedSelect.value)
        ? Number(speedSelect.value)
        : Number(DEFAULT_SPEED);

    return {
        autoAnswer: autoAnswerToggle.checked,
        autoScroll: autoScrollToggle.checked,
        answerSpeed: speed
    };
}

async function saveAutomationSettings() {
    try {
        await chrome.storage.local.set(readAutomationSettings());
        message.textContent = "Settings saved.";
    } catch (error) {
        message.textContent =
            `Could not save settings: ${error.message}`;
    }
}

async function loadSubjects() {
    try {
        const response = await chrome.runtime.sendMessage({
            type: "GET_SUBJECTS"
        });

        if (!response?.ok) {
            subjectSelect.innerHTML =
                "<option value=''>Backend unavailable</option>";
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

async function checkBackend() {
    try {
        const response = await chrome.runtime.sendMessage({
            type: "PING_BACKEND"
        });

        backendStatus.textContent = response?.ok
            ? "Backend: Connected"
            : `Backend: Disconnected${response?.error
                ? ` — ${response.error}`
                : ""}`;
    } catch (error) {
        backendStatus.textContent = "Backend: Disconnected";
    }
}

async function restoreState() {
    const state = await chrome.storage.local.get([
        "subject",
        "autoAnswer",
        "autoScroll",
        "answerSpeed"
    ]);

    if (state.subject) {
        subjectSelect.value = state.subject;
    }

    autoAnswerToggle.checked = Boolean(state.autoAnswer);
    autoScrollToggle.checked = Boolean(state.autoScroll);

    speedSelect.value = ALLOWED_SPEEDS.includes(
        String(state.answerSpeed)
    )
        ? String(state.answerSpeed)
        : DEFAULT_SPEED;

    // Ask THIS page whether it is running.
    try {
        const status = await sendToActiveTab({ type: "QAA_STATUS" });

        message.textContent = status?.enabled
            ? "Running on this page."
            : "Not running. Press Start.";
    } catch (error) {
        message.textContent =
            "Not running. Refresh the page if Start does not work.";
    }
}