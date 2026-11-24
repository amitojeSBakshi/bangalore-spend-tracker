const CACHE_NAME = 'spend-tracker-v5-2026-11-24-insights';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('message',event=>{
  if(event.data?.type==='GET_VERSION') event.ports[0]?.postMessage({version:CACHE_NAME});
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(
      SHELL_FILES.map(path=>new Request(new URL(path,self.location.href),{cache:'reload'}))
    )).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('spend-tracker-') && k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
    .then(()=>self.clients.claim())
  );
});

// Network-first for the app shell so updates show up quickly; fall back to cache when offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const root = new URL('./',self.location.href);
  if(url.origin!==root.origin || !url.pathname.startsWith(root.pathname)) return;
  // Cache the app shell only; never touch another app or private user files.
  const isNavigation = event.request.mode==='navigate';
  const isShell = SHELL_FILES.some(path=>new URL(path,root).pathname===url.pathname);
  if(!isNavigation && !isShell) return;
  event.respondWith(
    fetch(new Request(event.request,{cache:'no-cache'}))
      .then((response) => {
        if(response.ok){
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(()=>{}));
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request)) ||
        (isNavigation ? await caches.match(new URL('./index.html',root).href) : undefined) || Response.error())
  );
});
