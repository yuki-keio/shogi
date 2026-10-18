// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2026~ Yuki Lab
//
// だれかと対戦（マッチング）のクライアント。/online/ でだけ読み込まれる。
// shogi.js の後に defer で読み込まれ（build-pages.mjs が順序を保証）、
// shogi.js とは matchmakingBridge（グローバル）経由でだけ接続する。
// このファイルが無いページでも shogi.js 単体で完結する（tsumeBridge と同じ流儀）。

(function () {
    'use strict';

    // shogi.js が読み込まれていなければ何もしない（保険。通常は起こらない）
    if (typeof matchmakingBridge === 'undefined') return;

    // COMに切り替わるまでの秒数。1級以下60秒・到達した段級位が初段以上2分（サーバーの matchmaker.ts と同じ値）。
    // 端末の控えで先に出し、サーバーの queued が来たらその値に合わせる
    const SEEK_BOT_SECONDS = 60;
    const SEEK_BOT_DAN_SECONDS = 120;
    const SEEK_WAIT_CAP_SECONDS = 599;     // COMを切っている人の待った時間は 9:59 で止める（10分で打ち切りなので超えない）
    const SHODAN_RANK = ONLINE_RANK_LABELS.indexOf('初段'); // 初段の添字（サーバーの RANKS と同じ並び）
    const CANCEL_CLOSE_CODE = 4001;        // ✕で取り消すときの close コード。サーバーはこれで「接続が切れた」と見分ける
    const MM_WS_PING_INTERVAL_MS = 10000;  // Matchmakerは対局WSと同じping/pong自動応答
    const FOUND_PAUSE_MS = 1500;           // 緑カードを見せる時間 = 対局WS接続を待つ時間
    const STATS_REFRESH_MS = 30000;
    const BOT_FALLBACK_KEY = 'shogi_bot_fallback'; // '0' = 60秒COMフォールバックを使わない（読むだけ。ON/OFFは設定＝shogi.js が保存する）
    // ロビーの段級位カードを開いた瞬間に埋めるための控え。サーバーの値が来たら上書きする。
    // これが無いと、カードが空 → 値が入る、で数字が湧いて見える
    const RANK_CACHE_KEY = 'shogi_online_rank';
    // COM戦で実力値が動く上限の段級位（1級）。サーバーの src/worker/rating.ts と同じ値
    const BOT_RATED_MAX_RANK = 8;

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
        botAfter: SEEK_BOT_SECONDS, // この待機でCOMに切り替わるまでの秒数。COMを切っている人は null（待った時間を数え上げる）
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
        els.nameAuto = $('player-name-auto');
        els.nameReroll = $('player-name-reroll');
        els.nameCustom = $('player-name-custom');
        els.nameRow = $('name-row');
        els.nameEdit = els.nameRow;
        els.nameNotice = $('name-notice');
        els.nameDialog = $('name-dialog');
        els.nameDialogTitle = $('name-dialog-title');
        els.nameForm = $('name-form');
        els.nameSave = $('name-save');
        els.nameBack = $('name-back');
        els.nameError = $('player-name-error');
        els.nameInvitation = $('name-invitation');
        els.nameInvitationOpen = $('name-invitation-open');
        els.nameInvitationSkip = $('name-invitation-skip');
        els.nameGeneratedPanel = $('name-generated-panel');
        els.nameCustomPanel = $('name-custom-panel');
        els.namePrevious = $('name-previous-value');
        els.namePreview = $('name-preview-value');
        els.nameMods = $('name-mods');
        els.nameNouns = $('name-nouns');
        els.seek = $('online-seek');
        els.seekTitleText = $('seek-title-text');
        els.seekDots = $('seek-dots');
        els.seekNote = $('seek-note');
        els.seekTimer = $('seek-timer');
        els.seekTimerValue = $('seek-timer-value');
        els.seekTimerUnit = $('seek-timer-unit');
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

    const NAME_AUTO_KEY = 'shogi_name_auto'; // default=初期名、1=二つ名、0=自由入力（空欄は匿名）
    const NAME_CUSTOM_KEY = 'shogi_name_custom';
    const NAME_INVITATION_KEY = 'shogi_name_invitation'; // pending → shown の一方向
    let nameProfile = null;
    let nameInvitationState = '';
    let nameInvitationVisible = false;
    let nameLobbyVisible = false;
    let nameNavigating = false;
    let nameLobbyFrame = 0;
    let nameReturnFocus = null;
    let nameComposing = false;
    let nameSaving = false;
    const nameDraft = { custom: false, mod: '', noun: '' };

    function readLocal(key) {
        try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
    }

    function writeLocal(key, value) {
        try { localStorage.setItem(key, value); } catch (_) { /* 保存不可でも画面は使える */ }
    }

    function renderPlayerName() {
        if (!nameProfile) return;
        els.nameAuto.textContent = nameProfile.name || '匿名プレイヤー';
        els.nameRow.hidden = nameInvitationVisible;
        els.nameInvitation.hidden = !nameInvitationVisible;
    }

    function setNameInvitationState(value) {
        nameInvitationState = value;
        writeLocal(NAME_INVITATION_KEY, value);
    }

    function markNameGameFinished() {
        if (nameProfile?.mode === 'default' && !nameInvitationState) {
            setNameInvitationState('pending');
        }
    }

    // 終局後の連戦やページ移動では消費せず、実際にロビーを描く時だけ案内する。
    function syncNameLobby(visible) {
        nameLobbyVisible = visible;
        if (!nameProfile) return;
        if (!visible) {
            cancelAnimationFrame(nameLobbyFrame);
            nameLobbyFrame = 0;
            nameInvitationVisible = false;
            showNameNotice('');
            closeNameEditor();
            renderPlayerName();
            return;
        }
        if (nameLobbyFrame || nameNavigating) return;
        nameLobbyFrame = requestAnimationFrame(() => {
            nameLobbyFrame = 0;
            if (!nameLobbyVisible || nameNavigating || onlineState.joining || document.visibilityState !== 'visible') return;
            if (nameProfile.mode === 'default' && nameInvitationState === 'pending') {
                nameInvitationVisible = true;
                setNameInvitationState('shown');
            }
            renderPlayerName();
        });
    }

    matchmakingBridge.onLobbyVisibilityChange = syncNameLobby;
    matchmakingBridge.onNavigationChange = (navigating) => {
        nameNavigating = navigating;
        if (!navigating) syncNameLobby(nameLobbyVisible);
    };

    // 時間では消さない。消えた分だけ下の実力値カードと「だれかと対戦」が後から動くため。
    // ロビーを離れたとき（syncNameLobby）と、ダイアログを開いたときに消す
    function showNameNotice(message) {
        els.nameNotice.textContent = message;
    }

    function generatedDraftName() {
        return nameDraft.mod + 'の' + nameDraft.noun;
    }

    function setGeneratedDraft(name) {
        const at = name.indexOf('の');
        nameDraft.mod = name.slice(0, at);
        nameDraft.noun = name.slice(at + 1);
    }

    // 語彙は既存の共有データだけを使う。前後はどの語どうしでも組み合わせてよいので、両列とも全部の語を出す
    // （噛み合わない組み合わせを避けるのはランダムで引くときだけ）。
    function buildNameOptions() {
        if (els.nameMods.childElementCount) return;
        for (const [list, words, key] of [
            [els.nameMods, ShogiNames.MODS, 'mod'],
            [els.nameNouns, ShogiNames.NOUNS, 'noun'],
        ]) {
            for (const [word] of words) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'name-word';
                button.textContent = word;
                button.dataset.word = word;
                button.addEventListener('click', () => {
                    if (nameSaving) return;
                    nameDraft[key] = word;
                    renderNameDraft();
                });
                list.appendChild(button);
            }
            list.addEventListener('keydown', event => {
                if (nameSaving || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const options = [...list.children];
                const current = options.indexOf(document.activeElement);
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                    : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                const next = options[index];
                if (!next) return;
                next.click();
                next.focus({ preventScroll: true });
                next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            });
        }
    }

    function renderNameDraft(centerSelection = false) {
        const custom = nameDraft.custom;
        els.nameGeneratedPanel.hidden = custom;
        els.nameCustomPanel.hidden = !custom;
        els.nameDialogTitle.textContent = custom ? '表示名を入力' : '表示名を選ぶ';
        let valid = true;
        let candidate;
        if (custom) {
            candidate = ShogiNames.normalizeCustomName(els.nameInput.value);
            valid = ShogiNames.validCustomName(candidate);
            const error = valid ? '' : /[^A-Za-z0-9_\-.]/.test(candidate)
                ? '半角英数字で入力してください。' : '10文字以内で入力してください。';
            els.nameError.textContent = error;
            els.nameError.hidden = !error;
            els.nameInput.setAttribute('aria-invalid', String(!valid));
        } else {
            candidate = generatedDraftName();
            valid = ShogiNames.isGeneratedName(candidate);
            els.namePrevious.textContent = nameProfile.name || '匿名プレイヤー';
            els.namePreview.textContent = candidate;
            for (const [list, word] of [
                [els.nameMods, nameDraft.mod],
                [els.nameNouns, nameDraft.noun],
            ]) {
                for (const button of list.children) {
                    button.setAttribute('aria-pressed', String(button.dataset.word === word));
                    button.tabIndex = button.dataset.word === word ? 0 : -1;
                }
                if (centerSelection) {
                    const selected = list.querySelector('[aria-pressed="true"]');
                    if (selected) list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2;
                }
            }
        }
        els.nameSave.disabled = nameSaving || !valid || candidate === nameProfile.name;
    }

    function openNameEditor() {
        if (!nameProfile || els.nameDialog.open) return;
        nameReturnFocus = document.activeElement;
        showNameNotice('');
        nameDraft.custom = nameProfile.mode === '0';
        els.nameInput.value = nameDraft.custom ? nameProfile.name : readLocal(NAME_CUSTOM_KEY);
        setGeneratedDraft(nameProfile.mode === '1' && ShogiNames.isGeneratedName(nameProfile.name)
            ? nameProfile.name : ShogiNames.randomName());
        buildNameOptions();
        renderNameDraft();
        els.nameDialog.showModal();
        document.body.classList.add('modal-open');
        renderNameDraft(true);
        els.nameDialog.querySelector('[data-name-cancel]').focus({ preventScroll: true });
    }

    function closeNameEditor() {
        if (!els.nameDialog?.open || nameSaving) return;
        els.nameDialog.close();
        document.body.classList.remove('modal-open');
        const target = nameReturnFocus && nameReturnFocus.offsetParent !== null ? nameReturnFocus : els.nameEdit;
        target?.focus({ preventScroll: true });
        nameReturnFocus = null;
    }

    function savePlayerName(clickEvent) {
        if (nameSaving || nameComposing) return;
        renderNameDraft();
        if (els.nameSave.disabled) return;
        const name = nameDraft.custom ? ShogiNames.normalizeCustomName(els.nameInput.value) : generatedDraftName();
        nameProfile = { name, mode: nameDraft.custom ? '0' : '1' };
        writeLocal(PLAYER_NAME_KEY, name);
        writeLocal(NAME_AUTO_KEY, nameProfile.mode);
        if (nameDraft.custom) writeLocal(NAME_CUSTOM_KEY, name);
        setNameInvitationState('shown');
        nameInvitationVisible = false;
        nameSaving = true;
        els.nameSave.disabled = true;
        els.nameSave.setAttribute('aria-label', '設定しました');
        let ripple;
        const finish = () => {
            nameSaving = false;
            els.nameDialog.classList.remove('is-confirming', 'is-closing');
            ripple?.remove();
            els.nameSave.removeAttribute('aria-label');
            renderPlayerName();
            closeNameEditor();
            showNameNotice('🎉表示名を変更しました');
        };
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            finish();
            return;
        }
        const rect = els.nameSave.getBoundingClientRect();
        const size = rect.width * 2.4;
        const x = clickEvent?.detail ? clickEvent.clientX - rect.left : rect.width / 2;
        const y = clickEvent?.detail ? clickEvent.clientY - rect.top : rect.height / 2;
        ripple = document.createElement('span');
        ripple.className = 'name-save-ripple';
        ripple.setAttribute('aria-hidden', 'true');
        Object.assign(ripple.style, {
            width: size + 'px', height: size + 'px',
            left: x - size / 2 - els.nameSave.clientLeft + 'px',
            top: y - size / 2 - els.nameSave.clientTop + 'px',
        });
        els.nameSave.appendChild(ripple);
        els.nameDialog.classList.add('is-confirming');
        setTimeout(() => {
            els.nameDialog.classList.add('is-closing');
            setTimeout(finish, 100);
        }, 340);
    }

    function setupNameInput() {
        if (!els.nameDialog || typeof ShogiNames === 'undefined') return;
        nameProfile = ShogiNames.initialNameProfile(getStoredPlayerName() || '', readLocal(NAME_AUTO_KEY));
        writeLocal(PLAYER_NAME_KEY, nameProfile.name);
        writeLocal(NAME_AUTO_KEY, nameProfile.mode);
        nameInvitationState = readLocal(NAME_INVITATION_KEY);
        renderPlayerName();
        els.nameEdit.addEventListener('click', openNameEditor);
        els.nameInvitationOpen.addEventListener('click', openNameEditor);
        els.nameInvitationSkip.addEventListener('click', () => {
            nameInvitationVisible = false;
            setNameInvitationState('shown');
            renderPlayerName();
            showNameNotice('鉛筆からいつでも二つ名をつけられます');
            els.nameEdit.focus({ preventScroll: true });
        });
        els.nameDialog.querySelectorAll('[data-name-cancel]').forEach(button => button.addEventListener('click', closeNameEditor));
        els.nameDialog.addEventListener('cancel', event => { event.preventDefault(); closeNameEditor(); });
        els.nameDialog.addEventListener('click', event => {
            if (event.target !== els.nameDialog) return;
            const rect = els.nameDialog.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeNameEditor();
        });
        els.nameForm.addEventListener('submit', event => { event.preventDefault(); savePlayerName(); });
        els.nameSave.addEventListener('click', event => { event.preventDefault(); savePlayerName(event); });
        els.nameCustom.addEventListener('click', () => {
            if (nameSaving) return;
            nameDraft.custom = true;
            renderNameDraft();
            els.nameInput.focus();
        });
        els.nameBack.addEventListener('click', () => {
            if (nameSaving) return;
            nameDraft.custom = false;
            renderNameDraft(true);
            els.nameReroll.focus({ preventScroll: true });
        });
        els.nameReroll.addEventListener('click', () => {
            if (nameSaving) return;
            const current = generatedDraftName();
            let next;
            do { next = ShogiNames.randomName(); } while (next === current);
            setGeneratedDraft(next);
            renderNameDraft(true);
        });
        const updateInput = () => {
            if (nameComposing || nameSaving) return;
            els.nameInput.value = ShogiNames.normalizeCustomName(els.nameInput.value);
            renderNameDraft();
        };
        els.nameInput.addEventListener('compositionstart', () => { nameComposing = true; });
        els.nameInput.addEventListener('compositionend', () => { nameComposing = false; updateInput(); });
        els.nameInput.addEventListener('input', updateInput);
        els.nameInput.addEventListener('blur', updateInput);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') syncNameLobby(nameLobbyVisible);
        });
        // 初期合流はこの後に始まるため、次フレームの joining 判定まで待つ。
        syncNameLobby(document.body.classList.contains('online-lobby'));
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

    /**
     * 到達した段級位（下がらない方）。控えと、直前に終わっただれかと対戦で届いた自分の段級位の大きい方。
     * 終局時に MatchRoom が書き戻す値も見るのは、初段に上がった直後の「もう一度対戦する」で
     * 控えの更新（refreshStats の返事）がまだ届いていないことがあるため
     */
    function reachedRankIndex() {
        let rank = cachedRankIndex();
        const match = onlineState.match;
        if (match && match.game_over && match.match_type === 'matchmaking' && onlineState.side) {
            const mine = onlineState.side === SENTE ? match.sente_rank : match.gote_rank;
            if (typeof mine === 'number' && mine > rank) rank = mine;
        }
        return rank;
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
        sub.textContent = '右上の設定から戻せます';
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

    // 設定から戻したときはカードを埋め直す（非表示のあいだ描画を飛ばしているため）。
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
        const fromQueue = mm.phase === 'seeking' || mm.phase === 'found';
        mm.phase = phase;
        if (phase === 'game' && fromQueue) noticeGameStartInTitle();
        const onBoard = phase === 'seeking' || phase === 'found';
        document.body.classList.toggle('online-seeking', onBoard);
        // 待機中は止めていた盤の回転を、ここで対局の向きに合わせる（shogi.js の applyBoardOrientation）
        if (typeof applyBoardOrientation === 'function') applyBoardOrientation();
        if (typeof updateOnlineUiState === 'function') updateOnlineUiState();
    }

    // ---- 対局開始で盤をすべらせる ----------------------------------------------
    // 待機中は盤の上に状態カードがあり、対局が始まると消えるので盤の枠（#board-area）が上へ動く。
    // 相手が決まった合図で起きる＝触っていない時の動きなので、一瞬で跳ぶと画面のずれ（CLS）に数えられる。
    // 畳む直前の位置を測っておき、畳んだあと translate で元の位置へ戻してから0.3秒で今の位置へすべらせる。
    // 🔴 translate は後手番の transform: rotate とは別の指定なので回転を上書きしない。transition も
    //    transform のぶんを残す（消すと、同時に始まる盤の回転が一瞬で切り替わる）
    // 「視差効果を減らす」設定ではすべらせない（見た目は跳ぶのに数字だけ消すことはしない）

    /**
     * 畳む直前の盤の枠の位置。盤が見えていないとき（問題が取れず盤なしで待っていた）は null。
     * 別のアプリやタブを見ているときも null（描かれないので数えられず、戻ったときに盤がすべり出すだけになる）
     */
    function boardTopBeforeFold() {
        const area = document.getElementById('board-area');
        if (!area || !area.offsetParent || document.hidden || prefersReducedMotion()) return null;
        return area.offsetTop;
    }

    function glideBoardFrom(prevTop) {
        const area = document.getElementById('board-area');
        if (prevTop === null || !area || !area.offsetParent) return;
        const dy = prevTop - area.offsetTop;
        if (Math.abs(dy) < 1) return;
        area.style.transition = 'transform 0.3s ease';
        area.style.translate = `0 ${dy}px`;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            area.style.transition = 'transform 0.3s ease, translate 0.3s ease-out';
            area.style.translate = '';
            setTimeout(() => { area.style.transition = ''; }, 350);
        }));
    }

    // ---- 別のタブにいる間に対局が始まったら、タブの題名で知らせる ----------------------
    // 待っている間に別のタブを見ている人が多い。人との対局でもCOMでも、始まった瞬間に題名を変え、戻ったら元に戻す

    const GAME_STARTED_TITLE = '対局が始まりました';
    let titleBeforeNotice = null;

    function noticeGameStartInTitle() {
        if (!document.hidden || titleBeforeNotice !== null) return;
        titleBeforeNotice = document.title;
        document.title = GAME_STARTED_TITLE;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden || titleBeforeNotice === null) return;
        document.title = titleBeforeNotice;
        titleBeforeNotice = null;
    });

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

    // ---- 画面離れの計測（だれかと対戦の対局記録） ----------------------------
    // 自分の手番のあいだに、別のタブ・アプリ・ウィンドウへ切り替えた回数と時間。指し手と一緒に送り、
    // サーバーはだれかと対戦の対局記録にだけ残す（ソフト指しを見つける材料）。
    // 🔴 送ったときには数え直さない。送って断られた（反則・行き違い）だけで、その手番の値が消えるため。
    //    数え直すのは、新しい手が盤に乗ったときと対局が始まったとき（shogi.js が onPly で知らせる）
    const away = { count: 0, ms: 0, since: 0 };

    function markAway() {
        if (away.since) return;
        away.since = Date.now();
        away.count += 1;
    }

    function markBack() {
        if (!away.since) return;
        away.ms += Date.now() - away.since;
        away.since = 0;
    }

    // 広告の枠を押しただけでも window の blur は起きるが、そのときは文書のフォーカスが残るので数えない。
    // フォーカスの移り先が決まってから見るため、判定は一拍おく
    window.addEventListener('blur', () => setTimeout(() => {
        if (!document.hasFocus()) markAway();
    }, 0));
    window.addEventListener('focus', markBack);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) markAway();
        else if (document.hasFocus()) markBack();
    });
    // 画面に触れた＝戻っている（focus が届かない環境でも、離れたままの扱いにしない）
    document.addEventListener('pointerdown', markBack, { capture: true, passive: true });

    matchmakingBridge.onPly = () => {
        away.count = 0;
        away.ms = 0;
        away.since = 0;
        // 数え直した時点で別の画面にいたら、それも1回に数える
        if (document.hidden || !document.hasFocus()) markAway();
    };

    matchmakingBridge.awayStats = () => ({
        away: away.count,
        awayMs: Math.round(away.ms + (away.since ? Date.now() - away.since : 0)),
    });

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
        renderSeekNote();
        if (els.seekTimer) els.seekTimer.style.display = '';
        if (els.seekCancel) els.seekCancel.style.display = '';
        els.seek.hidden = false;
        // 盤の見出しの場所を先に取る。問題が届いてから出すと、そのぶん盤が下へずれる
        if (els.waitTsumeBar && !tsc.current) {
            els.waitTsumeBar.classList.remove('is-dim');
            els.waitTsumeBar.classList.add('is-pending');
            els.waitTsumeBar.hidden = false;
        }
    }

    function showFoundUi(opponentName, opponentRank) {
        if (!els.seek) return;
        els.seek.classList.add('is-found');
        setSvgHidden(els.seekIconSearch, true);
        setSvgHidden(els.seekIconCheck, false);
        if (els.seekTitleText) els.seekTitleText.textContent = '対戦相手が見つかりました！';
        if (els.seekDots) els.seekDots.style.display = 'none';
        if (els.seekNote) {
            // 敬称の付け方は shogi.js の withHonorific に集約（日本語名にはスペースを挟まない）
            const text = opponentName
                ? withHonorific(opponentName) + 'と対局を始めます'
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

    // 2行目はCOMに切り替わるまでの秒数で3通り。COMを切っている人には終わりの時刻を約束できないので、
    // 文言と数字の意味を変える（待った時間を数え上げる）
    // 狭い画面で2行になるときは「始まります」「待ちます」の前で折る（\u200B が折り返しの位置。Safari にも効く）
    function seekNoteText(botAfter) {
        if (botAfter === null) return '見つかるまで\u200B待ちます';
        return botAfter >= 120 && botAfter % 60 === 0
            ? '最長' + botAfter / 60 + '分で\u200B始まります'
            : '最長' + botAfter + '秒で\u200B始まります';
    }

    function renderSeekNote() {
        if (els.seekNote) els.seekNote.textContent = seekNoteText(mm.botAfter);
        // 「59秒」の「秒」は60秒までの人だけ。2分の人と待った時間は「1:52」の形
        if (els.seekTimerUnit) els.seekTimerUnit.hidden = mm.botAfter === null || mm.botAfter > 60;
    }

    function formatMinSec(seconds) {
        return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    }

    function startCountdown() {
        stopCountdown();
        mm.seekStartedAt = Date.now();
        updateCountdown();
        mm.countdownTimer = setInterval(updateCountdown, 250);
    }

    function updateCountdown() {
        if (!els.seekTimerValue) return;
        const elapsed = Math.max(0, Math.floor((Date.now() - mm.seekStartedAt) / 1000));
        if (mm.botAfter === null) {
            els.seekTimerValue.textContent = formatMinSec(Math.min(elapsed, SEEK_WAIT_CAP_SECONDS));
            return;
        }
        const left = Math.max(0, mm.botAfter - elapsed);
        els.seekTimerValue.textContent = mm.botAfter > 60 ? formatMinSec(left) : String(left);
    }

    // サーバーの知らせ（queued）で、COMまでの秒数と待った時間を合わせ直す。待った時間を引き継いだ人は途中の秒数から、
    // 別の端末で初段に上がった人は正しい秒数で出る。届くまでの通信の遅れ（1秒未満）では数字を戻さない
    function applyQueuedTiming(msg) {
        if (mm.phase !== 'seeking') return;
        if (msg.botAfter === null || typeof msg.botAfter === 'number') mm.botAfter = msg.botAfter;
        if (typeof msg.waitedMs === 'number' && msg.waitedMs >= 0) {
            const serverStart = Date.now() - msg.waitedMs;
            if (Math.abs(serverStart - mm.seekStartedAt) > 1000) mm.seekStartedAt = serverStart;
        }
        renderSeekNote();
        updateCountdown();
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
        // 2026-10-18 以降の画面の印。付けると、初段以上はCOMまで2分になる（古い画面は「最長60秒」と数えているので60秒のまま）
        params.set('v', '2');
        // 相手に自分の段級位を渡さない。サーバーはこれを見て相手側の値を null にする
        if (isRankHidden()) params.set('hr', '1');
        // 対局記録用の端末の種類の見分け。iPad は Mac と同じ名乗り方をするので、タッチ端末かを添える
        if (navigator.maxTouchPoints > 1) params.set('t', '1');
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
        // 端末の控えで先に決めておく（サーバーの queued で直す）。終局直後に届いた段級位も使うので、前の部屋を抜ける前に決める
        mm.botAfter = !isBotFallbackEnabled() ? null
            : reachedRankIndex() >= SHODAN_RANK ? SEEK_BOT_DAN_SECONDS : SEEK_BOT_SECONDS;
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
    // 切れてから3分以内ならサーバーが待った時間を引き継ぐので、数字はそのまま進め、queued の値で合わせ直す
    function handleVisibilityRequeue() {
        if (document.visibilityState !== 'visible') return;
        if (mm.phase !== 'seeking') return;
        const wsAlive = mm.ws && mm.ws.readyState === WebSocket.OPEN;
        if (wsAlive || !mm.wsLostWhileHidden) return;
        mm.wsLostWhileHidden = false;
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

    // code は✕で取り消すときだけ渡す（CANCEL_CLOSE_CODE）。サーバーはそれ以外の close を「切れた」として、待った時間を3分覚える
    function closeQueueWs(markServerClosed, code) {
        stopQueuePing();
        const ws = mm.ws;
        mm.ws = null;
        if (ws) {
            if (markServerClosed) mm.serverClosed = true;
            try {
                if (code) ws.close(code, 'cancel');
                else ws.close();
            } catch (_) { /* ignore */ }
        }
    }

    function handleQueueMessage(msg) {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'queued') {
            if (typeof msg.playing === 'number') applyStats(msg.playing);
            applyQueuedTiming(msg);
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

    // 相手が見つからなかった（1級以下は60秒・初段以上は2分）→ そのままローカルのCOM戦へ（設計書 §6.6）。
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
        plan: null, // COMの作戦（戦法）の状態。チュートリアルは null（作戦を使わない）
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
            started_at: new Date(now).toISOString(),
            ended_at: null,
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
            sente_rank_visible: !tutorial && playerSide === SENTE && !isRankHidden(),
            gote_rank_visible: !tutorial && playerSide === GOTE && !isRankHidden(),
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
        const boardTop = boardTopBeforeFold();
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
        // COMの戦法はいつもおまかせ（AI対戦と同じ袋から引く。AI対戦の「AIの戦法」の好みは使わない）
        local.plan = local.tutorial ? null : { id: drawAiStrategy(), rests: {}, misses: 0, off: false };
        local.tutorialLevel = 0; // 対局ごとにリセット
        local.reqId += 1; // 前局の応答を無効化

        onlineState.token = null; // 念押し。ローカル対局中は絶対に null
        onlineState.roomCode = LOCAL_ROOM_CODE;
        const fake = buildLocalMatchPayload(local.playerSide, opponentName, local.tutorial);
        const recordId = window.crypto?.randomUUID?.()
            || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        window.ShogiRecordsStart?.({
            id: `online-local:${recordId}`,
            startedAt: Date.parse(fake.started_at),
            mode: 'online',
            player: local.playerSide,
            source: local.tutorial ? 'legacy' : 'played',
            opponentName,
            opponentRank: null,
            opponentRating: null,
        });
        applyOnlineMatch(fake, {
            source: 'local',
            roomEpoch: onlineState.roomEpoch,
            expectedRoomCode: LOCAL_ROOM_CODE,
            disconnect: null,
            yourSide: local.playerSide,
        });
        setPhase('game');
        glideBoardFrom(boardTop);
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

    // 一手ごとの持ち時間。サーバーと同じく、締め切りから猶予ぶん過ぎても指していなければ手番側の負け。
    // 時計の表示は締め切りどおり0:00になる（猶予は見せない。設計書 §14）
    const LOCAL_FLAG_GRACE_MS = 1000; // サーバーの FLAG_GRACE_MS と同じ値にそろえる
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
        }, Math.max(0, deadline - Date.now()) + LOCAL_FLAG_GRACE_MS);
    }

    // プレイヤー・COM どちらかの一手が盤に適用されたあとの共通処理
    function afterLocalPly() {
        if (!local.active) return;
        const fake = onlineState.match;
        if (!fake) return;
        if (gameOver) {
            // 詰み・千日手は finalizeMove がダイアログまで出している。メタデータだけ揃える。
            // 連続王手の千日手は王手をかけ続けた側の負け。引き分けで記録・申告しないこと
            // （ダイアログは finalizeMove が同じ checkSennichite() の結果で勝ち負けを出している）
            let won = null;
            let reason = 'sennichite';
            if (typeof checkmate !== 'undefined' && checkmate) {
                won = getOpponent(currentPlayer);
                reason = 'checkmate';
            } else {
                const repetition = checkSennichite();
                if (repetition.isConsecutiveCheck && repetition.checkingPlayer) {
                    won = getOpponent(repetition.checkingPlayer);
                    reason = 'perpetual_check';
                }
            }
            localEndGame(won, reason, { dialogAlreadyShown: true });
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
        if (!local.active || onlineState.match?.game_over) return;
        markNameGameFinished();
        clearLocalTimers();
        local.reqId += 1;
        gameOver = true;
        const fake = onlineState.match;
        if (fake) {
            fake.game_over = true;
            fake.winner = winner ?? 'draw';
            fake.result_reason = reason || fake.result_reason;
            fake.ended_at = new Date().toISOString();
            fake.turn_deadline = null;
            window.ShogiRecordsCapture?.({
                endedAt: Date.parse(fake.ended_at),
                winner: fake.winner === SENTE || fake.winner === GOTE ? fake.winner : null,
                reason: fake.result_reason || 'other',
            });
        }
        updateOnlineUiState();
        // 盤の「動かせる駒」の印と持ち駒の「打てる」見た目を、終局に合わせて両方落とす
        // （syncCapturedDropState() は renderBoard() の中で走るので二重にはならない）
        renderBoard();
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

        // 実力値が付く見込みなら、段位カードの場所を先に取る（返事のあとで差し込むと下の中身がずれる）
        const cached = readCachedRank();
        if (cachedRankIndex() <= BOT_RATED_MAX_RANK) {
            reserveResultRankCard(cachedRankIndex(), cached ? cached.rating : 1500);
        }

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
                if (!json || !json.ok || !json.outcome) {
                    renderResultRankCard(null); // 先に取っておいたカードの場所を返す
                    return;
                }
                const outcome = json.outcome;
                // 先に消す。消す前に applyRankView を呼ぶと、隠れたカードのゲージを描いてしまう
                if (!outcome.rated) renderResultRankCard(null);
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
            .catch(() => {
                // 実力値が付かないだけ。対局結果はもう出ているので、先に取ったカードの場所だけ返す
                renderResultRankCard(null);
            });
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
            local.plan = data.plan ?? null;
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
                aiDifficulty: tuning ? tuning.difficulty : getStandardAiDifficulty(aiDifficulty),
                weakness: tuning ? tuning.weakness : undefined,
                aiPlayer: local.comSide,
                plan: local.plan,
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
    // 使うのは aiDifficulty（読みの深さ easy=1手 / medium=2手 / hard=3手先）と weakness の2つ。
    // weakness は人がやる間違いを写したつまみ（中身は ai-worker.js のコメントを参照）。
    // **強さを動かすのは safeMove（ただ取られる形に気づく割合）**で、
    // これを上げるとユーザーが勝てなくなる。緩めるときはここを下げる
    // weakness を渡さなければ難易度の既定値になり、easy ＝ AI対戦の「初級」と同じ挙動。
    // 駒の点数はエンジン側の評価値と同じ尺度（歩100・銀500・金600・角800・飛900）。
    // 🟡 しきい値は実プレイ調整前提（設計書 §6.7 / §14）
    // 調整は「ユーザーが劣勢のときだけ緩める」一方向。
    // ユーザーがリードしても強くはならない（追い上げは廃止）
    // 🔴 以前ここで使っていた benchmarkRandomness（最善から一定点以内の手からランダムに選ぶ）は
    //    使わない。値を上げると弱くはなるが、持ち駒の角を自陣の隅に打つ・意味なく香を上げる
    //    といった、初心者の目にも明らかにおかしい手が出る（自己対局の棋譜で確認済み）。
    //    呼び出し元が無くなったのでエンジン側からも削除した。
    const TUTORIAL_LEVELS = [
        // ユーザーの駒得がこの値以上なら、この設定を使う（上から順に判定）
        { minDiff: -300, difficulty: 'easy', weakness: null },  // 互角〜ユーザー優勢 → AI対戦の「初級」と同じ
        { minDiff: -800, difficulty: 'easy', weakness: { exchange: 0, safeMove: 0.35, safeDrop: 1, dropBlind: 0.7, farCapture: 1 } },  // 劣勢 → 緩める
        { minDiff: -Infinity, difficulty: 'novice', weakness: null }, // 大劣勢 → AI対戦の「入門」と同じ
    ];

    // ユーザーが持ち時間（1手30秒）の残り10秒を切って指したら、駒得に関係なくここまで落とす
    const TUTORIAL_TIME_PRESSURE_MS = 10000;
    const TUTORIAL_TIME_PRESSURE_LEVEL = 1; // 真ん中の段（easy を緩めたもの）

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
    // 公開済みの過去問（/tsume/challenge.json・1〜13手詰）を本物の盤で出題する。
    // 5手詰までは余詰が禁止されており、7手以上は「途中に別の正解がなく、正解の一覧に抜けもない」と
    // 毎日の詰将棋ジョブが確かめた問題だけが入っている（§7.1）ので、正誤判定は line[ply].accept との照合だけでよい。

    const WAIT_TSUME_LEVEL_KEY = 'shogi_wait_tsume_level'; // '1' | '3' | … | '13'
    const WAIT_TSUME_SEEN_KEY = 'shogi_wait_tsume_seen';   // 出題済みidの配列（最大100件FIFO）
    const WAIT_TSUME_HINT_KEY = 'shogi_wait_tsume_hint';   // 初回トーストを出したか
    const TSUME_REPLY_DELAY_MS = 600;                       // 玉方の応手の間
    const WAIT_LEVELS = [1, 3, 5, 7, 9, 11, 13];
    // 詰将棋ページの難易度と手数（scripts/tsume/config.ts の LEVEL_MOVES と同じ対応）。初期段の推定に使う
    const TSUME_LEVEL_MOVES = {
        beginner: 1, intermediate: 3, advanced: 5, expert: 7, master: 9, great: 11, transcendent: 13,
    };

    const tsc = {
        problems: null,  // challenge.json の配列（未取得: null / 取得失敗: false）
        level: null,     // 1 | 3 | 5
        current: null,   // 出題中の問題
        ply: 0,          // 攻方の何手目か（line のインデックス）
        busy: false,     // 玉方の応手待ち
        flawless: true,  // この問題でミス無しか
        cleanStreak: 0,  // 一発正解の連続数（セッション内メモリのみ・設計書 §7.3）
        retry: null,     // まちがえずに途中で終わった問題。次の待ち時間に1回だけ最初から出し直す（§7.3）
        retrying: false, // いま出しているのが出し直しの問題か
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

    // 初期段は詰将棋ページの実績から推定する。解いた記録のある一番長い手数から始める（設計書 §7.3）
    function inferInitialWaitLevel() {
        const stored = Number(lsGet(WAIT_TSUME_LEVEL_KEY));
        if (WAIT_LEVELS.includes(stored)) return stored;
        let longest = 1;
        try {
            const raw = lsGet('shogi_tsume_v1');
            const days = raw ? JSON.parse(raw)?.days : null;
            if (days && typeof days === 'object') {
                for (const date of Object.keys(days)) {
                    const day = days[date] || {};
                    for (const [level, moves] of Object.entries(TSUME_LEVEL_MOVES)) {
                        if ((day[level] === 'clean' || day[level] === 'solved') && moves > longest) longest = moves;
                    }
                }
            }
        } catch (_) { /* ignore */ }
        return longest;
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
        presentNextTsume();
        if (!lsGet(WAIT_TSUME_HINT_KEY)) {
            try { localStorage.setItem(WAIT_TSUME_HINT_KEY, '1'); } catch (_) { /* ignore */ }
            showWaitToast('対局が始まると自動で中断します');
        }
    }

    /** その段の在庫。無ければ短い段を長い順に、それも無ければ長い段を短い順に探して代用する（7手以上は在庫が0の日がありうる） */
    function poolForLevel(level) {
        const at = WAIT_LEVELS.indexOf(level);
        const order = [
            ...WAIT_LEVELS.slice(0, at + 1).reverse(),
            ...WAIT_LEVELS.slice(at + 1),
        ];
        for (const moves of order) {
            const pool = tsc.problems.filter((p) => p.moves === moves);
            if (pool.length) return pool;
        }
        return [];
    }

    function presentNextTsume() {
        // まちがえずに途中で終わった問題は、次の待ち時間に1回だけ最初から出し直す
        let problem = tsc.retry;
        tsc.retrying = problem !== null;
        tsc.retry = null;
        if (!problem) {
            const pool = poolForLevel(getWaitLevel());
            if (!pool.length) {
                document.body.classList.add('mm-no-tsume');
                return;
            }
            const seen = readSeenIds();
            const unseen = pool.filter((p) => !seen.includes(p.id));
            const pickFrom = unseen.length ? unseen : pool; // 使い切ったら再利用（設計書 §7.3）
            problem = pickFrom[Math.floor(Math.random() * pickFrom.length)];
            rememberSeen(problem.id);
        }

        tsc.current = problem;
        tsc.ply = 0;
        tsc.busy = false;
        tsc.flawless = true;
        setupTsumePosition(problem);
        updateWaitBar();
        if (els.waitTsumeBar) {
            els.waitTsumeBar.classList.remove('is-dim', 'is-pending');
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
            // 適用前に弾くので巻き戻しは不要。段下げはその場で1問につき1回まで
            // （試行錯誤のたびに下げると数回で1手詰まで落ちてしまう）。この問題は出し直さない
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
        if (tsc.current && tsc.flawless) {
            // まちがえずに途中で終わった。1手でも指していれば次の待ち時間に1回だけ出し直し、段は下げない。
            // 出し直しも途中で終わったら1段下げる。1手も指す前なら段は下げず、出し直しの問題は次もう一度出す。
            // まちがえた問題はその場で1段下げてあるので、ここでは何もしない（出し直さない・追加で下げない）
            const played = tsc.ply > 0 || tsc.busy;
            if (!played) {
                if (tsc.retrying) tsc.retry = tsc.current;
            } else if (tsc.retrying) {
                tsc.cleanStreak = 0;
                bumpWaitLevel(-1);
            } else {
                tsc.retry = tsc.current;
            }
        }
        const shown = tsc.current !== null;
        tsc.current = null;
        tsc.busy = false;
        syncCapturedDropState(); // 盤が見えたまま中断することがあるので、ここでも見た目を合わせる
        document.body.classList.remove('mm-no-tsume');
        hideWaitToast();
        if (els.waitTsumeBar) {
            // 問題を出す前に相手が決まったときは、中身（HTMLに書いてある仮の手数）を隠したまま場所だけ残す
            if (shown) els.waitTsumeBar.classList.remove('is-pending');
            if (dim) els.waitTsumeBar.classList.add('is-dim');
            else els.waitTsumeBar.hidden = true;
        }
    }

    function updateWaitBar() {
        // 玉方の応手が終わっても盤は描き直されないので、持ち駒の「打てる」見た目はここで合わせる
        // （tsc.busy の付け外しは必ずこの関数を通る）。shogi.js 側の関数
        syncCapturedDropState();

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

    // 対局保存に1手でも指した記録があるか。
    // 🔴 対局保存はページを開いただけでも0手の状態で書かれるので、キーの有無では判定しない。
    // キーの有無で見ていた頃は、AI対戦・将棋盤を先に開いた新規の人がみな免除になっていた
    function hasPlayedMoves(key) {
        const raw = lsGet(key);
        if (!raw) return false;
        try {
            const saved = JSON.parse(raw);
            if (!saved || typeof saved !== 'object') return false;
            if (Array.isArray(saved.moves)) return saved.moves.length > 0; // v2 形式
            return (Number(saved.moveCount) || 0) > 0; // 旧形式
        } catch (_) {
            return false;
        }
    }

    function seedLegacyExemption() {
        if (lsGet(EXEMPT_KEY) !== null) return;
        // 「実際に遊んだ痕跡」だけを見る。shogi_ai_difficulty や表示設定は
        // 初回ロードでデフォルト値が自動保存されるため、免除判定には使えない
        const legacyKeys = [
            'shogi_unlocked_levels', // 超級以上のクリアで書かれる
            'shogi_friend_side',     // 友達対戦の設定変更で書かれる
            'shogi_tsume_v1',        // 詰将棋の解答記録
        ];
        const isLegacy = hasPlayedMoves('shogi_game_state') // AI対戦の対局保存
            || hasPlayedMoves('shogi_game_state_pvp')       // 2人対戦の対局保存
            || legacyKeys.some((k) => lsGet(k) !== null);
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

    // ---- 初段からの確認「対戦相手の探し方」（設計書 §6.6） ----------------------------
    // 初段以上は、コンピュータに回らず実力の近い相手を待つのを既定にする。コンピュータの設定を
    // 一度も自分で変えていない人（保存値が無い＝今オンの人）にだけ、探し始める前に1回出す。
    // OKで設定に保存するので次からは出ない。✕は探さず何も保存しない（結果画面から開いたときも結果画面はそのまま）

    const SEARCH_CHOICE_UNCHECK_MS = 600; // 開いてからチェックを外すまで。オンからオフへ動くのを見せる
    let searchChoice = null; // 開いている間だけ { onOk, touched, timer, returnFocus }

    function needsSearchChoice() {
        let stored;
        try { stored = localStorage.getItem(BOT_FALLBACK_KEY); } catch (_) { return false; } // 保存できない端末では毎回出てしまう
        return stored === null && reachedRankIndex() >= SHODAN_RANK;
    }

    function buildSearchChoice() {
        const modal = document.createElement('div');
        modal.id = 'mm-search-modal';
        modal.hidden = true;
        modal.innerHTML =
            '<div class="settings-modal-backdrop" data-mm-search-close></div>' +
            '<div class="settings-modal-card mm-search-card" role="dialog" aria-modal="true" aria-labelledby="mm-search-title" aria-describedby="mm-search-lead">' +
            '<div class="settings-modal-header">' +
            '<h3 class="settings-title" id="mm-search-title">対戦相手の探し方</h3>' +
            '<button type="button" class="settings-modal-close-btn" data-mm-search-close aria-label="閉じる">✕</button>' +
            '</div>' +
            // 折り返しは言葉の切れ目（<wbr>）だけにする。Safari は word-break: auto-phrase を知らず、語の途中で折るため
            '<p class="mm-search-lead" id="mm-search-lead">初段からは、<wbr>実力の近い<wbr>相手が<wbr>見つかるまで<wbr>待つのが<wbr>おすすめです。</p>' +
            '<label class="settings-item mm-search-option" id="mm-search-option">' +
            '<span class="settings-text"><span class="settings-name" id="mm-search-name">相手が<wbr>いないときは<wbr>コンピュータと<wbr>対局</span>' +
            '<span class="settings-sub" id="mm-search-note">オンのときは、<wbr>2分たっても<wbr>実力の近い<wbr>相手が<wbr>見つからなければ<wbr>コンピュータと<wbr>対局します。<wbr>' +
            'コンピュータとの<wbr>対局では<wbr>実力値は<wbr>変わりません。<wbr>あとから<wbr>設定でも<wbr>変えられます。</span></span>' +
            '<input type="checkbox" id="mm-search-bot" aria-labelledby="mm-search-name" aria-describedby="mm-search-note" />' +
            '</label>' +
            '<button type="button" class="kifu-primary-wide mm-search-ok" id="mm-search-ok">OK</button>' +
            '</div>';
        document.body.appendChild(modal);
        modal.addEventListener('click', (ev) => {
            if (ev.target instanceof Element && ev.target.closest('[data-mm-search-close]')) closeSearchChoice();
        });
        const checkbox = document.getElementById('mm-search-bot');
        checkbox.addEventListener('change', () => {
            // 自分で触ったら、その状態を選んだことにする（あとから自動で外さない）
            if (!searchChoice) return;
            searchChoice.touched = true;
            clearTimeout(searchChoice.timer);
        });
        const option = document.getElementById('mm-search-option');
        option.addEventListener('animationend', () => option.classList.remove('is-flash'));
        document.getElementById('mm-search-ok').addEventListener('click', confirmSearchChoice);
        return modal;
    }

    function handleSearchChoiceKeydown(ev) {
        if (ev.key === 'Escape') {
            ev.preventDefault();
            closeSearchChoice();
            return;
        }
        if (ev.key !== 'Tab') return;
        const modal = document.getElementById('mm-search-modal');
        const focusables = [...modal.querySelectorAll('button, input')].filter((el) => el.offsetParent !== null);
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

    /** onOk はOKのあとに呼ぶ（探し始める。結果画面から開いたときは結果画面を閉じてから） */
    function openSearchChoice(onOk) {
        if (searchChoice) return;
        const modal = document.getElementById('mm-search-modal') || buildSearchChoice();
        const checkbox = document.getElementById('mm-search-bot');
        const option = document.getElementById('mm-search-option');
        // 開いた直後はオン、0.6秒後に外れて行が淡く光る。「視差効果を減らす」の端末では最初から外して光らせない
        const reduced = prefersReducedMotion();
        checkbox.checked = !reduced;
        option.classList.remove('is-flash');
        searchChoice = {
            onOk,
            touched: false,
            timer: reduced ? null : setTimeout(() => {
                if (!searchChoice || searchChoice.touched) return;
                checkbox.checked = false;
                option.classList.add('is-flash');
            }, SEARCH_CHOICE_UNCHECK_MS),
            returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        };
        modal.hidden = false;
        watchModalBands(modal); // 上下のアンカー広告の下に見出しと✕が潜らないよう、帯の高さを余白に入れる
        document.body.classList.add('modal-open');
        document.addEventListener('keydown', handleSearchChoiceKeydown);
        document.getElementById('mm-search-ok').focus({ preventScroll: true });
    }

    function closeSearchChoice() {
        const modal = document.getElementById('mm-search-modal');
        if (!searchChoice || !modal) return;
        clearTimeout(searchChoice.timer);
        const { returnFocus } = searchChoice;
        searchChoice = null;
        modal.hidden = true;
        stopModalBands(modal);
        document.body.classList.remove('modal-open');
        document.removeEventListener('keydown', handleSearchChoiceKeydown);
        if (returnFocus && returnFocus.offsetParent !== null) returnFocus.focus({ preventScroll: true });
    }

    function confirmSearchChoice() {
        if (!searchChoice) return;
        // 外れる前にOKを押しても、チェックに触れていなければオフ（おすすめのほう）で保存する
        const on = searchChoice.touched && document.getElementById('mm-search-bot').checked;
        const { onOk } = searchChoice;
        try { localStorage.setItem(BOT_FALLBACK_KEY, on ? '1' : '0'); } catch (_) { /* 保存できなくても探し始める */ }
        // 設定モーダルのチェックも合わせる（ページを開いたときの値のままにしない）
        const settingsCheckbox = document.getElementById('bot-fallback-checkbox');
        if (settingsCheckbox) settingsCheckbox.checked = on;
        // 値の意味は設定の「設定を変えた」と同じ。どこで選んだかだけ足す（OKのたびに送る）
        track('setting_change', { setting: 'bot_fallback', result: on ? 'on' : 'off', from: 'dialog' });
        closeSearchChoice();
        onOk();
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
                const boardTop = boardTopBeforeFold();
                hideSeekUi();
                if (els.waitTsumeBar) els.waitTsumeBar.hidden = true;
                setPhase('game');
                glideBoardFrom(boardTop);
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
        closeQueueWs(true, CANCEL_CLOSE_CODE); // 取り消しの印を付けて閉じる（サーバーは待った時間を覚えない）
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
        markNameGameFinished();
        mm.lastMatchType = match && match.match_type === 'matchmaking' ? 'matchmaking' : 'invite';
        // 対局が終わった直後だけ実力値を取り直す（30秒ごとのポーリングには乗せない）
        if (mm.lastMatchType === 'matchmaking') refreshStats({ withRating: true });
        // マッチング対戦は「もう一度」で自動再キュー。友達対戦は従来のまま
        setNewGameLabel(mm.lastMatchType === 'matchmaking' ? 'もう一度対戦する' : '次のゲームへ');
    };

    matchmakingBridge.handleNewGame = () => {
        // 初段からの確認は結果画面の上に出す。✕なら結果画面もローカル対局の後片付けもそのまま（OKで再キュー）
        if (mm.lastMatchType === 'matchmaking' && needsSearchChoice()) {
            openSearchChoice(requeueAfterGame);
            return true;
        }
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
        requeueAfterGame();
        return true;
    };

    /** 結果画面の「もう一度対戦する」= 再キュー */
    function requeueAfterGame() {
        if (local.active) exitLocalMatch();
        mm.lastMatchType = null;
        setNewGameLabel('次のゲームへ');
        if (typeof hideGameOverDialog === 'function') hideGameOverDialog();
        beginSeek(); // 内部で前の部屋から抜ける
    }

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
                if (needsSearchChoice()) {
                    openSearchChoice(beginSeek);
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
