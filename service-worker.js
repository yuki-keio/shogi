// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
// Service Worker for 将棋Web PWA
const CACHE_NAME = 'shogi-web-dev';
const OFFLINE_DOCUMENT_URL = '/index.html';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/shogi.js',
    '/style.css',
    '/ai-worker.js',
    '/yaneuraou-worker.js',
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
    '/images/koma/ryu.jpg',
    // YaneuraOu WASM files
    '/yaneuraou/sse42/yaneuraou.js?v2',
    '/yaneuraou/sse42/yaneuraou.wasm?v2',
    // SharedArrayBufferを使用しないため不要'/yaneuraou/sse42/yaneuraou.worker.js',
    '/yaneuraou/nosimd/yaneuraou.js?v2',
    '/yaneuraou/nosimd/yaneuraou.wasm?v2',
    // SharedArrayBufferを使用しないため不要'/yaneuraou/nosimd/yaneuraou.worker.js'
];

const NETWORK_FIRST_PATHS = new Set([
    '/',
    '/index.html',
    '/manifest.json'
]);

function isCacheableResponse(response) {
    return !!response && response.status === 200 && response.type === 'basic';
}

function isNavigationRequest(request) {
    return request.mode === 'navigate' || request.headers.get('Accept')?.includes('text/html');
}

function shouldUseNetworkFirst(request) {
    const url = new URL(request.url);
    return isNavigationRequest(request) || NETWORK_FIRST_PATHS.has(url.pathname);
}

async function cacheFirst(request) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
        return cachedResponse;
    }

    const networkResponse = await fetch(request);
    if (isCacheableResponse(networkResponse)) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, networkResponse.clone());
    }

    return networkResponse;
}

async function networkFirst(request) {
    try {
        const networkResponse = await fetch(request);
        if (isCacheableResponse(networkResponse)) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }

        if (isNavigationRequest(request)) {
            return caches.match(OFFLINE_DOCUMENT_URL);
        }

        throw error;
    }
}

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

// フェッチリクエストを処理
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

    if (shouldUseNetworkFirst(event.request)) {
        event.respondWith(
            networkFirst(event.request).catch(() => new Response('オフラインです', { status: 503 }))
        );
        return;
    }

    // 同一オリジンの静的アセットはCache First
    event.respondWith(
        cacheFirst(event.request).catch(() => new Response('オフラインです', { status: 503 }))
    );
});
