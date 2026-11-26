const cacheName = "guitar-chord-trainer-shell-v4";
const files = [
  "./index.html", "./styles.css?v=4", "./app.mjs?v=4", "./music.mjs",
  "./capture.mjs", "./songs.mjs", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", (event) => {
  const requests = files.map((file) => new Request(new URL(file, self.registration.scope), { cache: "reload" }));
  event.waitUntil(caches.open(cacheName)
    .then((cache) => cache.addAll(requests))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("guitar-chord-trainer-shell-") && key !== cacheName)
      .map((key) => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith(fetch(request, { cache: "no-cache" }).catch(async (error) => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request.mode === "navigate" ? "./index.html" : request);
    if (cached) return cached;
    throw error;
  }));
});
