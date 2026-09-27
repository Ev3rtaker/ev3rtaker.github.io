"use strict";

const SHOW_URL = "show.json";
const MOVIE_PROXY_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

const POLL_MS = 15000;

const player = document.getElementById("player");

let show = null;

let lastShowId = null;
let lastPause = null;
let lastMovieUrl = null;
let lastStartUnix = null;

let internalSeek = false;
let synchronizingPlay = false;
let finishTimer = null;


/* =========================================================
   TIME
   ========================================================= */

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


/* =========================================================
   PAUSE INTERVALS
   ========================================================= */

function getPauseIntervals() {
    if (
        !show
        || !Array.isArray(show.pauseIntervals)
    ) {
        return [];
    }

    return show.pauseIntervals.filter(
        interval => {
            if (
                !interval
                || typeof interval !== "object"
            ) {
                return false;
            }

            const start =
                Number(interval.startUnix);

            const end =
                Number(interval.endUnix);

            return (
                Number.isFinite(start)
                && Number.isFinite(end)
                && end >= start
            );
        }
    );
}


/*
 * Сумма ТОЛЬКО завершённых пауз.
 *
 * pausedDuration из JSON здесь намеренно
 * НЕ используется.
 */
function getCompletedPauseDuration() {
    const intervals =
        getPauseIntervals();

    let total = 0;

    for (const interval of intervals) {
        const start =
            Number(interval.startUnix);

        const end =
            Number(interval.endUnix);

        total += end - start;
    }

    return total;
}


/* =========================================================
   SHOW POSITION
   ========================================================= */

function getShowPosition() {
    if (!show) {
        return 0;
    }

    const start =
        getStartUnix();

    if (!Number.isFinite(start)) {
        return 0;
    }

    /*
     * До начала показа фильм находится
     * на нулевой позиции.
     */
    if (nowUnix() < start) {
        return 0;
    }

    /*
     * При активной паузе позиция фиксирована
     * и берётся непосредственно из JSON.
     */
    if (show.pause === true) {
        const position =
            Number(show.pausePosition);

        if (Number.isFinite(position)) {
            return Math.max(
                0,
                position
            );
        }

        return 0;
    }

    /*
     * Обычное воспроизведение:
     *
     * текущее время
     * - начало показа
     * - сумма ВСЕХ завершённых пауз
     */
    const paused =
        getCompletedPauseDuration();

    return Math.max(
        0,
        nowUnix()
            - start
            - paused
    );
}


function isStarted() {
    const start =
        getStartUnix();

    return (
        Number.isFinite(start)
        && nowUnix() >= start
    );
}


function isFinished() {
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


/* =========================================================
   VISIBILITY
   ========================================================= */

function showPlayer() {
    player.style.visibility =
        "visible";
}


function hidePlayer() {
    player.pause();

    player.style.visibility =
        "hidden";
}


function updateVisibility() {
    if (
        !show
        || !isStarted()
        || isFinished()
    ) {
        hidePlayer();
        return;
    }

    showPlayer();
}


/* =========================================================
   SEEK
   ========================================================= */

/*
 * Перемотка с ожиданием события seeked.
 *
 * Это важно:
 *
 *     seek
 *       ↓
 *     seeked
 *       ↓
 *     play
 *
 * Поэтому видео никогда не начинает играть
 * до завершения синхронизации.
 */
function seekToPosition(position) {
    return new Promise(resolve => {
        if (
            !Number.isFinite(player.duration)
            || player.duration <= 0
        ) {
            resolve(false);
            return;
        }

        if (!Number.isFinite(position)) {
            resolve(false);
            return;
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

        internalSeek = true;

        let finished = false;

        const cleanup = () => {
            if (finished) {
                return;
            }

            finished = true;

            player.removeEventListener(
                "seeked",
                onSeeked
            );

            internalSeek = false;

            resolve(true);
        };

        const onSeeked = () => {
            cleanup();
        };

        player.addEventListener(
            "seeked",
            onSeeked
        );

        try {
            player.currentTime =
                target;
        } catch (_) {
            cleanup();
            return;
        }

        /*
         * На некоторых браузерах seeked
         * может не прийти, если позиция
         * фактически не изменилась.
         */
        setTimeout(
            cleanup,
            1500
        );
    });
}


/* =========================================================
   PLAY SYNCHRONIZATION
   ========================================================= */

/*
 * Главная функция запуска фильма.
 *
 * ВСЕГДА:
 *
 * 1. pause()
 * 2. вычислить позицию
 * 3. seek
 * 4. дождаться seeked
 * 5. play()
 */
async function synchronizeAndPlay() {
    if (
        synchronizingPlay
        || !show
    ) {
        return;
    }

    if (
        !isStarted()
        || isFinished()
    ) {
        return;
    }

    if (show.pause === true) {
        player.pause();
        return;
    }

    synchronizingPlay = true;

    try {
        /*
         * Сначала обязательно останавливаем
         * текущее воспроизведение.
         */
        player.pause();

        const position =
            getShowPosition();

        if (
            Number.isFinite(player.duration)
            && player.duration > 0
            && position >= player.duration
        ) {
            hidePlayer();
            return;
        }

        /*
         * ВСЕГДА делаем дополнительную
         * автоматическую синхронизацию
         * перед Play.
         */
        await seekToPosition(
            position
        );

        /*
         * Пока мы синхронизировались,
         * сервер мог получить новую паузу.
         */
        if (
            !show
            || show.pause === true
            || !isStarted()
            || isFinished()
        ) {
            player.pause();
            return;
        }

        await player.play();

    } catch (error) {
        console.error(
            "Не удалось запустить видео:",
            error
        );

    } finally {
        synchronizingPlay = false;
    }
}


/* =========================================================
   USER PLAY BUTTON
   ========================================================= */

player.addEventListener(
    "play",
    event => {
        /*
         * Если это наш собственный player.play(),
         * ничего не делаем.
         */
        if (synchronizingPlay) {
            return;
        }

        /*
         * Если это программное воспроизведение
         * после внутренней синхронизации,
         * ничего не делаем.
         */
        if (internalSeek) {
            return;
        }

        /*
         * Если пользователь нажал Play —
         * немедленно останавливаем воспроизведение
         * и выполняем полную синхронизацию.
         */
        if (show) {
            event.preventDefault();

            player.pause();

            synchronizeAndPlay();
        }
    }
);


/* =========================================================
   USER SEEK
   ========================================================= */

player.addEventListener(
    "seeking",
    () => {
        /*
         * Это наша собственная перемотка.
         */
        if (internalSeek) {
            return;
        }

        if (
            !show
            || !isStarted()
        ) {
            return;
        }

        /*
         * Пользователь попытался перемотать.
         *
         * Возвращаем на серверную позицию.
         */
        const expected =
            getShowPosition();

        if (!Number.isFinite(expected)) {
            return;
        }

        /*
         * Небольшой допуск нужен,
         * чтобы не зациклить собственный seek.
         */
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


/* =========================================================
   METADATA
   ========================================================= */

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

        /*
         * Первый seek после загрузки фильма.
         */
        await seekToPosition(
            position
        );

        if (
            !show
            || show.pause === true
        ) {
            player.pause();
            return;
        }

        await synchronizeAndPlay();

        updateVisibility();
        scheduleFinishCheck();
    }
);


/* =========================================================
   PAUSE STATE
   ========================================================= */

async function applyPauseState(
    forceSeek = false
) {
    if (!show) {
        return;
    }

    if (show.pause === true) {
        /*
         * Пауза:
         *
         * устанавливаем сохранённую позицию
         * только когда это действительно
         * необходимо.
         */
        if (
            forceSeek
            || player.currentTime !==
                Number(show.pausePosition)
        ) {
            await seekToPosition(
                getShowPosition()
            );
        }

        player.pause();

        return;
    }

    /*
     * Пауза снята.
     *
     * Не запускаем старую позицию напрямую.
     * synchronizeAndPlay() сначала
     * вычислит актуальное время и
     * синхронизирует фильм.
     */
    await synchronizeAndPlay();
}


/* =========================================================
   FINISH
   ========================================================= */

function scheduleFinishCheck() {
    if (finishTimer) {
        clearTimeout(
            finishTimer
        );

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
            updateVisibility();

            if (!show.pause) {
                scheduleFinishCheck();
            }
        },
        Math.max(
            250,
            remaining * 1000
        )
    );
}


/* =========================================================
   APPLY SHOW
   ========================================================= */

async function applyShow(
    data,
    force = false
) {
    const movieUrl =
        data.url
        || MOVIE_PROXY_URL;

    const showId =
        data.showId
        || String(
            data.startUnix
            || data.start
            || ""
        );

    const newStartUnix =
        Number(data.startUnix);

    const newPause =
        Boolean(data.pause);

    const isNewShow =
        lastShowId !== null
        && showId !== lastShowId;

    const movieChanged =
        lastMovieUrl !== null
        && movieUrl !== lastMovieUrl;

    const startChanged =
        lastStartUnix !== null
        && Number.isFinite(newStartUnix)
        && newStartUnix !== lastStartUnix;

    const pauseChanged =
        lastPause !== null
        && newPause !== lastPause;

    /*
     * НОВЫЙ ПОКАЗ
     */
    if (isNewShow) {
        if (finishTimer) {
            clearTimeout(
                finishTimer
            );

            finishTimer = null;
        }

        player.pause();

        player.removeAttribute(
            "src"
        );

        player.load();

        lastMovieUrl = null;
        lastStartUnix = null;
        lastPause = null;

        /*
         * Новый showId означает
         * полностью новый сеанс.
         */
    }

    show = data;

    lastShowId =
        showId;

    lastMovieUrl =
        movieUrl;

    lastStartUnix =
        getStartUnix();

    /*
     * Фильм нужно загрузить:
     *
     * - при первом запуске;
     * - при новом showId;
     * - при смене movie URL.
     */
    if (
        force
        || isNewShow
        || movieChanged
    ) {
        player.src =
            movieUrl;

        player.load();

        /*
         * loadedmetadata выполнит
         * первичную синхронизацию.
         */
        updateVisibility();

        lastPause =
            newPause;

        return;
    }

    /*
     * Если показ ещё не начался.
     */
    if (!isStarted()) {
        player.pause();

        updateVisibility();

        lastPause =
            newPause;

        return;
    }

    /*
     * Фильм уже закончился.
     */
    if (isFinished()) {
        hidePlayer();

        lastPause =
            newPause;

        return;
    }

    /*
     * Состояние паузы изменилось.
     */
    if (pauseChanged) {
        if (newPause) {
            /*
             * Включилась пауза.
             *
             * Один раз переходим
             * на pausePosition.
             */
            await applyPauseState(
                true
            );
        } else {
            /*
             * Пауза снята.
             *
             * Сначала синхронизация,
             * потом Play.
             */
            await synchronizeAndPlay();
        }
    } else if (newPause) {
        /*
         * Уже стоит пауза.
         *
         * НЕ делаем seek каждую секунду.
         */
        player.pause();

    } else if (player.paused) {
        /*
         * Видео неожиданно остановилось.
         *
         * Снова синхронизируем.
         */
        await synchronizeAndPlay();
    }

    lastPause =
        newPause;

    updateVisibility();
    scheduleFinishCheck();
}


/* =========================================================
   LOAD SHOW.JSON
   ========================================================= */

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
            "Ошибка загрузки show.json:",
            error
        );
    }
}


/* =========================================================
   VISIBILITY CHANGE
   ========================================================= */

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
            player.pause();

            seekToPosition(
                getShowPosition()
            );

        } else {
            /*
             * После возврата на вкладку
             * обязательно повторяем синхронизацию.
             */
            synchronizeAndPlay();
        }
    }
);


/* =========================================================
   VIDEO EVENTS
   ========================================================= */

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


player.addEventListener(
    "error",
    () => {
        console.error(
            "Ошибка видео:",
            player.error
        );
    }
);


/* =========================================================
   PERIODIC CHECK
   ========================================================= */

setInterval(
    () => {
        if (!show) {
            return;
        }

        updateVisibility();

        if (
            !isStarted()
            || isFinished()
        ) {
            return;
        }

        if (show.pause === true) {
            /*
             * На паузе НЕ перематываем
             * каждую секунду.
             */
            if (!player.paused) {
                player.pause();
            }

            return;
        }

        /*
         * Если видео почему-то остановилось,
         * синхронизируем и запускаем.
         */
        if (
            player.paused
            && !synchronizingPlay
        ) {
            synchronizeAndPlay();
        }
    },
    1000
);


/* =========================================================
   START
   ========================================================= */

async function start() {
    await loadShow(true);

    setInterval(
        () => {
            loadShow(false);
        },
        POLL_MS
    );
}


start();