// hwp-viewer 서비스워커 — 오프라인 캐싱 (wasm 포함)
// 캐시 버전을 올리면(v20→v21...) 기존 캐시를 비우고 새로 받습니다.
const CACHE_NAME = 'hwp-viewer-v28';

// 오프라인에서도 동작하려면 이 파일들이 전부 캐시되어야 함
// 특히 rhwp_bg.wasm 이 빠지면 파일 열기가 멈춤
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './rhwp.js',
  './rhwp_bg.wasm',
  './manifest.json',
  './icon.svg',
];

// 설치: 필요한 파일을 모두 캐시에 적재
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // 일부 파일이 없어도 전체 설치가 실패하지 않도록 개별 처리
      Promise.allSettled(ASSETS.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 활성화: 이전 버전 캐시만 정리(현재 버전은 유지)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => Promise.all(
        clients.map((client) => client.postMessage({
          type: 'SW_ACTIVATED',
          version: CACHE_NAME,
        }))
      ))
  );
});

// 요청 처리: 캐시 우선, 없으면 네트워크 → 받은 건 캐시에 저장
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET 이외(POST 등)는 그냥 통과
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then((resp) => {
          // 정상 응답이면 캐시에 복제 저장 (동일 출처만)
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => cached); // 네트워크 실패 시 캐시(없으면 undefined)
    })
  );
});
