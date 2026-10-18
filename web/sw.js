/* Solis Monitor service worker — installable app + offline last-known data.
   Keep VERSION in lockstep with the ?v= query string in the HTML pages so a
   deploy that changes JS/CSS without touching sw.js still refreshes. */
const VERSION = "20261015b";
const CACHE = "solis-" + VERSION;
const SHELL = [
    "./", "./index.html", "./history", "./history.html",
    "./system", "./system.html",
    "./css/style.css?v=" + VERSION,
    "./config.js?v=" + VERSION,
    "./js/common.js?v=" + VERSION,
    "./js/dashboard.js?v=" + VERSION,
    "./js/history.js?v=" + VERSION,
    "./js/system.js?v=" + VERSION,
    "./js/chart.umd.min.js?v=" + VERSION,
    "./fonts/inter.woff2",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/icon-512-maskable.png",
    "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches.open(CACHE)
            .then((c) => Promise.all(SHELL.map((u) =>
                c.add(u).catch(() => {}))))
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

function putIfOk(req, res) {
    if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
}

self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);

    if (url.origin === location.origin) {
        // App shell: network-first, fall back to the cached copy offline.
        e.respondWith(
            fetch(req).then((res) => putIfOk(req, res))
                .catch(() => caches.match(req, { ignoreSearch: true }))
        );
    } else if (url.hostname.endsWith(".supabase.co")) {
        // Data: network-first, fall back to the last cached response offline.
        e.respondWith(
            fetch(req).then((res) => putIfOk(req, res))
                .catch(() => caches.match(req))
        );
    }
});
