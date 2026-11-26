const cacheName = "guitar-chord-trainer-shell-v3";
const files = [
  "./", "./index.html", "./styles.css", "./app.mjs", "./music.mjs",
  "./capture.mjs", "./songs.mjs", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(files)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("guitar-chord-trainer-shell-") && key !== cacheName)
      .map((key) => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(cacheName).then(async (cache) => {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    if (event.request.mode === "navigate") {
      try {
        return await fetch(event.request);
      } catch {
        return cache.match("./index.html");
      }
    }
    return fetch(event.request);
  }));
});
