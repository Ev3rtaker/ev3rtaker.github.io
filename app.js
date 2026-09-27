"use strict";

const SHOW_URL = "show.json";
const MOVIE_PROXY_URL = "https://raspy-cake-1c1a.qwgvpgy.workers.dev";
const POLL_MS = 15000;

const player = document.getElementById("player");

let show = null;
let lastPause = null;
let lastMovieUrl = null;
let lastStartUnix = null;

let internalSeek = false;
let finishTimer = null;

function nowUnix() {
    return Date.now() / 1000;
}

function getStartUnix() {
    if (!show) {
        return NaN;
    }

    const value = Number(show.startUnix);

    if (Number.isFinite(value)) {
        return value;
    }

    if (show.start) {
        const parsed = Date.parse(show.start);

        if (Number.isFinite(parsed)) {
            return parsed / 1000;
        }
    }

    return NaN;
}

function getPauseIntervals() {
    if (!show) {
        return [];
    }

    if (!Array.isArray(show.pauseIntervals)) {
        return [];
    }

    return show.pauseIntervals.filter(interval => {
        return (
            interval
            && Number.isFinite(
                Number(interval.startUnix)
            )
            && Number.isFinite(
                Number(interval.endUnix)
            )
            && Number(interval.endUnix)
                >= Number(interval.startUnix)
        );
    });
}

function getCompletedPausedDuration() {
    return getPauseIntervals().reduce(
        (total, interval) => {
            return total
                + (
                    Number(interval.endUnix)
                    - Number(interval.startUnix)
                );
        },
        0
    );
}

function getCurrentPauseInterval() {
    if (!show || show.pause !== true) {
        return null;
    }

    const pauseUnix = Number(
        show.pauseUnix
    );

    if (!Number.isFinite(pauseUnix)) {
        return null;
    }

    return {
        startUnix: pauseUnix,
        position: Number.isFinite(
            Number(show.pausePosition)
        )
            ? Number(show.pausePosition)
            : 0
    };
}

function isStarted() {
    const start = getStartUnix();

    return (
        Number.isFinite(start)
        && nowUnix() >= start
    );
}

/*
 * Главная функция синхронизации.
 *
 * При активной паузе:
 *     возвращаем сохранённую позицию.
 *
 * Без активной паузы:
 *     текущее время
 *     - время начала показа
 *     - сумма всех завершённых пауз.
 */
function getShowPosition() {
    if (!show) {
        return 0;
    }

    const currentPause =
        getCurrentPauseInterval();

    if (currentPause) {
        return Math.max(
            0,
            currentPause.position
        );
    }

    const start = getStartUnix();

    if (!Number.isFinite(start)) {
        return 0;
    }

    const pausedDuration =
        getCompletedPausedDuration();

    return Math.max(
        0,
        nowUnix()
            - start
            - pausedDuration
    );
}

function isFinished() {
    if (!show || !isStarted()) {
        return false;
    }

    if (
        !Number.isFinite(player.duration)
        || player.duration <= 0
    ) {
        return false;
    }

    return (
        getShowPosition()
        >= player.duration
    );
}

function setVisible(visible) {
    player.style.visibility =
        visible
            ? "visible"
            : "hidden";
}

function hidePlayer() {
    player.pause();
    setVisible(false);
}

function seekToPosition(position) {
    if (
        !Number.isFinite(player.duration)
        || player.duration <= 0
    ) {
        return false;
    }

    if (!Number.isFinite(position)) {
        return false;
    }

    if (position >= player.duration) {
        hidePlayer();
        return false;
    }

    const target = Math.max(
        0,
        Math.min(
            position,
            Math.max(
                0,
                player.duration - 0.05
            )
        )
    );

    try {
        internalSeek = true;
        player.currentTime = target;

        setTimeout(() => {
            internalSeek = false;
        }, 100);

        return true;
    } catch (_) {
        internalSeek = false;
        return false;
    }
}

async function tryPlay() {
    try {
        await player.play();
    } catch (_) {
        /*
         * Автовоспроизведение может быть
         * запрещено браузером.
         */
    }
}

function applyVisibility() {
    if (
        !show
        || !isStarted()
        || isFinished()
    ) {
        setVisible(false);

        if (isFinished()) {
            player.pause();
        }

        return;
    }

    setVisible(true);
}

function scheduleFinishCheck() {
    if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
    }

    if (
        !show
        || !isStarted()
        || show.pause === true
        || !Number.isFinite(player.duration)
        || player.duration <= 0
    ) {
        return;
    }

    const remaining =
        player.duration
        - getShowPosition();

    if (remaining <= 0) {
        hidePlayer();
        return;
    }

    finishTimer = setTimeout(
        () => {
            if (isFinished()) {
                hidePlayer();
            } else {
                scheduleFinishCheck();
            }
        },
        Math.max(
            250,
            remaining * 1000
        )
    );
}

async function applyShow(
    data,
    force = false
) {
    const newMovieUrl =
        data.url || MOVIE_PROXY_URL;

    const movieChanged =
        lastMovieUrl !== newMovieUrl;

    const startUnixValue =
        Number(data.startUnix);

    const startChanged =
        lastStartUnix !== null
        && Number.isFinite(startUnixValue)
        && lastStartUnix !== startUnixValue;

    const pauseChanged =
        lastPause !== Boolean(data.pause);

    show = data;

    if (movieChanged || force) {
        lastMovieUrl =
            newMovieUrl;

        lastStartUnix =
            getStartUnix();

        player.src =
            newMovieUrl;

        player.load();
    }

    applyVisibility();

    if (
        !isStarted()
        || isFinished()
    ) {
        player.pause();

        lastPause =
            Boolean(data.pause);

        scheduleFinishCheck();

        return;
    }

    /*
     * При первоначальной загрузке,
     * смене фильма или времени показа
     * устанавливаем правильную позицию.
     */
    if (
        force
        || movieChanged
        || startChanged
    ) {
        if (
            Number.isFinite(
                player.duration
            )
            && player.duration > 0
        ) {
            seekToPosition(
                getShowPosition()
            );
        }
    }

    if (data.pause === true) {
        /*
         * При паузе позиция хранится
         * непосредственно в show.json.
         *
         * Никаких ежесекундных seek.
         */
        const pausePosition =
            Number(
                data.pausePosition
            );

        if (
            force
            || movieChanged
            || pauseChanged
        ) {
            if (
                Number.isFinite(
                    pausePosition
                )
            ) {
                seekToPosition(
                    pausePosition
                );
            }
        }

        player.pause();
    } else {
        /*
         * При снятии паузы НЕ делаем seek.
         *
         * Позиция уже находится там,
         * где фильм был остановлен.
         */
        if (
            pauseChanged
            || force
            || movieChanged
            || player.paused
        ) {
            await tryPlay();
        }
    }

    lastPause =
        Boolean(data.pause);

    applyVisibility();
    scheduleFinishCheck();
}

async function loadShow(
    force = false
) {
    try {
        const response =
            await fetch(
                `${SHOW_URL}?t=${Date.now()}`,
                {
                    cache: "no-store",
                    headers: {
                        "Cache-Control":
                            "no-cache"
                    }
                }
            );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        if (
            !data
            || typeof data !== "object"
        ) {
            throw new Error(
                "Некорректный show.json"
            );
        }

        await applyShow(
            data,
            force
        );
    } catch (error) {
        console.error(
            "Не удалось загрузить show.json:",
            error
        );
    }
}

/*
 * Защита от ручной перемотки.
 *
 * Пользователь пытается изменить
 * currentTime — возвращаем фильм
 * на его фактическую позицию.
 */
player.addEventListener(
    "seeking",
    () => {
        if (
            internalSeek
            || !show
            || !isStarted()
        ) {
            return;
        }

        const expected =
            getShowPosition();

        if (!Number.isFinite(expected)) {
            return;
        }

        const difference =
            Math.abs(
                player.currentTime
                - expected
            );

        if (difference > 0.25) {
            seekToPosition(
                expected
            );
        }
    }
);

player.addEventListener(
    "loadedmetadata",
    async () => {
        if (
            !show
            || !isStarted()
            || isFinished()
        ) {
            return;
        }

        const position =
            getShowPosition();

        if (
            position >= player.duration
        ) {
            hidePlayer();
            return;
        }

        seekToPosition(position);

        if (show.pause === true) {
            player.pause();
        } else {
            await tryPlay();
        }

        applyVisibility();
        scheduleFinishCheck();
    }
);

player.addEventListener(
    "play",
    () => {
        /*
         * Если сервер говорит, что сейчас
         * пауза — воспроизведение запрещаем.
         */
        if (
            show
            && show.pause === true
        ) {
            player.pause();

            const position =
                Number(
                    show.pausePosition
                );

            if (
                Number.isFinite(position)
            ) {
                seekToPosition(position);
            }
        }
    }
);

player.addEventListener(
    "timeupdate",
    () => {
        if (isFinished()) {
            player.pause();
            hidePlayer();
        }
    }
);

player.addEventListener(
    "ended",
    () => {
        hidePlayer();
    }
);

document.addEventListener(
    "visibilitychange",
    () => {
        if (
            document.visibilityState
            !== "visible"
        ) {
            return;
        }

        if (
            !show
            || !isStarted()
            || isFinished()
        ) {
            return;
        }

        if (show.pause === true) {
            /*
             * После возврата на вкладку
             * восстанавливаем только сохранённый
             * кадр паузы.
             */
            const position =
                Number(
                    show.pausePosition
                );

            if (
                Number.isFinite(position)
            ) {
                seekToPosition(position);
            }

            player.pause();
        } else if (player.paused) {
            tryPlay();
        }
    }
);

/*
 * Здесь НЕТ seek во время паузы.
 *
 * Каждую секунду проверяется только:
 * - не закончился ли фильм;
 * - не остановился ли он неожиданно.
 */
setInterval(
    () => {
        if (!show) {
            return;
        }

        applyVisibility();

        if (
            !isStarted()
            || isFinished()
        ) {
            return;
        }

        if (show.pause === true) {
            if (!player.paused) {
                player.pause();
            }

            return;
        }

        if (player.paused) {
            tryPlay();
        }
    },
    1000
);

async function start() {
    await loadShow(true);

    /*
     * Периодически перечитываем show.json.
     * Это позволяет увидеть новые паузы
     * и снятие паузы.
     */
    setInterval(
        () => {
            loadShow(false);
        },
        POLL_MS
    );
}

start();