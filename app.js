// app.js
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


/*
 * ==========================================
 * UI
 * ==========================================
 */

function showCountdown() {
    if (!countdown || !player) {
        return;
    }

    countdown.classList.remove("hidden");
    player.classList.add("hidden");
}


function showPlayer() {
    if (!countdown || !player) {
        return;
    }

    countdown.classList.add("hidden");
    player.classList.remove("hidden");
}


function hideEverything() {
    if (!countdown || !player) {
        return;
    }

    countdown.classList.add("hidden");
    player.classList.add("hidden");
}


function formatCountdown(seconds) {
    const total =
        Math.max(
            0,
            Math.ceil(Number(seconds) || 0)
        );

    const hours =
        Math.floor(total / 3600);

    const minutes =
        Math.floor((total % 3600) / 60);

    const secs =
        total % 60;

    return [
        String(hours).padStart(2, "0"),
        String(minutes).padStart(2, "0"),
        String(secs).padStart(2, "0")
    ].join(":");
}


function updateCountdown() {
    if (!show || !countdown) {
        return;
    }

    const startUnix =
        getStartUnix();

    if (!Number.isFinite(startUnix)) {
        return;
    }

    const now =
        Date.now() / 1000;

    const remaining =
        startUnix - now;

    if (remaining > 0) {
        countdown.textContent =
            formatCountdown(remaining);

        showCountdown();

        if (!player.paused) {
            player.pause();
        }

        return;
    }

    /*
     * Показ уже начался.
     * Таймер больше не нужен.
     */
    showPlayer();

    if (
        Number.isFinite(player.duration) &&
        getShowPosition() >= player.duration
    ) {
        showFinished();
    }
}


function showFinished() {
    if (!player) {
        return;
    }

    player.pause();
    resetPlaybackRate();

    /*
     * После окончания показа
     * плеер полностью исчезает.
     */
    player.classList.add("hidden");
    countdown.classList.add("hidden");
}


/*
 * ==========================================
 * SHOW.JSON
 * ==========================================
 */

async function fetchShow() {
    const url =
        `${SHOW_URL}?_=${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`;

    const response =
        await fetch(url, {
            method: "GET",
            mode: "cors",
            cache: "no-store",
            credentials: "omit"
        });

    if (!response.ok) {
        throw new Error(
            `show.json HTTP ${response.status}`
        );
    }

    const data =
        await response.json();

    if (
        !data ||
        typeof data !== "object"
    ) {
        throw new Error(
            "Worker вернул некорректный JSON."
        );
    }

    if (!data.start) {
        throw new Error(
            "В show.json отсутствует start."
        );
    }

    return data;
}


/*
 * ==========================================
 * TIME / POSITION
 * ==========================================
 */

function getStartUnix() {
    if (
        show &&
        Number.isFinite(
            Number(show.startUnix)
        )
    ) {
        return Number(show.startUnix);
    }

    if (
        show &&
        show.start
    ) {
        const time =
            new Date(show.start).getTime();

        if (Number.isFinite(time)) {
            return time / 1000;
        }
    }

    return null;
}


function getPausedDuration() {
    if (
        !show ||
        !Array.isArray(show.pauseIntervals)
    ) {
        return 0;
    }

    let total = 0;

    for (const interval of show.pauseIntervals) {
        if (!interval) {
            continue;
        }

        const start =
            Number(interval.startUnix);

        const end =
            Number(interval.endUnix);

        if (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            end >= start
        ) {
            total += end - start;
        }
    }

    return total;
}


function getShowPosition() {
    if (!show) {
        return 0;
    }

    if (show.pause === true) {
        const position =
            Number(show.pausePosition);

        return Number.isFinite(position)
            ? Math.max(0, position)
            : 0;
    }

    const startUnix =
        getStartUnix();

    if (!Number.isFinite(startUnix)) {
        return 0;
    }

    const now =
        Date.now() / 1000;

    if (now < startUnix) {
        return 0;
    }

    return Math.max(
        0,
        now -
        startUnix -
        getPausedDuration()
    );
}


/*
 * ==========================================
 * VIDEO POSITION
 * ==========================================
 */

function setVideoPosition(position) {
    if (
        !player ||
        !Number.isFinite(player.duration)
    ) {
        return false;
    }

    let target =
        Math.max(
            0,
            Number(position) || 0
        );

    if (player.duration > 0) {
        target =
            Math.min(
                target,
                Math.max(
                    0,
                    player.duration - 0.05
                )
            );
    }

    const difference =
        Math.abs(
            player.currentTime - target
        );

    if (difference < 0.25) {
        return false;
    }

    if (forcingPosition) {
        return false;
    }

    forcingPosition = true;

    try {
        player.currentTime = target;
        return true;
    } catch (error) {
        console.warn(
            "Не удалось установить позицию:",
            error
        );
        return false;
    } finally {
        setTimeout(() => {
            forcingPosition = false;
        }, 150);
    }
}


/*
 * ==========================================
 * PLAYBACK RATE SYNC
 * ==========================================
 */

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

    if (absolute > 2) {
        resetPlaybackRate();
        setVideoPosition(target);
        return;
    }

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

    resetPlaybackRate();

    const position =
        getShowPosition();

    if (
        forcePosition ||
        Math.abs(
            player.currentTime - position
        ) > 2
    ) {
        setVideoPosition(position);
    }
}


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

        applyPauseState(true);

        updateCountdown();
    }
);


player.addEventListener(
    "canplay",
    () => {
        if (!show) {
            return;
        }

        const startUnix =
            getStartUnix();

        if (
            Number.isFinite(startUnix) &&
            Date.now() / 1000 < startUnix
        ) {
            showCountdown();
            player.pause();
            return;
        }

        if (show.pause === true) {
            showPlayer();
            applyPauseState(true);
            return;
        }

        const target =
            getShowPosition();

        if (
            Number.isFinite(player.duration) &&
            target >= player.duration
        ) {
            showFinished();
            return;
        }

        showPlayer();

        if (
            Number.isFinite(player.duration) &&
            target < player.duration
        ) {
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
    "ended",
    () => {
        resetPlaybackRate();
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
        show.pause === true
    ) {
        return;
    }

    const startUnix =
        getStartUnix();

    if (
        Number.isFinite(startUnix) &&
        Date.now() / 1000 < startUnix
    ) {
        showCountdown();
        return;
    }

    const target =
        getShowPosition();

    if (
        Number.isFinite(player.duration) &&
        target >= player.duration
    ) {
        showFinished();
        return;
    }

    if (
        Number.isFinite(player.duration) &&
        Math.abs(
            player.currentTime - target
        ) > 2
    ) {
        setVideoPosition(target);
    }

    showPlayer();

    try {
        await player.play();
    } catch (error) {
        try {
            player.muted = true;
            await player.play();
        } catch (mutedError) {
            console.warn(
                "Autoplay заблокирован:",
                mutedError
            );
        }
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

    const previousShow =
        show;

    show =
        newShow;

    currentShowId =
        newShowId;

    lastPauseState =
        newShow.pause;

    updateCountdown();

    /*
     * ======================================
     * НОВЫЙ ПОКАЗ
     * ======================================
     */

    if (showChanged) {
        console.log(
            "Новый показ:",
            newShowId
        );

        player.pause();
        resetPlaybackRate();

        player.removeAttribute("src");
        player.load();

        const startUnix =
            getStartUnix();

        /*
         * До начала показа показываем
         * большой полноэкранный таймер.
         */
        if (
            Number.isFinite(startUnix) &&
            Date.now() / 1000 < startUnix
        ) {
            showCountdown();
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
     * ======================================
     * ПОКАЗ ТОТ ЖЕ САМЫЙ
     * ======================================
     */

    if (!previousShow) {
        return;
    }

    if (pauseChanged) {
        console.log(
            "Изменилось состояние паузы:",
            newShow.pause
        );

        applyPauseState(true);

        if (!newShow.pause) {
            tryPlay();
        }

        return;
    }
}


/*
 * ==========================================
 * LOAD / REFRESH
 * ==========================================
 */

async function loadShow() {
    try {
        const newShow =
            await fetchShow();

        await applyShow(newShow);
    } catch (error) {
        console.error(
            "show.json:",
            error
        );
    }
}


function startRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }

    refreshTimer =
        setInterval(
            loadShow,
            7000
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

    /*
     * Обновляем таймер каждую секунду.
     */
    updateCountdown();

    /*
     * Пока видео ещё не загружено,
     * синхронизировать нечего.
     */
    if (!Number.isFinite(player.duration)) {
        return;
    }

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

        showCountdown();

        return;
    }

    /*
     * Активная серверная пауза.
     */
    if (show.pause === true) {
        resetPlaybackRate();

        showPlayer();

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
     * Фильм закончился.
     */
    const target =
        getShowPosition();

    if (
        target >= player.duration
    ) {
        showFinished();
        return;
    }

    showPlayer();

    /*
     * Мягкая синхронизация.
     */
    synchronizePlaybackRate(target);

    /*
     * Если браузер остановил видео,
     * продолжаем воспроизведение.
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