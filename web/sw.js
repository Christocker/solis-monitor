/* Solis Monitor service worker — installable app + offline shell.
   Keep VERSION in lockstep with the ?v= query string in the HTML pages so a
   deploy that changes JS/CSS without touching sw.js still refreshes.
   Supabase data is deliberately NOT cached: it is private to the signed-in
   user and must disappear when the device is locked. */
const VERSION = "20261115e";
const CACHE = "solis-" + VERSION;
const SHELL = [
    "./", "./index.html", "./history", "./history.html",
    "./system", "./system.html",
    "./login", "./login.html",
    "./css/style.css?v=" + VERSION,
    "./config.js?v=" + VERSION,
    "./js/auth.js?v=" + VERSION,
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
    }
    // Supabase requests are not intercepted: no session-scoped data in the
    // CacheStorage. The dashboard's in-memory/localStorage fallback handles
    // "last known" only while the user is signed in.
});
