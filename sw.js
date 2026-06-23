const CACHE_NAME = 'shiftr-v6';

// Assets essenciais - APENAS arquivos que realmente existem
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// CDNs que queremos cachear (TensorFlow + jsPDF)
const EXTERNAL_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/tensorflow.js/4.11.0/tf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tensorflow-hub/4.2.1/tf-hub.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// ═══════════════════════════════════════════════════════
// INSTALL: Cachear apenas arquivos que existem
// ═══════════════════════════════════════════════════════
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // Cachear arquivos locais (essenciais)
        return cache.addAll(ASSETS)
          .catch(err => {
            console.warn('[SW] Erro ao cachear assets locais:', err);
            // Continua mesmo se falhar
            return Promise.resolve();
          });
      })
      .then(() => {
        // Cachear CDNs (opcional - sem bloquear install)
        return caches.open(CACHE_NAME)
          .then(cache => {
            // Tenta cachear cada CDN individualmente
            // Se um falhar, não afeta os outros
            return Promise.allSettled(
              EXTERNAL_ASSETS.map(url => 
                fetch(url)
                  .then(res => {
                    if (res.status === 200) {
                      return cache.put(url, res);
                    }
                  })
                  .catch(err => {
                    console.warn(`[SW] Falha ao cachear ${url}:`, err);
                    // Ignora erro individual
                  })
              )
            );
          });
      })
      .then(() => self.skipWaiting())
      .catch(err => {
        console.error('[SW] Erro crítico no install:', err);
      })
  );
});

// ═══════════════════════════════════════════════════════
// ACTIVATE: Limpar caches antigos
// ═══════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      // Deletar caches antigos (v1-v5)
      return Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Deletando cache antigo:', k);
            return caches.delete(k);
          })
      );
    })
      .then(() => {
        // Reclama todos os clientes
        return self.clients.claim();
      })
      .then(() => {
        // Notifica clientes sobre atualização
        return self.clients.matchAll();
      })
      .then(clients => {
        clients.forEach(client => {
          client.postMessage({ 
            type: 'SW_UPDATED',
            version: CACHE_NAME
          });
        });
      })
  );
});

// ═══════════════════════════════════════════════════════
// FETCH: Cache-first com fallback de rede
// ═══════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // NÃO cachear requisições de:
  const skipCache = [
    'firebase',
    'googleapis',
    'gstatic',
    'google.com',
    'recaptcha'
  ].some(domain => url.hostname.includes(domain));
  
  // NÃO cachear POST, PUT, DELETE, etc
  const isGetRequest = event.request.method === 'GET';
  
  // Se deve pular cache ou não é GET, deixa passar
  if (skipCache || !isGetRequest) {
    return;
  }
  
  // Estratégia: Cache-first, fallback na rede
  event.respondWith(
    (async () => {
      try {
        // 1. Tenta buscar do cache
        const cached = await caches.match(event.request);
        if (cached) {
          // Atualiza cache em background (não bloqueia resposta)
          fetch(event.request)
            .then(res => {
              if (res && res.status === 200) {
                const resClone = res.clone();
                caches.open(CACHE_NAME)
                  .then(cache => cache.put(event.request, resClone))
                  .catch(() => {}); // Ignora erro
              }
            })
            .catch(() => {}); // Ignora erro de rede
          
          return cached;
        }
        
        // 2. Se não tem cache, busca na rede
        const res = await fetch(event.request);
        
        // 3. Se conseguiu, cachea para próxima vez
        if (res && res.status === 200) {
          const resClone = res.clone();
          try {
            const cache = await caches.open(CACHE_NAME);
            cache.put(event.request, resClone);
          } catch (e) {
            console.warn('[SW] Erro ao cachear resposta:', e);
            // Continua mesmo se falhar
          }
        }
        
        return res;
      } catch (error) {
        // Offline e sem cache = erro
        console.error('[SW] Erro no fetch:', error);
        throw error;
      }
    })()
  );
});

// ═══════════════════════════════════════════════════════
// MESSAGE: Comunicação com página principal
// ═══════════════════════════════════════════════════════
self.addEventListener('message', event => {
  // Página principal pede para atualizar
  if (event.data?.type === 'SKIP_WAITING') {
    console.log('[SW] Recebido SKIP_WAITING');
    self.skipWaiting();
  }
  
  // Página principal pede status
  if (event.data?.type === 'GET_STATUS') {
    event.ports[0].postMessage({
      version: CACHE_NAME,
      status: 'active'
    });
  }
});

console.log('[SW] Service Worker v6 carregado:', CACHE_NAME);
