/* Solis Monitor service worker — installable app + offline last-known data. */
const CACHE = "solis-v1";
const SHELL = [
    "./", "./index.html", "./history.html", "./system.html",
    "./css/style.css", "./config.js",
    "./js/common.js", "./js/dashboard.js", "./js/history.js", "./js/system.js",
    "./js/chart.umd.min.js", "./fonts/inter.woff2",
    "./icons/icon-192.png", "./icons/icon-512.png",
    "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches.open(CACHE)
            .then((c) => c.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);

    if (url.origin === location.origin) {
        // App shell: network-first, fall back to the cached copy offline.
        e.respondWith(
            fetch(req).then((res) => {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
                return res;
            }).catch(() => caches.match(req, { ignoreSearch: true }))
        );
    } else if (url.hostname.endsWith("supabase.co")) {
        // Data: network-first, fall back to the last cached response offline.
        e.respondWith(
            fetch(req).then((res) => {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
                return res;
            }).catch(() => caches.match(req))
        );
    }
});
