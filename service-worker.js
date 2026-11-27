const cacheName = "guitar-chord-trainer-shell-v14";
const guitarDirectory = "./assets/guitar/";
const fretsByString = { e2: "013", a2: "023", d3: "01234", g3: "01234", b3: "0123", e4: "01234" };
const guitarFiles = Object.entries(fretsByString).flatMap(([string, frets]) =>
  [...frets].flatMap((fret) => ["d", "u"].map((stroke) => `meta-steel/${string}-${fret}-${stroke}.wav`)));
guitarFiles.push("muted-1.wav", "muted-2.wav");
const files = [
  "./index.html", "./styles.css?v=14", "./app.mjs?v=14", "./music.mjs",
  ...guitarFiles.map((name) => guitarDirectory + name),
  "./capture.mjs", "./tuner.mjs", "./songs.mjs", "./song-format.mjs", "./assets/songs/dream-a-little-dream.txt", "./assets/songs/dream-a-little-dream-triplet.txt", "./rhythm.mjs", "./rhythm-ui.mjs", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png",
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
  if (request.url.startsWith(new URL(guitarDirectory, self.registration.scope).href)) {
    event.respondWith(caches.open(cacheName).then(async (cache) => (await cache.match(request)) ?? fetch(request)));
    return;
  }
  event.respondWith(fetch(request, { cache: "no-cache" }).catch(async (error) => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request.mode === "navigate" ? "./index.html" : request);
    if (cached) return cached;
    throw error;
  }));
});
