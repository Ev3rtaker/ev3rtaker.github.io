"use strict";

const SHOW_URL = "show.json";
const MOVIE_PROXY_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

const POLL_MS = 1000;

const player = document.getElementById("player");

let show = null;
let lastShowId = null;
let lastPause = null;

let internalSeek = false;
let finishTimer = null;
let loadedMovieUrl = "";
let loadedStartUnix = null;


/* =========================================================
   ОБЩИЕ ФУНКЦИИ
   ========================================================= */

function nowUnix() {
    return Date.now() / 1000;
}


function getMovieUrl(data) {
    return data?.url || MOVIE_PROXY_URL;
}


function getStartUnix(data = show) {
    if (!data) {
        return NaN;
    }

    const value = Number(data.startUnix);

    if (Number.isFinite(value)) {
        return value;
    }

    const parsed = Date.parse(data.start);

    if (Number.isFinite(parsed)) {
        return parsed / 1000;
    }

    return NaN;
}


/* =========================================================
   ПАУЗЫ
   ========================================================= */

/*
 * Суммируем ТОЛЬКО завершённые интервалы.
 *
 * Активная пауза:
 *
 * {
 *   startUnix: ...,
 *   endUnix: null
 * }
 *
 * сюда НЕ входит.
 */
function getCompletedPauseDuration(data = show) {
    if (!data) {
        return 0;
    }

    const intervals =
        Array.isArray(data.pauseIntervals)
            ? data.pauseIntervals
            : [];

    let total = 0;

    for (const interval of intervals) {
        const start = Number(
            interval?.startUnix
        );

        const end = Number(
            interval?.endUnix
        );

        if (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            end >= start
        ) {
            total += end - start;
        }
    }

    /*
     * Совместимость со старым show.json,
     * где ещё не было pauseIntervals.
     */
    if (
        intervals.length === 0 &&
        Number.isFinite(Number(data.pausedDuration))
    ) {
        return Math.max(
            0,
            Number(data.pausedDuration)
        );
    }

    return Math.max(0, total);
}


/*
 * Точная позиция фильма согласно show.json.
 */
function getShowPosition(data = show) {
    if (!data) {
        return 0;
    }

    /*
     * Во время активной паузы позиция ЗАМОРОЖЕНА.
     *
     * Это самое важное место:
     * никакого nowUnix() здесь нет.
     */
    if (data.pause === true) {
        const pausePosition =
            Number(data.pausePosition);

        return Number.isFinite(pausePosition)
            ? Math.max(0, pausePosition)
            : 0;
    }

    const start = getStartUnix(data);

    if (!Number.isFinite(start)) {
        return 0;
    }

    /*
     * Показ ещё не начался.
     */
    if (nowUnix() < start) {
        return 0;
    }

    /*
     * После снятия паузы:
     *
     * позиция =
     *     реальное прошедшее время
     *     - ВСЕ завершённые паузы
     */
    return Math.max(
        0,
        nowUnix()
            - start
            - getCompletedPauseDuration(data)
    );
}


function isStarted(data = show) {
    const start = getStartUnix(data);

    return (
        Number.isFinite(start) &&
        nowUnix() >= start
    );
}


function isFinished() {
    if (
        !player ||
        !Number.isFinite(player.duration) ||
        player.duration <= 0
    ) {
        return false;
    }

    return (
        getShowPosition() >= player.duration
    );
}


/* =========================================================
   VIDEO POSITION
   ========================================================= */

function clampPosition(position) {
    if (!Number.isFinite(position)) {
        return 0;
    }

    if (
        !Number.isFinite(player.duration) ||
        player.duration <= 0
    ) {
        return Math.max(0, position);
    }

    return Math.max(
        0,
        Math.min(
            position,
            Math.max(
                0,
                player.duration - 0.05
            )
        )
    );
}


/*
 * Единственная функция, которая программно
 * меняет currentTime.
 */
function setVideoPosition(position) {
    if (
        !Number.isFinite(player.duration) ||
        player.duration <= 0
    ) {
        return false;
    }

    const target =
        clampPosition(position);

    /*
     * Не делаем бессмысленный seek,
     * если мы уже практически там.
     */
    if (
        Math.abs(
            player.currentTime - target
        ) < 0.15
    ) {
        return false;
    }

    try {
        internalSeek = true;
        player.currentTime = target;
        return true;
    } catch (error) {
        internalSeek = false;

        console.error(
            "Не удалось установить currentTime:",
            error
        );

        return false;
    }
}


player.addEventListener(
    "seeked",
    () => {
        internalSeek = false;
    }
);


/* =========================================================
   VISIBILITY
   ========================================================= */

function updateVisibility() {
    if (
        !show ||
        !isStarted(show) ||
        isFinished()
    ) {
        player.style.visibility = "hidden";

        if (isFinished()) {
            player.pause();
        }

        return;
    }

    player.style.visibility = "visible";
}


/* =========================================================
   FINISH
   ========================================================= */

function scheduleFinishCheck() {
    if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
    }

    if (
        !show ||
        show.pause === true ||
        !isStarted(show) ||
        !Number.isFinite(player.duration) ||
        player.duration <= 0
    ) {
        return;
    }

    const remaining =
        player.duration -
        getShowPosition(show);

    if (remaining <= 0) {
        updateVisibility();
        return;
    }

    finishTimer = setTimeout(
        () => {
            updateVisibility();
            scheduleFinishCheck();
        },
        Math.max(
            250,
            remaining * 1000
        )
    );
}


/* =========================================================
   PLAY / PAUSE
   ========================================================= */

async function startPlayback() {
    try {
        await player.play();
    } catch (error) {
        /*
         * Autoplay может быть запрещён браузером.
         * Это не ошибка расписания.
         */
    }
}


/*
 * Полностью применяет состояние show.json.
 *
 * ВАЖНО:
 *
 * pause false -> true
 *     1. остановить видео
 *     2. поставить pausePosition
 *
 * pause true -> false
 *     1. посчитать позицию с учётом ВСЕХ пауз
 *     2. поставить её
 *     3. запустить
 *
 * обычное обновление JSON:
 *     ничего лишнего с currentTime не делать.
 */
async function applyShow(data) {
    if (
        !data ||
        typeof data !== "object"
    ) {
        return;
    }

    const newShowId =
        data.showId ||
        `${data.startUnix || ""}:${data.movie || "movie.mp4"}`;

    const newPause =
        Boolean(data.pause);

    const newMovieUrl =
        getMovieUrl(data);

    const newStartUnix =
        getStartUnix(data);

    const showChanged =
        lastShowId !== null &&
        lastShowId !== newShowId;

    const pauseChanged =
        lastPause !== null &&
        lastPause !== newPause;

    const movieChanged =
        loadedMovieUrl !== newMovieUrl;

    const startChanged =
        loadedStartUnix !== null &&
        Number.isFinite(newStartUnix) &&
        loadedStartUnix !== newStartUnix;


    /*
     * Новый показ.
     */
    if (showChanged) {
        if (finishTimer) {
            clearTimeout(finishTimer);
            finishTimer = null;
        }

        player.pause();

        player.removeAttribute("src");
        player.load();

        loadedMovieUrl = "";
        loadedStartUnix = null;

        lastPause = null;
    }


    /*
     * Сохраняем новое состояние.
     */
    show = data;
    lastShowId = newShowId;

    loadedStartUnix =
        Number.isFinite(newStartUnix)
            ? newStartUnix
            : null;


    /*
     * Загружаем movie.mp4 только если действительно
     * поменялся показ/фильм.
     */
    if (
        showChanged ||
        movieChanged
    ) {
        loadedMovieUrl =
            newMovieUrl;

        player.src =
            newMovieUrl;

        player.load();

        /*
         * loadedmetadata сам выполнит
         * первичную синхронизацию.
         */
        lastPause = newPause;

        return;
    }


    /*
     * До начала показа.
     */
    if (!isStarted(data)) {
        player.pause();
        updateVisibility();

        lastPause = newPause;

        return;
    }


    /*
     * Фильм закончился.
     */
    if (isFinished()) {
        player.pause();
        updateVisibility();

        lastPause = newPause;

        return;
    }


    /*
     * =====================================================
     * ВКЛЮЧИЛИ ПАУЗУ
     * =====================================================
     */
    if (
        pauseChanged &&
        newPause === true
    ) {
        /*
         * Сначала остановить.
         */
        player.pause();

        /*
         * Затем один раз установить ТОЧНО
         * pausePosition из Python.
         */
        setVideoPosition(
            getShowPosition(data)
        );

        updateVisibility();

        lastPause = true;

        return;
    }


    /*
     * =====================================================
     * СНЯЛИ ПАУЗУ
     * =====================================================
     */
    if (
        pauseChanged &&
        newPause === false
    ) {
        /*
         * Здесь getShowPosition() уже использует
         * pausedDuration / pauseIntervals.
         *
         * В твоём тесте получится:
         *
         * 3058.069459915...
         */
        const target =
            getShowPosition(data);

        /*
         * ОДИН раз выставляем позицию.
         */
        setVideoPosition(target);

        /*
         * И только после этого запускаем.
         */
        await startPlayback();

        updateVisibility();
        scheduleFinishCheck();

        lastPause = false;

        return;
    }


    /*
     * =====================================================
     * ОБЫЧНАЯ ПАУЗА
     * =====================================================
     *
     * show.json просто обновился,
     * но состояние pause не изменилось.
     *
     * НИКАКОГО seek каждую секунду.
     */
    if (newPause === true) {
        if (!player.paused) {
            player.pause();
        }

        /*
         * Ничего больше не делаем.
         *
         * Это гарантирует, что refresh show.json
         * не будет дёргать кадр.
         */

        lastPause = true;

        return;
    }


    /*
     * =====================================================
     * ОБЫЧНОЕ ВОСПРОИЗВЕДЕНИЕ
     * =====================================================
     *
     * JSON обновился, но паузы не было.
     *
     * Не трогаем currentTime.
     */
    if (player.paused) {
        await startPlayback();
    }

    updateVisibility();
    scheduleFinishCheck();

    lastPause = false;
}


/* =========================================================
   LOADING show.json
   ========================================================= */

async function loadShow() {
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
            !data ||
            typeof data !== "object"
        ) {
            throw new Error(
                "Некорректный show.json"
            );
        }

        await applyShow(data);

    } catch (error) {
        console.error(
            "show.json:",
            error
        );
    }
}


/* =========================================================
   VIDEO EVENTS
   ========================================================= */


/*
 * Когда metadata загружена, duration уже известна.
 *
 * Здесь происходит первая синхронизация.
 */
player.addEventListener(
    "loadedmetadata",
    async () => {
        if (!show) {
            return;
        }

        if (!isStarted(show)) {
            player.pause();
            updateVisibility();
            return;
        }

        const position =
            getShowPosition(show);

        if (
            Number.isFinite(player.duration) &&
            position >= player.duration
        ) {
            player.pause();
            updateVisibility();
            return;
        }

        /*
         * Поставить точную серверную позицию.
         */
        setVideoPosition(position);

        if (show.pause === true) {
            /*
             * Во время серверной паузы
             * воспроизведение запрещено.
             */
            player.pause();
        } else {
            /*
             * После загрузки фильма
             * продолжаем показ.
             */
            await startPlayback();
        }

        updateVisibility();
        scheduleFinishCheck();
    }
);


/*
 * Защита от ручной перемотки.
 */
player.addEventListener(
    "seeking",
    () => {
        if (
            internalSeek ||
            !show ||
            !isStarted(show)
        ) {
            return;
        }

        const expected =
            getShowPosition(show);

        if (!Number.isFinite(expected)) {
            return;
        }

        /*
         * Во время паузы возвращаем
         * именно pausePosition.
         *
         * После паузы — текущую позицию
         * по расписанию.
         */
        if (
            Math.abs(
                player.currentTime -
                expected
            ) > 0.25
        ) {
            setVideoPosition(expected);
        }
    }
);


/*
 * Пользователь нажал Play во время серверной паузы.
 *
 * Python всё равно главный источник истины,
 * поэтому Play немедленно отменяется.
 */
player.addEventListener(
    "play",
    () => {
        if (!show) {
            return;
        }

        if (show.pause === true) {
            player.pause();

            setVideoPosition(
                getShowPosition(show)
            );
        }
    }
);


player.addEventListener(
    "ended",
    () => {
        updateVisibility();
    }
);


player.addEventListener(
    "timeupdate",
    () => {
        if (isFinished()) {
            player.pause();
            updateVisibility();
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


/* =========================================================
   ВОЗВРАТ НА ВКЛАДКУ
   ========================================================= */

document.addEventListener(
    "visibilitychange",
    async () => {
        if (
            document.visibilityState !==
            "visible"
        ) {
            return;
        }

        /*
         * Сначала получаем самое свежее
         * состояние Python.
         */
        await loadShow();
    }
);


/* =========================================================
   POLLING
   ========================================================= */

setInterval(
    async () => {
        await loadShow();
    },
    POLL_MS
);


/* =========================================================
   START
   ========================================================= */

loadShow();
