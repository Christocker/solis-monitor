/* ============================================================
   Solis Monitor — hosted-site PIN session.

   The site is static, so the PIN is checked by Supabase Auth, not by
   JavaScript. A successful login stores the user's JWT and refresh token;
   every Supabase request then uses that JWT. The database's RLS policies
   only allow members in public.app_users.

   Load this file BEFORE common.js on every dashboard page.
   ============================================================ */

const AUTH_STORAGE_KEY = "solis:auth";

let _authRefreshPromise = null;
let _authRedirecting = false;

function authEmail() {
    return typeof AUTH_EMAIL !== "undefined" ? AUTH_EMAIL : "";
}

function loadAuth() {
    try {
        const raw = localStorage.getItem(AUTH_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function saveAuth(data) {
    try {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* private mode: session lasts for this page only */ }
}

function clearAuth() {
    try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) { /* ignore */ }
}

function authFetchRaw(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

function authLoginUrl() {
    const next = location.pathname + location.search + location.hash;
    return "login.html?next=" + encodeURIComponent(next);
}

function redirectToLogin() {
    if (_authRedirecting) return;
    _authRedirecting = true;
    location.replace(authLoginUrl());
}

async function authLogin(pin) {
    const value = String(pin || "").replace(/\D/g, "");
    if (value.length !== 6) throw new Error("Enter the 6-digit PIN.");
    if (!authEmail()) throw new Error("Auth email is not configured.");

    const res = await authFetchRaw(
        SUPABASE_URL + "/auth/v1/token?grant_type=password",
        {
            method: "POST",
            headers: {
                apikey: SUPABASE_ANON_KEY,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ email: authEmail(), password: value }),
        },
        20000,
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.access_token) {
        if (res.status === 429) {
            throw new Error("Too many attempts. Wait a few minutes.");
        }
        const msg = data && (data.error_description || data.msg || data.error);
        throw new Error(msg && msg.toLowerCase().includes("invalid")
            ? "Wrong PIN." : (msg || "Sign in failed."));
    }
    saveAuth({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
    });
    return true;
}

async function authRefresh() {
    const current = loadAuth();
    if (!current || !current.refresh_token) return false;
    if (_authRefreshPromise) return _authRefreshPromise;

    _authRefreshPromise = (async () => {
        try {
            const res = await authFetchRaw(
                SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token",
                {
                    method: "POST",
                    headers: {
                        apikey: SUPABASE_ANON_KEY,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ refresh_token: current.refresh_token }),
                },
                15000,
            );
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.access_token) {
                clearAuth();
                return false;
            }
            saveAuth({
                access_token: data.access_token,
                refresh_token: data.refresh_token || current.refresh_token,
                expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
            });
            return true;
        } catch (e) {
            clearAuth();
            return false;
        } finally {
            _authRefreshPromise = null;
        }
    })();
    return _authRefreshPromise;
}

async function authToken() {
    let current = loadAuth();
    if (!current || !current.refresh_token) return null;
    if (!current.expires_at || Date.now() > current.expires_at - 60000) {
        const ok = await authRefresh();
        if (!ok) return null;
        current = loadAuth();
    }
    return current ? current.access_token : null;
}

async function authHasSession() {
    if (!loadAuth()) return false;
    return !!(await authToken());
}

async function authReady() {
    if (!loadAuth()) {
        redirectToLogin();
        return false;
    }
    const token = await authToken();
    if (!token) {
        redirectToLogin();
        return false;
    }
    return true;
}

async function authLogout() {
    const current = loadAuth();
    if (current && current.access_token) {
        // Best effort: revoke the refresh token server-side too.
        try {
            await authFetchRaw(SUPABASE_URL + "/auth/v1/logout", {
                method: "POST",
                headers: {
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: "Bearer " + current.access_token,
                },
            }, 8000);
        } catch (e) { /* ignore */ }
    }
    clearAuth();
    try {
        Object.keys(localStorage).forEach((k) => {
            if (k === "solis:last" || k.indexOf("lifetimeEnergy:") === 0) {
                localStorage.removeItem(k);
            }
        });
    } catch (e) { /* ignore */ }
    try {
        Object.keys(sessionStorage).forEach((k) => {
            if (k.indexOf("hist:") === 0) sessionStorage.removeItem(k);
        });
    } catch (e) { /* ignore */ }
    try {
        if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.filter((k) => k.indexOf("solis-") === 0)
                .map((k) => caches.delete(k)));
        }
    } catch (e) { /* ignore */ }
    location.replace("login.html");
}

function authLockButton() {
    const host = document.querySelector(".topbar-right");
    if (!host || document.getElementById("auth-lock")) return;
    const btn = document.createElement("button");
    btn.id = "auth-lock";
    btn.type = "button";
    btn.className = "theme-toggle auth-lock";
    btn.title = "Lock this device";
    btn.setAttribute("aria-label", "Lock this device");
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/>' +
        '<path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
    btn.addEventListener("click", () => {
        if (confirm("Lock this device? You will need the PIN again.")) {
            authLogout();
        }
    });
    host.appendChild(btn);
}

document.addEventListener("DOMContentLoaded", authLockButton);
