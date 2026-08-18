// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
// Service Worker for 将棋Web PWA
// キャッシュ名は固定。ファイル名側に内容ハッシュ（shogi.54a778fa.js）が入っているので、
// 更新の判別はファイル名で足りる。ビルドごとに名前を変えると activate で丸ごと捨てることになり、
// 中身が変わっていない 4MB 超（大半は将棋AIのWASM）を毎デプロイで入れ直す羽目になる。
// 詰将棋の日次ジョブが毎朝デプロイするので、名前を変えると「毎日全捨て」になっていた。
// 古いビルドの残骸は activate で個別に消す（pruneSupersededAssets）。
const CACHE_NAME = 'shogi-web-v1';
// モードごとに独立したドキュメントを配信している。オフライン時は同じモードの
// ドキュメントを返す（'/' は最後のフォールバック）。
// '/index.html' は静的アセット側で '/' へリダイレクトされるためキャッシュ対象にしない
// （リダイレクト済みレスポンスはナビゲーションのフォールバックに使えない）。
const OFFLINE_DOCUMENT_URLS = ['/online/', '/board/', '/tsume/', '/'];
const ASSETS_TO_CACHE = [
    '/',
    '/board/',
    '/online/',
    '/tsume/',
    '/shogi.js',
    // 詰将棋のロジック。/tsume/ でだけ読み込むが、機内モードでも開けるようにここでは取っておく
    '/shogi-tsume.js',
    // だれかと対戦のロジック。/online/ でだけ読み込む
    '/online-match.js',
    '/name-filter.js',
    // 待機中の詰めチャレンジの出題データ(/tsume/challenge.json)はここに入れない。
    // あの盤はマッチング用のWebSocketがつながって初めて出るので、オフラインでは表示されない＝
    // 先読みしても使い道が無く、/online/ を開かない人にも配ることになるだけ。
    // 初回に取った時点で networkFirst がキャッシュへ入れるので、offlineの保険もそれで足りる
    '/style.css',
    '/ai-worker.js',
    '/yaneuraou-worker.js',
    // 詰将棋の玉方を動かす詰み探索。機内モードでも作意から外れた手を指せるように先に入れておく
    '/tsume-solver.js',
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
    '/board/',
    '/online/',
    // 当日の問題をHTMLに焼き込んでいるので、必ずネットワークを先に見る
    '/tsume/',
    // 毎日入れ替わる。SWのキャッシュはHTTPヘッダを見ないので、ここに入れておかないと
    // no-cache を付けても初回キャッシュ時点のプールで固まってしまう。
    // ここを通る限り、取得のたびにキャッシュ側も更新される
    '/tsume/challenge.json',
    '/manifest.json'
]);

function isCacheableResponse(response) {
    return !!response && response.status === 200 && response.type === 'basic';
}

function isNavigationRequest(request) {
    return request.mode === 'navigate' || request.headers.get('Accept')?.includes('text/html');
}

function pickOfflineDocument(request) {
    const { pathname } = new URL(request.url);
    return OFFLINE_DOCUMENT_URLS.find((doc) => doc !== '/' && pathname.startsWith(doc)) || '/';
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
        // 招待URL(/online/?room=XXXX)は毎回異なるためキャッシュを際限なく太らせる。
        // クエリ無しのドキュメントだけ保存する。
        if (isCacheableResponse(networkResponse) && new URL(request.url).search === '') {
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
            return caches.match(pickOfflineDocument(request));
        }

        throw error;
    }
}

// インストール時にアセットをキャッシュ
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(async (cache) => {
                // cache.add は既に入っていても取り直すので、足りないものだけに絞る。
                // これが無いと、1ファイル変わっただけのデプロイでも全件を取り直すことになる。
                const cached = await cache.keys();
                const have = new Set(cached.map((request) => {
                    const url = new URL(request.url);
                    return url.pathname + url.search;
                }));
                const missing = ASSETS_TO_CACHE.filter((asset) => !have.has(asset));

                // addAll は1つでも失敗すると全件ロールバックし skipWaiting にも進めない。
                // 取得できたものだけ個別に入れて、SWの有効化は必ず行う。
                const results = await Promise.allSettled(
                    missing.map((asset) => cache.add(asset))
                );
                const failed = missing.filter((_, i) => results[i].status === 'rejected');
                if (failed.length) {
                    console.warn('Failed to cache some assets:', failed);
                }
            })
            .catch((error) => {
                console.error('Failed to open cache:', error);
            })
            // 新しいService Workerをすぐに有効化
            .then(() => self.skipWaiting())
    );
});

// '/shogi.54a778fa.js' -> '/shogi.js'。ハッシュ付きでなければ null
function hashedAssetBase(pathname) {
    const matched = pathname.match(/^(.*)\.[0-9a-f]{8}\.(js|css)$/);
    return matched ? `${matched[1]}.${matched[2]}` : null;
}

// 前のビルドのハッシュ付きファイル（古い shogi.<旧ハッシュ>.js など）だけを消す。
// 今回のリストと「ハッシュを除いた名前」が一致するものだけが対象なので、
// 実行時にキャッシュされた画像やハッシュ付きでも今回のリストに無いもの（qrcode など）は残る。
async function pruneSupersededAssets(cache) {
    const current = new Map();
    for (const asset of ASSETS_TO_CACHE) {
        const base = hashedAssetBase(new URL(asset, self.location.origin).pathname);
        if (base) current.set(base, asset);
    }
    if (!current.size) return;

    const stale = [];
    for (const request of await cache.keys()) {
        const { pathname } = new URL(request.url);
        const base = hashedAssetBase(pathname);
        if (base && current.has(base) && current.get(base) !== pathname) {
            stale.push(request);
        }
    }
    await Promise.all(stale.map((request) => cache.delete(request)));
}

// 古いキャッシュを削除
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                // ビルドごとに名前を変えていた頃の shogi-web-<タイムスタンプ> を含む、別名のものは丸ごと削除
                return Promise.all(
                    cacheNames
                        .filter((cacheName) => cacheName !== CACHE_NAME)
                        .map((cacheName) => caches.delete(cacheName))
                );
            })
            // 名前を固定した分、中身の入れ替わりはここで面倒を見る
            .then(() => caches.open(CACHE_NAME))
            .then((cache) => pruneSupersededAssets(cache))
            .catch((error) => {
                console.warn('Failed to prune old assets:', error);
            })
            .then(() => {
                // すぐにコントロールを取得
                return self.clients.claim();
            })
    );
});

// フェッチリクエストを処理
self.addEventListener('fetch', (event) => {
    // オンライン対戦API (/api/*) はキャッシュ対象外（常にネットワークへ直行）
    if (new URL(event.request.url).pathname.startsWith('/api/')) {
        return;
    }

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
