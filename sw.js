"use strict";


const CACHE_NAME =
    "movie-show-v6";


const STATIC_FILES = [
    "./",
    "./index.html",
    "./app.js"
];


self.addEventListener(
    "install",
    event => {

        event.waitUntil(

            caches
                .open(
                    CACHE_NAME
                )
                .then(
                    cache =>
                        cache.addAll(
                            STATIC_FILES
                        )
                )
                .then(
                    () =>
                        self.skipWaiting()
                )
        );
    }
);


self.addEventListener(
    "activate",
    event => {

        event.waitUntil(

            caches
                .keys()
                .then(
                    keys =>
                        Promise.all(
                            keys
                                .filter(
                                    key =>
                                        key !==
                                        CACHE_NAME
                                )
                                .map(
                                    key =>
                                        caches.delete(
                                            key
                                        )
                                )
                        )
                )
                .then(
                    () =>
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
            new URL(
                request.url
            );


        /*
         * show.json теперь находится
         * в Cloudflare Worker.
         *
         * Не кешируем его.
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
                        cache:
                            "no-store"
                    }
                )
            );

            return;
        }


        /*
         * Видео также не кладём
         * в Cache Storage.
         */

        if (
            url.pathname
                .toLowerCase()
                .endsWith(
                    ".mp4"
                )
        ) {

            event.respondWith(
                fetch(request)
            );

            return;
        }


        /*
         * Статические файлы.
         */

        event.respondWith(

            fetch(request)
                .then(
                    response => {

                        if (
                            response.ok
                            &&
                            request.method ===
                                "GET"
                        ) {

                            const copy =
                                response.clone();

                            caches
                                .open(
                                    CACHE_NAME
                                )
                                .then(
                                    cache =>
                                        cache.put(
                                            request,
                                            copy
                                        )
                                )
                                .catch(
                                    () => {}
                                );
                        }

                        return response;
                    }
                )
                .catch(
                    () =>
                        caches.match(
                            request
                        )
                )
        );
    }
);