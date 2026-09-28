"use strict";

const CACHE_NAME =
    "movie-show-v8";

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
                    cache.addAll(STATIC_FILES)
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
                                    key !== CACHE_NAME
                            )
                            .map(key =>
                                caches.delete(key)
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
         * Worker API никогда не кэшируем.
         *
         * Это особенно важно для show.json.
         */
        if (
            url.hostname === WORKER_HOST
        ) {
            return;
        }


        /*
         * Видео никогда не кэшируем
         * через Cache API.
         *
         * Браузер сам управляет HTTP Range,
         * буферизацией и потоковой загрузкой.
         */
        if (
            url.pathname
                .toLowerCase()
                .endsWith(".mp4")
        ) {
            return;
        }


        if (
            request.method !== "GET"
        ) {
            return;
        }


        /*
         * Network-first.
         *
         * Сначала всегда пробуем получить
         * свежий app.js / index.html.
         *
         * Cache используется только если сеть
         * недоступна.
         */
        event.respondWith(
            fetch(request, {
                cache: "no-store"
            })
                .then(response => {
                    if (
                        response &&
                        response.ok
                    ) {
                        const copy =
                            response.clone();

                        caches.open(CACHE_NAME)
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
                    caches.match(request)
                        .then(cached =>
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