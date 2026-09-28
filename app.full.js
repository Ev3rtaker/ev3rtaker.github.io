"use strict";

const WORKER_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

const SHOW_URL =
    `${WORKER_URL}/show.json`;

const MOVIE_URL =
    WORKER_URL;

const player =
    document.getElementById("player");

const countdown =
    document.getElementById("countdown");

let show = null;
let refreshTimer = null;
let positionTimer = null;

let currentShowId = null;
let lastPauseState = null;
let forcingPosition = false;
let showFinishedState = false;


/*
 * ==========================================
 * COUNTDOWN / PLAYER UI
 * ==========================================
 */

function showCountdown() {
    if (countdown) {
        countdown.classList.remove("hidden");
    }

    if (player) {
        player.classList.add("hidden");
    }
}


function showPlayer() {
    if (countdown) {
        countdown.classList.add("hidden");
    }

    if (player) {
        player.classList.remove("hidden");
    }
}


function formatCountdown(seconds) {
    const total =
        Math.max(0, Math.ceil(seconds));

    const hours =
        Math.floor(total / 3600);

    const minutes =
        Math.floor((total % 3600) / 60);

    const secs =
        total % 60;

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}


function updateCountdown() {
    if (!show || !countdown) {
        return false;
    }

    const startUnix =
        getStartUnix();

    if (!Number.isFinite(startUnix)) {
        return false;
    }

    const remaining =
        startUnix - Date.now() / 1000;

    if (remaining > 0) {
        countdown.textContent =
            formatCountdown(remaining);

        showCountdown();

        if (!player.paused) {
            player.pause();
        }

        return true;
    }

    return false;
}


function showFinished() {
    showFinishedState = true;

    resetPlaybackRate();

    player.pause();
    player.classList.add("hidden");

    if (countdown) {
        countdown.textContent = "Показ завершен";
        countdown.classList.remove("hidden");
    }
}


/*
 * ==========================================
 * FETCH SHOW
 * ==========================================
 */

async function fetchShow() {
    const response =
        await fetch(
            `${SHOW_URL}?t=${Date.now()}`,
            {
                cache: "no-store"
            }
        );

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status}`
        );
    }

    return response.json();
}


/*
 * ==========================================
 * TIME / POSITION
 * ==========================================
 */

function getStartUnix() {
    if (!show) {
        return NaN;
    }

    if (
        show.startUnix !== undefined &&
        show.startUnix !== null
    ) {
        const value =
            Number(show.startUnix);

        if (Number.isFinite(value)) {
            return value;
        }
    }

    if (
        show.start !== undefined &&
        show.start !== null
    ) {
        if (
            typeof show.start === "number"
        ) {
            return show.start;
        }

        const numeric =
            Number(show.start);

        if (Number.isFinite(numeric)) {
            return numeric;
        }

        const parsed =
            Date.parse(show.start);

        if (Number.isFinite(parsed)) {
            return parsed / 1000;
        }
    }

    return NaN;
}


function getPausedDuration() {
    if (!show) {
        return 0;
    }

    const intervals =
        Array.isArray(show.pauseIntervals)
            ? show.pauseIntervals
            : [];

    let total = 0;

    for (const interval of intervals) {
        if (!interval) {
            continue;
        }

        let start =
            Number(
                interval.start ??
                interval.from ??
                interval.startUnix
            );

        let end =
            Number(
                interval.end ??
                interval.to ??
                interval.endUnix
            );

        if (!Number.isFinite(start)) {
            continue;
        }

        if (!Number.isFinite(end)) {
            end = Date.now() / 1000;
        }

        if (end > start) {
            total += end - start;
        }
    }

    return total;
}


function getShowPosition() {
    if (!show) {
        return NaN;
    }

    const startUnix =
        getStartUnix();

    if (!Number.isFinite(startUnix)) {
        return NaN;
    }

    const now =
        Date.now() / 1000;

    let position =
        now - startUnix;

    position -=
        getPausedDuration();

    if (
        show.pause === true &&
        Number.isFinite(
            Number(show.pausePosition)
        )
    ) {
        return Number(show.pausePosition);
    }

    return Math.max(0, position);
}


/*
 * ==========================================
 * VIDEO POSITION
 * ==========================================
 */

function setVideoPosition(position) {
    if (
        !Number.isFinite(position) ||
        !Number.isFinite(player.duration)
    ) {
        return;
    }

    const safePosition =
        Math.max(
            0,
            Math.min(
                position,
                player.duration
            )
        );

    forcingPosition = true;

    try {
        player.currentTime =
            safePosition;
    } catch (error) {
        console.error(
            "SEEK ERROR:",
            error
        );
    }

    forcingPosition = false;
}


function resetPlaybackRate() {
    if (player.playbackRate !== 1) {
        player.playbackRate = 1;
    }
}


function synchronizePlaybackRate(target) {
    if (
        !Number.isFinite(player.duration) ||
        player.paused
    ) {
        resetPlaybackRate();
        return;
    }

    const difference =
        target - player.currentTime;

    const absolute =
        Math.abs(difference);

    if (absolute < 0.25) {
        resetPlaybackRate();
        return;
    }

    /*
     * Сильный рассинхрон.
     * Здесь нужен настоящий seek.
     */

    if (absolute > 2) {
        resetPlaybackRate();
        setVideoPosition(target);
        return;
    }

    /*
     * Небольшой рассинхрон.
     *
     * Видео немного ускоряется,
     * если отстаёт, и немного замедляется,
     * если опережает.
     *
     * Это значительно мягче,
     * чем постоянный currentTime=...
     */

    let rate = 1;

    if (difference > 1) {
        rate = 1.025;
    } else if (difference > 0.5) {
        rate = 1.015;
    } else if (difference > 0.25) {
        rate = 1.008;
    } else if (difference < -1) {
        rate = 0.975;
    } else if (difference < -0.5) {
        rate = 0.985;
    } else if (difference < -0.25) {
        rate = 0.992;
    }

    if (player.playbackRate !== rate) {
        player.playbackRate = rate;
    }
}


/*
 * ==========================================
 * PAUSE
 * ==========================================
 */

function applyPauseState(forcePosition = false) {
    if (!show || !player) {
        return;
    }

    if (show.pause === true) {
        resetPlaybackRate();

        const position =
            Number(show.pausePosition);

        if (Number.isFinite(position)) {
            if (
                forcePosition ||
                Math.abs(
                    player.currentTime - position
                ) > 0.25
            ) {
                setVideoPosition(position);
            }
        }

        if (!player.paused) {
            player.pause();
        }

        return;
    }

    const position =
        getShowPosition();

    if (Number.isFinite(position)) {
        if (
            forcePosition ||
            Math.abs(
                player.currentTime - position
            ) > 2
        ) {
            setVideoPosition(position);
        }
    }
}


/*
 * ==========================================
 * MANUAL SEEK PROTECTION
 * ==========================================
 */

player.addEventListener(
    "seeked",
    () => {
        if (forcingPosition) {
            return;
        }

        if (!show) {
            return;
        }

        /*
         * Не перехватываем каждый seek пользователя
         * немедленно. synchronizeVideo вернёт
         * плеер на серверную позицию только если
         * расхождение действительно большое.
         */
    }
);


/*
 * ==========================================
 * VIDEO EVENTS
 * ==========================================
 */

player.addEventListener(
    "loadedmetadata",
    () => {
        if (!show) {
            return;
        }

        /*
         * Только первоначальная установка.
         */

        applyPauseState(true);
    }
);


player.addEventListener(
    "canplay",
    () => {
        if (!show) {
            return;
        }

        if (updateCountdown()) {
            return;
        }

        if (showFinishedState) {
            return;
        }

        showPlayer();

        if (show.pause === true) {
            applyPauseState(true);
            return;
        }

        const target =
            getShowPosition();

        if (
            Number.isFinite(player.duration) &&
            target < player.duration
        ) {
            /*
             * Первоначальная синхронизация.
             */

            if (
                Math.abs(
                    player.currentTime - target
                ) > 0.5
            ) {
                setVideoPosition(target);
            }

            tryPlay();
        }
    }
);


player.addEventListener(
    "pause",
    () => {
        /*
         * Ничего не делаем.
         *
         * synchronizeVideo сам решит,
         * нужно ли продолжить воспроизведение.
         */
    }
);


player.addEventListener(
    "ended",
    () => {
        showFinished();
    }
);


player.addEventListener(
    "error",
    () => {
        console.error(
            "VIDEO ERROR:",
            player.error
        );
    }
);


/*
 * ==========================================
 * AUTOPLAY
 * ==========================================
 */

async function tryPlay() {
    if (
        !player ||
        !show ||
        show.pause === true ||
        showFinishedState
    ) {
        return;
    }

    try {
        await player.play();
    } catch (error) {
        console.warn(
            "PLAY BLOCKED:",
            error
        );
    }
}


/*
 * ==========================================
 * APPLY SHOW
 * ==========================================
 */

async function applyShow(newShow) {
    const newShowId =
        newShow.showId || null;

    const showChanged =
        currentShowId !== newShowId;

    const pauseChanged =
        lastPauseState !== newShow.pause;

    /*
     * Запоминаем старое состояние до замены.
     */

    const previousShow =
        show;

    if (showChanged) {
        showFinishedState = false;
    }

    show =
        newShow;

    currentShowId =
        newShowId;

    lastPauseState =
        newShow.pause;

    /*
     * До начала показа показываем только таймер.
     * Видео при этом не загружаем.
     */

    if (updateCountdown()) {
        if (showChanged) {
            player.pause();
            player.removeAttribute("src");
            player.load();
        }

        return;
    }

    /*
     * ======================================
     * НОВЫЙ ПОКАЗ
     * ======================================
     */

    if (showChanged) {
        console.log(
            "NEW SHOW:",
            newShow
        );

        player.pause();

        resetPlaybackRate();

        player.removeAttribute("src");
        player.load();

        if (
            Number.isFinite(getStartUnix()) &&
            Date.now() / 1000 < getStartUnix()
        ) {
            return;
        }

        player.src =
            MOVIE_URL;

        player.preload =
            "auto";

        player.load();

        return;
    }

    /*
     * Если показа раньше вообще не было,
     * ничего дополнительно не делаем.
     */

    if (!previousShow) {
        return;
    }

    /*
     * После завершения текущего показа
     * ничего больше не запускаем.
     */

    if (showFinishedState) {
        return;
    }

    /*
     * Если src по какой-то причине отсутствует,
     * загружаем видео.
     */

    if (!player.getAttribute("src")) {
        player.src =
            MOVIE_URL;

        player.preload =
            "auto";

        player.load();

        return;
    }

    showPlayer();

    /*
     * Изменилось серверное состояние паузы.
     */

    if (pauseChanged) {
        applyPauseState(true);

        if (!newShow.pause) {
            tryPlay();
        }

        return;
    }
}


/*
 * ==========================================
 * LOAD SHOW
 * ==========================================
 */

async function loadShow() {
    try {
        const newShow =
            await fetchShow();

        await applyShow(
            newShow
        );
    } catch (error) {
        console.error(
            "SHOW LOAD ERROR:",
            error
        );
    }
}


/*
 * ==========================================
 * REFRESH
 * ==========================================
 */

function startRefresh() {
    if (refreshTimer) {
        clearInterval(
            refreshTimer
        );
    }

    refreshTimer =
        setInterval(
            loadShow,
            4000
        );
}


/*
 * ==========================================
 * SYNCHRONIZATION
 * ==========================================
 */

function synchronizeVideo() {
    if (!show || !player) {
        return;
    }

    if (updateCountdown()) {
        return;
    }

    /*
     * Если показ уже завершён,
     * не возвращаем чёрный плеер.
     */

    if (showFinishedState) {
        return;
    }

    if (!player.getAttribute("src")) {
        player.src =
            MOVIE_URL;

        player.preload =
            "auto";

        player.load();

        return;
    }

    if (!Number.isFinite(player.duration)) {
        return;
    }

    showPlayer();

    const startUnix =
        getStartUnix();

    if (!Number.isFinite(startUnix)) {
        return;
    }

    const now =
        Date.now() / 1000;

    /*
     * До начала показа.
     */

    if (now < startUnix) {
        resetPlaybackRate();

        if (!player.paused) {
            player.pause();
        }

        return;
    }

    /*
     * Активная серверная пауза.
     */

    if (show.pause === true) {
        resetPlaybackRate();

        const target =
            Number(show.pausePosition);

        if (Number.isFinite(target)) {
            if (
                Math.abs(
                    player.currentTime - target
                ) > 0.25
            ) {
                setVideoPosition(target);
            }
        }

        if (!player.paused) {
            player.pause();
        }

        return;
    }

    /*
     * Фильм должен идти.
     */

    const target =
        getShowPosition();

    if (
        target >= player.duration
    ) {
        resetPlaybackRate();

        player.pause();

        showFinished();

        return;
    }

    /*
     * Мягкая синхронизация.
     */

    synchronizePlaybackRate(
        target
    );

    /*
     * Если браузер почему-то остановил видео,
     * пытаемся продолжить.
     */

    if (player.paused) {
        tryPlay();
    }
}


/*
 * ==========================================
 * START
 * ==========================================
 */

showCountdown();

loadShow();

startRefresh();

positionTimer =
    setInterval(
        synchronizeVideo,
        1000
    );