"use strict";

const CACHE_NAME =
    "movie-show-v7";

const WORKER_HOST =
    "raspy-cake-1c1a.qwgvpgy.workers.dev";

const STATIC_FILES = [
    "./",
    "./index.html",
    "./app.js"
];

self.addEventListener(
    "install",
    event => {
        event.waitUntil(
            caches.open(CACHE_NAME)
                .then(cache =>
                    cache.addAll(
                        STATIC_FILES
                    )
                )
                .then(() =>
                    self.skipWaiting()
                )
        );
    }
);

self.addEventListener(
    "activate",
    event => {
        event.waitUntil(
            caches.keys()
                .then(keys =>
                    Promise.all(
                        keys
                            .filter(
                                key =>
                                    key !==
                                    CACHE_NAME
                            )
                            .map(key =>
                                caches.delete(
                                    key
                                )
                            )
                    )
                )
                .then(() =>
                    self.clients.claim()
                )
        );
    }
);

self.addEventListener(
    "fetch",
    event => {
        const request =
            event.request;

        const url =
            new URL(request.url);

        /*
         * Cloudflare Worker полностью
         * исключён из Service Worker.
         *
         * Браузер сам выполняет GET/OPTIONS/CORS.
         */
        if (
            url.hostname ===
            WORKER_HOST
        ) {
            return;
        }

        /*
         * Видео тоже не перехватываем.
         * Это важно для HTTP Range.
         */
        if (
            url.pathname
                .toLowerCase()
                .endsWith(".mp4")
        ) {
            return;
        }

        /*
         * Кэшируем только GET-запросы
         * самого сайта.
         */
        if (
            request.method !== "GET"
        ) {
            return;
        }

        event.respondWith(
            fetch(request)
                .then(response => {
                    if (
                        response &&
                        response.ok
                    ) {
                        const copy =
                            response.clone();

                        caches.open(
                            CACHE_NAME
                        )
                            .then(cache =>
                                cache.put(
                                    request,
                                    copy
                                )
                            )
                            .catch(() => {});
                    }

                    return response;
                })
                .catch(() =>
                    caches.match(
                        request
                    ).then(cached =>
                        cached ||
                        new Response(
                            "Offline",
                            {
                                status: 503,
                                headers: {
                                    "Content-Type":
                                        "text/plain; charset=utf-8"
                                }
                            }
                        )
                    )
                )
        );
    }
);