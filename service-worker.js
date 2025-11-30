// Service Worker for 将棋Web PWA
const CACHE_NAME = 'shogi-web-v1';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/shogi.js',
    '/style.css',
    '/manifest.json',
    '/favicon.ico',
    '/sounds/piece_placement.mp3',
    '/images/iOSinstall.webp',
    '/images/icon-16x16.png',
    '/images/icon-32x32.png',
    '/images/icon-192x192.png',
    '/images/icon-512x512.png',
    '/images/shogi_web_maskable_192.png',
    '/images/shogi_web_maskable_512.png',
    '/images/screenshot_desktop.png',
    '/images/screenshot_mobile.png',
    '/images/apple-touch-icon-180x180.png',
    '/images/settings.svg',
    '/images/og-image.png',
    // 駒画像
    '/images/koma/fu.jpg',
    '/images/koma/kyo.jpg',
    '/images/koma/kei.jpg',
    '/images/koma/gin.jpg',
    '/images/koma/kin.jpg',
    '/images/koma/kaku.jpg',
    '/images/koma/hi.jpg',
    '/images/koma/ou.jpg',
    '/images/koma/to.jpg',
    '/images/koma/narikyo.jpg',
    '/images/koma/narikei.jpg',
    '/images/koma/narigin.jpg',
    '/images/koma/uma.jpg',
    '/images/koma/ryu.jpg'
];

// インストール時にアセットをキャッシュ
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Caching app assets');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .then(() => {
                // 新しいService Workerをすぐに有効化
                return self.skipWaiting();
            })
            .catch((error) => {
                console.error('Failed to cache assets:', error);
            })
    );
});

// 古いキャッシュを削除
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((cacheName) => cacheName !== CACHE_NAME)
                        .map((cacheName) => caches.delete(cacheName))
                );
            })
            .then(() => {
                // すぐにコントロールを取得
                return self.clients.claim();
            })
    );
});

// フェッチリクエストを処理（Cache First戦略）
self.addEventListener('fetch', (event) => {
    // Googleフォントや外部リソースはネットワーク優先
    if (event.request.url.includes('fonts.googleapis.com') ||
        event.request.url.includes('fonts.gstatic.com') ||
        event.request.url.includes('googletagmanager.com') ||
        event.request.url.includes('googlesyndication.com')) {
        event.respondWith(
            fetch(event.request)
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // 同一オリジンのリクエストはCache First
    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                if (cachedResponse) {
                    // バックグラウンドでキャッシュを更新（Stale While Revalidate）
                    fetch(event.request)
                        .then((networkResponse) => {
                            if (networkResponse && networkResponse.status === 200) {
                                caches.open(CACHE_NAME)
                                    .then((cache) => {
                                        cache.put(event.request, networkResponse.clone());
                                    });
                            }
                        })
                        .catch(() => {
                            // ネットワークエラーは無視（キャッシュが使われる）
                        });
                    return cachedResponse;
                }

                // キャッシュにない場合はネットワークから取得してキャッシュ
                return fetch(event.request)
                    .then((networkResponse) => {
                        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                            return networkResponse;
                        }

                        const responseToCache = networkResponse.clone();
                        caches.open(CACHE_NAME)
                            .then((cache) => {
                                cache.put(event.request, responseToCache);
                            });

                        return networkResponse;
                    })
                    .catch(() => {
                        // オフライン時のフォールバック（HTMLリクエストの場合）
                        if (event.request.headers.get('Accept')?.includes('text/html')) {
                            return caches.match('/index.html');
                        }
                        return new Response('オフラインです', { status: 503 });
                    });
            })
    );
});
