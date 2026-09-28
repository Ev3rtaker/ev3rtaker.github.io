"use strict";

const WORKER_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

const SHOW_URL =
    `${WORKER_URL}/show.json`;

const MOVIE_URL =
    WORKER_URL;

const player =
    document.getElementById("player");

const countdown =
    document.getElementById("countdown");

let show = null;
let refreshTimer = null;
let positionTimer = null;

let currentShowId = null;
let lastPauseState = null;
let forcingPosition = false;


/*
 * ==========================================
 * COUNTDOWN / PLAYER UI
 * ==========================================
 */

function showCountdown() {
    if (countdown) {
        countdown.classList.remove("hidden");
    }

    if (player) {
        player.classList.add("hidden");
    }
}


function showPlayer() {
    if (countdown) {
        countdown.classList.add("hidden");
    }

    if (player) {
        player.classList.remove("hidden");
    }
}


function formatCountdown(seconds) {
    const total =
        Math.max(0, Math.ceil(seconds));

    const hours =
        Math.floor(total / 3600);

    const minutes =
        Math.floor((total % 3600) / 60);

    const secs =
        total % 60;

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}


function updateCountdown() {
    if (!show || !countdown) {
        return false;
    }

    const startUnix =
        getStartUnix();

    if (!Number.isFinite(startUnix)) {
        return false;
    }

    const remaining =
        startUnix - Date.now() / 1000;

    if (remaining > 0) {
        countdown.textContent =
            formatCountdown(remaining);

        showCountdown();

        if (!player.paused) {
            player.pause();
        }

        return true;
    }

    return false;
}


function showFinished() {
    resetPlaybackRate();

    player.pause();
    player.classList.add("hidden");

    if (countdown) {
        countdown.textContent = "Показ завершен";
        countdown.classList.remove("hidden");
    }
}

/*
 * ==========================================
 * SHOW.JSON
 * ==========================================
 */

async function fetchShow() {
    /*
     * Уникальный query-параметр дополнительно
     * ломает обычный browser/proxy cache.
     */
    const url =
        `${SHOW_URL}?_=${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`;

    const response =
        await fetch(url, {
            method: "GET",
            mode: "cors",
            cache: "no-store",
            credentials: "omit"
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
        return Number(show.startUnix);
    }

    if (
        show &&
        show.start
    ) {
        const time =
            new Date(show.start).getTime();

        if (Number.isFinite(time)) {
            return time / 1000;
        }
    }

    return null;
}


function getPausedDuration() {
    if (
        !show ||
        !Array.isArray(show.pauseIntervals)
    ) {
        return 0;
    }

    let total = 0;

    for (const interval of show.pauseIntervals) {
        if (!interval) {
            continue;
        }

        const start =
            Number(interval.startUnix);

        const end =
            Number(interval.endUnix);

        if (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            end >= start
        ) {
            total += end - start;
        }
    }

    return total;
}


function getShowPosition() {
    if (!show) {
        return 0;
    }

    if (show.pause === true) {
        const position =
            Number(show.pausePosition);

        return Number.isFinite(position)
            ? Math.max(0, position)
            : 0;
    }

    const startUnix =
        getStartUnix();

    if (!Number.isFinite(startUnix)) {
        return 0;
    }

    const now =
        Date.now() / 1000;

    if (now < startUnix) {
        return 0;
    }

    return Math.max(
        0,
        now -
        startUnix -
        getPausedDuration()
    );
}


/*
 * ==========================================
 * VIDEO POSITION
 * ==========================================
 */

function setVideoPosition(position) {
    if (
        !player ||
        !Number.isFinite(player.duration)
    ) {
        return false;
    }

    let target =
        Math.max(
            0,
            Number(position) || 0
        );

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
            player.currentTime - target
        );

    /*
     * Если мы уже рядом —
     * НЕ делаем seek.
     */
    if (difference < 0.25) {
        return false;
    }

    if (forcingPosition) {
        return false;
    }

    forcingPosition = true;

    try {
        player.currentTime = target;
        return true;
    } catch (error) {
        console.warn(
            "Не удалось установить позицию:",
            error
        );
        return false;
    } finally {
        setTimeout(() => {
            forcingPosition = false;
        }, 150);
    }
}


/*
 * ==========================================
 * PLAYBACK RATE SYNC
 * ==========================================
 *
 * Вместо постоянного seek:
 *
 * 0.25-2 сек расхождения ->
 * слегка ускоряем/замедляем видео.
 *
 * > 2 сек ->
 * делаем один настоящий seek.
 */

function resetPlaybackRate() {
    if (player.playbackRate !== 1) {
        player.playbackRate = 1;
    }
}


function synchronizePlaybackRate(target) {
    if (
        !Number.isFinite(player.duration) ||
        player.paused
    ) {
        resetPlaybackRate();
        return;
    }

    const difference =
        target - player.currentTime;

    const absolute =
        Math.abs(difference);

    if (absolute < 0.25) {
        resetPlaybackRate();
        return;
    }

    /*
     * Сильный рассинхрон.
     * Здесь нужен настоящий seek.
     */
    if (absolute > 2) {
        resetPlaybackRate();
        setVideoPosition(target);
        return;
    }

    /*
     * Небольшой рассинхрон.
     *
     * Видео немного ускоряется,
     * если отстаёт, и немного замедляется,
     * если опережает.
     *
     * Это значительно мягче,
     * чем постоянный currentTime=...
     */
    let rate = 1;

    if (difference > 1) {
        rate = 1.025;
    } else if (difference > 0.5) {
        rate = 1.015;
    } else if (difference > 0.25) {
        rate = 1.008;
    } else if (difference < -1) {
        rate = 0.975;
    } else if (difference < -0.5) {
        rate = 0.985;
    } else if (difference < -0.25) {
        rate = 0.992;
    }

    if (player.playbackRate !== rate) {
        player.playbackRate = rate;
    }
}


/*
 * ==========================================
 * PAUSE
 * ==========================================
 */

function applyPauseState(forcePosition = false) {
    if (!show || !player) {
        return;
    }

    if (show.pause === true) {
        resetPlaybackRate();

        const position =
            Number(show.pausePosition);

        if (Number.isFinite(position)) {
            if (
                forcePosition ||
                Math.abs(
                    player.currentTime - position
                ) > 0.25
            ) {
                setVideoPosition(position);
            }
        }

        if (!player.paused) {
            player.pause();
        }

        return;
    }

    /*
     * Пауза закончилась.
     * Только здесь возвращаемся
     * к серверной позиции.
     */
    resetPlaybackRate();

    const position =
        getShowPosition();

    if (
        forcePosition ||
        Math.abs(
            player.currentTime - position
        ) > 2
    ) {
        setVideoPosition(position);
    }
}


/*
 * ==========================================
 * MANUAL SEEK PROTECTION
 * ==========================================
 */

player.addEventListener(
    "seeked",
    () => {
        if (forcingPosition) {
            return;
        }

        if (!show) {
            return;
        }

        /*
         * Не перехватываем каждый seek пользователя
         * немедленно. synchronizeVideo вернёт
         * плеер на серверную позицию только если
         * расхождение действительно большое.
         */
    }
);


/*
 * ==========================================
 * VIDEO EVENTS
 * ==========================================
 */

player.addEventListener(
    "loadedmetadata",
    () => {
        if (!show) {
            return;
        }

        /*
         * Только первоначальная установка.
         */
        applyPauseState(true);
    }
);


player.addEventListener(
    "canplay",
    () => {
        if (!show) {
            return;
        }

        if (updateCountdown()) {
            return;
        }

        showPlayer();

        if (show.pause === true) {
            applyPauseState(true);
            return;
        }

        const target =
            getShowPosition();

        if (
            Number.isFinite(player.duration) &&
            target < player.duration
        ) {
            /*
             * Первоначальная синхронизация.
             */
            if (
                Math.abs(
                    player.currentTime - target
                ) > 0.5
            ) {
                setVideoPosition(target);
            }

            tryPlay();
        }
    }
);


player.addEventListener(
    "pause",
    () => {
        /*
         * Ничего не делаем.
         *
         * synchronizeVideo сам решит,
         * нужно ли продолжить воспроизведение.
         */
    }
);


player.addEventListener(
    "ended",
    () => {
        showFinished();
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
        Number.isFinite(player.duration) &&
        target >= player.duration
    ) {
        return;
    }

    /*
     * Не делаем seek каждый раз перед play.
     * Корректируем только если действительно
     * сильно разошлись.
     */
    if (
        Number.isFinite(player.duration) &&
        Math.abs(
            player.currentTime - target
        ) > 2
    ) {
        setVideoPosition(target);
    }

    try {
        await player.play();
    } catch (error) {
        /*
         * Автоплей со звуком запрещён —
         * пробуем muted.
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

async function applyShow(newShow) {
    const newShowId =
        newShow.showId || null;

    const showChanged =
        currentShowId !== newShowId;

    const pauseChanged =
        lastPauseState !== newShow.pause;

    /*
     * Запоминаем старое состояние до замены.
     */
    const previousShow =
        show;

    show =
        newShow;

    currentShowId =
        newShowId;

    lastPauseState =
        newShow.pause;

    /*
     * До начала показа показываем только таймер.
     * Видео при этом не загружаем.
     */
    if (updateCountdown()) {
        if (showChanged) {
            player.pause();
            player.removeAttribute("src");
            player.load();
        }

        return;
    }

    /*
     * ======================================
     * НОВЫЙ ПОКАЗ
     * ======================================
     */

    if (showChanged) {
        console.log(
            "Новый показ:",
            newShowId
        );

        player.pause();
        resetPlaybackRate();

        player.removeAttribute("src");
        player.load();

        /*
         * Новый показ обязательно
         * начинается с серверной позиции.
         */
        if (
            Number.isFinite(
                getStartUnix()
            ) &&
            Date.now() / 1000 <
                getStartUnix()
        ) {
            return;
        }

        player.src =
            MOVIE_URL;

        player.preload =
            "auto";

        player.load();

        return;
    }


    /*
     * ======================================
     * ПОКАЗ ТОТ ЖЕ САМЫЙ
     * ======================================
     *
     * Вот здесь была главная проблема.
     *
     * Раньше каждые 5 секунд:
     *
     * show.json -> applyShow()
     * -> applyPauseState()
     * -> currentTime =
     * -> tryPlay()
     * -> currentTime =
     *
     * То есть видео постоянно seek'алось.
     *
     * Теперь обычное обновление show.json
     * НЕ трогает currentTime.
     */

    if (!previousShow) {
        return;
    }

    /*
     * Если таймер закончился между обновлениями show.json,
     * загружаем видео только сейчас.
     */
    if (!player.getAttribute("src")) {
        player.src =
            MOVIE_URL;

        player.preload =
            "auto";

        player.load();

        return;
    }

    showPlayer();

    /*
     * Проверяем только изменение паузы.
     */
    if (pauseChanged) {
        console.log(
            "Изменилось состояние паузы:",
            newShow.pause
        );

        applyPauseState(true);

        if (!newShow.pause) {
            tryPlay();
        }

        return;
    }

    /*
     * В обычном состоянии вообще
     * не трогаем video.
     */
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

        await applyShow(newShow);
    } catch (error) {
        console.error(
            "show.json:",
            error
        );
    }
}


function startRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }

    /*
     * 5 секунд можно оставить.
     *
     * Теперь обновление show.json
     * не вызывает seek видео.
     */
    refreshTimer =
        setInterval(
            loadShow,
            4000
        );
}


/*
 * ==========================================
 * SYNCHRONIZATION
 * ==========================================
 */

function synchronizeVideo() {
    if (!show || !player) {
        return;
    }

    if (updateCountdown()) {
        return;
    }

    if (!player.getAttribute("src")) {
        player.src =
            MOVIE_URL;

        player.preload =
            "auto";

        player.load();

        return;
    }

    if (!Number.isFinite(player.duration)) {
        return;
    }

    showPlayer();

    const startUnix =
        getStartUnix();

    if (!Number.isFinite(startUnix)) {
        return;
    }

    const now =
        Date.now() / 1000;

    /*
     * До начала показа.
     */
    if (now < startUnix) {
        resetPlaybackRate();

        if (!player.paused) {
            player.pause();
        }

        return;
    }

    /*
     * Активная серверная пауза.
     */
    if (show.pause === true) {
        resetPlaybackRate();

        const target =
            Number(show.pausePosition);

        if (Number.isFinite(target)) {
            if (
                Math.abs(
                    player.currentTime - target
                ) > 0.25
            ) {
                setVideoPosition(target);
            }
        }

        if (!player.paused) {
            player.pause();
        }

        return;
    }

    /*
     * Фильм должен идти.
     */
    const target =
        getShowPosition();

    if (
        target >= player.duration
    ) {
        resetPlaybackRate();
        player.pause();
        showFinished();
        return;
    }

    /*
     * Мягкая синхронизация.
     */
    synchronizePlaybackRate(target);

    /*
     * Если браузер почему-то остановил видео,
     * пытаемся продолжить.
     */
    if (player.paused) {
        tryPlay();
    }
}


/*
 * ==========================================
 * START
 * ==========================================
 */

showCountdown();

loadShow();

startRefresh();

positionTimer =
    setInterval(
        synchronizeVideo,
        1000
    );