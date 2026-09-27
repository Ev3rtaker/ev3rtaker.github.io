"use strict";

const SHOW_URL = "show.json";

const MOVIE_PROXY_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

const POLL_MS = 1000;

const player = document.getElementById("player");

let show = null;

let lastShowId = null;
let lastPause = null;
let lastMovieUrl = null;
let lastStartUnix = null;

let internalSeek = false;
let syncing = false;
let allowPlayEvent = false;

let finishTimer = null;


/* =========================================================
   BASIC HELPERS
   ========================================================= */

function nowUnix() {
    return Date.now() / 1000;
}


function getMovieUrl(data) {
    return data && data.url
        ? data.url
        : MOVIE_PROXY_URL;
}


function getStartUnix(data = show) {
    if (!data) {
        return NaN;
    }

    const value = Number(data.startUnix);

    if (Number.isFinite(value)) {
        return value;
    }

    if (data.start) {
        const parsed = Date.parse(data.start);

        if (Number.isFinite(parsed)) {
            return parsed / 1000;
        }
    }

    return NaN;
}


function getShowId(data) {
    if (!data) {
        return null;
    }

    if (data.showId) {
        return String(data.showId);
    }

    /*
     * Совместимость со старым show.json,
     * где showId ещё не существовал.
     */
    const start = getStartUnix(data);

    return Number.isFinite(start)
        ? String(start)
        : null;
}


/* =========================================================
   PAUSE INTERVALS
   ========================================================= */

/*
 * pauseIntervals — единственный источник истины
 * для накопленного времени пауз.
 *
 * pausedDuration специально НЕ читается.
 */
function getClosedPauseIntervals(data = show) {
    if (
        !data
        || !Array.isArray(data.pauseIntervals)
    ) {
        return [];
    }

    return data.pauseIntervals.filter(interval => {
        if (!interval || typeof interval !== "object") {
            return false;
        }

        const start = Number(interval.startUnix);
        const end = Number(interval.endUnix);

        return (
            Number.isFinite(start)
            && Number.isFinite(end)
            && end >= start
        );
    });
}


function getCompletedPauseDuration(data = show) {
    let total = 0;

    for (const interval of getClosedPauseIntervals(data)) {
        total +=
            Number(interval.endUnix)
            - Number(interval.startUnix);
    }

    return Math.max(0, total);
}


/*
 * На активной паузе позиция берётся
 * непосредственно из pausePosition.
 *
 * После Resume:
 *
 *     now
 *     - startUnix
 *     - все ЗАКРЫТЫЕ pauseIntervals
 *
 * Это автоматически даёт ту же позицию,
 * с которой закончилась пауза.
 */
function getShowPosition(data = show) {
    if (!data) {
        return 0;
    }

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

    const now = nowUnix();

    if (now <= start) {
        return 0;
    }

    const paused =
        getCompletedPauseDuration(data);

    return Math.max(
        0,
        now - start - paused
    );
}


/* =========================================================
   SHOW STATE
   ========================================================= */

function isStarted(data = show) {
    const start = getStartUnix(data);

    return (
        Number.isFinite(start)
        && nowUnix() >= start
    );
}


function isFinished(data = show) {
    if (
        !Number.isFinite(player.duration)
        || player.duration <= 0
    ) {
        return false;
    }

    return (
        getShowPosition(data)
        >= player.duration
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


/* =========================================================
   SEEK
   ========================================================= */

function seekToPosition(position) {
    return new Promise(resolve => {
        if (
            !Number.isFinite(position)
            || !Number.isFinite(player.duration)
            || player.duration <= 0
        ) {
            resolve(false);
            return;
        }

        const maxPosition =
            Math.max(
                0,
                player.duration - 0.05
            );

        const target =
            Math.max(
                0,
                Math.min(
                    position,
                    maxPosition
                )
            );

        /*
         * Если мы уже практически в нужной позиции,
         * seek не нужен.
         */
        if (
            Math.abs(
                player.currentTime - target
            ) < 0.05
        ) {
            resolve(true);
            return;
        }

        internalSeek = true;

        let finished = false;
        let timeoutId = null;

        function cleanup(success) {
            if (finished) {
                return;
            }

            finished = true;

            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }

            player.removeEventListener(
                "seeked",
                onSeeked
            );

            internalSeek = false;

            resolve(success);
        }

        function onSeeked() {
            cleanup(true);
        }

        player.addEventListener(
            "seeked",
            onSeeked
        );

        timeoutId = setTimeout(
            () => cleanup(false),
            2000
        );

        try {
            player.currentTime = target;
        } catch (error) {
            console.error(
                "Не удалось установить currentTime:",
                error
            );

            cleanup(false);
        }
    });
}


/* =========================================================
   FRESH SHOW.JSON
   ========================================================= */

/*
 * При Resume нужен именно свежий JSON.
 */
async function fetchFreshShow() {
    const response = await fetch(
        `${SHOW_URL}?t=${Date.now()}`,
        {
            cache: "no-store",

            headers: {
                "Cache-Control": "no-cache"
            }
        }
    );

    if (!response.ok) {
        throw new Error(
            `show.json: HTTP ${response.status}`
        );
    }

    const data = await response.json();

    if (
        !data
        || typeof data !== "object"
    ) {
        throw new Error(
            "show.json содержит некорректные данные."
        );
    }

    return data;
}


/* =========================================================
   PLAY
   ========================================================= */

/*
 * Единственная функция, которая запускает фильм.
 *
 * Алгоритм:
 *
 * 1. pause
 * 2. свежий show.json
 * 3. вычислить точную позицию
 * 4. seek
 * 5. дождаться seeked
 * 6. снова проверить состояние
 * 7. play
 */
async function syncAndPlay({
    refresh = true
} = {}) {
    if (syncing) {
        return;
    }

    syncing = true;

    try {
        player.pause();

        if (refresh) {
            const fresh = await fetchFreshShow();

            await applyShow(
                fresh,
                {
                    fromPlaySync: true,
                    allowAutoplay: false
                }
            );
        }

        if (!show) {
            return;
        }

        if (!isStarted(show)) {
            player.pause();
            applyVisibility();
            return;
        }

        /*
         * Если за время запроса сервер включил паузу,
         * продолжать нельзя.
         */
        if (show.pause === true) {
            player.pause();

            await seekToPosition(
                getShowPosition(show)
            );

            return;
        }

        if (isFinished(show)) {
            player.pause();
            applyVisibility();
            return;
        }

        const target =
            getShowPosition(show);

        const seekSuccess =
            await seekToPosition(target);

        if (!seekSuccess) {
            return;
        }

        /*
         * Пока выполнялся seek, show.json мог измениться.
         */
        if (
            !show
            || show.pause === true
            || !isStarted(show)
            || isFinished(show)
        ) {
            player.pause();
            applyVisibility();
            return;
        }

        allowPlayEvent = true;

        try {
            await player.play();
        } finally {
            allowPlayEvent = false;
        }

        applyVisibility();
        scheduleFinishCheck();

    } catch (error) {
        console.error(
            "Ошибка синхронизации видео:",
            error
        );

    } finally {
        syncing = false;
    }
}


/* =========================================================
   PAUSE / RESUME
   ========================================================= */

async function applyPauseState({
    forceSeek = false
} = {}) {
    if (!show) {
        return;
    }

    if (show.pause === true) {
        player.pause();

        const target =
            getShowPosition(show);

        if (
            forceSeek
            || Math.abs(
                player.currentTime - target
            ) > 0.10
        ) {
            await seekToPosition(target);
        }

        return;
    }

    /*
     * Resume:
     *
     * Не используем старую currentTime.
     */
    await syncAndPlay({
        refresh: true
    });
}


/* =========================================================
   APPLY SHOW
   ========================================================= */

async function applyShow(
    data,
    options = {}
) {
    const {
        fromPlaySync = false,
        allowAutoplay = true
    } = options;

    if (!data) {
        return;
    }

    const newShowId =
        getShowId(data);

    const newMovieUrl =
        getMovieUrl(data);

    const newStartUnix =
        getStartUnix(data);

    const newPause =
        data.pause === true;

    const isFirstShow =
        show === null;

    const showChanged =
        !isFirstShow
        && lastShowId !== null
        && newShowId !== lastShowId;

    const movieChanged =
        !isFirstShow
        && lastMovieUrl !== null
        && newMovieUrl !== lastMovieUrl;

    const startChanged =
        !isFirstShow
        && Number.isFinite(newStartUnix)
        && Number.isFinite(lastStartUnix)
        && newStartUnix !== lastStartUnix;

    const pauseChanged =
        !isFirstShow
        && lastPause !== null
        && newPause !== lastPause;

    /*
     * Новый показ.
     */
    if (
        showChanged
        || movieChanged
        || startChanged
    ) {
        player.pause();

        if (finishTimer !== null) {
            clearTimeout(finishTimer);
            finishTimer = null;
        }

        show = data;

        lastShowId = newShowId;
        lastMovieUrl = newMovieUrl;
        lastStartUnix = newStartUnix;
        lastPause = newPause;

        player.src = newMovieUrl;
        player.load();

        applyVisibility();

        return;
    }

    show = data;

    lastShowId = newShowId;
    lastMovieUrl = newMovieUrl;
    lastStartUnix = newStartUnix;

    /*
     * Первый вызов.
     */
    if (isFirstShow) {
        lastPause = newPause;

        if (player.src !== newMovieUrl) {
            player.src = newMovieUrl;
            player.load();
        }

        applyVisibility();

        return;
    }

    /*
     * Показ ещё не начался.
     */
    if (!isStarted(show)) {
        player.pause();

        lastPause = newPause;

        applyVisibility();

        return;
    }

    /*
     * Фильм закончился.
     */
    if (isFinished(show)) {
        player.pause();

        lastPause = newPause;

        applyVisibility();

        return;
    }

    /*
     * ВКЛЮЧИЛАСЬ ПАУЗА.
     */
    if (pauseChanged && newPause) {
        player.pause();

        await applyPauseState({
            forceSeek: true
        });

        lastPause = true;

        applyVisibility();

        return;
    }

    /*
     * ПАУЗА СНЯТА.
     */
    if (pauseChanged && !newPause) {
        lastPause = false;

        if (
            !fromPlaySync
            && allowAutoplay
        ) {
            await syncAndPlay({
                refresh: true
            });
        }

        applyVisibility();
        scheduleFinishCheck();

        return;
    }

    /*
     * ПАУЗА УЖЕ АКТИВНА.
     *
     * Не перематываем каждую секунду.
     */
    if (newPause) {
        player.pause();

        const target =
            getShowPosition(show);

        if (
            Math.abs(
                player.currentTime - target
            ) > 0.10
        ) {
            await seekToPosition(target);
        }

        lastPause = true;

        applyVisibility();

        return;
    }

    /*
     * ОБЫЧНОЕ ВОСПРОИЗВЕДЕНИЕ.
     */
    lastPause = false;

    applyVisibility();

    if (
        player.paused
        && !syncing
        && allowAutoplay
        && !fromPlaySync
    ) {
        await syncAndPlay({
            refresh: false
        });
    }

    scheduleFinishCheck();
}


/* =========================================================
   PLAY BUTTON
   ========================================================= */

player.addEventListener(
    "play",
    () => {
        /*
         * Это наш собственный player.play().
         */
        if (allowPlayEvent) {
            return;
        }

        /*
         * Во время внутренней перемотки
         * play не обрабатываем.
         */
        if (internalSeek) {
            return;
        }

        /*
         * Пользователь нажал Play.
         *
         * Немедленно останавливаем видео
         * и делаем полную синхронизацию.
         */
        player.pause();

        syncAndPlay({
            refresh: true
        });
    }
);


/* =========================================================
   USER SEEK
   ========================================================= */

player.addEventListener(
    "seeking",
    () => {
        if (internalSeek) {
            return;
        }

        if (!show || !isStarted(show)) {
            return;
        }

        /*
         * Во время серверной паузы
         * пользователь не может перемотать фильм.
         */
        if (show.pause === true) {
            seekToPosition(
                getShowPosition(show)
            );

            return;
        }

        /*
         * Во время обычного просмотра
         * ручная перемотка также запрещена.
         */
        seekToPosition(
            getShowPosition(show)
        );
    }
);


/* =========================================================
   METADATA
   ========================================================= */

player.addEventListener(
    "loadedmetadata",
    async () => {
        if (!show) {
            return;
        }

        applyVisibility();

        if (
            !isStarted(show)
            || isFinished(show)
        ) {
            player.pause();
            return;
        }

        /*
         * Первый seek после загрузки фильма.
         */
        await seekToPosition(
            getShowPosition(show)
        );

        if (show.pause === true) {
            player.pause();
            return;
        }

        /*
         * Только после seeked запускаем.
         */
        await syncAndPlay({
            refresh: false
        });
    }
);


/* =========================================================
   VISIBILITY CHANGE
   ========================================================= */

document.addEventListener(
    "visibilitychange",
    () => {
        if (
            document.visibilityState !== "visible"
        ) {
            return;
        }

        if (!show) {
            return;
        }

        /*
         * При возврате во вкладку
         * выполняем свежую синхронизацию.
         */
        if (show.pause === true) {
            player.pause();

            seekToPosition(
                getShowPosition(show)
            );

            return;
        }

        syncAndPlay({
            refresh: true
        });
    }
);


/* =========================================================
   VIDEO EVENTS
   ========================================================= */

player.addEventListener(
    "timeupdate",
    () => {
        if (
            show
            && !show.pause
            && isFinished(show)
        ) {
            player.pause();
            applyVisibility();
        }
    }
);


player.addEventListener(
    "ended",
    () => {
        player.pause();
        player.style.visibility = "hidden";
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
   FINISH TIMER
   ========================================================= */

function scheduleFinishCheck() {
    if (finishTimer !== null) {
        clearTimeout(finishTimer);
        finishTimer = null;
    }

    if (
        !show
        || show.pause === true
        || !isStarted(show)
        || !Number.isFinite(player.duration)
        || player.duration <= 0
    ) {
        return;
    }

    const remaining =
        player.duration
        - getShowPosition(show);

    if (remaining <= 0) {
        player.pause();
        applyVisibility();
        return;
    }

    finishTimer = setTimeout(
        () => {
            if (!show) {
                return;
            }

            if (isFinished(show)) {
                player.pause();
                applyVisibility();
                return;
            }

            scheduleFinishCheck();
        },
        Math.max(
            250,
            remaining * 1000
        )
    );
}


/* =========================================================
   POLLING
   ========================================================= */

async function pollShow() {
    try {
        const data =
            await fetchFreshShow();

        await applyShow(data);

    } catch (error) {
        console.error(
            "Ошибка обновления show.json:",
            error
        );
    }
}


/* =========================================================
   START
   ========================================================= */

async function start() {
    await pollShow();

    setInterval(
        pollShow,
        POLL_MS
    );
}


start();