/* RDM service worker.

   WHY IT EXISTS: web push needs one. On iOS (16.4+) push is only available to a PWA the member has
   added to their home screen, and only through a service worker — there is no other route. It also
   makes Android offer the real install prompt, and it means the app shell opens instantly on a second
   visit instead of waiting on the network.

   ────────────────────────────────────────────────────────────────────────────────────────────────
   THE ONE WAY A SERVICE WORKER CAN RUIN AN APP is by serving stale HTML forever: cache index.html
   cache-first and every member is frozen on whatever build they happened to install, with no way back
   short of clearing site data. Everything below is arranged so that cannot happen.

     NAVIGATIONS ARE NETWORK-FIRST. A deploy always wins. The cache is a fallback for when the network
     genuinely fails, which is the only time it should ever be read.

     ASSETS ARE CACHE-FIRST, but only /assets/*, whose filenames are CONTENT-HASHED by Vite
     (index-CJKH6x2J.js). A new build is a new filename, so a cached one can never be the wrong version
     — it is either the file you asked for or it is not in the cache at all.

     SUPABASE IS NEVER TOUCHED. Only same-origin GETs are handled at all, so the vault (tool code,
     exercises, the sound packs), auth and every RPC go straight to the network exactly as before. That
     matters beyond correctness: those are paywalled, and a cached copy would sit in the browser after a
     membership lapses. vault.js already does its own `no-store` + ?v=TOOLS_VERSION dance and this must
     not second-guess it.
   ──────────────────────────────────────────────────────────────────────────────────────────────── */

/* Bumping this drops every old cache on activate. It does NOT need bumping per deploy — hashed asset
   names already handle that — only when the caching RULES below change. */
const VERSION = "rdm-v1";
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;
const KEEP = [SHELL, ASSETS];

/* Enough to paint the app offline. Deliberately short: everything else arrives through the asset rule
   on first use. The brand background and logo are here because the boot splash draws them, and a splash
   with a missing image is worse than a slower one. */
const SHELL_URLS = ["/", "/index.html", "/rdm-bg.png", "/rdm-logo.png", "/site.webmanifest"];

self.addEventListener("install", (e) => {
  /* addAll is all-or-nothing, so one 404 would fail the whole install and leave the app with no worker
     at all. Each URL is fetched on its own and failures are ignored — a shell entry that did not cache
     just means that one request goes to the network later. */
  e.waitUntil(
    caches.open(SHELL).then((c) =>
      Promise.all(SHELL_URLS.map((u) => c.add(u).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;      // Supabase and anything else: untouched
  if (url.pathname.startsWith("/tools/")) return;       // dev-only tool source; never cache it

  /* HTML: network first. `mode === "navigate"` covers a normal page load; the Accept sniff catches the
     rest. On failure fall back to the cached page, then to the shell — a deep link opened offline
     should still boot the SPA rather than showing the browser's error page. */
  const isDoc = req.mode === "navigate" ||
                (req.headers.get("accept") || "").includes("text/html");
  if (isDoc) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html")))
    );
    return;
  }

  // Hashed build output: safe to serve from cache, because the name IS the version.
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(ASSETS).then((c) => c.put(req, copy)).catch(() => {}); }
          return res;
        })
      )
    );
    return;
  }

  /* Everything else same-origin (icons, the tutorial pictures in /learn, the manifest): stale-while-
     revalidate. These are not content-hashed, so serving a stale one briefly is fine but pinning it is
     not — the refresh in the background is what keeps them from going permanently out of date. */
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(ASSETS).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

/* Push arrives here once notifications are wired up (a VAPID key + a subscription per member). Kept
   deliberately minimal for now: showing SOMETHING for a push the browser has already accepted is
   required — a push event that displays no notification is a violation the browser will eventually
   punish by revoking permission. */
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  const title = data.title || "Rudimental Drumming Mastery";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow(target);
    })
  );
});
