"use strict";

const SHOW_URL = "show.json";
const MOVIE_PROXY_URL = "https://raspy-cake-1c1a.qwgvpgy.workers.dev";
const POLL_MS = 15000;

const player = document.getElementById("player");

let show = null;
let lastPause = null;
let pollTimer = null;
let finishTimer = null;
let initialSyncNeeded = true;
let internalSeek = false;
let lastShowId = null;

function getMovieUrl(data) {
    return data.url || MOVIE_PROXY_URL;
}

function nowUnix() {
    return Date.now() / 1000;
}

function startUnix() {
    if (!show) {
        return NaN;
    }

    if (Number.isFinite(Number(show.startUnix))) {
        return Number(show.startUnix);
    }

    const parsed = Date.parse(show.start);

    return Number.isFinite(parsed)
        ? parsed / 1000
        : NaN;
}

/*
 * Суммируем все завершённые интервалы паузы.
 *
 * Если старый show.json ещё не содержит
 * pauseIntervals, используем pausedDuration.
 */
function pausedDuration() {
    if (!show) {
        return 0;
    }

    const intervals = Array.isArray(show.pauseIntervals)
        ? show.pauseIntervals
        : [];

    let total = 0;

    for (const interval of intervals) {
        const begin = Number(
            interval?.startUnix
        );

        const end = Number(
            interval?.endUnix
        );

        if (
            Number.isFinite(begin)
            && Number.isFinite(end)
            && end >= begin
        ) {
            total += end - begin;
        }
    }

    if (intervals.length > 0) {
        return total;
    }

    return Math.max(
        0,
        Number(show.pausedDuration) || 0
    );
}

/*
 * Вычисляет фактическую позицию фильма
 * по серверному времени.
 */
function showPosition() {
    if (!show) {
        return 0;
    }

    /*
     * При активной паузе позиция фиксированная.
     * Время продолжающее идти после pauseUnix
     * здесь НЕ учитывается.
     */
    if (show.pause === true) {
        return Math.max(
            0,
            Number(show.pausePosition) || 0
        );
    }

    const start = startUnix();

    if (!Number.isFinite(start)) {
        return 0;
    }

    /*
     * До начала показа фильм всегда находится
     * на нулевой позиции.
     */
    if (nowUnix() < start) {
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
        internalSeek = false;
        return false;
    }
}

player.addEventListener(
    "seeked",
    () => {
        internalSeek = false;
    }
);

async function tryPlay() {
    try {
        await player.play();
    } catch (_) {
        /*
         * Браузер может запретить autoplay.
         */
    }
}

/*
 * КАЖДЫЙ PLAY дополнительно синхронизирует видео.
 *
 * Это важно, например, если:
 * - человек сам нажал Play;
 * - браузер сам остановил видео;
 * - вкладка долго была неактивной;
 * - произошёл небольшой рассинхрон.
 *
 * Перед продолжением воспроизведения currentTime
 * устанавливается на позицию, которую диктует show.json.
 */
player.addEventListener(
    "play",
    () => {
        if (
            !show
            || !isStarted()
            || isFinished()
        ) {
            return;
        }

        seekToPosition(
            showPosition()
        );

        /*
         * Если сервер говорит, что сейчас пауза,
         * пользовательский Play всё равно не должен
         * запустить фильм.
         */
        if (show.pause === true) {
            player.pause();
        }
    }
);

function scheduleFinishCheck() {
    if (finishTimer) {
        clearTimeout(finishTimer);
    }

    finishTimer = null;

    if (
        !show
        || !isStarted()
        || !Number.isFinite(player.duration)
        || player.duration <= 0
        || show.pause === true
    ) {
        return;
    }

    const remaining =
        player.duration
        - showPosition();

    if (remaining <= 0) {
        applyVisibility();
        return;
    }

    finishTimer = setTimeout(
        () => {
            applyVisibility();
            scheduleFinishCheck();
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
    const url =
        getMovieUrl(data);

    const newStart =
        Number(data.startUnix);

    /*
     * showId создаётся Python при каждом
     * новом показе.
     *
     * Fallback нужен для старого show.json,
     * где showId ещё отсутствует.
     */
    const newShowId =
        data.showId
        || `${data.startUnix || ""}:${data.movie || "movie.mp4"}`;

    const showChanged =
        lastShowId !== null
        && lastShowId !== newShowId;

    const movieChanged =
        player.dataset.movieUrl !== url;

    const startChanged =
        Number.isFinite(newStart)
        && Number(player.dataset.startUnix)
            !== newStart;

    const pauseChanged =
        lastPause !== Boolean(data.pause);

    /*
     * Новый показ.
     *
     * Полностью сбрасываем состояние старого фильма.
     * Старые pauseIntervals после этого никак
     * не могут повлиять на новый показ.
     */
    if (showChanged) {
        if (finishTimer) {
            clearTimeout(finishTimer);
            finishTimer = null;
        }

        player.pause();

        player.removeAttribute("src");
        player.load();

        player.dataset.movieUrl = "";
        player.dataset.startUnix = "";

        initialSyncNeeded = true;
        lastPause = null;
    }

    show = data;
    lastShowId = newShowId;
    lastPause = Boolean(data.pause);

    /*
     * Загружаем фильм:
     * - при первом запуске;
     * - при новом показе;
     * - при смене URL;
     * - при force.
     */
    if (
        movieChanged
        || showChanged
        || force
    ) {
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
        return;
    }

    /*
     * Первичная синхронизация.
     *
     * Во время обычной работы сюда постоянно
     * не попадаем, поэтому кадр на паузе
     * не дёргается.
     */
    if (
        force
        || showChanged
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
                position >= player.duration
            ) {
                applyVisibility();
                return;
            }

            seekToPosition(position);

            initialSyncNeeded = false;
        }
    }

    if (show.pause === true) {
        /*
         * При включении паузы один раз
         * устанавливаем сохранённую позицию.
         *
         * Никаких seek каждую секунду.
         */
        if (
            pauseChanged
            || force
            || showChanged
            || movieChanged
        ) {
            seekToPosition(
                showPosition()
            );
        }

        player.pause();
    } else {
        /*
         * После снятия серверной паузы
         * не делаем дополнительный seek здесь.
         *
         * Play-событие само выполнит точную
         * синхронизацию перед воспроизведением.
         */
        if (
            pauseChanged
            || force
            || showChanged
            || movieChanged
            || player.paused
        ) {
            await tryPlay();
        }
    }

    applyVisibility();
    scheduleFinishCheck();
}

async function loadShow(force = false) {
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
            "show.json:",
            error
        );
    }
}

/*
 * Защита от ручной перемотки.

 * Если пользователь потянул timeline,
 * фильм возвращается на серверную позицию.
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

        if (
            Math.abs(
                player.currentTime
                - expected
            ) > 0.25
        ) {
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
            position >= player.duration
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

        /*
         * После возврата на вкладку тоже
         * восстанавливаем точную позицию.
         */
        seekToPosition(
            showPosition()
        );

        if (show.pause === true) {
            player.pause();
        } else if (player.paused) {
            tryPlay();
        }
    }
);

/*
 * Периодическая проверка состояния.
 *
 * ВАЖНО:
 * во время pause currentTime НЕ меняется.
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
     * show.json периодически перечитывается,
     * поэтому изменение pause/showId/startUnix
     * будет замечено без перезагрузки страницы.
     */
    pollTimer = setInterval(
        () => {
            loadShow(false);
        },
        POLL_MS
    );
}

start();