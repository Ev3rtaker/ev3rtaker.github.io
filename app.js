"use strict";


const WORKER_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev";


const SHOW_URL =
    WORKER_URL + "/show.json";


const MOVIE_URL =
    WORKER_URL;


const SHOW_REFRESH_MS =
    1000;


const SYNC_MS =
    250;


const player =
    document.getElementById(
        "player"
    );


let currentShow = null;

let currentShowId = null;

let metadataReady = false;

let showRequestNumber = 0;

let abortController = null;

let internalSeek = false;


// ============================================================
// TIME
// ============================================================

function nowUnix() {
    return Date.now() / 1000;
}


// ============================================================
// PAUSED DURATION
// ============================================================

function getPausedDuration(show) {

    const intervals =
        show.pauseIntervals;

    if (
        !Array.isArray(intervals)
    ) {
        return 0;
    }

    let total = 0;

    for (
        const item of intervals
    ) {

        if (
            !item
            ||
            typeof item !== "object"
        ) {
            continue;
        }

        const start =
            Number(
                item.startUnix
            );

        const end =
            Number(
                item.endUnix
            );

        if (
            Number.isFinite(start)
            &&
            Number.isFinite(end)
            &&
            end >= start
        ) {

            total +=
                end - start;
        }
    }

    return Math.max(
        0,
        total
    );
}


// ============================================================
// START TIME
// ============================================================

function getStartUnix(show) {

    const value =
        Number(
            show.startUnix
        );

    if (
        Number.isFinite(value)
    ) {
        return value;
    }

    const parsed =
        Date.parse(
            show.start
        );

    if (
        Number.isFinite(parsed)
    ) {
        return parsed / 1000;
    }

    return NaN;
}


// ============================================================
// CURRENT MOVIE POSITION
// ============================================================

function getSchedulePosition(show) {

    if (!show) {
        return 0;
    }

    const start =
        getStartUnix(show);

    if (
        !Number.isFinite(start)
    ) {
        return 0;
    }

    const now =
        nowUnix();

    if (
        now < start
    ) {
        return 0;
    }

    /*
     * Активная пауза.
     *
     * Здесь pausePosition является
     * абсолютной сохранённой позицией.
     */
    if (
        show.pause === true
    ) {

        return Math.max(
            0,
            Number(
                show.pausePosition
            ) || 0
        );
    }

    /*
     * После снятия паузы:
     *
     * реальное время
     * - время старта
     * - все завершённые паузы
     */
    const paused =
        getPausedDuration(
            show
        );

    return Math.max(
        0,
        now
        - start
        - paused
    );
}


// ============================================================
// VISIBILITY
// ============================================================

function hidePlayer() {

    player.style.display =
        "none";
}


function showPlayer() {

    player.style.display =
        "block";
}


// ============================================================
// LOAD MOVIE
// ============================================================

function loadMovie() {

    metadataReady =
        false;

    player.src =
        MOVIE_URL;

    player.load();
}


// ============================================================
// APPLY SHOW
// ============================================================

function applyShow(show) {

    if (!show) {
        return;
    }

    const oldShowId =
        currentShowId;

    currentShow =
        show;

    currentShowId =
        show.showId;

    if (
        oldShowId !==
        currentShowId
    ) {

        loadMovie();
    }
}


// ============================================================
// SEEK
// ============================================================

function seekToPosition(
    position
) {

    if (
        !Number.isFinite(
            player.duration
        )
        ||
        player.duration <= 0
    ) {

        return;
    }

    const target =
        Math.max(
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

        internalSeek =
            true;

        player.currentTime =
            target;

    } catch (_) {

        internalSeek =
            false;
    }
}


player.addEventListener(
    "seeked",
    () => {

        internalSeek =
            false;
    }
);


// ============================================================
// SYNC
// ============================================================

function syncPlayer() {

    const show =
        currentShow;

    if (!show) {

        hidePlayer();

        return;
    }

    const start =
        getStartUnix(
            show
        );

    if (
        !Number.isFinite(start)
    ) {

        hidePlayer();

        return;
    }

    /*
     * Показ ещё не начался.
     */

    if (
        nowUnix() < start
    ) {

        showPlayer();

        player.pause();

        if (
            metadataReady
        ) {

            seekToPosition(
                0
            );
        }

        return;
    }

    /*
     * Без duration браузер пока
     * не может определить конец.
     */

    if (
        !metadataReady
        ||
        !Number.isFinite(
            player.duration
        )
        ||
        player.duration <= 0
    ) {

        return;
    }

    const target =
        getSchedulePosition(
            show
        );

    /*
     * Фильм закончен.
     */

    if (
        target >=
        player.duration
    ) {

        player.pause();

        hidePlayer();

        return;
    }

    showPlayer();

    /*
     * Если пауза активна —
     * всегда стоим на pausePosition.
     */

    if (
        show.pause === true
    ) {

        const difference =
            Math.abs(
                player.currentTime
                - target
            );

        if (
            difference > 0.25
        ) {

            seekToPosition(
                target
            );
        }

        player.pause();

        return;
    }

    /*
     * Обычный режим.
     *
     * Если пользователь вручную
     * перемотал фильм, seeking ниже
     * вернёт его обратно.
     */

    if (
        player.paused
    ) {

        player.play()
            .catch(
                () => {}
            );
    }
}


// ============================================================
// MANUAL SEEK
// ============================================================

player.addEventListener(
    "seeking",
    () => {

        if (
            internalSeek
        ) {

            return;
        }

        if (
            !currentShow
            ||
            !metadataReady
        ) {

            return;
        }

        const target =
            getSchedulePosition(
                currentShow
            );

        if (
            Math.abs(
                player.currentTime
                - target
            ) > 0.5
        ) {

            seekToPosition(
                target
            );
        }
    }
);


// ============================================================
// METADATA
// ============================================================

player.addEventListener(
    "loadedmetadata",
    () => {

        metadataReady =
            true;

        syncPlayer();
    }
);


// ============================================================
// ENDED
// ============================================================

player.addEventListener(
    "ended",
    () => {

        hidePlayer();
    }
);


// ============================================================
// LOAD SHOW
// ============================================================

async function loadShow() {

    const requestNumber =
        ++showRequestNumber;

    if (
        abortController
    ) {

        abortController.abort();
    }

    abortController =
        new AbortController();

    try {

        const response =
            await fetch(
                SHOW_URL
                + "?t="
                + Date.now(),
                {
                    method: "GET",

                    cache: "no-store",

                    signal:
                        abortController.signal,

                    headers: {
                        "Cache-Control":
                            "no-cache",

                        "Pragma":
                            "no-cache"
                    }
                }
            );

        if (
            !response.ok
        ) {

            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        /*
         * Старый запрос не может
         * перезаписать новый.
         */

        if (
            requestNumber
            !==
            showRequestNumber
        ) {

            return;
        }

        applyShow(
            data
        );

        syncPlayer();

    } catch (error) {

        if (
            error.name ===
            "AbortError"
        ) {

            return;
        }

        console.error(
            "show.json:",
            error
        );
    }
}


// ============================================================
// SEQUENTIAL POLLING
// ============================================================

async function pollingLoop() {

    while (true) {

        await loadShow();

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    SHOW_REFRESH_MS
                )
        );
    }
}


// ============================================================
// FAST SYNC
// ============================================================

setInterval(
    () => {

        syncPlayer();

    },
    SYNC_MS
);


// ============================================================
// START
// ============================================================

pollingLoop();