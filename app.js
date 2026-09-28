"use strict";

const SHOW_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev/show.json";

const SHOW_REFRESH_MS = 15000;
const SYNC_MS = 250;

const video = document.getElementById("player");

let showData = null;
let currentShowId = null;
let currentMovieUrl = null;

let loadingMovie = false;
let showRequestController = null;
let showRequestNumber = 0;

let suppressSeeking = false;


/*
 * ============================================================
 * Время
 * ============================================================
 */

function nowUnix() {
    return Date.now() / 1000;
}


function clamp(value, min, max) {
    return Math.min(
        max,
        Math.max(min, value)
    );
}


/*
 * ============================================================
 * Паузы
 * ============================================================
 */

function getPausedDuration(data) {
    const intervals = data?.pauseIntervals;

    if (!Array.isArray(intervals)) {
        return 0;
    }

    let total = 0;

    for (const item of intervals) {
        if (!item || typeof item !== "object") {
            continue;
        }

        const begin = Number(item.startUnix);
        const end = Number(item.endUnix);

        if (
            Number.isFinite(begin) &&
            Number.isFinite(end) &&
            end >= begin
        ) {
            total += end - begin;
        }
    }

    return Math.max(0, total);
}


/*
 * ============================================================
 * Позиция фильма по расписанию
 * ============================================================
 */

function getSchedulePosition(data) {
    if (!data) {
        return 0;
    }

    const startUnix = Number(data.startUnix);

    if (!Number.isFinite(startUnix)) {
        return 0;
    }

    const now = nowUnix();

    /*
     * Показ ещё не начался.
     */
    if (now < startUnix) {
        return 0;
    }

    /*
     * Во время паузы position из JSON
     * является единственным источником истины.
     */
    if (data.pause) {
        const pausePosition = Number(data.pausePosition);

        if (Number.isFinite(pausePosition)) {
            return Math.max(0, pausePosition);
        }

        return 0;
    }

    /*
     * Обычное воспроизведение.
     */
    const paused = getPausedDuration(data);

    return Math.max(
        0,
        now - startUnix - paused
    );
}


/*
 * ============================================================
 * Player
 * ============================================================
 */

function hidePlayer() {
    video.style.display = "none";

    try {
        video.pause();
    } catch (_) {
        // ignore
    }
}


function showPlayer() {
    video.style.display = "block";
}


/*
 * ============================================================
 * Установка позиции
 * ============================================================
 */

function setVideoTime(position) {
    if (!Number.isFinite(position)) {
        return;
    }

    if (
        !Number.isFinite(video.duration) ||
        video.duration <= 0
    ) {
        return;
    }

    const target = clamp(
        position,
        0,
        Math.max(0, video.duration - 0.05)
    );

    if (
        Math.abs(video.currentTime - target) < 0.35
    ) {
        return;
    }

    suppressSeeking = true;

    try {
        video.currentTime = target;
    } catch (_) {
        // ignore
    }

    setTimeout(() => {
        suppressSeeking = false;
    }, 150);
}


/*
 * ============================================================
 * Загрузка фильма
 * ============================================================
 */

async function loadMovie(url) {
    if (!url) {
        return;
    }

    if (
        loadingMovie &&
        currentMovieUrl === url
    ) {
        return;
    }

    if (
        currentMovieUrl === url &&
        video.src
    ) {
        return;
    }

    loadingMovie = true;
    currentMovieUrl = url;

    suppressSeeking = true;

    try {
        video.pause();

        video.src = url;
        video.load();

        await new Promise(resolve => {
            if (video.readyState >= 1) {
                resolve();
                return;
            }

            const handler = () => {
                video.removeEventListener(
                    "loadedmetadata",
                    handler
                );

                resolve();
            };

            video.addEventListener(
                "loadedmetadata",
                handler
            );
        });

    } catch (error) {
        console.error(
            "Ошибка загрузки фильма:",
            error
        );

    } finally {
        loadingMovie = false;

        setTimeout(() => {
            suppressSeeking = false;
        }, 150);
    }
}


/*
 * ============================================================
 * Синхронизация видео
 * ============================================================
 */

function syncVideo() {
    if (!showData) {
        return;
    }

    if (
        !Number.isFinite(video.duration) ||
        video.duration <= 0
    ) {
        return;
    }

    const position =
        getSchedulePosition(showData);

    /*
     * Фильм закончился.
     */
    if (
        position >= video.duration - 0.1
    ) {
        hidePlayer();
        return;
    }

    showPlayer();

    /*
     * ========================================================
     * ПАУЗА
     * ========================================================
     */

    if (showData.pause) {
        if (!video.paused) {
            video.pause();
        }

        setVideoTime(position);

        return;
    }

    /*
     * ========================================================
     * ОБЫЧНОЕ ВОСПРОИЗВЕДЕНИЕ
     * ========================================================
     */

    const difference =
        Math.abs(
            video.currentTime - position
        );

    if (difference > 0.35) {
        setVideoTime(position);
    }

    if (
        video.paused &&
        !video.ended
    ) {
        video.play().catch(() => {
            // autoplay может быть запрещён браузером
        });
    }
}


/*
 * ============================================================
 * show.json
 * ============================================================
 */

async function loadShow() {
    const requestNumber =
        ++showRequestNumber;

    /*
     * Отменяем предыдущий запрос,
     * если он ещё существует.
     */
    if (showRequestController) {
        showRequestController.abort();
    }

    const controller =
        new AbortController();

    showRequestController =
        controller;

    try {
        const url =
            SHOW_URL +
            "?t=" +
            Date.now();

        const response =
            await fetch(url, {
                method: "GET",
                cache: "no-store",

                headers: {
                    "Cache-Control": "no-cache"
                },

                signal: controller.signal
            });

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        /*
         * Если появился более новый запрос,
         * старый ответ больше нельзя применять.
         */
        if (
            requestNumber !==
            showRequestNumber
        ) {
            return;
        }

        if (
            !data ||
            typeof data !== "object"
        ) {
            throw new Error(
                "Некорректный show.json"
            );
        }

        const newShowId =
            data.showId || null;

        /*
         * Начался новый показ.
         */
        if (
            currentShowId !== null &&
            newShowId !== currentShowId
        ) {
            currentMovieUrl = null;

            try {
                video.pause();
            } catch (_) {
                // ignore
            }
        }

        currentShowId =
            newShowId;

        /*
         * Только здесь меняем актуальное состояние.
         */
        showData = data;

        const movieUrl =
            data.url ||
            "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

        if (
            currentMovieUrl !== movieUrl
        ) {
            await loadMovie(movieUrl);
        }

        syncVideo();

    } catch (error) {
        if (
            error.name !==
            "AbortError"
        ) {
            console.error(
                "show.json:",
                error
            );
        }

    } finally {
        if (
            requestNumber ===
            showRequestNumber
        ) {
            showRequestController =
                null;
        }
    }
}


/*
 * ============================================================
 * Последовательный polling
 * ============================================================
 */

async function showPollingLoop() {
    while (true) {
        await loadShow();

        await new Promise(resolve => {
            setTimeout(
                resolve,
                SHOW_REFRESH_MS
            );
        });
    }
}


/*
 * ============================================================
 * Локальная синхронизация
 * ============================================================
 */

setInterval(
    syncVideo,
    SYNC_MS
);


/*
 * ============================================================
 * Возвращение на вкладку
 * ============================================================
 */

document.addEventListener(
    "visibilitychange",
    () => {
        if (
            document.visibilityState ===
            "visible"
        ) {
            loadShow();
        }
    }
);


/*
 * ============================================================
 * Защита от ручной перемотки
 * ============================================================
 */

video.addEventListener(
    "seeking",
    () => {
        if (suppressSeeking) {
            return;
        }

        if (!showData) {
            return;
        }

        const position =
            getSchedulePosition(showData);

        setVideoTime(position);
    }
);


video.addEventListener(
    "seeked",
    () => {
        if (suppressSeeking) {
            return;
        }

        if (!showData) {
            return;
        }

        const position =
            getSchedulePosition(showData);

        if (
            Math.abs(
                video.currentTime - position
            ) > 0.35
        ) {
            setVideoTime(position);
        }
    }
);


/*
 * ============================================================
 * Локальная кнопка Pause
 * ============================================================
 */

video.addEventListener(
    "pause",
    () => {
        if (
            suppressSeeking ||
            !showData
        ) {
            return;
        }

        /*
         * Серверное состояние pause=false,
         * поэтому локальную остановку отменяем.
         */
        if (
            !showData.pause &&
            !video.ended
        ) {
            setTimeout(
                syncVideo,
                50
            );
        }
    }
);


/*
 * ============================================================
 * Локальная кнопка Play
 * ============================================================
 */

video.addEventListener(
    "play",
    () => {
        if (!showData) {
            return;
        }

        /*
         * При серверной паузе
         * воспроизведение запрещено.
         */
        if (showData.pause) {
            video.pause();

            setVideoTime(
                getSchedulePosition(showData)
            );
        }
    }
);


/*
 * ============================================================
 * Конец фильма
 * ============================================================
 */

video.addEventListener(
    "ended",
    () => {
        hidePlayer();
    }
);


/*
 * ============================================================
 * Запуск
 * ============================================================
 */

video.style.display = "none";

showPollingLoop();