"use strict";

const SHOW_URL = "show.json";
const MOVIE_PROXY_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

const POLL_MS = 1000;
const SHOW_REFRESH_MS = 10000;
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


/* TIME / SHOW */

function nowUnix() {
    return Date.now() / 1000;
}

function getMovieUrl(data) {
    return data?.url || MOVIE_PROXY_URL;
}

function getStartUnix(data = show) {
    if (!data) return NaN;

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

    return Number.isFinite(start) && nowUnix() >= start;
}


/* PAUSE INTERVALS */

function getCompletedPauseDuration(data = show) {
    if (!data) return 0;

    const intervals =
        Array.isArray(data.pauseIntervals)
            ? data.pauseIntervals
            : [];

    let total = 0;

    for (const interval of intervals) {
        const start = Number(interval?.startUnix);
        const end = Number(interval?.endUnix);

        if (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            end >= start
        ) {
            total += end - start;
        }
    }

    if (
        intervals.length === 0 &&
        Number.isFinite(Number(data.pausedDuration))
    ) {
        return Math.max(0, Number(data.pausedDuration));
    }

    return Math.max(0, total);
}

function getShowPosition(data = show) {
    if (!data) return 0;

    if (data.pause === true) {
        const position = Number(data.pausePosition);

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
        nowUnix() -
            start -
            getCompletedPauseDuration(data)
    );
}


/* VIDEO POSITION */

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
            Math.max(0, player.duration - 0.05)
        )
    );
}

function seekToPosition(position) {
    if (
        !Number.isFinite(player.duration) ||
        player.duration <= 0
    ) {
        return Promise.resolve(false);
    }

    const target = clampPosition(position);

    if (
        Math.abs(player.currentTime - target) < 0.10
    ) {
        return Promise.resolve(false);
    }

    if (seekPromise) {
        return seekPromise;
    }

    seekPromise = new Promise(resolve => {
        let finished = false;

        const finish = success => {
            if (finished) return;

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
            player.currentTime = target;
        } catch (error) {
            console.error(
                "currentTime:",
                error
            );

            finish(false);
        }

        setTimeout(() => {
            if (!finished) {
                finish(
                    Math.abs(
                        player.currentTime - target
                    ) < 0.25
                );
            }
        }, 3000);
    });

    return seekPromise;
}


/* VISIBILITY */

function isFinished() {
    if (
        !Number.isFinite(player.duration) ||
        player.duration <= 0
    ) {
        return false;
    }

    return getShowPosition() >= player.duration;
}

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


/* PLAY */

async function startPlayback() {
    try {
        await player.play();
    } catch (_) {}
}

async function syncAndPlay() {
    if (
        !show ||
        show.pause === true ||
        !isStarted(show) ||
        isFinished()
    ) {
        return;
    }

    const target = getShowPosition(show);

    await seekToPosition(target);

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


/* APPLY SHOW */

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

    const newPause = Boolean(data.pause);

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


    /* NEW SHOW */

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


    /* NEW MOVIE */

    if (
        showChanged ||
        movieChanged
    ) {
        player.pause();

        loadedMovieUrl = newMovieUrl;

        player.src = newMovieUrl;
        player.load();

        lastPause = newPause;

        return;
    }


    /* NOT STARTED */

    if (!isStarted(data)) {
        player.pause();

        updateVisibility();

        lastPause = newPause;

        return;
    }


    /* FINISHED */

    if (isFinished()) {
        player.pause();

        updateVisibility();

        lastPause = newPause;

        return;
    }


    /* PAUSE STARTED */

    if (
        pauseChanged &&
        newPause === true
    ) {
        player.pause();

        await seekToPosition(
            getShowPosition(data)
        );

        player.pause();

        lastPause = true;

        updateVisibility();

        return;
    }


    /* PAUSE ENDED */

    if (
        pauseChanged &&
        newPause === false
    ) {
        const target =
            getShowPosition(data);

        console.log(
            "[RESUME] server position:",
            target
        );

        await seekToPosition(target);

        console.log(
            "[RESUME] video position:",
            player.currentTime
        );

        await startPlayback();

        lastPause = false;

        updateVisibility();

        return;
    }


    /* SERVER PAUSED */

    if (newPause === true) {
        if (!player.paused) {
            player.pause();
        }

        lastPause = true;

        return;
    }


    /* SERVER PLAYING */

    if (player.paused) {
        await syncAndPlay();
    }

    lastPause = false;

    updateVisibility();
}


/* SHOW.JSON */

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


/* VIDEO LOADED */

player.addEventListener(
    "loadedmetadata",
    async () => {
        if (!show) return;

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

        await seekToPosition(target);

        console.log(
            "[METADATA] video position:",
            player.currentTime
        );

        if (!show) return;

        if (show.pause === true) {
            player.pause();
        } else {
            await startPlayback();
        }

        updateVisibility();
    }
);


/* MANUAL SEEK */

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
                player.currentTime - expected
            ) > 0.25
        ) {
            seekToPosition(expected);
        }
    }
);


/* USER PLAY DURING SERVER PAUSE */

player.addEventListener(
    "play",
    () => {
        if (!show) return;

        if (show.pause === true) {
            player.pause();

            seekToPosition(
                getShowPosition(show)
            );
        }
    }
);


/* VIDEO EVENTS */

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


/* TAB RETURN */

document.addEventListener(
    "visibilitychange",
    async () => {
        if (
            document.visibilityState !==
            "visible"
        ) {
            return;
        }

        await loadShow();

        if (
            show &&
            show.pause === false &&
            isStarted(show)
        ) {
            await syncAndPlay();
        }
    }
);


/* LOCAL VIDEO SYNC — EVERY SECOND */

setInterval(
    async () => {
        if (!show) return;

        updateVisibility();

        if (
            !isStarted(show) ||
            isFinished()
        ) {
            return;
        }

        if (show.pause === true) {
            if (!player.paused) {
                player.pause();
            }

            return;
        }

        const expected =
            getShowPosition(show);

        const actual =
            player.currentTime;

        const drift =
            Math.abs(
                actual - expected
            );

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

        if (player.paused) {
            await syncAndPlay();
        }
    },
    POLL_MS
);


/* SHOW.JSON REFRESH — EVERY 10 SECONDS */

setInterval(
    async () => {
        await loadShow();
    },
    SHOW_REFRESH_MS
);


/* START */

loadShow();