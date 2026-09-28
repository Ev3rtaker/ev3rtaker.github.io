"use strict";

const CACHE_NAME = "movie-show-v5";

const STATIC_FILES = [
    "./",
    "./index.html",
    "./app.js"
];


/*
 * ============================================================
 * Install
 * ============================================================
 */

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


/*
 * ============================================================
 * Activate
 * ============================================================
 */

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
                            .map(
                                key =>
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


/*
 * ============================================================
 * Fetch
 * ============================================================
 */

self.addEventListener(
    "fetch",
    event => {
        const request =
            event.request;

        const url =
            new URL(request.url);


        /*
         * ====================================================
         * show.json
         * ====================================================
         *
         * Никогда не берём из Cache Storage.
         */

        if (
            url.pathname.endsWith(
                "/show.json"
            )
        ) {
            event.respondWith(
                fetch(
                    request,
                    {
                        cache: "no-store"
                    }
                )
            );

            return;
        }


        /*
         * ====================================================
         * MP4
         * ====================================================
         *
         * Не кэшируем.
         * Важно для Range-запросов Safari.
         */

        if (
            url.pathname
                .toLowerCase()
                .endsWith(".mp4")
        ) {
            event.respondWith(
                fetch(request)
            );

            return;
        }


        /*
         * ====================================================
         * Остальные файлы
         * ====================================================
         */

        event.respondWith(
            fetch(request)
                .then(response => {
                    if (
                        response &&
                        response.ok &&
                        request.method === "GET"
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
                    caches.match(request)
                )
        );
    }
);