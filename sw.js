// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER v7 - FORÇA ATUALIZAÇÃO (NÃO FICA CONGELADO!)
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME = 'shiftr-v7';
const CACHE_VERSAO = 'v7-' + new Date().getTime(); // Força nova versão

// Assets essenciais - APENAS arquivos que realmente existem
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// CDNs externas
const EXTERNAL_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.11.0/dist/tf.min.js',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// ═══════════════════════════════════════════════════════════════
// INSTALL: Cache assets (mas NOT agressivamente!)
// ═══════════════════════════════════════════════════════════════

self.addEventListener('install', event => {
  console.log('🔧 [SW v7] Install iniciado...');
  
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache apenas os assets locais
      return Promise.allSettled(
        ASSETS.map(asset => 
          fetch(asset).then(response => {
            if (response.ok) {
              return cache.put(asset, response);
            }
          }).catch(err => {
            console.warn(`⚠️ Não conseguiu cachear: ${asset}`, err);
          })
        )
      );
    }).then(() => {
      console.log('✅ [SW v7] Assets cacheados com sucesso');
      self.skipWaiting(); // Ativa imediatamente
    })
  );
});

// ═══════════════════════════════════════════════════════════════
// ACTIVATE: Limpa caches antigos (CRITICAL!)
// ═══════════════════════════════════════════════════════════════

self.addEventListener('activate', event => {
  console.log('🗑️  [SW v7] Limpando caches antigos...');
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME && !cacheName.includes('shiftr-v7')) {
            console.log(`   ❌ Deletando: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('✅ [SW v7] Caches antigos removidos');
      // Notifica todas as abas pra recarregar
      return self.clients.matchAll();
    }).then(clients => {
      clients.forEach(client => {
        client.postMessage({
          type: 'SW_UPDATED',
          message: 'Nova versão disponível! Recarregando...'
        });
      });
    })
  );
});

// ═══════════════════════════════════════════════════════════════
// FETCH: Network-first para HTML, cache-first para assets
// ═══════════════════════════════════════════════════════════════

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  
  // HTML: SEMPRE tenta buscar versão nova primeiro!
  if (request.destination === '' || url.pathname.endsWith('.html') || url.pathname === '/') {
    return event.respondWith(
      fetch(request)
        .then(response => {
          // Se conseguiu, atualiza cache
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(request, responseClone);
            });
            return response;
          }
          // Se erro, usa cache
          return caches.match(request);
        })
        .catch(() => caches.match(request))
    );
  }
  
  // Assets locais: cache-first (mais rápido)
  if (ASSETS.includes(url.pathname)) {
    return event.respondWith(
      caches.match(request)
        .then(response => response || fetch(request))
        .catch(() => response)
    );
  }
  
  // CDNs externas: tenta rede, fallback cache
  if (url.hostname.includes('cdn.') || url.hostname.includes('cloudflare')) {
    return event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(request, responseClone);
            });
            return response;
          }
          return caches.match(request);
        })
        .catch(() => caches.match(request))
    );
  }
  
  // Padrão: passa pra rede normalmente
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICA O APP QUANDO HOUVER ATUALIZAÇÃO
// ═══════════════════════════════════════════════════════════════

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('✅ [SW v7] Service Worker carregado com force update!');
