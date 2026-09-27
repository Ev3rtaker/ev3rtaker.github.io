"use strict";

const SHOW_URL = "show.json";
const MOVIE_PROXY_URL = "https://raspy-cake-1c1a.qwgvpgy.workers.dev";
const POLL_MS = 15000;

const player = document.getElementById("player");

let show = null;
let lastPause = null;
let finishTimer = null;
let initialSyncNeeded = true;
let internalSeek = false;

function getMovieUrl(data) {
    return data.url || MOVIE_PROXY_URL;
}

function nowUnix() {
    return Date.now() / 1000;
}

function startUnix() {
    if (!show) return NaN;

    if (
        Number.isFinite(
            Number(show.startUnix)
        )
    ) {
        return Number(show.startUnix);
    }

    const parsed = Date.parse(
        show.start
    );

    return Number.isFinite(parsed)
        ? parsed / 1000
        : NaN;
}

function pausedDuration() {
    const value = Number(
        show?.pausedDuration
    );

    return Number.isFinite(value) && value > 0
        ? value
        : 0;
}

function showPosition() {
    if (!show) return 0;

    if (show.pause === true) {
        const position = Number(
            show.pausePosition
        );

        return Number.isFinite(position)
            ? Math.max(0, position)
            : 0;
    }

    const start = startUnix();

    if (!Number.isFinite(start)) {
        return 0;
    }

    return Math.max(
        0,
        nowUnix()
        - start
        - pausedDuration()
    );
}

function isStarted() {
    const start = startUnix();

    return (
        Number.isFinite(start)
        && nowUnix() >= start
    );
}

function isFinished() {
    return (
        Number.isFinite(player.duration)
        && player.duration > 0
        && showPosition() >= player.duration
    );
}

function applyVisibility() {
    if (
        !show
        || !isStarted()
        || isFinished()
    ) {
        player.style.visibility = "hidden";

        if (isFinished()) {
            player.pause();
        }

        return;
    }

    player.style.visibility = "visible";
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

        return true;
    } catch (_) {
        return false;
    } finally {
        setTimeout(() => {
            internalSeek = false;
        }, 0);
    }
}

async function tryPlay() {
    try {
        await player.play();
    } catch (_) {
        // Автовоспроизведение может быть запрещено браузером.
    }
}

function scheduleFinishCheck() {
    if (finishTimer) {
        clearTimeout(finishTimer);
    }

    finishTimer = null;

    if (
        !show
        || !isStarted()
        || !Number.isFinite(player.duration)
    ) {
        return;
    }

    /*
     * При паузе фильм логически не движется.
     */
    if (show.pause === true) {
        return;
    }

    const remaining =
        player.duration - showPosition();

    if (remaining <= 0) {
        applyVisibility();
        return;
    }

    finishTimer = setTimeout(() => {
        applyVisibility();
        scheduleFinishCheck();
    }, Math.max(
        250,
        remaining * 1000
    ));
}

async function applyShow(
    data,
    force = false
) {
    const url = getMovieUrl(data);

    const newStart =
        Number(data.startUnix);

    const movieChanged =
        player.dataset.movieUrl !== url;

    const startChanged =
        Number.isFinite(newStart)
        && Number(
            player.dataset.startUnix
        ) !== newStart;

    const pauseChanged =
        lastPause !== Boolean(data.pause);

    show = data;

    if (movieChanged || force) {
        player.dataset.movieUrl = url;

        player.dataset.startUnix =
            String(startUnix());

        player.src = url;
        player.load();

        initialSyncNeeded = true;
    }

    applyVisibility();

    if (
        !isStarted()
        || isFinished()
    ) {
        player.pause();
        scheduleFinishCheck();

        lastPause =
            Boolean(data.pause);

        return;
    }

    /*
     * Seek только:
     *
     * - при первой загрузке;
     * - при смене фильма;
     * - при изменении времени старта.
     *
     * Обычный poll show.json НЕ трогает currentTime.
     */
    if (
        force
        || movieChanged
        || startChanged
        || initialSyncNeeded
    ) {
        if (
            Number.isFinite(player.duration)
            && player.duration > 0
        ) {
            const position =
                showPosition();

            if (
                position >=
                player.duration
            ) {
                applyVisibility();
                return;
            }

            seekToPosition(position);

            initialSyncNeeded = false;
        }
    }

    if (data.pause === true) {
        /*
         * При постановке паузы:
         *
         * pausePosition уже записан Python.
         *
         * После этого НЕ делаем seek
         * каждые 15 секунд.
         */
        if (
            force
            || movieChanged
            || pauseChanged
        ) {
            seekToPosition(
                Number(data.pausePosition)
            );
        }

        player.pause();
    } else {
        /*
         * При снятии паузы:
         *
         * НИКАКОГО seek.
         *
         * Просто продолжаем с текущего кадра.
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
        const response = await fetch(
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

        const data =
            await response.json();

        await applyShow(
            data,
            force
        );
    } catch (error) {
        console.error(
            "show.json:",
            error
        );
    }
}

/*
 * Защита от ручной перемотки.
 *
 * Если пользователь двигает ползунок:
 *
 * pause=true:
 *     возвращаемся в pausePosition.
 *
 * pause=false:
 *     возвращаемся в позицию,
 *     которая сейчас положена по расписанию.
 *
 * При этом обычное воспроизведение
 * не вызывает этот обработчик с изменением
 * currentTime со стороны нашего кода.
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
            showPosition();

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
            showPosition();

        if (
            position >=
            player.duration
        ) {
            applyVisibility();
            return;
        }

        seekToPosition(position);

        initialSyncNeeded = false;

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
    "ended",
    () => {
        applyVisibility();
    }
);

player.addEventListener(
    "timeupdate",
    () => {
        if (isFinished()) {
            player.pause();
            applyVisibility();
        }
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

async function start() {
    await loadShow(true);

    /*
     * show.json проверяется периодически,
     * чтобы увидеть изменение pause.
     */
    setInterval(() => {
        loadShow(false);
    }, POLL_MS);

    /*
     * Здесь НЕТ seek во время паузы.
     *
     * Проверяем только состояние воспроизведения
     * и окончание фильма.
     */
    setInterval(() => {
        if (!show) return;

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
    }, 1000);
}

start();