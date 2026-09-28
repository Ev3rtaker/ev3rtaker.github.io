"use strict";

const SHOW_URL = "show.json";
const MOVIE_PROXY_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

const POLL_MS = 1000;
const SYNC_TOLERANCE = 0.75;

const player = document.getElementById("player");

let show = null;

let lastShowId = null;
let lastPause = null;

let loadedMovieUrl = "";
let loadedStartUnix = null;

let internalSeek = false;
let finishTimer = null;

let seekPromise = null;


/* =========================================================
   TIME / SHOW
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


function isStarted(data = show) {
    const start = getStartUnix(data);

    return (
        Number.isFinite(start) &&
        nowUnix() >= start
    );
}


/* =========================================================
   PAUSE INTERVALS
   ========================================================= */

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
        const start =
            Number(interval?.startUnix);

        const end =
            Number(interval?.endUnix);

        if (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            end >= start
        ) {
            total += end - start;
        }
    }

    /*
     * Совместимость со старым JSON.
     */
    if (
        intervals.length === 0 &&
        Number.isFinite(
            Number(data.pausedDuration)
        )
    ) {
        return Math.max(
            0,
            Number(data.pausedDuration)
        );
    }

    return Math.max(0, total);
}


/*
 * ЕДИНСТВЕННЫЙ источник серверной позиции.
 */
function getShowPosition(data = show) {
    if (!data) {
        return 0;
    }

    /*
     * АКТИВНАЯ ПАУЗА.
     *
     * Никакого nowUnix().
     * Никакого пересчёта.
     *
     * Позиция заморожена Python-скриптом.
     */
    if (data.pause === true) {
        const position =
            Number(data.pausePosition);

        return Number.isFinite(position)
            ? Math.max(0, position)
            : 0;
    }

    const start = getStartUnix(data);

    if (!Number.isFinite(start)) {
        return 0;
    }

    if (nowUnix() < start) {
        return 0;
    }

    return Math.max(
        0,
        nowUnix()
            - start
            - getCompletedPauseDuration(data)
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
 * Ждём реального завершения seek.
 *
 * Это принципиальное отличие от предыдущей версии.
 */
function seekToPosition(position) {
    if (
        !Number.isFinite(player.duration) ||
        player.duration <= 0
    ) {
        return Promise.resolve(false);
    }

    const target =
        clampPosition(position);

    /*
     * Уже практически на нужной позиции.
     */
    if (
        Math.abs(
            player.currentTime - target
        ) < 0.10
    ) {
        return Promise.resolve(false);
    }

    /*
     * Если seek уже выполняется,
     * ждём его завершения.
     */
    if (seekPromise) {
        return seekPromise;
    }

    seekPromise = new Promise(resolve => {
        let finished = false;

        const finish = success => {
            if (finished) {
                return;
            }

            finished = true;

            player.removeEventListener(
                "seeked",
                onSeeked
            );

            player.removeEventListener(
                "error",
                onError
            );

            internalSeek = false;
            seekPromise = null;

            resolve(success);
        };

        const onSeeked = () => {
            finish(true);
        };

        const onError = () => {
            finish(false);
        };

        player.addEventListener(
            "seeked",
            onSeeked
        );

        player.addEventListener(
            "error",
            onError
        );

        try {
            internalSeek = true;

            player.currentTime =
                target;

        } catch (error) {
            console.error(
                "currentTime:",
                error
            );

            finish(false);
        }

        /*
         * Защита от зависшего seek.
         */
        setTimeout(() => {
            if (!finished) {
                finish(
                    Math.abs(
                        player.currentTime -
                        target
                    ) < 0.25
                );
            }
        }, 3000);
    });

    return seekPromise;
}


/* =========================================================
   VISIBILITY
   ========================================================= */

function isFinished() {
    if (
        !Number.isFinite(player.duration) ||
        player.duration <= 0
    ) {
        return false;
    }

    return (
        getShowPosition() >=
        player.duration
    );
}


function updateVisibility() {
    if (
        !show ||
        !isStarted(show) ||
        isFinished()
    ) {
        player.style.visibility =
            "hidden";

        if (isFinished()) {
            player.pause();
        }

        return;
    }

    player.style.visibility =
        "visible";
}


/* =========================================================
   PLAY
   ========================================================= */

async function startPlayback() {
    try {
        await player.play();
    } catch (_) {
        /*
         * Autoplay может быть запрещён.
         */
    }
}


/*
 * Сначала seek.
 * Потом play.
 */
async function syncAndPlay() {
    if (
        !show ||
        show.pause === true ||
        !isStarted(show) ||
        isFinished()
    ) {
        return;
    }

    const target =
        getShowPosition(show);

    /*
     * КРИТИЧЕСКИ ВАЖНО:
     *
     * сначала ждём seeked,
     * потом запускаем play.
     */
    await seekToPosition(target);

    /*
     * show.json мог измениться,
     * пока мы ждали seek.
     */
    if (
        !show ||
        show.pause === true
    ) {
        player.pause();
        return;
    }

    await startPlayback();

    updateVisibility();
}


/* =========================================================
   APPLY SHOW
   ========================================================= */

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


    /*
     * НОВЫЙ ПОКАЗ
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


    show = data;
    lastShowId = newShowId;

    loadedStartUnix =
        Number.isFinite(newStartUnix)
            ? newStartUnix
            : null;


    /*
     * НОВЫЙ ФИЛЬМ
     */
    if (
        showChanged ||
        movieChanged
    ) {
        player.pause();

        loadedMovieUrl =
            newMovieUrl;

        player.src =
            newMovieUrl;

        player.load();

        lastPause =
            newPause;

        return;
    }


    /*
     * ПОКАЗ ЕЩЁ НЕ НАЧАЛСЯ
     */
    if (!isStarted(data)) {
        player.pause();

        updateVisibility();

        lastPause =
            newPause;

        return;
    }


    /*
     * ФИЛЬМ ЗАКОНЧИЛСЯ
     */
    if (isFinished()) {
        player.pause();

        updateVisibility();

        lastPause =
            newPause;

        return;
    }


    /*
     * =====================================================
     * PAUSE: FALSE -> TRUE
     * =====================================================
     */
    if (
        pauseChanged &&
        newPause === true
    ) {
        /*
         * Немедленно остановить.
         */
        player.pause();

        /*
         * Ждём точного завершения seek.
         */
        await seekToPosition(
            getShowPosition(data)
        );

        /*
         * На всякий случай снова остановить
         * после seek.
         */
        player.pause();

        lastPause = true;

        updateVisibility();

        return;
    }


    /*
     * =====================================================
     * PAUSE: TRUE -> FALSE
     * =====================================================
     */
    if (
        pauseChanged &&
        newPause === false
    ) {
        /*
         * Это ключевой момент.
         *
         * getShowPosition() уже учитывает
         * ВСЕ pauseIntervals.
         */
        const target =
            getShowPosition(data);

        console.log(
            "[RESUME] server position:",
            target
        );

        /*
         * ЖДЁМ seeked.
         */
        await seekToPosition(target);

        console.log(
            "[RESUME] video position:",
            player.currentTime
        );

        /*
         * Запускаем только после завершения seek.
         */
        await startPlayback();

        lastPause = false;

        updateVisibility();

        return;
    }


    /*
     * =====================================================
     * ОСТАЁМСЯ НА ПАУЗЕ
     * =====================================================
     */
    if (newPause === true) {
        /*
         * НИКАКОГО seek!
         *
         * Это важно:
         * refresh show.json не должен
         * менять кадр на паузе.
         */
        if (!player.paused) {
            player.pause();
        }

        lastPause = true;

        return;
    }


    /*
     * =====================================================
     * ОБЫЧНОЕ ВОСПРОИЗВЕДЕНИЕ
     * =====================================================
     *
     * Здесь JSON просто обновился.
     * Не делаем seek каждый раз.
     *
     * Отдельный sync-таймер ниже будет
     * контролировать drift.
     */
    if (player.paused) {
        await syncAndPlay();
    }

    lastPause = false;

    updateVisibility();
}


/* =========================================================
   show.json
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
   VIDEO LOADED
   ========================================================= */

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

        const target =
            getShowPosition(show);

        console.log(
            "[METADATA] server position:",
            target
        );

        /*
         * Сначала ждём seek.
         */
        await seekToPosition(target);

        console.log(
            "[METADATA] video position:",
            player.currentTime
        );

        /*
         * Проверяем состояние снова.
         */
        if (!show) {
            return;
        }

        if (show.pause === true) {
            player.pause();
        } else {
            await startPlayback();
        }

        updateVisibility();
    }
);


/* =========================================================
   MANUAL SEEK PROTECTION
   ========================================================= */

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

        if (
            Math.abs(
                player.currentTime -
                expected
            ) > 0.25
        ) {
            seekToPosition(expected);
        }
    }
);


/* =========================================================
   USER PLAY DURING SERVER PAUSE
   ========================================================= */

player.addEventListener(
    "play",
    () => {
        if (!show) {
            return;
        }

        if (show.pause === true) {
            player.pause();

            /*
             * Возвращаемся к pausePosition.
             */
            seekToPosition(
                getShowPosition(show)
            );
        }
    }
);


/* =========================================================
   FINISH
   ========================================================= */

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
         * Берём свежий JSON.
         */
        await loadShow();

        /*
         * После возврата на вкладку
         * один раз корректируем позицию.
         */
        if (
            show &&
            show.pause === false &&
            isStarted(show)
        ) {
            await syncAndPlay();
        }
    }
);


/* =========================================================
   ЖЁСТКАЯ СИНХРОНИЗАЦИЯ
   ========================================================= */

setInterval(
    async () => {
        if (!show) {
            return;
        }

        updateVisibility();

        if (
            !isStarted(show) ||
            isFinished()
        ) {
            return;
        }

        /*
         * ВО ВРЕМЯ ПАУЗЫ:
         *
         * вообще ничего не перематываем.
         */
        if (show.pause === true) {
            if (!player.paused) {
                player.pause();
            }

            return;
        }

        /*
         * ВО ВРЕМЯ ВОСПРОИЗВЕДЕНИЯ:
         *
         * проверяем реальный currentTime
         * против серверного времени.
         */
        const expected =
            getShowPosition(show);

        const actual =
            player.currentTime;

        const drift =
            Math.abs(
                actual - expected
            );

        /*
         * Если браузер ушёл больше чем
         * на 0.75 секунды — корректируем.
         */
        if (
            Number.isFinite(actual) &&
            drift > SYNC_TOLERANCE
        ) {
            console.log(
                "[SYNC]",
                "server:",
                expected,
                "video:",
                actual,
                "drift:",
                drift
            );

            await syncAndPlay();

            return;
        }

        /*
         * Если видео само остановилось —
         * запускаем его снова.
         */
        if (player.paused) {
            await syncAndPlay();
        }

    },
    POLL_MS
);


/* =========================================================
   START
   ========================================================= */

loadShow();