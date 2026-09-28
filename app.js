"use strict";

const WORKER_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

const SHOW_URL =
    `${WORKER_URL}/show.json`;

const MOVIE_URL =
    WORKER_URL;

const player =
    document.getElementById("player");

let show = null;
let refreshTimer = null;
let positionTimer = null;

let currentShowId = null;
let lastForcedPosition = null;
let forcingPosition = false;


/*
 * ==========================================
 * SHOW.JSON
 * ==========================================
 */

async function fetchShow() {
    const url =
        `${SHOW_URL}?t=${Date.now()}`;

    /*
     * Никаких custom headers.
     *
     * Это важно:
     * браузер не должен делать CORS preflight
     * из-за Cache-Control.
     */
    const response =
        await fetch(url, {
            method: "GET",
            mode: "cors",
            cache: "no-store"
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
        return Number(
            show.startUnix
        );
    }

    if (
        show &&
        show.start
    ) {
        const time =
            new Date(show.start)
                .getTime();

        if (Number.isFinite(time)) {
            return time / 1000;
        }
    }

    return null;
}


function getPausedDuration() {
    if (
        !show ||
        !Array.isArray(
            show.pauseIntervals
        )
    ) {
        return 0;
    }

    let total = 0;

    for (
        const interval of
        show.pauseIntervals
    ) {
        if (!interval) {
            continue;
        }

        const start =
            Number(
                interval.startUnix
            );

        const end =
            Number(
                interval.endUnix
            );

        if (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            end >= start
        ) {
            total +=
                end - start;
        }
    }

    return total;
}


function getShowPosition() {
    if (!show) {
        return 0;
    }

    /*
     * Во время активной паузы
     * pausePosition является
     * единственным источником истины.
     */
    if (show.pause === true) {
        const pausePosition =
            Number(
                show.pausePosition
            );

        if (
            Number.isFinite(
                pausePosition
            )
        ) {
            return Math.max(
                0,
                pausePosition
            );
        }

        return 0;
    }

    const startUnix =
        getStartUnix();

    if (
        !Number.isFinite(
            startUnix
        )
    ) {
        return 0;
    }

    const now =
        Date.now() / 1000;

    if (now < startUnix) {
        return 0;
    }

    const paused =
        getPausedDuration();

    return Math.max(
        0,
        now -
        startUnix -
        paused
    );
}


/*
 * ==========================================
 * VIDEO POSITION
 * ==========================================
 */

function setVideoPosition(
    position,
    force = false
) {
    if (
        !player ||
        !Number.isFinite(
            player.duration
        )
    ) {
        return;
    }

    let target =
        Math.max(
            0,
            Number(position) || 0
        );

    /*
     * Не пытаемся установить
     * currentTime за пределы файла.
     */
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
            player.currentTime -
            target
        );

    /*
     * Не дёргаем video постоянно.
     */
    if (
        !force &&
        difference <= 1.5
    ) {
        return;
    }

    if (forcingPosition) {
        return;
    }

    forcingPosition = true;

    try {
        player.currentTime =
            target;

        lastForcedPosition =
            target;
    } catch (error) {
        console.warn(
            "Не удалось установить позицию:",
            error
        );
    } finally {
        setTimeout(() => {
            forcingPosition = false;
        }, 100);
    }
}


/*
 * ==========================================
 * PAUSE
 * ==========================================
 */

function applyPauseState() {
    if (!show || !player) {
        return;
    }

    if (show.pause === true) {
        /*
         * Серверная пауза.
         */
        const position =
            Number(
                show.pausePosition
            );

        if (
            Number.isFinite(
                position
            )
        ) {
            setVideoPosition(
                position,
                true
            );
        }

        if (!player.paused) {
            player.pause();
        }

        return;
    }

    /*
     * Пауза выключена.
     */
    const position =
        getShowPosition();

    setVideoPosition(
        position,
        true
    );
}


/*
 * ==========================================
 * MANUAL SEEK PROTECTION
 * ==========================================
 *
 * Пользователь может попробовать
 * перетащить ползунок.
 *
 * После seeked возвращаем его
 * на позицию расписания.
 */

player.addEventListener(
    "seeking",
    () => {
        /*
         * Ничего не делаем.
         * Ждём seeked.
         */
    }
);


player.addEventListener(
    "seeked",
    () => {
        if (
            forcingPosition
        ) {
            return;
        }

        if (!show) {
            return;
        }

        const target =
            show.pause === true
                ? Number(
                    show.pausePosition
                )
                : getShowPosition();

        if (
            !Number.isFinite(
                target
            )
        ) {
            return;
        }

        setVideoPosition(
            target,
            true
        );
    }
);


/*
 * ==========================================
 * VIDEO
 * ==========================================
 */

player.addEventListener(
    "loadedmetadata",
    () => {
        if (!show) {
            return;
        }

        applyPauseState();
    }
);


player.addEventListener(
    "loadeddata",
    () => {
        if (!show) {
            return;
        }

        applyPauseState();
    }
);


player.addEventListener(
    "canplay",
    () => {
        if (!show) {
            return;
        }

        applyPauseState();

        /*
         * Если показ уже должен идти,
         * пытаемся запустить видео.
         */
        if (
            show.pause !== true &&
            getShowPosition() <
                player.duration
        ) {
            tryPlay();
        }
    }
);


player.addEventListener(
    "timeupdate",
    () => {
        if (!show) {
            return;
        }

        /*
         * Активная серверная пауза:
         * видео должно оставаться
         * на pausePosition.
         */
        if (
            show.pause === true
        ) {
            const position =
                Number(
                    show.pausePosition
                );

            if (
                Number.isFinite(
                    position
                )
            ) {
                if (
                    Math.abs(
                        player.currentTime -
                        position
                    ) > 0.5
                ) {
                    setVideoPosition(
                        position,
                        true
                    );
                }
            }

            if (!player.paused) {
                player.pause();
            }

            return;
        }

        /*
         * Обычный режим.
         *
         * Каждые несколько секунд
         * ниже будет выполняться точная
         * синхронизация.
         */
    }
);


player.addEventListener(
    "ended",
    () => {
        /*
         * Ничего дополнительно не делаем.
         * Когда позиция достигнет duration,
         * видео естественно закончится.
         */
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

    const target =
        getShowPosition();

    if (
        Number.isFinite(
            player.duration
        ) &&
        target >=
            player.duration
    ) {
        return;
    }

    /*
     * Перед play сначала
     * ставим точную позицию.
     */
    setVideoPosition(
        target,
        true
    );

    try {
        await player.play();
    } catch (error) {
        /*
         * Автовоспроизведение со звуком
         * может быть запрещено браузером.
         *
         * Пробуем muted.
         */
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

async function applyShow(
    newShow
) {
    const newShowId =
        newShow.showId || null;

    const showChanged =
        currentShowId !== null &&
        newShowId !== null &&
        currentShowId !== newShowId;

    show = newShow;

    /*
     * Новый показ.
     */
    if (showChanged) {
        console.log(
            "Новый показ:",
            newShowId
        );

        player.pause();

        player.removeAttribute(
            "src"
        );

        player.load();

        lastForcedPosition =
            null;
    }

    currentShowId =
        newShowId;

    /*
     * Если показ ещё не начался,
     * видео не должно играть.
     */
    const startUnix =
        getStartUnix();

    if (
        Number.isFinite(
            startUnix
        ) &&
        Date.now() / 1000 <
            startUnix
    ) {
        player.pause();
        return;
    }

    /*
     * Проверяем, что movie.mp4
     * уже установлен.
     */
    if (
        !player.src ||
        !player.src.startsWith(
            MOVIE_URL
        )
    ) {
        player.src =
            MOVIE_URL;

        player.preload =
            "auto";

        player.load();

        return;
    }

    /*
     * Видео уже загружено.
     */
    if (
        Number.isFinite(
            player.duration
        )
    ) {
        applyPauseState();

        if (
            show.pause !== true
        ) {
            tryPlay();
        }
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

        await applyShow(
            newShow
        );
    } catch (error) {
        console.error(
            "show.json:",
            error
        );
    }
}


function startRefresh() {
    if (refreshTimer) {
        clearInterval(
            refreshTimer
        );
    }

    /*
     * Проверяем KV каждые 5 секунд.
     *
     * При этом movie.mp4
     * не скачивается заново.
     */
    refreshTimer =
        setInterval(
            loadShow,
            5000
        );
}


/*
 * ==========================================
 * SYNCHRONIZATION
 * ==========================================
 */

function synchronizeVideo() {
    if (
        !show ||
        !player ||
        !Number.isFinite(
            player.duration
        )
    ) {
        return;
    }

    const startUnix =
        getStartUnix();

    if (
        !Number.isFinite(
            startUnix
        )
    ) {
        return;
    }

    const now =
        Date.now() / 1000;

    /*
     * До начала показа.
     */
    if (
        now < startUnix
    ) {
        if (!player.paused) {
            player.pause();
        }

        return;
    }

    /*
     * Активная пауза.
     */
    if (
        show.pause === true
    ) {
        applyPauseState();
        return;
    }

    /*
     * Показ идёт.
     */
    const target =
        getShowPosition();

    /*
     * Фильм закончился.
     */
    if (
        target >=
        player.duration
    ) {
        player.pause();

        return;
    }

    const difference =
        Math.abs(
            player.currentTime -
            target
        );

    /*
     * Если пользователь
     * вручную перемотал видео,
     * возвращаем точную позицию.
     */
    if (
        difference > 2
    ) {
        setVideoPosition(
            target,
            true
        );
    }

    /*
     * Если видео остановилось,
     * пытаемся продолжить.
     */
    if (
        player.paused
    ) {
        tryPlay();
    }
}


/*
 * ==========================================
 * START
 * ==========================================
 */

loadShow();

startRefresh();

positionTimer =
    setInterval(
        synchronizeVideo,
        1000
    );