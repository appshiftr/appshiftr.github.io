// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER v9 - FORÇA ATUALIZAÇÃO (NÃO FICA CONGELADO!)
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME = 'shiftr-v9';
const CACHE_VERSAO = 'v9-' + new Date().getTime(); // Força nova versão

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
  console.log('🔧 [SW v9] Install iniciado...');
  
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
      console.log('✅ [SW v9] Assets cacheados com sucesso');
      self.skipWaiting(); // Ativa imediatamente
    })
  );
});

// ═══════════════════════════════════════════════════════════════
// ACTIVATE: Limpa caches antigos (CRITICAL!)
// ═══════════════════════════════════════════════════════════════

self.addEventListener('activate', event => {
  console.log('🗑️  [SW v9] Limpando caches antigos...');
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log(`   ❌ Deletando: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('✅ [SW v9] Caches antigos removidos');
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

  // ✅ FIX: métodos não-GET (POST, PUT...) NUNCA passam pelo cache.
  // Cache API só suporta GET — tentar cache.put em POST jogava
  // "Failed to execute 'put' on 'Cache': Request method 'POST' is unsupported".
  // Isso pegava, sem querer, as chamadas fetch() da Análise IA (Claude Vision),
  // EmailJS, Firebase etc. Deixa o navegador tratar normalmente.
  if (request.method !== 'GET') {
    return;
  }

  // HTML/navegação: SEMPRE tenta buscar versão nova primeiro!
  // ✅ FIX: usa request.mode === 'navigate' (em vez de destination === '')
  // pra não capturar fetch() de API por engano.
  if (request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(
      fetch(request, { cache: 'no-store' }) // ✅ ignora o cache de 10min do GitHub Pages, sempre busca fresco
        .then(response => {
          // Se conseguiu, atualiza cache
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(request, responseClone))
              .catch(err => console.warn('Falha ao cachear HTML:', err));
            return response;
          }
          // Se erro, usa cache
          return caches.match(request);
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Assets locais: cache-first (mais rápido)
  if (ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request)
        .then(response => response || fetch(request))
        .catch(() => fetch(request))
    );
    return;
  }

  // CDNs externas: tenta rede, fallback cache
  // ✅ FIX: scripts cross-origin sem CORS chegam como resposta "opaque"
  // (response.ok é SEMPRE false numa opaque, mesmo quando o carregamento
  // deu certo!). Isso fazia jspdf/tf.min.js/coco-ssd caírem no
  // caches.match() vazio no 1º load → undefined → "net::ERR_FAILED".
  if (url.hostname.includes('cdn.') || url.hostname.includes('cloudflare')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok || response.type === 'opaque') {
            const responseClone = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(request, responseClone))
              .catch(err => console.warn('Falha ao cachear CDN:', err));
            return response;
          }
          return caches.match(request);
        })
        .catch(() => caches.match(request))
    );
    return;
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

console.log('✅ [SW v9] Service Worker carregado com force update!');
