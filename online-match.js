// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2026~ Yuki Lab
//
// だれかと対戦（マッチング）のクライアント。/online/ でだけ読み込まれる。
// shogi.js の後に defer で読み込まれ（build-pages.mjs が順序を保証）、
// shogi.js とは matchmakingBridge（グローバル）経由でだけ接続する。
// このファイルが無いページでも shogi.js 単体で完結する（tsumeBridge と同じ流儀）。
//
// 仕様は docs/online-matchmaking-spec.md。ここに無い判断は設計書に追記してから行う。

(function () {
    'use strict';

    // shogi.js が読み込まれていなければ何もしない（保険。通常は起こらない）
    if (typeof matchmakingBridge === 'undefined') return;

    const SEEK_MAX_SECONDS = 60;           // サーバーの60秒COMフォールバックと同じ値
    const MM_WS_PING_INTERVAL_MS = 10000;  // Matchmakerは対局WSと同じping/pong自動応答
    const FOUND_PAUSE_MS = 1500;           // 緑カードを見せる時間 = 対局WS接続を待つ時間
    const STATS_REFRESH_MS = 30000;
    const BOT_FALLBACK_KEY = 'shogi_bot_fallback'; // '0' = 60秒COMフォールバックを使わない（読むだけ。ON/OFFは詳細設定＝shogi.js が保存する）
    // ロビーの段級位カードを開いた瞬間に埋めるための控え。サーバーの値が来たら上書きする。
    // これが無いと、カードが空 → 値が入る、で数字が湧いて見える
    const RANK_CACHE_KEY = 'shogi_online_rank';

    const mm = {
        phase: 'lobby',      // 'lobby' | 'seeking' | 'found' | 'game'
        ws: null,
        pingTimer: null,
        countdownTimer: null,
        watchTimer: null,
        watchDeadline: null,
        seekStartedAt: 0,
        wsLostWhileHidden: false, // 裏に回っている間にキューWSが落ちた（復帰時に並び直す）
        serverClosed: false, // matched/bot/error を受信済み（closeを異常扱いしない）
        lastMatchType: null, // 直近に終局した対局の種類（「もう一度」の判定用）
        matchedFromQueue: false, // 計測用。いまの対局が待ち行列から来たか
        lastWaitSeconds: null,   // 計測用。相手が決まるまでに待った秒数
        statsTimer: null,
        noBotMode: false,    // フォールバックOFFで待機中（経過秒のカウントアップ表示）
        lastPlaying: 0,      // 最後に取得した対局中人数（解放直後の表示復元用）
        botTicket: null,     // COM戦の結果を1回だけ申告できる引換券（サーバー発行）
        rankFetched: false,  // 実力値を一度でも取りに行ったか
    };

    // ---- DOM --------------------------------------------------------------

    const els = {};
    function grabElements() {
        const $ = (id) => document.getElementById(id);
        els.cta = $('mm-cta');
        els.metaText = $('mm-cta-meta-text');
        els.pulse = $('mm-pulse');
        els.tutorial = $('mm-tutorial');
        els.nameInput = $('player-name');
        els.nameRow = $('name-row');
        els.nameHint = $('player-name-hint');
        els.seek = $('online-seek');
        els.seekTitleText = $('seek-title-text');
        els.seekDots = $('seek-dots');
        els.seekNote = $('seek-note');
        els.seekTimer = $('seek-timer');
        els.seekTimerValue = $('seek-timer-value');
        els.seekCancel = $('seek-cancel');
        els.seekIconSearch = $('seek-icon-search');
        els.seekIconCheck = $('seek-icon-check');
        els.rankCard = $('mm-rank-card');
        els.rankBadge = $('mm-rank-badge');
        els.rankName = $('mm-rank-name');
        els.rankRate = $('mm-rank-rate');
        els.rankFill = $('mm-rank-fill');
        els.rankNext = $('mm-rank-next');
        els.rankHide = $('mm-rank-hide');
        els.toastSlot = $('mm-toast-slot');
        els.waitTsumeBar = $('wait-tsume-bar');
        els.waitTsumeMoves = $('wait-tsume-moves');
        els.waitTsumeRemaining = $('wait-tsume-remaining');
    }

    // ---- 表示名 ------------------------------------------------------------

    const NAME_HINT_DEFAULT = '半角英数字のみ・10文字まで';
    const NAME_HINT_WARN_MS = 4500;
    const JP_CHARS = /[ぁ-んァ-ヶー一-龥々〆]/;

    function nfkc(value) {
        const s = String(value == null ? '' : value);
        try { return s.normalize('NFKC'); } catch (_) { return s; }
    }

    // 半角英数字と _ - . のみ・最大10文字（設計書 §5.1）。日本語は入力段階で落とす。
    // サーバー（src/worker/index.ts normalizeDisplayName）と同じ NFKC → 除去 → 10文字の順。
    // NFKC を先に掛けるのは全角英数「ＹＵＫＩ」を捨てずに「YUKI」として拾うため。
    // 保存キーと読み出しは shogi.js の getStoredPlayerName()（友達対戦と共通）
    function sanitizeName(value) {
        return nfkc(value).replace(/[^A-Za-z0-9_\-.]/g, '').slice(0, 10);
    }

    // 文字が落ちた理由（引数は NFKC 済み）。日本語入力が圧倒的に多い失敗なので専用の文言を出す
    function nameWarnText(normalized) {
        const dropped = normalized.replace(/[A-Za-z0-9_\-.]/g, '');
        if (!dropped) return '10文字までです';
        return JP_CHARS.test(dropped)
            ? '日本語は使えません（半角英数字のみ）'
            : 'その文字は使えません（半角英数字のみ）';
    }

    let nameHintTimer = 0;
    function setNameHint(text, warn) {
        if (els.nameHint) {
            els.nameHint.textContent = text;
            els.nameHint.classList.toggle('is-warn', !!warn);
        }
        if (els.nameRow) els.nameRow.classList.toggle('is-warn', !!warn);
        clearTimeout(nameHintTimer);
        // 戻すのはタイマーだけ（有効な入力で即座に戻すと、変換確定直後の input で
        // 警告が一瞬で消えてしまう。ブラウザによって compositionend と input の順が違う）
        if (warn) nameHintTimer = setTimeout(() => setNameHint(NAME_HINT_DEFAULT, false), NAME_HINT_WARN_MS);
    }

    // 整形と保存。IME の変換中には絶対に呼ばない（下の setupNameInput のコメント参照）
    function applyNameFilter() {
        const input = els.nameInput;
        const normalized = nfkc(input.value);
        const cleaned = sanitizeName(normalized);
        if (input.value !== cleaned) input.value = cleaned;
        // 警告は文字が本当に落ちたときだけ。全角英数「ＹＵＫＩ」→「YUKI」は落としていない
        if (normalized !== cleaned) setNameHint(nameWarnText(normalized), true);
        try { localStorage.setItem(PLAYER_NAME_KEY, cleaned); } catch (_) { /* ignore */ }
    }

    function setupNameInput() {
        const input = els.nameInput;
        if (!input) return;
        input.value = getStoredPlayerName() || '';
        // 日本語変換の途中でも input は発火する（isComposing = true）。そこで value を
        // 書き換えると変換中の文字が消えて IME が壊れる（打っても何も出ない）ので、
        // 変換が確定してから整形する。blur は「変換したままCTAを押した」場合の保険
        let composing = false;
        input.addEventListener('compositionstart', () => { composing = true; });
        input.addEventListener('compositionend', () => { composing = false; applyNameFilter(); });
        input.addEventListener('input', (e) => {
            if (composing || e.isComposing) return;
            applyNameFilter();
        });
        input.addEventListener('blur', applyNameFilter);
    }

    // ---- 「N人が対局中」 ----------------------------------------------------

    // 人数の取得口に実力値を相乗りさせる（通信を1本増やさないため）。
    // 🔴 uid を付けるのは「初回」と「対局が終わった直後」だけ。30秒ごとのポーリング
    //    全部に付けると、ロビーを開いているだけでD1の読みが延々と走る
    async function refreshStats({ withRating = false } = {}) {
        const wantRating = withRating || !mm.rankFetched;
        let url = ONLINE_API_BASE + '/online-stats';
        if (wantRating) {
            const uid = getOnlineUid();
            if (uid) url += '?uid=' + encodeURIComponent(uid);
        }
        try {
            const res = await fetch(url, { cache: 'no-store' });
            const json = await res.json();
            applyStats(json && typeof json.playing === 'number' ? json.playing : 0);
            if (json && json.rating) {
                mm.rankFetched = true;
                applyRankView(json.rating);
            }
        } catch (_) {
            applyStats(0); // 失敗してもロビーを壊さない（0人表示 = 人数行を出さない）
        }
    }

    // ---- 自分の段級位カード --------------------------------------------------

    function readCachedRank() {
        try {
            const raw = localStorage.getItem(RANK_CACHE_KEY);
            const view = raw ? JSON.parse(raw) : null;
            return view && typeof view.rank === 'number' ? view : null;
        } catch (_) {
            return null;
        }
    }

    function applyRankView(view) {
        if (!view || typeof view.rank !== 'number' || !els.rankCard) return;
        // 控えは非表示中でも更新しておく（戻したときに古い数字を出さないため）
        try {
            localStorage.setItem(RANK_CACHE_KEY, JSON.stringify(view));
        } catch (_) { /* 容量不足などは無視。表示には影響しない */ }
        if (isRankHidden()) return;

        renderRankBadgeInto(els.rankBadge, view.rank, 'koma');
        if (els.rankName) els.rankName.textContent = view.rankLabel || '';
        if (els.rankRate) els.rankRate.textContent = String(view.rating);
        if (els.rankFill) {
            els.rankFill.style.width = Math.round((view.progress || 0) * 100) + '%';
        }
        if (els.rankNext) {
            els.rankNext.textContent = view.nextLabel
                ? view.nextLabel + 'まで あと' + view.pointsToNext
                : '最高位';
        }
        // 結果ダイアログの段位カードが出ていれば、次までのゲージもここで埋める。
        // ゲージの値は対局データに入っていないので、この返事だけが持っている
        applyResultRankProgress(view);
    }

    /** 控えにある自分の段級位。まだ何も無ければ 5級 */
    function cachedRankIndex() {
        const cached = readCachedRank();
        return cached ? cached.rank : 4;
    }

    // 開いた瞬間は前回の値をそのまま出す（数字が湧いて見えないように）
    function primeRankCard() {
        if (isRankHidden()) return; // カードは <html class="rank-hidden"> で最初から消えている
        const cached = readCachedRank();
        if (cached) applyRankView(cached);
        else if (els.rankBadge) renderRankBadgeInto(els.rankBadge, 4, 'koma'); // 5級
    }

    // ---- 段位カードの×とトースト ---------------------------------------------
    // 🔴 トーストは高さ0の入れ物に absolute で浮かせる。画面下に固定すると
    //    PCのアンカー広告に重なるうえ、消えたときにレイアウトが動く。

    const HIDE_TOAST_MS = 5000;
    let hideToastTimer = null;

    function clearHideToast() {
        if (hideToastTimer) clearTimeout(hideToastTimer);
        hideToastTimer = null;
        if (!els.toastSlot) return;
        // 消す前に、トーストの中にフォーカスが残っていたら逃がす
        // （消えた要素にフォーカスが残るとTabがページ先頭に戻ってしまう）
        if (els.toastSlot.contains(document.activeElement) && els.cta) {
            els.cta.focus({ preventScroll: true });
        }
        els.toastSlot.textContent = '';
    }

    function showHideToast() {
        if (!els.toastSlot) return;
        clearHideToast();

        // 🔴 role="status" は入れ物（#mm-toast-slot）側に置いてある。
        //    組み立て終わった要素ごと挿すと「変化」と見なされず読み上げられないため
        const toast = document.createElement('div');
        toast.className = 'mm-toast';

        const text = document.createElement('span');
        const title = document.createElement('b');
        title.textContent = '段級位を非表示にしました';
        const sub = document.createElement('i');
        sub.textContent = '右上の詳細設定から戻せます';
        text.appendChild(title);
        text.appendChild(sub);

        const undo = document.createElement('button');
        undo.type = 'button';
        undo.textContent = '元に戻す';
        undo.addEventListener('click', () => {
            clearHideToast();
            setRankHidden(false);
            track('rank_visibility', { hidden: 0, from: 'undo' });
        });

        toast.appendChild(text);
        toast.appendChild(undo);
        els.toastSlot.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('visible'));
        // ×は今この瞬間に消えた要素なので、フォーカスを「元に戻す」へ移しておく
        undo.focus({ preventScroll: true });
        hideToastTimer = setTimeout(clearHideToast, HIDE_TOAST_MS);
    }

    // 詳細設定から戻したときはカードを埋め直す（非表示のあいだ描画を飛ばしているため）。
    // 控えは隠れているあいだも applyRankView が更新しているので、これだけで数字は最新
    matchmakingBridge.onRankHiddenChange = (hidden) => {
        if (hidden) return;
        clearHideToast();
        primeRankCard();
    };

    function applyStats(playing) {
        if (!els.metaText || !els.pulse) return;
        const n = Math.max(0, Math.floor(Number(playing) || 0));
        mm.lastPlaying = n;
        // 未解放のCTAは「チュートリアルをクリアで解放」を優先表示する
        if (!isMatchmakingUnlocked()) return;
        if (n >= 1) {
            els.metaText.innerHTML = '<b>' + n + '</b>人が対局中 ・ 一手30秒';
            els.pulse.hidden = false;
        } else {
            // 0人のときは人数の行を出さない（逆効果なので）
            els.metaText.textContent = '一手30秒';
            els.pulse.hidden = true;
        }
    }

    // ---- 状態遷移 ----------------------------------------------------------

    function setPhase(phase) {
        mm.phase = phase;
        const onBoard = phase === 'seeking' || phase === 'found';
        document.body.classList.toggle('online-seeking', onBoard);
        if (typeof updateOnlineUiState === 'function') updateOnlineUiState();
    }

    matchmakingBridge.isSeeking = () => mm.phase === 'seeking' || mm.phase === 'found';

    // ---- 計測 ---------------------------------------------------------------
    // 対局成立そのものは shogi.js の trackOnlineMatchFound が数える。ここは
    // 「その対局がどこから来たのか」と「どれだけ待ったのか」を答える係。

    /** ローカル対局（COM戦・チュートリアル）は 'bot'、待ち行列から来たなら 'random' */
    matchmakingBridge.matchKind = () => {
        if (local.active) return 'bot';
        if (mm.matchedFromQueue) return 'random';
        return 'invite';
    };

    /** 待った秒数の段階。だれかと対戦だけが持つ（招待対局には待ち行列が無い） */
    matchmakingBridge.waitBucket = () => {
        if (!mm.matchedFromQueue && !local.active) return null;
        if (!mm.lastWaitSeconds && mm.lastWaitSeconds !== 0) return null;
        const s = mm.lastWaitSeconds;
        if (s < 15) return '0-15s';
        if (s < 30) return '15-30s';
        if (s < 60) return '30-60s';
        return '60s+';
    };

    /** 相手が決まった瞬間に、待った秒数を確定させる */
    function markMatchedFromQueue(fromQueue) {
        mm.matchedFromQueue = fromQueue;
        mm.lastWaitSeconds = mm.seekStartedAt
            ? Math.round((Date.now() - mm.seekStartedAt) / 1000)
            : null;
    }

    // 部屋を離れたら忘れる。持ち越すと、次に作った招待対局が
    // 「待ち行列から来た対局」として数えられてしまう
    matchmakingBridge.onLeaveRoom = () => {
        mm.matchedFromQueue = false;
        mm.lastWaitSeconds = null;
    };

    // ---- 待機カード ---------------------------------------------------------

    // SVG要素に .hidden プロパティは無い（HTMLElementだけ）ので属性で切り替える
    function setSvgHidden(el, hide) {
        if (!el) return;
        if (hide) el.setAttribute('hidden', '');
        else el.removeAttribute('hidden');
    }

    function showSeekUi() {
        if (!els.seek) return;
        els.seek.classList.remove('is-found');
        setSvgHidden(els.seekIconSearch, false);
        setSvgHidden(els.seekIconCheck, true);
        if (els.seekTitleText) els.seekTitleText.textContent = '対戦相手を探しています';
        if (els.seekDots) els.seekDots.style.display = '';
        // フォールバックOFFの人には終わりの時刻を約束できないので文言と秒の意味を変える
        if (els.seekNote) {
            els.seekNote.textContent = mm.noBotMode
                ? '見つかりしだい自動で始まります'
                : '最長60秒で始まります';
        }
        if (els.seekTimer) els.seekTimer.style.display = '';
        if (els.seekCancel) els.seekCancel.style.display = '';
        els.seek.hidden = false;
    }

    function showFoundUi(opponentName, opponentRank) {
        if (!els.seek) return;
        els.seek.classList.add('is-found');
        setSvgHidden(els.seekIconSearch, true);
        setSvgHidden(els.seekIconCheck, false);
        if (els.seekTitleText) els.seekTitleText.textContent = '対戦相手が見つかりました！';
        if (els.seekDots) els.seekDots.style.display = 'none';
        if (els.seekNote) {
            const text = opponentName
                ? opponentName + ' さんと対局を始めます'
                : 'まもなく対局を始めます';
            // 相手は実力値の数値を出さず段級位だけ。名前は textContent で入れる
            els.seekNote.textContent = '';
            const badge = createRankBadge(opponentRank, 'pill');
            if (badge) els.seekNote.appendChild(badge);
            els.seekNote.appendChild(document.createTextNode(text));
        }
        if (els.seekTimer) els.seekTimer.style.display = 'none';
        if (els.seekCancel) els.seekCancel.style.display = 'none';
    }

    function hideSeekUi() {
        if (els.seek) els.seek.hidden = true;
    }

    function startCountdown() {
        stopCountdown();
        mm.seekStartedAt = Date.now();
        updateCountdown();
        mm.countdownTimer = setInterval(updateCountdown, 250);
    }

    function updateCountdown() {
        if (!els.seekTimerValue) return;
        const elapsed = Math.floor((Date.now() - mm.seekStartedAt) / 1000);
        els.seekTimerValue.textContent = mm.noBotMode
            ? String(elapsed) // フォールバックOFF: 経過秒のカウントアップ
            : String(Math.max(0, SEEK_MAX_SECONDS - elapsed));
    }

    function stopCountdown() {
        if (mm.countdownTimer) {
            clearInterval(mm.countdownTimer);
            mm.countdownTimer = null;
        }
    }

    // ---- 待機キュー（WebSocket） --------------------------------------------

    function isBotFallbackEnabled() {
        try { return localStorage.getItem(BOT_FALLBACK_KEY) !== '0'; } catch (_) { return true; }
    }

    function queueWsUrl() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const params = new URLSearchParams({ uid: getOnlineUid() });
        const name = getStoredPlayerName();
        if (name) params.set('name', name);
        if (!isBotFallbackEnabled()) params.set('bot', '0');
        // 相手に自分の段級位を渡さない。サーバーはこれを見て相手側の値を null にする
        if (isRankHidden()) params.set('hr', '1');
        return proto + '://' + location.host + ONLINE_API_BASE + '/match/ws?' + params.toString();
    }

    async function beginSeek() {
        if (mm.phase === 'seeking' || mm.phase === 'found') return;
        // 並んだ数。成立数と並べると「並んだのに対局に至らなかった」割合が出る
        track('match_seek', {});
        exitLocalMatch();
        // 先に待機状態を立てる: 部屋から抜ける処理の中の updateOnlineUiState が
        // ロビー（盤を隠す状態）へ戻してしまうのを防ぐ
        setPhase('seeking');
        mm.noBotMode = !isBotFallbackEnabled();
        if (onlineState.roomCode || onlineState.match) {
            // 「もう一度」経由: 前の部屋（ローカル対局含む）から抜けてから並ぶ（盤も初期化される）
            try { await onlineLeaveRoom({ resignIfActive: false }); } catch (_) { /* ignore */ }
        }
        showSeekUi();
        startCountdown();
        openQueueWs();
        // 待ち時間の腕試し（詰めチャレンジ）。取得できなければ盤なしで待機を続ける
        ensureChallengeData().then(() => {
            if (mm.phase === 'seeking') startTsumeChallenge();
        });
    }

    // 画面に戻ってきたとき、待機中なのにソケットが無ければ黙って並び直す。
    // サーバー側の待ち時間はやり直しになるので、カウントダウンも仕切り直す
    function handleVisibilityRequeue() {
        if (document.visibilityState !== 'visible') return;
        if (mm.phase !== 'seeking') return;
        const wsAlive = mm.ws && mm.ws.readyState === WebSocket.OPEN;
        if (wsAlive || !mm.wsLostWhileHidden) return;
        mm.wsLostWhileHidden = false;
        startCountdown();
        openQueueWs();
    }

    function openQueueWs() {
        closeQueueWs(false);
        mm.serverClosed = false;
        mm.wsLostWhileHidden = false;
        let ws;
        try {
            ws = new WebSocket(queueWsUrl());
        } catch (_) {
            exitToLobby('通信を開始できませんでした。時間をおいてお試しください。');
            return;
        }
        mm.ws = ws;
        ws.onopen = () => startQueuePing();
        ws.onmessage = (ev) => {
            if (typeof ev.data !== 'string' || ev.data === 'pong') return;
            let msg = null;
            try { msg = JSON.parse(ev.data); } catch (_) { return; }
            handleQueueMessage(msg);
        };
        ws.onclose = (ev) => {
            if (mm.ws !== ws) return;
            mm.ws = null;
            stopQueuePing();
            // matched/bot/error の後の close は正常系。それ以外は接続断
            if (mm.serverClosed || mm.phase !== 'seeking') return;
            if (ev && ev.code === 4000) {
                // 別のタブで探し始めたので置き換えられた（サーバーのsuperseded）。
                // このタブは静かにロビーへ戻すだけにする
                exitToLobby(null);
                return;
            }
            if (document.visibilityState === 'hidden') {
                // モバイルはタブ切替・画面ロックでソケットが落ちる（対局WSと同じ事情）。
                // 待機状態は保ち、画面に戻ってきたときに黙って並び直す
                mm.wsLostWhileHidden = true;
                return;
            }
            exitToLobby('通信が切れました。もう一度お試しください。');
        };
        ws.onerror = () => { /* onclose に任せる */ };
    }

    function startQueuePing() {
        stopQueuePing();
        mm.pingTimer = setInterval(() => {
            if (!mm.ws || mm.ws.readyState !== WebSocket.OPEN) return;
            try { mm.ws.send('ping'); } catch (_) { /* ignore */ }
        }, MM_WS_PING_INTERVAL_MS);
    }

    function stopQueuePing() {
        if (mm.pingTimer) {
            clearInterval(mm.pingTimer);
            mm.pingTimer = null;
        }
    }

    function closeQueueWs(markServerClosed) {
        stopQueuePing();
        const ws = mm.ws;
        mm.ws = null;
        if (ws) {
            if (markServerClosed) mm.serverClosed = true;
            try { ws.close(); } catch (_) { /* ignore */ }
        }
    }

    function handleQueueMessage(msg) {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'queued') {
            if (typeof msg.playing === 'number') applyStats(msg.playing);
            return;
        }
        if (msg.type === 'matched') {
            mm.serverClosed = true;
            onMatched(msg);
            return;
        }
        if (msg.type === 'bot') {
            mm.serverClosed = true;
            onBotFallback(typeof msg.ticket === 'string' ? msg.ticket : null);
            return;
        }
        if (msg.type === 'error') {
            mm.serverClosed = true;
            exitToLobby(queueErrorText(msg.error && msg.error.code));
        }
    }

    function queueErrorText(code) {
        if (code === 'queue_timeout') return '相手が見つかりませんでした。時間をおいてお試しください。';
        if (code === 'match_failed') return 'マッチングに失敗しました。もう一度お試しください。';
        if (code === 'rate_limited') return '接続が多すぎます。少し待ってからお試しください。';
        return 'エラーが発生しました。もう一度お試しください。';
    }

    // 60秒相手が見つからなかった → そのままローカルのCOM戦へ（設計書 §6.6）。
    // 表示は相手名が「COM」になるだけ。専用バナー・ダイアログは出さない
    function onBotFallback(ticket) {
        markMatchedFromQueue(false); // 待ち行列は経由したが相手は人ではない
        mm.botTicket = ticket;
        startLocalMatch({ opponentName: 'COM', tutorial: false });
    }

    // ---- ローカル対局（COMフォールバック / チュートリアル） --------------------
    // オンラインUI一式（手番ガード・時計・開始演出・状態文言・盤反転）は
    // onlineState.match 駆動の表示ロジックなので、ローカルで組んだ MatchPayload を
    // applyOnlineMatch に1回通せばそのまま動く。以降の進行はこのドライバが担い、
    // 指し手は shogi.js の onlineSubmitMove / onlineResign 先頭のフックで受け取る。
    // 安全弁: onlineState.token を絶対に null に保つ（WS・ポーリング・投了APIの
    // 全ネットワーク経路が token ガードで止まり、偽の部屋がサーバーへ漏れない）

    const LOCAL_ROOM_CODE = 'LOCAL';
    const LOCAL_TC_SECONDS = 30;
    const LOCAL_START_BUFFER_MS = 5000; // サーバーの MATCH_START_BUFFER_MS と同じ体感
    const COM_MOVE_DELAY_MS = 700;      // COMの応手の間（即指しは対局の感じが出ない）

    const local = {
        active: false,
        tutorial: false,
        playerSide: null,
        comSide: null,
        worker: null,
        reqId: 0,
        joseki: { pattern: null, index: 0 },
        tutorialLevel: 0, // TUTORIAL_LEVELS のインデックス。緩む方向にしか動かない（対局中は戻さない）
        deadlineTimer: null,
        comDelayTimer: null,
    };

    function localSideRandom() {
        return (crypto.getRandomValues(new Uint8Array(1))[0] & 1) === 1 ? SENTE : GOTE;
    }

    // initializeBoard() 直後のグローバル局面から MatchPayload を組む
    function buildLocalMatchPayload(playerSide, opponentName, tutorial) {
        const now = Date.now();
        return {
            room_code: LOCAL_ROOM_CODE,
            created_at: new Date(now).toISOString(),
            expires_at: new Date(now + 24 * 3600 * 1000).toISOString(),
            sente_joined: true,
            gote_joined: true,
            sente_name: playerSide === SENTE ? getStoredPlayerName() : opponentName,
            gote_name: playerSide === GOTE ? getStoredPlayerName() : opponentName,
            state: {
                board: deepCopyBoard(board),
                capturedPieces: deepCopyCaptured(capturedPieces),
                currentPlayer: currentPlayer,
                moveCount: moveCount,
                lastMove: null,
                isCheck: false,
                usiMoveHistory: [],
            },
            revision: 0,
            game_over: false,
            winner: null,
            result_reason: null,
            disconnect_side: null,
            disconnect_deadline: null,
            side_pref: 'random',
            match_type: 'matchmaking',
            // 自分の段級位だけ出す（COM側は段級位を持たないので null のまま）。
            // 値は前回サーバーから受け取った控え。COM戦は結果を出すまで実力値が動かないので
            // 対局中はこれで正しい。
            // 🔴 チュートリアルは実力値対象外なので出さない（出すと「この対局も数えられる」と誤解させる）
            sente_rank: !tutorial && playerSide === SENTE ? cachedRankIndex() : null,
            gote_rank: !tutorial && playerSide === GOTE ? cachedRankIndex() : null,
            sente_rating: null,
            gote_rating: null,
            sente_rating_delta: null,
            gote_rating_delta: null,
            sente_promoted: null,
            gote_promoted: null,
            tc_type: 'per_move',
            tc_seconds: LOCAL_TC_SECONDS,
            sente_time_ms: null,
            gote_time_ms: null,
            turn_deadline: new Date(now + LOCAL_START_BUFFER_MS + LOCAL_TC_SECONDS * 1000).toISOString(),
            server_now: new Date(now).toISOString(),
        };
    }

    function startLocalMatch({ opponentName, tutorial }) {
        closeQueueWs(true);
        stopCountdown();
        stopWatchTimer();
        stopTsumeChallenge();
        hideSeekUi();

        initializeBoard(); // 待機中の詰めチャレンジで動いた盤を初期局面へ戻す

        local.active = true;
        local.tutorial = Boolean(tutorial);
        local.playerSide = localSideRandom();
        local.comSide = local.playerSide === SENTE ? GOTE : SENTE;
        local.joseki = { pattern: null, index: 0 };
        local.tutorialLevel = 0; // 対局ごとにリセット
        local.reqId += 1; // 前局の応答を無効化

        onlineState.token = null; // 念押し。ローカル対局中は絶対に null
        onlineState.roomCode = LOCAL_ROOM_CODE;
        applyOnlineMatch(buildLocalMatchPayload(local.playerSide, opponentName, local.tutorial), {
            source: 'local',
            roomEpoch: onlineState.roomEpoch,
            expectedRoomCode: LOCAL_ROOM_CODE,
            disconnect: null,
            yourSide: local.playerSide,
        });
        setPhase('game');
        armLocalDeadline();
        if (currentPlayer === local.comSide) scheduleComMove();
    }

    function exitLocalMatch() {
        if (!local.active) return;
        clearLocalTimers();
        local.reqId += 1; // 飛んでいる思考依頼の応答を無効化
        local.active = false;
    }

    function clearLocalTimers() {
        if (local.deadlineTimer) { clearTimeout(local.deadlineTimer); local.deadlineTimer = null; }
        if (local.comDelayTimer) { clearTimeout(local.comDelayTimer); local.comDelayTimer = null; }
    }

    // 一手ごとの持ち時間。サーバーの flag-fall と同じく、超えたら手番側の負け
    function armLocalDeadline() {
        if (local.deadlineTimer) { clearTimeout(local.deadlineTimer); local.deadlineTimer = null; }
        const fake = onlineState.match;
        const deadline = fake && fake.turn_deadline ? Date.parse(fake.turn_deadline) : NaN;
        if (!Number.isFinite(deadline)) return;
        const mover = currentPlayer;
        local.deadlineTimer = setTimeout(() => {
            local.deadlineTimer = null;
            if (!local.active || gameOver) return;
            if (currentPlayer !== mover) return; // すでに指されている
            localEndGame(mover === SENTE ? GOTE : SENTE, 'timeout');
        }, Math.max(0, deadline - Date.now()) + 250);
    }

    // プレイヤー・COM どちらかの一手が盤に適用されたあとの共通処理
    function afterLocalPly() {
        if (!local.active) return;
        const fake = onlineState.match;
        if (!fake) return;
        if (gameOver) {
            // 詰み・千日手は finalizeMove がダイアログまで出している。メタデータだけ揃える
            const won = (typeof checkmate !== 'undefined' && checkmate)
                ? getOpponent(currentPlayer)
                : null;
            localEndGame(won, won ? 'checkmate' : 'sennichite', { dialogAlreadyShown: true });
            return;
        }
        // 直前に指したのがユーザーで、残り10秒を切っていたら弱める（時間に追われている救済）。
        // 判定は turn_deadline を次の手番用に更新する前に行う
        if (local.tutorial && currentPlayer === local.comSide) {
            const prevDeadline = fake.turn_deadline ? Date.parse(fake.turn_deadline) : NaN;
            if (Number.isFinite(prevDeadline) && prevDeadline - Date.now() < TUTORIAL_TIME_PRESSURE_MS) {
                easeTutorialLevel(TUTORIAL_TIME_PRESSURE_LEVEL);
            }
        }
        fake.turn_deadline = new Date(Date.now() + LOCAL_TC_SECONDS * 1000).toISOString();
        fake.server_now = new Date().toISOString();
        updateOnlineUiState();
        armLocalDeadline();
        if (currentPlayer === local.comSide) scheduleComMove();
    }

    function localEndGame(winner, reason, { dialogAlreadyShown = false } = {}) {
        if (!local.active) return;
        clearLocalTimers();
        local.reqId += 1;
        gameOver = true;
        const fake = onlineState.match;
        if (fake) {
            fake.game_over = true;
            fake.winner = winner ?? 'draw';
            fake.result_reason = reason || fake.result_reason;
            fake.turn_deadline = null;
        }
        updateOnlineUiState();
        if (!dialogAlreadyShown) {
            const label = winner === SENTE ? '先手' : winner === GOTE ? '後手' : '引き分け';
            showGameOverDialog(label, mapResultReason(reason));
        }
        if (local.tutorial) {
            onTutorialEnd(winner);
        } else {
            // 「もう一度」= 再キュー（COM戦もマッチングの一部として扱う）
            mm.lastMatchType = 'matchmaking';
            setNewGameLabel('もう一度対戦する');
            reportBotResult(winner);
        }
    }

    // ---- COM戦の結果をサーバーへ申告 -------------------------------------------
    // サーバーはこの対局を一切見ていないので、勝ちを申告するときは棋譜を丸ごと送り、
    // サーバー側で初手から並べ直して本当に詰みかを確かめてもらう（src/worker/bot_result.ts）。
    // 券は「60秒待ってCOMに切り替わった人」にしか出ないので、1人60秒に1枚が上限。

    function reportBotResult(winner) {
        const ticket = mm.botTicket;
        mm.botTicket = null; // 1局につき1回。失敗しても撃ち直さない
        if (!ticket || local.tutorial) return;

        const side = local.playerSide === SENTE ? 'sente' : 'gote';
        const result = winner === local.playerSide
            ? 'win'
            : winner === local.comSide ? 'lose' : 'draw';
        // 勝ちの申告だけ棋譜を付ける（負け・引き分けは自己申告のまま受けてもらう）。
        // 🔴 kifuAllMoves() を使う。ローカル対局の手は usiMoveHistory 側に溜まる
        const body = {
            ticket,
            side,
            result,
            difficulty: getStandardAiDifficulty(aiDifficulty),
        };
        if (result === 'win') body.moves = kifuAllMoves();

        fetch(ONLINE_API_BASE + '/bot-result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => {
                if (!json || !json.ok || !json.outcome) return;
                const outcome = json.outcome;
                applyRankView(outcome.rating);
                if (!outcome.rated) return; // 初段以上の凍結・1日の上限。数字は動かさない
                // ダイアログは先に出ているので、返事が来た時点で段位カードを足す。
                // 第2引数まで渡すとゲージも一度に埋まる（人対人と違い1往復で全部そろう）
                renderResultRating({
                    rating: outcome.rating.rating,
                    delta: outcome.ratingDelta,
                    rank: outcome.rating.rank,
                    promotedTo: outcome.promotedTo,
                }, outcome.rating);
            })
            .catch(() => { /* 実力値が付かないだけ。対局結果はもう出ている */ });
    }

    // ---- COMの思考（/online/ では shogi.js が aiWorker を作らないので自前で持つ） ----

    function ensureComWorker() {
        if (local.worker) return local.worker;
        let worker;
        try {
            worker = new Worker('/ai-worker.js');
        } catch (_) {
            return null;
        }
        worker.onmessage = (e) => {
            const { type, data } = (e && e.data) || {};
            if (type !== 'bestMove' || !data) return;
            if (!local.active || data.requestId !== local.reqId) return; // 古い応答
            local.joseki = {
                pattern: data.currentJosekiPattern ?? null,
                index: data.josekiMoveIndex ?? 0,
            };
            if (gameOver || currentPlayer !== local.comSide) return;
            if (data.move) {
                executeAIMove(data.move);
                afterLocalPly();
            } else {
                // COMに合法手が無い = 詰まされている。プレイヤーの勝ち
                localEndGame(local.playerSide, 'checkmate');
            }
        };
        worker.onerror = () => { /* 応答が来なければ手番の時間切れ処理が拾う */ };
        local.worker = worker;
        return worker;
    }

    function scheduleComMove() {
        if (local.comDelayTimer) clearTimeout(local.comDelayTimer);
        local.comDelayTimer = setTimeout(() => {
            local.comDelayTimer = null;
            requestComMove();
        }, COM_MOVE_DELAY_MS);
    }

    function requestComMove() {
        if (!local.active || gameOver || currentPlayer !== local.comSide) return;
        const worker = ensureComWorker();
        if (!worker) {
            // Workerを作れない環境ではCOM戦が成立しない。相手の投了扱いで終える
            localEndGame(local.playerSide, 'disconnect');
            return;
        }
        local.reqId += 1;
        // チュートリアルは、その時点の形勢でエンジンのパラメータを決める（§6.7）。
        // COM戦の強さは「最後に選んだAI難易度」。yaneuraou級は超級に丸める（§6.6）
        const tuning = local.tutorial ? tutorialParams() : null;
        worker.postMessage({
            type: 'getBestMove',
            data: {
                board,
                capturedPieces,
                currentPlayer,
                moveCount,
                lastMoveDetail,
                aiDifficulty: tuning ? tuning.difficulty : getStandardAiDifficulty(aiDifficulty),
                benchmarkRandomness: tuning ? tuning.randomness : 0,
                aiPlayer: local.comSide,
                josekiEnabled: !local.tutorial,
                currentJosekiPattern: local.joseki.pattern,
                josekiMoveIndex: local.joseki.index,
                requestId: local.reqId,
            },
        });
    }

    matchmakingBridge.interceptMove = (move) => {
        // 待機中の詰めチャレンジが盤を使っている間はそちらの判定へ
        if (matchmakingBridge.claimsBoard?.()) {
            handleTsumeChallengeMove(move);
            return true;
        }
        if (!local.active) return false;
        if (gameOver || currentPlayer !== local.playerSide) return true; // 念のため握りつぶす
        executeAIMove(move); // 名前はAIだが「検証済みの手を盤へ適用する」共通実行器
        afterLocalPly();
        return true;
    };

    matchmakingBridge.interceptResign = () => {
        if (!local.active) return false;
        if (!gameOver) localEndGame(local.comSide, 'resign');
        return true;
    };

    // ---- チュートリアル（設計書 §6.7） --------------------------------------
    // オンライン対戦と同じ画面・同じ時計・同じ開始演出のローカル対局。
    // ルール説明はしない。「手加減します」等の文言もUIに一切出さない。

    // チュートリアルの手加減は、AI対戦と同じエンジン（ai-worker.js）に渡すパラメータだけで作る。
    // 使うのは既存の2つのノブ:
    //   aiDifficulty        … 読みの深さ（easy=1手 / medium=2手 / hard=3手先）
    //   benchmarkRandomness … 最善から (値×2) 点以内の手からランダムに選ぶ。
    //                         0 のときだけエンジン側の既定のブレ（深さ3未満なら6割の確率で
    //                         上位5手からランダム・ai-worker.js の maxDepth<3 の分岐）が働くので、
    //                         「easy + 0」は AI対戦の「初級」とまったく同じ挙動になる
    // 駒の点数はエンジン側の評価値と同じ尺度（歩100・銀500・金600・角800・飛900）。
    // 🟡 しきい値は実プレイ調整前提（設計書 §6.7 / §14）
    // 調整は「ユーザーが劣勢のときだけ緩める」一方向。
    // ユーザーがリードしても強くはならない（追い上げは廃止）
    // ⚠️ randomness と強さの関係は「谷型」で、単調ではない。値を下げる＝弱くする、ではない。
    // randomness>0 は「最善から `値×2` 点以内」の足切りフィルタなので、
    // 値が小さいうちは悪手に上限がかかって逆に手が安定する＝強くなる。
    // 値を極端に上げて初めて足切りが効かなくなり、最善手にこだわらなくなって弱くなる。
    // 自己対戦の実測（各60局・先後入替え。easy:0 から見た勝率）:
    //   medium:40 → 0% / easy:100 → 0% / easy:200 → 3% / easy:500 → 35%   ここまで easy:0 より強い
    //   easy:600 → 73% / easy:700 → 86% / easy:1400 → 100%                ここから弱い
    // 反転点は 500〜600 の間なので、緩和側は余裕を持って 700 以上を使う。
    // （ai-worker.js のコメントは randomness を 1〜100 と書いているが、実装は `値×2` を点数の
    //   しきい値にしているだけなので、この範囲外の値でもそのまま機能する）
    const TUTORIAL_LEVELS = [
        // ユーザーの駒得がこの値以上なら、この設定を使う（上から順に判定）
        { minDiff: -300, difficulty: 'easy', randomness: 0 },    // 互角〜ユーザー優勢 → AI対戦の「初級」と同じ
        { minDiff: -800, difficulty: 'easy', randomness: 700 },  // 劣勢 → 緩める（初級が86%勝つ強さ）
        { minDiff: -Infinity, difficulty: 'easy', randomness: 1400 }, // 大劣勢 → 底まで緩める（初級が100%勝つ強さ）
    ];

    // ユーザーが持ち時間（1手30秒）の残り10秒を切って指したら、駒得に関係なくここまで落とす
    const TUTORIAL_TIME_PRESSURE_MS = 10000;
    const TUTORIAL_TIME_PRESSURE_LEVEL = 1; // easy / randomness 700

    // 手数が伸びたら、駒得に関係なく緩める。
    // 駒得で勝っていても寄せきれずに長引く＝苦戦しているサインなので、駒得だけの判定を補う。
    // 単位は手数（ply・両者の指し手の合計）
    const TUTORIAL_LONG_GAME_STEPS = [
        { plies: 60, level: 1 },  // 双方30手ずつ指しても決まらない
        { plies: 110, level: 2 }, // まだ終わらない → 駒を渡す
    ];

    // 弱くする方向にだけレベルを動かす（対局中は元に戻さない）
    function easeTutorialLevel(index) {
        if (index > local.tutorialLevel) local.tutorialLevel = index;
    }

    // 形勢判定用の駒価値。ai-worker.js の PIECE_VALUES と同じ尺度にそろえてある
    // （玉は勝敗そのものなので数えない）
    const PIECE_VALUES = {
        FU: 100, KY: 400, KE: 400, GI: 500, KI: 600, KA: 800, HI: 900, OU: 0,
        '+FU': 650, '+KY': 650, '+KE': 650, '+GI': 650, '+KA': 1000, '+HI': 1100,
    };

    // side 視点の駒得（正 = side が優勢）。盤上と持ち駒を合算する
    function materialDiff(side) {
        let diff = 0;
        for (let y = 0; y < 9; y++) {
            for (let x = 0; x < 9; x++) {
                const p = board[y][x];
                if (!p) continue;
                const v = PIECE_VALUES[p.type] || 0;
                diff += p.owner === side ? v : -v;
            }
        }
        for (const owner of [SENTE, GOTE]) {
            const hand = capturedPieces[owner] || {};
            for (const t of Object.keys(hand)) {
                const v = (PIECE_VALUES[t] || 0) * (hand[t] || 0);
                diff += owner === side ? v : -v;
            }
        }
        return diff;
    }

    // その局面の形勢と手数から、エンジンに渡すパラメータを決める。
    // 狙いは「ユーザーがやや優勢のまま終盤に入る」こと。
    // 一度緩めたらその対局中は戻さない（追いついた瞬間に強くなる＝追い上げ、を避ける）
    function tutorialParams() {
        const diff = materialDiff(local.playerSide); // 正 = ユーザーが駒得
        let idx = TUTORIAL_LEVELS.findIndex((lv) => diff >= lv.minDiff);
        if (idx < 0) idx = TUTORIAL_LEVELS.length - 1;
        easeTutorialLevel(idx);
        for (const step of TUTORIAL_LONG_GAME_STEPS) {
            if (moveCount >= step.plies) easeTutorialLevel(step.level);
        }
        return TUTORIAL_LEVELS[local.tutorialLevel];
    }

    async function startTutorial() {
        if (mm.phase === 'seeking' || mm.phase === 'found') return;
        // 待ち行列を経由していないので、前回の待ち時間を持ち越さないようにする
        mm.seekStartedAt = 0;
        markMatchedFromQueue(false);
        exitLocalMatch();
        if (onlineState.roomCode || onlineState.match) {
            try { await onlineLeaveRoom({ resignIfActive: false }); } catch (_) { /* ignore */ }
        }
        // 相手の表示名は 'COM'。チュートリアルの相手は手加減したCOMそのものなので、
        // 対局者バーや終局ダイアログでは COMフォールバックと同じ呼び方にそろえる
        startLocalMatch({ opponentName: 'COM', tutorial: true });
    }

    // チュートリアルの終局処理（localEndGame から呼ばれる）
    function onTutorialEnd(winner) {
        if (winner === local.playerSide) {
            try { localStorage.setItem(TUTORIAL_DONE_KEY, '1'); } catch (_) { /* ignore */ }
            // 勝ったら通常の「次のゲームへ」でロビーに戻る（CTAは解放済みになっている）
            mm.lastMatchType = null;
            setNewGameLabel('次のゲームへ');
            refreshGateUi();
        } else {
            // 負け・引き分けはそのまま再挑戦できる（強さは形勢だけで決まる）
            mm.lastMatchType = 'tutorial';
            setNewGameLabel('もう一度挑戦する');
        }
    }

    // ---- 待機中の詰めチャレンジ（設計書 §7） --------------------------------
    // 公開済みの過去問（/tsume/challenge.json・1手/3手/5手詰）を本物の盤で出題する。
    // 5手詰までは余詰が禁止されているので、正誤判定は line[ply].accept との照合だけでよい。

    const WAIT_TSUME_LEVEL_KEY = 'shogi_wait_tsume_level'; // '1' | '3' | '5'
    const WAIT_TSUME_SEEN_KEY = 'shogi_wait_tsume_seen';   // 出題済みidの配列（最大100件FIFO）
    const WAIT_TSUME_HINT_KEY = 'shogi_wait_tsume_hint';   // 初回トーストを出したか
    const TSUME_REPLY_DELAY_MS = 600;                       // 玉方の応手の間
    const WAIT_LEVELS = [1, 3, 5];

    const tsc = {
        problems: null,  // challenge.json の配列（未取得: null / 取得失敗: false）
        level: null,     // 1 | 3 | 5
        current: null,   // 出題中の問題
        ply: 0,          // 攻方の何手目か（line のインデックス）
        busy: false,     // 玉方の応手待ち
        flawless: true,  // この問題でミス無しか
        cleanStreak: 0,  // 一発正解の連続数（セッション内メモリのみ・設計書 §7.3）
        pendingMiss: false, // 解けないまま待機を終えた → 次の待機で1段下げる
        replyTimer: null,
        toastTimer: null,
    };

    matchmakingBridge.claimsBoard = () =>
        mm.phase === 'seeking' && !local.active && tsc.current !== null;

    matchmakingBridge.boardInputAllowed = () =>
        !tsc.busy && !gameOver && currentPlayer === SENTE;

    function ensureChallengeData() {
        if (tsc.problems === false) tsc.problems = null; // 前回失敗していたら取り直す
        if (tsc.problems !== null) return Promise.resolve();
        return fetch('/tsume/challenge.json')
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error('http_' + res.status))))
            .then((list) => {
                tsc.problems = Array.isArray(list) && list.length ? list : false;
            })
            .catch(() => {
                tsc.problems = false; // 今回の待機は盤なし。次の待機で再試行する
            });
    }

    function getWaitLevel() {
        if (tsc.level === null) tsc.level = inferInitialWaitLevel();
        return tsc.level;
    }

    // 初期段は詰将棋ページの実績から推定する（設計書 §7.3）
    function inferInitialWaitLevel() {
        const stored = lsGet(WAIT_TSUME_LEVEL_KEY);
        if (stored === '1' || stored === '3' || stored === '5') return Number(stored);
        try {
            const raw = lsGet('shogi_tsume_v1');
            const days = raw ? JSON.parse(raw)?.days : null;
            if (days && typeof days === 'object') {
                let hasIntermediate = false;
                for (const date of Object.keys(days)) {
                    const day = days[date] || {};
                    const solved = (lv) => day[lv] === 'clean' || day[lv] === 'solved';
                    if (solved('advanced')) return 5;
                    if (solved('intermediate')) hasIntermediate = true;
                }
                if (hasIntermediate) return 3;
            }
        } catch (_) { /* ignore */ }
        return 1;
    }

    function bumpWaitLevel(delta) {
        const idx = Math.max(0, Math.min(WAIT_LEVELS.length - 1, WAIT_LEVELS.indexOf(getWaitLevel()) + delta));
        tsc.level = WAIT_LEVELS[idx];
        try { localStorage.setItem(WAIT_TSUME_LEVEL_KEY, String(tsc.level)); } catch (_) { /* ignore */ }
    }

    function readSeenIds() {
        try {
            const arr = JSON.parse(lsGet(WAIT_TSUME_SEEN_KEY) || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch (_) {
            return [];
        }
    }

    function rememberSeen(id) {
        const arr = readSeenIds().filter((x) => x !== id);
        arr.push(id);
        while (arr.length > 100) arr.shift();
        try { localStorage.setItem(WAIT_TSUME_SEEN_KEY, JSON.stringify(arr)); } catch (_) { /* ignore */ }
    }

    function startTsumeChallenge() {
        if (mm.phase !== 'seeking' || local.active) return;
        if (!tsc.problems || !tsc.problems.length) {
            // 出題データが無い: 盤を出さず状態カードだけにする（待機自体は続ける）
            document.body.classList.add('mm-no-tsume');
            return;
        }
        document.body.classList.remove('mm-no-tsume');
        if (tsc.pendingMiss) {
            // 前回、解けないまま待機を終えた → 不正解と同じ扱いで1段下げる
            tsc.pendingMiss = false;
            tsc.cleanStreak = 0;
            bumpWaitLevel(-1);
        }
        presentNextTsume();
        if (!lsGet(WAIT_TSUME_HINT_KEY)) {
            try { localStorage.setItem(WAIT_TSUME_HINT_KEY, '1'); } catch (_) { /* ignore */ }
            showWaitToast('対局が始まると自動で中断します');
        }
    }

    function presentNextTsume() {
        const level = getWaitLevel();
        // その段の在庫が無ければ近い段で代用する（アーカイブがまだ浅い時期の保険）
        let pool = tsc.problems.filter((p) => p.moves === level);
        if (!pool.length) {
            for (const lv of WAIT_LEVELS) {
                pool = tsc.problems.filter((p) => p.moves === lv);
                if (pool.length) break;
            }
        }
        if (!pool.length) {
            document.body.classList.add('mm-no-tsume');
            return;
        }
        const seen = readSeenIds();
        const unseen = pool.filter((p) => !seen.includes(p.id));
        const pickFrom = unseen.length ? unseen : pool; // 使い切ったら再利用（設計書 §7.3）
        const problem = pickFrom[Math.floor(Math.random() * pickFrom.length)];
        rememberSeen(problem.id);

        tsc.current = problem;
        tsc.ply = 0;
        tsc.busy = false;
        tsc.flawless = true;
        setupTsumePosition(problem);
        updateWaitBar();
        if (els.waitTsumeBar) {
            els.waitTsumeBar.classList.remove('is-dim');
            els.waitTsumeBar.hidden = false;
        }
        updateOnlineUiState();
    }

    function handleTsumeChallengeMove(move) {
        const problem = tsc.current;
        if (!problem || tsc.busy || gameOver) return;
        const step = problem.line[tsc.ply];
        if (!step) return;
        const usi = toUsiMoveString(move);
        if (!Array.isArray(step.accept) || !step.accept.includes(usi)) {
            // 適用前に弾くので巻き戻しは不要。段下げは1問につき1回まで
            // （試行錯誤のたびに下げると数回で1手詰まで落ちてしまう）
            if (tsc.flawless) bumpWaitLevel(-1);
            tsc.flawless = false;
            tsc.cleanStreak = 0;
            showWaitToast('その手では詰みません', 'bad');
            return;
        }
        executeAIMove(move);
        if (checkmate || !step.defend) {
            onTsumeSolved();
            return;
        }
        // 玉方の応手（データの defend をそのまま指す）
        tsc.busy = true;
        updateWaitBar();
        tsc.replyTimer = setTimeout(() => {
            tsc.replyTimer = null;
            if (!matchmakingBridge.claimsBoard?.() || !tsc.busy) return;
            const reply = usiMoveToMove(step.defend);
            if (reply) executeAIMove(reply);
            tsc.busy = false;
            tsc.ply += 1;
            updateWaitBar();
        }, TSUME_REPLY_DELAY_MS);
    }

    function onTsumeSolved() {
        recordChallengeSolved(tsc.current, tsc.flawless);
        refreshGateUi(); // 詰将棋1問で「だれかと対戦」が解放される
        if (tsc.flawless) {
            tsc.cleanStreak += 1;
            if (tsc.cleanStreak >= 2) {
                // 一発正解が2問続いたら1段上げる（設計書 §7.3）
                tsc.cleanStreak = 0;
                bumpWaitLevel(1);
            }
        }
        showWaitToast('正解！', 'good');
        tsc.current = null;
        tsc.replyTimer = setTimeout(() => {
            tsc.replyTimer = null;
            if (mm.phase === 'seeking' && !local.active) presentNextTsume();
        }, 900);
    }

    // 解いた記録は詰将棋ページと同じ場所（shogi_tsume_v1）に互換形式で書く。
    // 連続日数（streak/lastDate）は動かさない。累計には加算する（設計書 §7.2）
    function recordChallengeSolved(problem, flawless) {
        if (!problem || !problem.date || !problem.level) return;
        try {
            const raw = localStorage.getItem('shogi_tsume_v1');
            const parsed = raw ? JSON.parse(raw) : null;
            const days = parsed?.days && typeof parsed.days === 'object' ? { ...parsed.days } : {};
            // 旧形式（today/todayDate）の記録を落とさない（shogi-tsume.js の移行処理と同じ）
            const legacyDate = parsed?.todayDate || parsed?.lastDate || '';
            if (legacyDate && !days[legacyDate] && parsed?.today && typeof parsed.today === 'object') {
                days[legacyDate] = parsed.today;
            }
            const progress = {
                lastDate: parsed?.lastDate || '',
                streak: Number(parsed?.streak) || 0,
                total: Number(parsed?.total) || 0,
                days,
            };
            if (!progress.days[problem.date]) progress.days[problem.date] = {};
            const day = progress.days[problem.date];
            const already = day[problem.level];
            day[problem.level] = flawless || already === 'clean' ? 'clean' : 'solved';
            progress.total += 1;
            localStorage.setItem('shogi_tsume_v1', JSON.stringify(progress));
        } catch (_) { /* ignore */ }
    }

    // 中断（マッチ成立・キャンセル・COM戦開始）。dim はカードを残したまま薄くする
    function stopTsumeChallenge({ dim = false } = {}) {
        if (tsc.replyTimer) { clearTimeout(tsc.replyTimer); tsc.replyTimer = null; }
        if (tsc.current && (tsc.ply > 0 || !tsc.flawless)) {
            tsc.pendingMiss = true; // 解けないまま中断 → 次の待機で1段下げる
        }
        tsc.current = null;
        tsc.busy = false;
        document.body.classList.remove('mm-no-tsume');
        hideWaitToast();
        if (els.waitTsumeBar) {
            if (dim) els.waitTsumeBar.classList.add('is-dim');
            else els.waitTsumeBar.hidden = true;
        }
    }

    function updateWaitBar() {
        if (!els.waitTsumeBar || !tsc.current) return;
        const p = tsc.current;
        if (els.waitTsumeMoves) els.waitTsumeMoves.textContent = `${p.moves}手詰`;
        const played = tsc.ply * 2 + (tsc.busy ? 1 : 0);
        if (els.waitTsumeRemaining) {
            els.waitTsumeRemaining.textContent = String(Math.max(1, p.moves - played));
        }
    }

    // 詰将棋ページの #tsume-toast と同じマークアップを盤上に生成する（CSSは共通）
    function showWaitToast(text, tone) {
        const stage = document.getElementById('board-stage');
        if (!stage) return;
        let toast = document.getElementById('tsume-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'tsume-toast';
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');
            stage.appendChild(toast);
        }
        toast.textContent = text;
        toast.classList.toggle('tone-bad', tone === 'bad');
        toast.classList.toggle('tone-good', tone === 'good');
        toast.classList.add('visible');
        if (tsc.toastTimer) clearTimeout(tsc.toastTimer);
        tsc.toastTimer = setTimeout(() => {
            toast.classList.remove('visible');
            tsc.toastTimer = null;
        }, tone === 'bad' ? 2000 : 2600);
    }

    function hideWaitToast() {
        const toast = document.getElementById('tsume-toast');
        if (toast) toast.classList.remove('visible');
        if (tsc.toastTimer) { clearTimeout(tsc.toastTimer); tsc.toastTimer = null; }
    }

    // ---- 解放ゲート（設計書 §6.8） ------------------------------------------

    const TUTORIAL_DONE_KEY = 'shogi_tutorial_done';
    const AI_WIN_COUNT_KEY = 'shogi_ai_win_count';
    // 既存ユーザー免除の判定結果。'1'=免除 / '0'=判定済み・免除なし。
    // キーが無いとき（初回ロード）だけ判定するので、リリース後の新規ユーザーには適用されない
    const EXEMPT_KEY = 'shogi_mm_exempt';
    const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';

    function lsGet(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }

    function seedLegacyExemption() {
        if (lsGet(EXEMPT_KEY) !== null) return;
        // 「実際に遊んだ痕跡」だけを見る。shogi_ai_difficulty や表示設定は
        // 初回ロードでデフォルト値が自動保存されるため、免除判定には使えない
        const legacyKeys = [
            'shogi_game_state',      // AI対戦の対局保存（指した時に書かれる）
            'shogi_game_state_pvp',  // 2人対戦の対局保存
            'shogi_unlocked_levels', // 超級以上のクリアで書かれる
            'shogi_friend_side',     // 友達対戦の設定変更で書かれる
            'shogi_tsume_v1',        // 詰将棋の解答記録
        ];
        const isLegacy = legacyKeys.some((k) => lsGet(k) !== null);
        try { localStorage.setItem(EXEMPT_KEY, isLegacy ? '1' : '0'); } catch (_) { /* ignore */ }
    }

    // 詰将棋を1問でも解いたか（過去問でも可・設計書 §6.8-3）
    function hasSolvedAnyTsume() {
        const raw = lsGet('shogi_tsume_v1');
        if (!raw) return false;
        try {
            const days = JSON.parse(raw)?.days;
            if (!days || typeof days !== 'object') return false;
            for (const date of Object.keys(days)) {
                const levels = days[date];
                if (!levels || typeof levels !== 'object') continue;
                for (const level of Object.keys(levels)) {
                    if (levels[level] === 'clean' || levels[level] === 'solved') return true;
                }
            }
        } catch (_) { /* ignore */ }
        return false;
    }

    function isMatchmakingUnlocked() {
        if (lsGet(EXEMPT_KEY) === '1') return true;
        if (lsGet(TUTORIAL_DONE_KEY)) return true;
        if ((parseInt(lsGet(AI_WIN_COUNT_KEY) || '0', 10) || 0) >= 1) return true;
        return hasSolvedAnyTsume();
    }

    // CTAの見た目を解放状態に合わせる。未解放の表記は一番やってほしい1つだけに絞る
    // （条件の一覧は案内ダイアログ側で説明する。設計書 §6.3）
    function refreshGateUi() {
        const unlocked = isMatchmakingUnlocked();
        if (els.cta) els.cta.classList.toggle('is-locked', !unlocked);
        if (els.tutorial) els.tutorial.classList.toggle('is-primary', !unlocked);
        if (!unlocked) {
            if (els.pulse) els.pulse.hidden = true;
            if (els.metaText) {
                els.metaText.innerHTML =
                    '<span class="mm-cta-lock">' + LOCK_SVG + '</span>チュートリアルをクリアで解放';
            }
        } else {
            applyStats(mm.lastPlaying || 0);
        }
    }

    // 未解放のCTAを押したときの案内（押せないボタンにはしない）。
    // 既存モーダル（handleSettingsModalKeydown 等）と同じく Escape とTab循環に対応する
    let gateGuideReturnFocus = null;

    function gateGuideFocusables() {
        const modal = document.getElementById('mm-gate-modal');
        if (!modal) return [];
        return [...modal.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    }

    function handleGateGuideKeydown(ev) {
        if (ev.key === 'Escape') {
            ev.preventDefault();
            hideGateGuide();
            return;
        }
        if (ev.key !== 'Tab') return;
        const focusables = gateGuideFocusables();
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (ev.shiftKey && document.activeElement === first) {
            ev.preventDefault();
            last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
            ev.preventDefault();
            first.focus();
        }
    }

    function showGateGuide() {
        let modal = document.getElementById('mm-gate-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'mm-gate-modal';
            modal.innerHTML =
                '<div class="settings-modal-backdrop" data-mm-gate-close></div>' +
                '<div class="settings-modal-card mm-gate-card" role="dialog" aria-modal="true" aria-labelledby="mm-gate-title">' +
                '<div class="settings-modal-header">' +
                '<h3 class="settings-title" id="mm-gate-title">だれかと対戦の解放</h3>' +
                '<button type="button" class="settings-modal-close-btn" data-mm-gate-close aria-label="閉じる">✕</button>' +
                '</div>' +
                '<p class="mm-gate-lead">次のどれか1つをクリアすると、だれかと対戦できるようになります。</p>' +
                '<ol class="mm-gate-list">' +
                '<li>チュートリアルに勝つ</li>' +
                '<li>AI対戦で1回勝つ</li>' +
                '<li>詰将棋を1問解く</li>' +
                '</ol>' +
                '<button type="button" class="friend-guide-close-btn" id="mm-gate-tutorial-btn">チュートリアルをはじめる</button>' +
                '</div>';
            document.body.appendChild(modal);
            modal.addEventListener('click', (ev) => {
                if (ev.target instanceof Element && ev.target.closest('[data-mm-gate-close]')) {
                    hideGateGuide();
                }
            });
            const tutorialBtn = document.getElementById('mm-gate-tutorial-btn');
            if (tutorialBtn) {
                tutorialBtn.addEventListener('click', () => {
                    hideGateGuide();
                    startTutorial();
                });
            }
        }
        gateGuideReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        modal.style.display = 'flex';
        document.body.classList.add('modal-open');
        document.addEventListener('keydown', handleGateGuideKeydown);
        document.getElementById('mm-gate-tutorial-btn')?.focus();
    }

    function hideGateGuide() {
        const modal = document.getElementById('mm-gate-modal');
        if (!modal || modal.style.display === 'none') return;
        modal.style.display = 'none';
        document.body.classList.remove('modal-open');
        document.removeEventListener('keydown', handleGateGuideKeydown);
        if (gateGuideReturnFocus) {
            gateGuideReturnFocus.focus();
            gateGuideReturnFocus = null;
        }
    }

    // ---- マッチ成立 → 対局へ -------------------------------------------------

    function onMatched(msg) {
        markMatchedFromQueue(true);
        stopCountdown();
        stopTsumeChallenge({ dim: true }); // 見出しを薄くして視線を外させる（設計書 §13）
        setPhase('found'); // body は online-seeking のまま（盤を見せ続ける）
        showFoundUi(
            typeof msg.opponentName === 'string' && msg.opponentName ? msg.opponentName : null,
            msg.opponentRank,
        );
        // 緑カードを1.5秒見せる。この時間が対局WSの接続と state 到着の待ち時間を兼ねる
        setTimeout(() => {
            if (mm.phase !== 'found') return; // その間に離脱した
            enterRoom(msg);
        }, FOUND_PAUSE_MS);
    }

    function enterRoom(msg) {
        // 🔴 setUrlRoom は呼ばない: マッチング対戦の部屋コードをURLに出すと
        // 招待URLとして使い回されてしまう（設計書 §6.1）
        onlineState.token = msg.token;
        onlineState.roomCode = msg.room_code;
        onlineState.side = msg.yourSide === 'gote' ? GOTE : SENTE; // 盤の向きの初期値。state到着後に確定
        onlineConnectWs(); // 接続 → サーバーが state を push → applyOnlineMatch が走る
        watchGameStart();
    }

    // 対局 state が適用されたら待機表示を畳む。つながらないままならロビーへ戻す
    function watchGameStart() {
        stopWatchTimer();
        mm.watchDeadline = Date.now() + 15000;
        mm.watchTimer = setInterval(() => {
            if (mm.phase !== 'found') { stopWatchTimer(); return; }
            if (onlineState.match && onlineState.roomCode) {
                stopWatchTimer();
                hideSeekUi();
                if (els.waitTsumeBar) els.waitTsumeBar.hidden = true;
                setPhase('game');
                return;
            }
            if (Date.now() > mm.watchDeadline) {
                stopWatchTimer();
                onlineLeaveRoom({ resignIfActive: false }).catch(() => { /* ignore */ });
                exitToLobby('対局への接続に失敗しました。もう一度お試しください。');
            }
        }, 150);
    }

    function stopWatchTimer() {
        if (mm.watchTimer) {
            clearInterval(mm.watchTimer);
            mm.watchTimer = null;
        }
    }

    // ---- キャンセル・ロビーへ戻る -------------------------------------------

    function cancelSeek() {
        if (mm.phase !== 'seeking') return;
        closeQueueWs(true); // 自分から閉じる（サーバー側はcloseがキャンセル扱い）
        exitToLobby(null);
    }

    function exitToLobby(message) {
        closeQueueWs(true);
        stopCountdown();
        stopWatchTimer();
        stopTsumeChallenge();
        hideSeekUi();
        setPhase('lobby');
        refreshGateUi();
        refreshStats();
        if (message) alert(message); // まれな異常系なので既存の onlineJoinRoom と同じ alert で十分
    }

    // ---- 終局後の「もう一度」 ------------------------------------------------

    function setNewGameLabel(text) {
        if (typeof newGameButton === 'undefined' || !newGameButton) return;
        const main = newGameButton.querySelector('.new-game-main');
        if (main) main.textContent = text;
    }

    matchmakingBridge.onGameOver = (match) => {
        mm.lastMatchType = match && match.match_type === 'matchmaking' ? 'matchmaking' : 'invite';
        // 対局が終わった直後だけ実力値を取り直す（30秒ごとのポーリングには乗せない）
        if (mm.lastMatchType === 'matchmaking') refreshStats({ withRating: true });
        // マッチング対戦は「もう一度」で自動再キュー。友達対戦は従来のまま
        setNewGameLabel(mm.lastMatchType === 'matchmaking' ? 'もう一度対戦する' : '次のゲームへ');
    };

    matchmakingBridge.handleNewGame = () => {
        // どの経路（再キュー/再挑戦/既定のロビー戻り）でもローカル対局の残骸を残さない
        if (local.active) exitLocalMatch();
        if (mm.lastMatchType === 'tutorial') {
            // チュートリアルに負けた → 同じ設定でもう一度
            mm.lastMatchType = null;
            setNewGameLabel('次のゲームへ');
            if (typeof hideGameOverDialog === 'function') hideGameOverDialog();
            startTutorial();
            return true;
        }
        if (mm.lastMatchType !== 'matchmaking') return false;
        mm.lastMatchType = null;
        setNewGameLabel('次のゲームへ');
        if (typeof hideGameOverDialog === 'function') hideGameOverDialog();
        beginSeek(); // 内部で前の部屋から抜ける
        return true;
    };

    // ---- 起動 ---------------------------------------------------------------

    matchmakingBridge.start = () => {
        grabElements();
        primeRankCard(); // 前回の値で先に埋める。サーバーの値は refreshStats が持ってくる
        setupNameInput();
        seedLegacyExemption();
        refreshGateUi();
        if (els.cta) {
            els.cta.addEventListener('click', () => {
                if (!isMatchmakingUnlocked()) {
                    showGateGuide();
                    return;
                }
                beginSeek();
            });
        }
        if (els.rankHide) {
            els.rankHide.addEventListener('click', () => {
                setRankHidden(true);
                showHideToast();
                track('rank_visibility', { hidden: 1, from: 'card' });
            });
        }
        if (els.tutorial) els.tutorial.addEventListener('click', () => { startTutorial(); });
        if (els.seekCancel) els.seekCancel.addEventListener('click', cancelSeek);
        document.addEventListener('visibilitychange', handleVisibilityRequeue);
        refreshStats();
        mm.statsTimer = setInterval(() => {
            if (mm.phase === 'lobby' && document.visibilityState === 'visible') refreshStats();
        }, STATS_REFRESH_MS);
    };
})();
