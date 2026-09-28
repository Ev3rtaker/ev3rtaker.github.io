"use strict";

const CACHE_NAME = "movie-show-v6";

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

    // Cloudflare Worker: никогда не перехватываем.
    if (url.hostname === "raspy-cake-1c1a.qwgvpgy.workers.dev") {
        return;
    }

    // Видео тоже не кэшируем.
    if (url.pathname.toLowerCase().endsWith(".mp4")) {
        return;
    }

    event.respondWith(
        fetch(request).catch(() => caches.match(request))
    );
});