/**
 * ============================================================
 *  Digitale Solution POS — Service Worker
 *  Version : 2.0.0
 *  Stratégies :
 *    • App shell   → Cache First  (offline garanti)
 *    • Firebase    → Network Only (temps réel)
 *    • Images CDN  → Stale-While-Revalidate
 *    • Background Sync → file ds-sync-queue
 * ============================================================
 */

const CACHE_VERSION   = 'ds-pos-v2.0.0';
const SHELL_CACHE     = CACHE_VERSION + '-shell';
const DYNAMIC_CACHE   = CACHE_VERSION + '-dynamic';
const IMAGE_CACHE     = CACHE_VERSION + '-images';
const SYNC_TAG        = 'ds-sync-queue';
const MAX_IMAGE_CACHE = 60;   // nb max d'images en cache
const MAX_DYN_CACHE   = 40;   // nb max d'entrées dynamiques

/* ── Assets app shell à précacher ─────────────────────────── */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
  /* Les fonts Google sont chargées via CDN → gérées en dynamic cache */
];

/* ── Domaines Firebase à exclure du cache ─────────────────── */
const NETWORK_ONLY_PATTERNS = [
  /firestore\.googleapis\.com/,
  /firebase\.googleapis\.com/,
  /identitytoolkit\.googleapis\.com/,
  /securetoken\.googleapis\.com/,
  /fcm\.googleapis\.com/,
  /wa\.me/,
  /api\.whatsapp\.com/
];

/* ── Domaines CDN à mettre en cache (stale-while-revalidate) ─ */
const CDN_PATTERNS = [
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /cdnjs\.cloudflare\.com/
];

/* ============================================================
   INSTALL — précache de l'app shell
   ============================================================ */
self.addEventListener('install', event => {
  console.log('[SW] Install — version:', CACHE_VERSION);
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())          // active immédiatement
      .catch(err => console.warn('[SW] Précache partiel:', err.message))
  );
});

/* ============================================================
   ACTIVATE — nettoyer les anciens caches
   ============================================================ */
self.addEventListener('activate', event => {
  console.log('[SW] Activate — nettoyage anciens caches');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('ds-pos-') && k !== SHELL_CACHE && k !== DYNAMIC_CACHE && k !== IMAGE_CACHE)
          .map(k => { console.log('[SW] Suppression cache obsolète:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())         // prend le contrôle immédiatement
  );
});

/* ============================================================
   FETCH — routeur de stratégies
   ============================================================ */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ① Ignorer les requêtes non-GET et les extensions navigateur
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;
  if (url.pathname.startsWith('/sw.js')) return;

  // ② Firebase & APIs temps réel → Network Only (jamais en cache)
  if (NETWORK_ONLY_PATTERNS.some(p => p.test(request.url))) {
    event.respondWith(fetch(request));
    return;
  }

  // ③ CDN (fonts, scripts) → Stale-While-Revalidate
  if (CDN_PATTERNS.some(p => p.test(request.url))) {
    event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE, MAX_DYN_CACHE));
    return;
  }

  // ④ Images → Cache + limite 60 entrées
  if (request.destination === 'image') {
    event.respondWith(cacheFirst(request, IMAGE_CACHE, MAX_IMAGE_CACHE));
    return;
  }

  // ⑤ App shell (HTML, JS inline, CSS inline) → Cache First + fallback offline
  if (request.destination === 'document' || url.origin === self.location.origin) {
    event.respondWith(appShellFirst(request));
    return;
  }

  // ⑥ Tout le reste → Network First avec fallback cache
  event.respondWith(networkFirst(request, DYNAMIC_CACHE, MAX_DYN_CACHE));
});

/* ============================================================
   STRATÉGIES CACHE
   ============================================================ */

/** Cache First : renvoie le cache, sinon réseau → cache */
async function cacheFirst(request, cacheName, maxEntries) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      await trimCache(cache, maxEntries - 1);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 408, statusText: 'Offline' });
  }
}

/** Network First : réseau prioritaire, fallback cache */
async function networkFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await trimCache(cache, maxEntries - 1);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || offlineFallback(request);
  }
}

/** Stale-While-Revalidate : cache immédiat + revalidation en fond */
async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(async response => {
    if (response.ok) {
      await trimCache(cache, maxEntries - 1);
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);
  return cached || await fetchPromise || offlineFallback(request);
}

/** App Shell First : cache → réseau → page offline */
async function appShellFirst(request) {
  const cache  = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  // Tenter réseau
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    // Fallback : retourner la racine du shell
    const root = await cache.match('/') || await cache.match('/index.html');
    return root || offlineFallback(request);
  }
}

/** Page / réponse de fallback hors ligne */
function offlineFallback(request) {
  if (request.destination === 'document') {
    return new Response(
      `<!DOCTYPE html><html lang="fr"><head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
        <title>Digitale Solution — Hors ligne</title>
        <style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{background:#0A0E16;color:#E2E8F0;font-family:'DM Sans',sans-serif;
               display:flex;align-items:center;justify-content:center;
               min-height:100vh;text-align:center;padding:24px}
          .card{background:#141922;border:1px solid rgba(232,115,12,.3);
                border-radius:16px;padding:40px 32px;max-width:400px;width:100%}
          .ico{font-size:3.5rem;margin-bottom:16px}
          h1{font-size:1.4rem;font-weight:700;margin-bottom:10px;color:#E8730C}
          p{color:#94A3B8;font-size:.9rem;line-height:1.6;margin-bottom:24px}
          button{background:#E8730C;color:#fff;border:none;border-radius:8px;
                 padding:12px 28px;font-size:.95rem;font-weight:600;cursor:pointer}
          button:hover{background:#d4650a}
        </style>
      </head><body>
        <div class="card">
          <div class="ico">📡</div>
          <h1>Vous êtes hors ligne</h1>
          <p>Vérifiez votre connexion internet. Les données déjà chargées restent accessibles.</p>
          <button onclick="location.reload()">🔄 Réessayer</button>
        </div>
      </body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
    );
  }
  return new Response('', { status: 408, statusText: 'Offline' });
}

/** Limiter le nombre d'entrées dans un cache */
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    await Promise.all(keys.slice(0, keys.length - maxEntries).map(k => cache.delete(k)));
  }
}

/* ============================================================
   BACKGROUND SYNC — file ds-sync-queue
   ============================================================ */
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    console.log('[SW] Background Sync déclenché:', SYNC_TAG);
    event.waitUntil(processSyncQueue());
  }
});

async function processSyncQueue() {
  // Récupérer la file depuis l'app via MessageChannel
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) {
    const channel = new MessageChannel();
    const queueData = await new Promise(resolve => {
      channel.port1.onmessage = e => resolve(e.data);
      client.postMessage({ type: 'GET_QUEUE' }, [channel.port2]);
    });
    const queue = queueData?.queue || [];
    if (!queue.length) continue;
    console.log('[SW] Traitement de', queue.length, 'action(s) en file');
    const synced = [], failed = [];
    for (const item of queue) {
      try {
        if (item.url && item.options) {
          const resp = await fetch(item.url, item.options);
          if (resp.ok) synced.push(item.id);
          else failed.push(item.id);
        } else {
          // Action locale (localStorage) — signaler à l'app pour traitement
          synced.push(item.id);
        }
      } catch { failed.push(item.id); }
    }
    const pending = failed.length + (queue.length - synced.length - failed.length);
    client.postMessage({ type: 'SYNC_COMPLETE', synced: synced.length, pending });
    if (synced.length > 0) {
      client.postMessage({ type: 'REMOVE_SYNCED', ids: synced });
    }
    console.log('[SW] Sync terminé —', synced.length, 'ok,', failed.length, 'échoués');
  }
}

/* ============================================================
   MESSAGES depuis l'application
   ============================================================ */
self.addEventListener('message', async event => {
  const { type, data } = event.data || {};

  switch (type) {

    case 'FORCE_SYNC':
      console.log('[SW] Sync manuelle demandée');
      await processSyncQueue();
      break;

    case 'SAVE_QUEUE':
      // L'app pousse sa file hors ligne dans le SW (pour persistance mémoire)
      // Ici on ne stocke pas — on confirme la réception
      if (event.source) {
        event.source.postMessage({ type: 'QUEUE_SIZE', size: (data || []).length });
      }
      break;

    case 'GET_QUEUE_SIZE':
      // Retourner la taille de la file (0 côté SW — c'est l'app qui la gère)
      if (event.source) {
        event.source.postMessage({ type: 'QUEUE_SIZE', size: 0 });
      }
      break;

    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'CACHE_STATUS':
      // Retourner les noms et tailles des caches actifs
      const keys   = await caches.keys();
      const counts = await Promise.all(keys.map(async k => {
        const c = await caches.open(k);
        const entries = await c.keys();
        return { name: k, count: entries.length };
      }));
      if (event.source) {
        event.source.postMessage({ type: 'CACHE_STATUS_RESULT', caches: counts });
      }
      break;

    default:
      console.log('[SW] Message inconnu:', type);
  }
});

/* ============================================================
   PUSH NOTIFICATIONS (optionnel — prêt pour activation)
   ============================================================ */
self.addEventListener('push', event => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { payload = { title: 'Digitale Solution', body: event.data.text() }; }
  const options = {
    body:    payload.body  || '',
    icon:    payload.icon  || '/icons/icon-192.png',
    badge:   payload.badge || '/icons/icon-72.png',
    tag:     payload.tag   || 'ds-notif',
    data:    payload.data  || {},
    vibrate: [200, 100, 200],
    actions: payload.actions || []
  };
  event.waitUntil(self.registration.showNotification(payload.title || 'Digitale Solution', options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      const existing = windowClients.find(c => c.url === url && 'focus' in c);
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});

console.log('[SW] Digitale Solution SW chargé — version', CACHE_VERSION);
