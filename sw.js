"use strict";

const CACHE_NAME = "movie-show-v4";

const STATIC_FILES = [
    "./",
    "./index.html",
    "./app.js"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_FILES))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys =>
                Promise.all(
                    keys
                        .filter(key => key !== CACHE_NAME)
                        .map(key => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    const request = event.request;
    const url = new URL(request.url);

    /*
     * show.json всегда идёт в сеть.
     * Service Worker не отдаёт его из кэша.
     */
    if (url.pathname.endsWith("/show.json")) {
        event.respondWith(
            fetch(request, {
                cache: "no-store"
            })
        );
        return;
    }

    /*
     * MP4 вообще не кэшируем.
     * Range-запросы обрабатывает браузер/Worker.
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
     * Остальные файлы:
     * сеть → при ошибке кэш.
     */
    event.respondWith(
        fetch(request)
            .then(response => {
                if (
                    response
                    && response.ok
                    && request.method === "GET"
                ) {
                    const copy =
                        response.clone();

                    caches.open(CACHE_NAME)
                        .then(cache => {
                            cache.put(
                                request,
                                copy
                            );
                        })
                        .catch(() => {});
                }

                return response;
            })
            .catch(() =>
                caches.match(request)
            )
    );
});