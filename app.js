const MOVIE_PROXY_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

const SHOW_URL =
    `${MOVIE_PROXY_URL}/show.json`;

const waiting = document.getElementById("waiting");
const playerBox = document.getElementById("playerBox");
const player = document.getElementById("player");
const finished = document.getElementById("finished");

const titleEl = document.getElementById("title");
const countdownEl = document.getElementById("countdown");
const startEl = document.getElementById("start");
const statusEl = document.getElementById("status");

let show = null;
let startTime = null;
let endTime = null;
let timer = null;
let refreshTimer = null;

let seekTarget = null;
let seekDone = false;
let autoplayAttempted = false;
let currentShowId = null;

function formatDate(date) {
    return new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/Moscow"
    }).format(date);
}

function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(seconds));

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    return [
        hours,
        String(minutes).padStart(2, "0"),
        String(secs).padStart(2, "0")
    ].join(":");
}

function setStatus(text) {
    if (statusEl) {
        statusEl.textContent = text;
    }
}

function getMovieUrl() {
    return MOVIE_PROXY_URL;
}

/*
 * Получаем позицию фильма по show.json.
 *
 * Важно:
 * pauseIntervals учитываются здесь так же,
 * как в Python scheduler.
 */
function calculateSeekTarget() {
    if (!show || !startTime) {
        return 0;
    }

    const now =
        Date.now() / 1000;

    const start =
        Number(show.startUnix);

    if (!Number.isFinite(start)) {
        return Math.max(
            0,
            (Date.now() -
                startTime.getTime()) / 1000
        );
    }

    if (now < start) {
        return 0;
    }

    /*
     * Если сейчас активная пауза,
     * её pausePosition является точной позицией.
     */
    if (show.pause === true) {
        const pausePosition =
            Number(show.pausePosition);

        if (Number.isFinite(pausePosition)) {
            return Math.max(
                0,
                pausePosition
            );
        }
    }

    /*
     * Суммируем завершённые паузы.
     */
    let paused = 0;

    if (Array.isArray(show.pauseIntervals)) {
        for (const interval of show.pauseIntervals) {
            if (!interval) {
                continue;
            }

            const pauseStart =
                Number(interval.startUnix);

            const pauseEnd =
                Number(interval.endUnix);

            if (
                Number.isFinite(pauseStart) &&
                Number.isFinite(pauseEnd) &&
                pauseEnd >= pauseStart
            ) {
                paused +=
                    pauseEnd - pauseStart;
            }
        }
    }

    return Math.max(
        0,
        now - start - paused
    );
}

function seekToShowPosition() {
    if (!startTime) {
        return;
    }

    if (!Number.isFinite(player.duration)) {
        return;
    }

    const target =
        calculateSeekTarget();

    seekTarget = Math.min(
        target,
        Math.max(
            0,
            player.duration - 0.1
        )
    );

    seekDone = false;

    try {
        player.currentTime =
            seekTarget;
    } catch (error) {
        console.error(
            "SEEK error:",
            error
        );
        return;
    }

    setTimeout(
        verifySeek,
        100
    );

    setTimeout(
        verifySeek,
        500
    );

    setTimeout(
        verifySeek,
        1500
    );
}

function verifySeek() {
    if (
        seekTarget === null ||
        !Number.isFinite(player.currentTime)
    ) {
        return;
    }

    const difference =
        Math.abs(
            player.currentTime -
            seekTarget
        );

    if (difference <= 2) {
        seekDone = true;

        setStatus(
            `Фильм: ${formatDuration(
                player.currentTime
            )}`
        );

        return;
    }

    /*
     * Если пользователь вручную перемотал фильм,
     * возвращаем его на расчётную позицию.
     */
    if (!player.seeking) {
        try {
            player.currentTime =
                seekTarget;
        } catch (_) {}
    }
}

async function tryAutoplay() {
    if (autoplayAttempted) {
        return;
    }

    autoplayAttempted = true;

    try {
        await player.play();

        setStatus(
            "Фильм воспроизводится автоматически."
        );

        return;
    } catch (error) {
        console.warn(
            "Обычный autoplay заблокирован:",
            error
        );
    }

    try {
        player.muted = true;

        await player.play();

        setStatus(
            "Фильм запущен без звука. " +
            "Включите звук кнопкой видео."
        );
    } catch (error) {
        console.warn(
            "Muted autoplay заблокирован:",
            error
        );

        setStatus(
            "Нажмите Play для начала просмотра."
        );
    }
}

function updateCountdown() {
    if (!startTime) {
        return;
    }

    const now =
        new Date();

    if (now < startTime) {
        const diff =
            Math.floor(
                (
                    startTime.getTime() -
                    now.getTime()
                ) / 1000
            );

        countdownEl.textContent =
            formatDuration(diff);

        waiting.hidden = false;
        playerBox.hidden = true;
        finished.hidden = true;

        return;
    }

    /*
     * Если duration уже известна,
     * вычисляем окончание по фактической
     * длительности фильма.
     */
    if (
        Number.isFinite(player.duration) &&
        player.duration > 0
    ) {
        const target =
            calculateSeekTarget();

        /*
         * При активной паузе фильм не заканчивается.
         */
        if (
            show &&
            show.pause === true
        ) {
            waiting.hidden = true;
            playerBox.hidden = false;
            finished.hidden = true;
            countdownEl.textContent =
                "ПАУЗА";
            return;
        }

        /*
         * Если текущая позиция достигла duration,
         * показ закончен.
         */
        if (target >= player.duration) {
            finishShow();
            return;
        }
    }

    waiting.hidden = true;
    finished.hidden = true;
    playerBox.hidden = false;

    countdownEl.textContent =
        "00:00:00";
}

function finishShow() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }

    waiting.hidden = true;
    playerBox.hidden = true;
    finished.hidden = false;

    countdownEl.textContent =
        "00:00:00";

    try {
        player.pause();
    } catch (_) {}
}

/*
 * Единственный GET для расписания.
 *
 * Здесь НЕТ headers.
 *
 * Поэтому браузеру не требуется CORS
 * preflight из-за Cache-Control.
 *
 * ?t= нужен только для уникального URL.
 */
async function fetchShow() {
    const url =
        `${SHOW_URL}?t=${Date.now()}`;

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
            "Worker вернул некорректный show.json."
        );
    }

    if (!data.start) {
        throw new Error(
            "В show.json отсутствует start."
        );
    }

    return data;
}

function applyShow(data) {
    const oldShowId =
        currentShowId;

    show = data;
    currentShowId =
        data.showId || null;

    startTime =
        new Date(data.start);

    if (
        !Number.isFinite(
            startTime.getTime()
        )
    ) {
        throw new Error(
            "Некорректное время start."
        );
    }

    titleEl.textContent =
        data.title || "Кинопоказ";

    startEl.textContent =
        `Начало: ${formatDate(
            startTime
        )}`;

    /*
     * duration из show.json больше не обязателен.
     * Фактическую длительность определяет
     * HTMLVideoElement через player.duration.
     */
    endTime = null;

    /*
     * Новый showId означает новый показ.
     */
    if (
        oldShowId &&
        currentShowId &&
        oldShowId !== currentShowId
    ) {
        seekDone = false;
        seekTarget = null;
        autoplayAttempted = false;

        player.pause();
        player.removeAttribute("src");
        player.load();

        player.src =
            getMovieUrl();

        player.preload = "auto";
        player.load();

        return;
    }

    /*
     * Если видео уже загружено,
     * пересчитываем позицию.
     */
    if (
        Number.isFinite(player.duration)
    ) {
        seekToShowPosition();
    }

    updateCountdown();
}

async function loadShow() {
    try {
        const data =
            await fetchShow();

        applyShow(data);

        setStatus(
            "Расписание обновлено."
        );

    } catch (error) {
        console.error(
            "show.json:",
            error
        );

        setStatus(
            `Ошибка расписания: ${error.message}`
        );
    }
}

function startShowRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }

    /*
     * Периодически получаем актуальное
     * состояние из Cloudflare KV.
     *
     * Сам фильм при этом НЕ перезагружается.
     */
    refreshTimer =
        setInterval(
            loadShow,
            5000
        );
}

player.addEventListener(
    "loadedmetadata",
    () => {
        seekToShowPosition();
    }
);

player.addEventListener(
    "canplay",
    () => {
        if (!seekDone) {
            seekToShowPosition();
        }
    }
);

player.addEventListener(
    "loadeddata",
    () => {
        if (!seekDone) {
            seekToShowPosition();
        }
    }
);

player.addEventListener(
    "seeking",
    () => {
        /*
         * Пользователь пытается перемотать.
         * Ничего не делаем здесь.
         * Проверка будет выполнена после seeked.
         */
    }
);

player.addEventListener(
    "seeked",
    () => {
        /*
         * Всегда возвращаемся к точной
         * позиции расписания.
         */
        seekToShowPosition();

        if (
            seekDone &&
            show &&
            show.pause !== true
        ) {
            tryAutoplay();
        }
    }
);

player.addEventListener(
    "play",
    () => {
        if (
            !seekDone &&
            seekTarget !== null
        ) {
            seekToShowPosition();
        }
    }
);

player.addEventListener(
    "playing",
    () => {
        setStatus(
            `Фильм: ${formatDuration(
                player.currentTime
            )}`
        );
    }
);

player.addEventListener(
    "timeupdate",
    () => {
        /*
         * Во время паузы браузер не должен
         * продолжать воспроизведение.
         */
        if (
            show &&
            show.pause === true
        ) {
            if (!player.paused) {
                player.pause();
            }

            const pausePosition =
                Number(
                    show.pausePosition
                );

            if (
                Number.isFinite(
                    pausePosition
                ) &&
                Math.abs(
                    player.currentTime -
                    pausePosition
                ) > 0.5
            ) {
                try {
                    player.currentTime =
                        pausePosition;
                } catch (_) {}
            }

            return;
        }

        /*
         * Обычный режим:
         * не разрешаем пользователю уйти
         * от текущей позиции расписания.
         */
        if (
            seekDone &&
            Number.isFinite(
                player.currentTime
            )
        ) {
            const target =
                calculateSeekTarget();

            if (
                Math.abs(
                    player.currentTime -
                    target
                ) > 2
            ) {
                seekTarget =
                    target;

                try {
                    player.currentTime =
                        target;
                } catch (_) {}
            }
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

        setStatus(
            "Ошибка загрузки movie.mp4."
        );
    }
);

player.addEventListener(
    "ended",
    () => {
        finishShow();
    }
);

player.addEventListener(
    "click",
    () => {
        if (player.muted) {
            player.muted = false;
        }
    }
);

document.addEventListener(
    "click",
    () => {
        if (
            seekDone &&
            player.paused &&
            show &&
            show.pause !== true
        ) {
            player.play()
                .then(() => {
                    if (player.muted) {
                        player.muted = false;
                    }
                })
                .catch(error => {
                    console.warn(
                        "Manual play failed:",
                        error
                    );
                });
        }
    }
);

loadShow();
startShowRefresh();

if (timer) {
    clearInterval(timer);
}

timer =
    setInterval(
        updateCountdown,
        1000
    );