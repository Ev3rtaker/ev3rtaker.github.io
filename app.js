"use strict";

/*
 * ============================================================
 * Настройки
 * ============================================================
 */

const SHOW_URL =
    "https://raspy-cake-1c1a.qwgvpgy.workers.dev/show.json";

/*
 * Проверяем show.json раз в секунду.
 *
 * Поэтому изменение pause/resume будет замечено
 * максимум примерно через 1 секунду.
 */
const SHOW_REFRESH_MS = 1000;

/*
 * Частота локальной синхронизации видео.
 */
const SYNC_MS = 250;


/*
 * ============================================================
 * DOM
 * ============================================================
 */

const video =
    document.getElementById("player");


/*
 * ============================================================
 * Состояние
 * ============================================================
 */

let showData = null;

let currentShowId = null;
let currentMovieUrl = null;

let loadingMovie = false;

let lastSyncTime = 0;

let suppressSeeking = false;


/*
 * ============================================================
 * Утилиты
 * ============================================================
 */

function nowUnix() {
    return Date.now() / 1000;
}


function isNumber(value) {
    return (
        typeof value === "number" &&
        Number.isFinite(value)
    );
}


function clamp(value, min, max) {
    return Math.min(
        max,
        Math.max(min, value)
    );
}


/*
 * ============================================================
 * Расчёт общей длительности завершённых пауз
 * ============================================================
 */

function getPausedDuration(data) {
    const intervals =
        data?.pauseIntervals;

    if (!Array.isArray(intervals)) {
        return 0;
    }

    let total = 0;

    for (const item of intervals) {
        if (
            !item ||
            typeof item !== "object"
        ) {
            continue;
        }

        const begin =
            Number(item.startUnix);

        const end =
            Number(item.endUnix);

        if (
            Number.isFinite(begin) &&
            Number.isFinite(end) &&
            end >= begin
        ) {
            total +=
                end - begin;
        }
    }

    return Math.max(
        0,
        total
    );
}


/*
 * ============================================================
 * Точная позиция фильма по расписанию
 * ============================================================
 *
 * Логика полностью соответствует Python:
 *
 * normal:
 *
 *   now - startUnix - completed pauses
 *
 * pause:
 *
 *   pausePosition
 *
 * Это позволяет странице перезагружаться,
 * не теряя позицию.
 * ============================================================
 */

function getSchedulePosition(data) {
    if (!data) {
        return 0;
    }

    const startUnix =
        Number(data.startUnix);

    if (!Number.isFinite(startUnix)) {
        return 0;
    }

    const now =
        nowUnix();

    /*
     * Показ ещё не начался.
     */

    if (now < startUnix) {
        return 0;
    }

    /*
     * Во время паузы позиция фиксирована.
     */

    if (data.pause) {
        const pausePosition =
            Number(
                data.pausePosition
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

    /*
     * Обычное воспроизведение.
     *
     * Учитываем только завершённые
     * pauseIntervals.
     */

    const paused =
        getPausedDuration(data);

    const position =
        now -
        startUnix -
        paused;

    return Math.max(
        0,
        position
    );
}


/*
 * ============================================================
 * Спрятать/показать player
 * ============================================================
 */

function hidePlayer() {
    video.style.display = "none";

    /*
     * Останавливаем воспроизведение,
     * чтобы после окончания показа
     * браузер ничего не продолжал играть.
     */

    try {
        video.pause();
    } catch (_) {
        // ignore
    }
}


function showPlayer() {
    video.style.display =
        "block";
}


/*
 * ============================================================
 * Установка currentTime без зацикливания seeking
 * ============================================================
 */

function setVideoTime(position) {
    if (
        !Number.isFinite(position)
    ) {
        return;
    }

    if (
        !Number.isFinite(
            video.duration
        ) ||
        video.duration <= 0
    ) {
        return;
    }

    const target =
        clamp(
            position,
            0,
            Math.max(
                0,
                video.duration - 0.05
            )
        );

    /*
     * Если уже практически на нужной
     * позиции — ничего не делаем.
     */

    if (
        Math.abs(
            video.currentTime -
            target
        ) < 0.35
    ) {
        return;
    }

    suppressSeeking = true;

    try {
        video.currentTime =
            target;
    } catch (_) {
        // ignore
    }

    /*
     * seeking может прийти асинхронно.
     * Снимаем флаг чуть позже.
     */

    setTimeout(() => {
        suppressSeeking = false;
    }, 100);
}


/*
 * ============================================================
 * Загрузка фильма
 * ============================================================
 */

async function loadMovie(url) {
    if (!url) {
        return;
    }

    if (
        loadingMovie &&
        currentMovieUrl === url
    ) {
        return;
    }

    /*
     * Если это тот же фильм,
     * повторно src не устанавливаем.
     */

    if (
        currentMovieUrl === url &&
        video.src
    ) {
        return;
    }

    loadingMovie = true;

    currentMovieUrl =
        url;

    suppressSeeking = true;

    try {
        video.pause();

        video.src = url;

        video.load();

        /*
         * После загрузки metadata
         * синхронизируемся с расписанием.
         */

        await new Promise(
            resolve => {
                if (
                    video.readyState >= 1
                ) {
                    resolve();
                    return;
                }

                const handler = () => {
                    video.removeEventListener(
                        "loadedmetadata",
                        handler
                    );

                    resolve();
                };

                video.addEventListener(
                    "loadedmetadata",
                    handler
                );
            }
        );
    } catch (error) {
        console.error(
            "Ошибка загрузки фильма:",
            error
        );
    } finally {
        loadingMovie = false;

        setTimeout(() => {
            suppressSeeking = false;
        }, 100);
    }
}


/*
 * ============================================================
 * Синхронизация видео с show.json
 * ============================================================
 */

function syncVideo() {
    if (!showData) {
        return;
    }

    if (
        !Number.isFinite(
            video.duration
        ) ||
        video.duration <= 0
    ) {
        return;
    }

    const position =
        getSchedulePosition(
            showData
        );

    /*
     * Показ закончился.
     */

    if (
        position >=
        video.duration - 0.1
    ) {
        hidePlayer();
        return;
    }

    showPlayer();

    /*
     * Если стоит пауза —
     * видео должно быть остановлено
     * на точной позиции.
     */

    if (showData.pause) {
        if (!video.paused) {
            video.pause();
        }

        setVideoTime(
            position
        );

        return;
    }

    /*
     * Обычное воспроизведение.
     */

    const difference =
        Math.abs(
            video.currentTime -
            position
        );

    /*
     * Исправляем положение,
     * если пользователь перемотал фильм
     * или браузер заметно ушёл от расписания.
     */

    if (difference > 0.35) {
        setVideoTime(
            position
        );
    }

    /*
     * Видео должно играть.
     */

    if (
        video.paused &&
        !video.ended
    ) {
        video.play()
            .catch(() => {
                /*
                 * Браузер может запретить
                 * autoplay до взаимодействия
                 * пользователя.
                 *
                 * В этом случае следующая
                 * синхронизация снова попробует
                 * запустить видео.
                 */
            });
    }
}


/*
 * ============================================================
 * Загрузка show.json
 * ============================================================
 */

async function loadShow() {
    try {
        /*
         * Cache-busting в браузере.
         *
         * Каждый запрос получает новый URL.
         */

        const url =
            SHOW_URL +
            "?t=" +
            Date.now();

        const response =
            await fetch(
                url,
                {
                    method: "GET",

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

        /*
         * Запоминаем showId.
         */

        const newShowId =
            data.showId || null;

        /*
         * Если появился совершенно новый показ,
         * сбрасываем старый URL.
         */

        if (
            currentShowId !== null &&
            newShowId !== currentShowId
        ) {
            currentMovieUrl = null;

            try {
                video.pause();
            } catch (_) {
                // ignore
            }
        }

        currentShowId =
            newShowId;

        showData = data;

        /*
         * Python сохраняет Worker URL
         * в поле url.
         */

        const movieUrl =
            data.url ||
            "https://raspy-cake-1c1a.qwgvpgy.workers.dev";

        /*
         * Загружаем фильм только если
         * URL действительно изменился.
         */

        if (
            currentMovieUrl !== movieUrl
        ) {
            await loadMovie(
                movieUrl
            );
        }

        /*
         * Если show.json пришёл во время
         * активной паузы, сразу фиксируем
         * видео на pausePosition.
         */

        syncVideo();

    } catch (error) {
        console.error(
            "show.json:",
            error
        );
    }
}


/*
 * ============================================================
 * Автоматическая синхронизация
 * ============================================================
 */

setInterval(
    syncVideo,
    SYNC_MS
);


/*
 * ============================================================
 * Обновление show.json
 * ============================================================
 */

setInterval(
    loadShow,
    SHOW_REFRESH_MS
);


/*
 * ============================================================
 * Возвращение на вкладку
 * ============================================================
 */

document.addEventListener(
    "visibilitychange",
    () => {
        if (
            document.visibilityState ===
            "visible"
        ) {
            /*
             * Не ждём следующей секунды,
             * а сразу забираем актуальный JSON.
             */

            loadShow();
        }
    }
);


/*
 * ============================================================
 * Пользовательская перемотка
 * ============================================================
 *
 * Если пользователь вручную двигает ползунок,
 * сразу возвращаем его на позицию расписания.
 * ============================================================
 */

video.addEventListener(
    "seeking",
    () => {
        if (suppressSeeking) {
            return;
        }

        if (!showData) {
            return;
        }

        /*
         * Всегда возвращаемся на точную
         * позицию расписания.
         */

        const position =
            getSchedulePosition(
                showData
            );

        setVideoTime(
            position
        );
    }
);


/*
 * ============================================================
 * Защита от ручного seek после seeked
 * ============================================================
 */

video.addEventListener(
    "seeked",
    () => {
        if (suppressSeeking) {
            return;
        }

        if (!showData) {
            return;
        }

        const position =
            getSchedulePosition(
                showData
            );

        if (
            Math.abs(
                video.currentTime -
                position
            ) > 0.35
        ) {
            setVideoTime(
                position
            );
        }
    }
);


/*
 * ============================================================
 * Если пользователь нажал Pause
 * ============================================================
 *
 * Кнопки управления самого video не должны
 * изменять расписание.
 *
 * Следующая синхронизация вернёт состояние,
 * которое хранится в show.json.
 * ============================================================
 */

video.addEventListener(
    "pause",
    () => {
        if (
            suppressSeeking ||
            !showData
        ) {
            return;
        }

        /*
         * Если pause=false в show.json,
         * снова запускаем видео.
         *
         * Это предотвращает ручную остановку.
         */

        if (
            !showData.pause &&
            !video.ended
        ) {
            setTimeout(
                syncVideo,
                50
            );
        }
    }
);


/*
 * ============================================================
 * Если пользователь нажал Play
 * ============================================================
 */

video.addEventListener(
    "play",
    () => {
        if (!showData) {
            return;
        }

        /*
         * При активной серверной паузе
         * запрещаем воспроизведение.
         */

        if (showData.pause) {
            video.pause();

            setVideoTime(
                getSchedulePosition(
                    showData
                )
            );
        }
    }
);


/*
 * ============================================================
 * Конец фильма
 * ============================================================
 */

video.addEventListener(
    "ended",
    () => {
        hidePlayer();
    }
);


/*
 * ============================================================
 * Первый запуск
 * ============================================================
 */

video.style.display =
    "none";

loadShow();