const SHOW_URL = "./show.json";

const title = document.getElementById("title");
const waiting = document.getElementById("waiting");
const countdown = document.getElementById("countdown");
const startText = document.getElementById("start");
const playerBox = document.getElementById("playerBox");
const finished = document.getElementById("finished");
const player = document.getElementById("player");
const status = document.getElementById("status");

let show = null;
let started = false;
let serviceWorkerReady = false;

function now() {
    return Date.now();
}

function formatTime(ms) {
    let seconds = Math.max(0, Math.ceil(ms / 1000));

    const days = Math.floor(seconds / 86400);
    seconds %= 86400;

    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;

    const minutes = Math.floor(seconds / 60);
    seconds %= 60;

    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    return days
        ? `${days}д ${hh}:${mm}:${ss}`
        : `${hh}:${mm}:${ss}`;
}

function formatDate(timestamp) {
    return new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "Europe/Kaliningrad"
    }).format(timestamp);
}

function showWaiting(start) {
    waiting.hidden = false;
    playerBox.hidden = true;
    finished.hidden = true;

    countdown.textContent = formatTime(start - now());
    startText.textContent = `Начало: ${formatDate(start)}`;
}

function showFinished() {
    waiting.hidden = true;
    playerBox.hidden = true;
    finished.hidden = false;

    player.pause();
}

async function startPlayback(start) {
    if (started || !serviceWorkerReady) {
        return;
    }

    started = true;

    waiting.hidden = true;
    finished.hidden = true;
    playerBox.hidden = false;

    const elapsed = Math.max(
        0,
        (now() - start) / 1000
    );

    status.textContent = "Подготовка видео...";

    if (player.readyState < 1) {
        await new Promise(resolve => {
            player.addEventListener(
                "loadedmetadata",
                resolve,
                { once: true }
            );
        });
    }

    try {
        player.currentTime = elapsed;
    } catch {
        status.textContent = "Не удалось установить позицию видео.";
        return;
    }

    try {
        await player.play();
        status.textContent = "Показ идёт.";
    } catch {
        status.textContent = "Нажмите ▶ для начала воспроизведения.";
    }
}

function update() {
    if (!show) {
        return;
    }

    const start = Date.parse(show.start);
    const end = start + show.duration * 1000;
    const current = now();

    if (current < start) {
        started = false;
        showWaiting(start);
        return;
    }

    if (current >= end) {
        showFinished();
        return;
    }

    startPlayback(start);
}

async function load() {
    const response = await fetch(
        `${SHOW_URL}?t=${Date.now()}`,
        {
            cache: "no-store"
        }
    );

    if (!response.ok) {
        throw new Error("Не удалось загрузить show.json");
    }

    show = await response.json();

    title.textContent = show.title || "Кинопоказ";

    if (!show.chunks || !show.chunks.length) {
        throw new Error("Видео ещё не опубликовано.");
    }

    if (!show.size || !show.duration) {
        throw new Error("Некорректный show.json.");
    }

    if (!("serviceWorker" in navigator)) {
        throw new Error(
            "Браузер не поддерживает Service Worker."
        );
    }

    const registration =
        await navigator.serviceWorker.register("./sw.js");

    await navigator.serviceWorker.ready;

    const worker =
        registration.active ||
        navigator.serviceWorker.controller;

    if (!worker) {
        throw new Error(
            "Service Worker ещё не активен. Обновите страницу."
        );
    }

    worker.postMessage({
        type: "SET_MANIFEST",
        manifest: {
            chunks: show.chunks,
            size: show.size,
            mime: show.mime || "video/mp4"
        }
    });

    serviceWorkerReady = true;

    player.src =
        `${location.origin}${location.pathname}movie.mp4`;

    update();

    setInterval(update, 250);
}

load().catch(error => {
    console.error(error);

    title.textContent = "Ошибка";
    waiting.hidden = false;
    playerBox.hidden = true;
    finished.hidden = true;

    countdown.textContent = error.message;
});