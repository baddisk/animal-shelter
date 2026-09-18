/*
 * 서비스워커 (P2: 웹앱 설치 · 담당자가 홈 화면에 앱처럼 추가해 매일 사용)
 *  - 목적은 "설치 가능(installable)"과 재방문 체감 속도이며, 데이터를 오래 붙잡지 않는다.
 *  - 동물 목록·상세·이미지 같은 실시간성 응답(/api, /a, /p)은 절대 캐시하지 않는다.
 *  - 정적 자산(css/js/아이콘 등)만 stale-while-revalidate로 다뤄 최신본을 놓치지 않는다.
 */
const VERSION = 'v1.4.3';
const STATIC_CACHE = `shelter-static-${VERSION}`;

// 설치 시 미리 받아둘 최소 셸(오프라인/재방문 즉시 표시용)
const PRECACHE = [
  '/',
  '/index.html',
  '/css/style.css?v=1.4.3',
  '/js/app.js?v=1.4.3',
  '/logo.svg',
  '/favicon.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {})) // 일부 실패해도 설치는 진행
      .then(() => self.skipWaiting())
  );
});

// 이전 버전 캐시 정리
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 정적 자산인지 판별 (실시간 응답은 제외)
function isStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;         // 외부(CDN·이미지 원본)는 관여 안 함
  if (url.pathname.startsWith('/api/')) return false;            // API 응답은 캐시 금지(이미지는 HTTP 캐시가 담당)
  if (/^\/(a|p|s)\//.test(url.pathname)) return false;           // 공유/미리보기/짧은주소 페이지 제외
  return /\.(css|js|svg|png|jpg|jpeg|webp|ico|webmanifest|woff2?)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 문서(HTML) 요청: 항상 네트워크 우선 → 최신 목록을 보장, 실패 시에만 캐시 셸로 폴백
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // 정적 자산: stale-while-revalidate (즉시 표시 + 백그라운드 갱신)
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((res) => { if (res && res.status === 200) cache.put(req, res.clone()); return res; })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
  }
});
