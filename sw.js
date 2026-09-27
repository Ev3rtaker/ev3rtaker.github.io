let manifest = null;

self.addEventListener("install", event => {
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("message", event => {
    if (event.data?.type === "SET_MANIFEST") {
        manifest = event.data.manifest;
    }
});

self.addEventListener("fetch", event => {
    const url = new URL(event.request.url);

    if (!url.pathname.endsWith("/movie.mp4")) {
        return;
    }

    event.respondWith(
        handleVideoRequest(event.request)
    );
});

function parseRange(value, size) {
    if (!value) {
        return {
            start: 0,
            end: size - 1
        };
    }

    const match =
        value.match(/bytes=(\d+)-(\d*)/);

    if (!match) {
        return null;
    }

    const start = Number(match[1]);

    let end = match[2]
        ? Number(match[2])
        : size - 1;

    end = Math.min(end, size - 1);

    if (
        start > end ||
        start >= size
    ) {
        return null;
    }

    return {
        start,
        end
    };
}

function findChunk(offset) {
    let current = 0;

    for (
        let i = 0;
        i < manifest.chunks.length;
        i++
    ) {
        const size =
            manifest.chunks[i].size;

        if (offset < current + size) {
            return {
                index: i,
                offset: offset - current
            };
        }

        current += size;
    }

    return null;
}

async function getBytes(start, end) {
    const output = [];

    let position = start;

    while (position <= end) {
        const chunk = findChunk(position);

        if (!chunk) {
            throw new Error("Chunk not found.");
        }

        const info =
            manifest.chunks[chunk.index];

        const chunkStart = chunk.offset;

        const chunkEnd = Math.min(
            info.size - 1,
            chunk.offset + (end - position)
        );

        const response = await fetch(
            info.url,
            {
                headers: {
                    Range:
                        `bytes=${chunkStart}-${chunkEnd}`
                }
            }
        );

        if (
            !response.ok &&
            response.status !== 206
        ) {
            throw new Error(
                `Chunk HTTP ${response.status}`
            );
        }

        const data =
            new Uint8Array(
                await response.arrayBuffer()
            );

        if (!data.byteLength) {
            throw new Error(
                "Empty chunk response."
            );
        }

        output.push(data);

        position += data.byteLength;
    }

    const total =
        output.reduce(
            (sum, item) =>
                sum + item.byteLength,
            0
        );

    const result =
        new Uint8Array(total);

    let offset = 0;

    for (const item of output) {
        result.set(item, offset);
        offset += item.byteLength;
    }

    return result;
}

async function handleVideoRequest(request) {
    if (!manifest) {
        return new Response(
            "Manifest not ready",
            {
                status: 503
            }
        );
    }

    const range = parseRange(
        request.headers.get("Range"),
        manifest.size
    );

    if (!range) {
        return new Response(null, {
            status: 416,
            headers: {
                "Content-Range":
                    `bytes */${manifest.size}`
            }
        });
    }

    try {
        const data =
            await getBytes(
                range.start,
                range.end
            );

        return new Response(data, {
            status: 206,
            headers: {
                "Content-Type":
                    manifest.mime ||
                    "video/mp4",

                "Content-Length":
                    String(data.byteLength),

                "Content-Range":
                    `bytes ${range.start}-${range.end}/${manifest.size}`,

                "Accept-Ranges": "bytes",

                "Cache-Control":
                    "public, max-age=3600"
            }
        });

    } catch (error) {
        return new Response(
            error.message,
            {
                status: 502
            }
        );
    }
}