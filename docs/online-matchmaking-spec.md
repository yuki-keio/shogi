# 「だれかと対戦」+ チュートリアル 実装設計書

最終更新: 2026-08-13 / 対象リポジトリ: `web_shogi`

この文書は**実装者（人・AI）が読んで手を動かすための仕様**で、**この1ファイルで完結**しています
（設計を検討したときのUIモックは一時ファイルで、もう残っていません。**寸法・配色・マークアップの
唯一の情報源はこの文書**です。完全なCSSは §13 にあります）。

決定事項はすべて §1〜§13 に書き込んであり、**未決事項はありません**（§12 に決定履歴）。
迷ったらこの文書の記述を優先し、ここに無い判断をしたら**この文書に追記してから**進めてください。

**命名規則**: 内部の識別子に**ランダム前提の語（`quick` / `random` / `casual`）を使わない**。将来レート戦に組み直す可能性があるので、組み合わせ方が変わっても意味が変わらない**機構ベースの名前**にする。
招待URL経由 = `invite`、サーバーが相手を割り当てる = `matchmaking`（CSSクラスとIDの接頭辞は `mm-`）。

記号: 🟢 実コードで確認済み / 🟡 判断が必要・要チューニング / 🔴 リスク

---

## 1. 作るもの / 作らないもの

| | 内容 |
|---|---|
| **作る** | ①相手を自動で割り当てる対戦（マッチング）②待機中の詰めチャレンジ ③チュートリアル対局 ④解放ゲート ⑤表示名の入力とNG語フィルタ（**友達対戦でも表示する**）⑥「N人が対局中」表示 |
| **作らない** | レート・ランキング／チャット／通報・ブロック・BAN／新しいページ（すべて `/online/` 内で完結）／即投了の連戦を抑える仕組み（2026-08-13 に「不要」で決定） |

対局そのものは**既存の `MatchRoom`（Durable Object）をそのまま使う**。サーバー権威の合法手検証・持ち時間・
切断60秒猶予・再接続・投了はすべて実装済みで、**一手30秒も実装済み**（`tc_type: "per_move"`, `tc_seconds: 30`）。
新規に書くのは**マッチングだけ**。

---

## 2. 前提として確認済みの既存実装 🟢

| 事実 | 場所 |
|---|---|
| 部屋作成 RPC `stub.createRoom({roomCode, uid, displayName, sidePref, tcType, tcSeconds})` → `{ok, match, yourSide, disconnect}` | `src/worker/match_room.ts:428` 付近 / 呼び出し例 `src/worker/index.ts:355` |
| 参加 RPC `stub.join({uid, displayName})` | `src/worker/match_room.ts:472` |
| DO stub の取り方 `env.MATCH_ROOM.getByName(roomCode)` | `src/worker/index.ts:356` |
| 部屋コード生成 `generateRoomCode(10)`（`A-Z2-9`・0/O/1/I なし） | `src/worker/room.ts` |
| 座席トークン `signPlayerToken({roomCode, side, uid, exp}, env.TOKEN_SECRET)` / `issueToken()` | `src/worker/token.ts:45` / `index.ts:142` |
| **表示名はサーバー実装済み**。`MatchPayload.sente_name / gote_name` として全クライアントへ配信される | `src/worker/protocol.ts:26` / DBカラムは `match_room.ts:109` |
| 表示名の現状の正規化は **trim + 40文字**だけ（フィルタなし） | `src/worker/index.ts:101 normalizeDisplayName()` |
| **クライアントは表示名を送信も表示もしていない**（`shogi.js` に `displayName` の参照ゼロ） | 実測 |
| create/join の IPレート制限あり | `src/worker/index.ts:80 isRateLimited()` |
| 対局WSのURL `/api/rooms/{code}/ws?token=…` | `shogi.js:838` |
| 部屋入場後の合流処理 `applyOnlineMatch(match, {source, roomEpoch, expectedRoomCode, disconnect, yourSide})` → `onlineConnectWs()` | `shogi.js:975` / `shogi.js:830` |
| ロビー状態では盤・手番表示・操作ボタンが非表示（`body.online-lobby`） | `index.html` の Critical CSS |
| AI難易度は standard エンジンが `easy/medium/hard/super`、`master` 以上が yaneuraou（WASM） | `shogi.js:51 DIFFICULTY_LEVELS` / 判定は `isYaneuraouDifficulty()` `shogi.js:78` |
| 詰将棋の過去問は `/tsume/days/YYYY-MM-DD.json` で静的配信（直近30日・1週間キャッシュ） | `build-pages.mjs:28 TSUME_ARCHIVE_DAYS` / `dist/_headers` |
| **5手詰まで**は余詰が無い（攻方の全分岐で詰む手が一意）。7手以上は余詰を許容している | `scripts/tsume/config.ts: YOZUME_STRICT_MAX_MOVES = 5` |
| 詰将棋の解答記録は日付ごと（`shogi_tsume_v1` の `days`）。過去問でも✓と累計が残り、連続日数は当日ぶんだけ動く。**この改修は2026-08-12に完了済みなので作り直さない** | `shogi-tsume.js` の `readTsumeProgress()` / `recordTsumeSolved()` |

---

## 3. 追加・変更するファイル

| ファイル | 種別 | 内容 |
|---|---|---|
| `src/worker/matchmaker.ts` | 新規 | Matchmaker DO（キュー・ペアリング・部屋作成・対局中カウント） |
| `src/worker/name_filter.ts` | 新規 | リバーシの `name_filter.js` の TS 移植 |
| `src/worker/index.ts` | 変更 | ルート追加 `GET /api/match/ws`, `GET /api/online-stats`、`normalizeDisplayName` の強化 |
| `src/worker/match_room.ts` | 変更 | `matchType` の保持と配信（最小変更） |
| `wrangler.jsonc` | 変更 | DO binding `MATCHMAKER` + migration `v2` |
| `name-filter.js` | 新規 | クライアント側フィルタ（リバーシの JS をほぼそのまま） |
| `online-match.js` | 新規 | クライアント: キュー接続・待機UI・詰めチャレンジ・チュートリアル・ゲート判定 |
| `shogi.js` | 変更 | フックの追加のみ（§6.1）。ロジック本体は `online-match.js` に置く |
| `index.html` | 変更 | ロビー・待機のマークアップ、Critical CSS |
| `style.css` | 変更 | ファーストビュー外のスタイル |
| `build.sh` / `service-worker.js` | 変更 | 新規JSのハッシュ付与とキャッシュ登録 |
| `build-pages.mjs` | 変更 | 詰めチャレンジ用データの書き出し（§8） |
| `pages/article.online.html` | 変更 | SEO記事に説明とFAQを追記 |
| `test/matchmaker.spec.ts` | 新規 | ペア成立・キャンセル・二重登録・タイムアウト |
| `test/name_filter.spec.ts` | 新規 | リバーシのケーステーブルを流用したパリティテスト |
| `test/fixtures/name_filter_cases.json` | 新規 | 上のケーステーブル本体（リバーシからコピー） |

---

## 4. サーバー: Matchmaker DO

### 4.1 全体の流れ

```
クライアント                     Worker                    Matchmaker DO           MatchRoom DO
    │  GET /api/match/ws ─────────▶│ レート制限 → uid検証         │                        │
    │                              │ getByName("global") ───────▶│ キューに追加            │
    │  ◀─ {type:"queued", …} ──────────────────────────────────  │                        │
    │                                                            │ 2人揃った              │
    │                                                            │ createRoom ───────────▶│ 部屋作成（matchmaking）
    │                                                            │ join ─────────────────▶│
    │  ◀─ {type:"matched", room_code, token, yourSide, opponentName} ─                     │
    │  （このWSは閉じる。以降は既存の /api/rooms/{code}/ws で対局）                          │
```

### 4.2 エンドポイント 🟢

```
GET /api/match/ws?uid=<uid>&name=<displayName>&bot=1
  Upgrade: websocket
```

- `uid` は既存の `isValidUid()`（`/^[0-9a-zA-Z-]{8,64}$/`）で検証。不正なら 400。
- `bot=0` はCOMフォールバックOFFの人（§6.6）。この接続には60秒の `bot` を送らず、待機を続ける。
- `name` は空でも可。**サーバー側で §5 の正規化とNG語伏せ字を必ず通す**（クライアントの値を信用しない）。
- レート制限: `queue:${ip}` で **1分に10回**まで（`RATE_MAX_JOINS` と同じ仕組みを流用）。超過は 429。
- インスタンスは1つ: `env.MATCHMAKER.getByName("global")`。

```
GET /api/online-stats  →  200 {"playing": 3}
```
- キャッシュヘッダは `no-store`。エラー時は `{"playing": 0}` を返して**クライアントを壊さない**。

### 4.3 サーバー → クライアント メッセージ

```jsonc
{ "type": "queued",  "playing": 3 }                    // 接続直後。playing は §4.6
{ "type": "matched", "room_code": "ABCD234XYZ",
  "token": "<jwtライク>", "yourSide": "sente",
  "opponentName": "yamada" }                            // 成立。直後にサーバーがcloseする
{ "type": "bot" }                                       // 60秒たっても相手が居ない
{ "type": "error",   "error": { "code": "…", "message": "…" } }
```

- クライアント → サーバーのメッセージは**無し**。キャンセルは WS を閉じるだけ。
- ping/pong は対局WSと同じ扱い（クライアントが `"ping"` を送ったら `"pong"` を返す）。
- `matched` / `bot` を送ったら**サーバー側から close(1000)** する。キューからも消す。

### 4.4 ペアリング仕様 🟢

1. **FIFO**。先に並んだ2人を組む。レートが無いので待ち時間の公平性だけを見る。
2. **同じ uid は同時に1つだけ**。既にキューに居る uid が再接続してきたら、**古いソケットを閉じて新しい方を残す**
   （タブを開き直したときに詰まらないようにする）。自分同士のマッチは絶対に作らない。
3. 成立時の処理（この順序で行う）:
   - `roomCode = generateRoomCode(10)`
   - `createRoom({roomCode, uid: A.uid, displayName: A.name, sidePref: "random", tcType: "per_move", tcSeconds: 30, matchType: "matchmaking"})`
     → 返ってきた `yourSide` が A の手番。**先後は DO 側の `sidePref: "random"` 解決に任せる**（自前で振らない）。
     この `"random"` は**先後の振り分け**を指す既存APIの値なので、命名規則の対象外。そのまま使う。
   - `join({uid: B.uid, displayName: B.name})` → B の手番は A の逆。
   - 両者ぶんの `signPlayerToken({roomCode, side, uid, exp: now + 24h}, env.TOKEN_SECRET)`
   - 双方に `matched` を送って close。`activeRooms` に記録（§4.6）。
   - **どこかで失敗したら**両者に `{type:"error", error:{code:"match_failed"}}` を送って close。
     クライアントは「もう一度お試しください」を出してロビーへ戻す（キューには自動復帰しない）。
4. **60秒タイムアウト**: 各ソケットに `queuedAt` を持ち、DO alarm（1秒間隔ではなく**5秒間隔**で十分）で
   経過60秒を超えたソケットに `bot` を送って close。
   `bot=0`（フォールバックOFF）の接続は対象外だが、**10分**で `{type:"error", error:{code:"queue_timeout"}}`
   を送って close する（ゾンビソケットを残さない）。クライアントは「時間をおいて試してください」を出す。

### 4.4.1 「相手が接続してこない」ケースは追加実装が不要 🟢

**マッチするのは、その瞬間に Matchmaker と WebSocket でつながっている2人だけ**なので、
「最初から居ない相手」と組まれることはない。危ないのは *成立してから対局WSを張るまでの受け渡し（1秒程度）*
の間にタブが落ちる、という細い窓だけ。そこは**既存の切断ルールがそのまま効く**ので、新しい仕組みは作らない。

根拠（実コードで確認済み）:

- Matchmaker は成立時に `createRoom` と `join` を呼ぶので、**その時点で両席が埋まる**。
- `started = bothSeated(row) && !row.game_over`（`match_room.ts:228`）なので **`started` が即 true**。
- `createRoom` / `join` は `last_seen_sente` / `last_seen_gote` を**その時刻で埋める**（`match_room.ts:496`）。
- `evaluateDisconnect()` は `started` かつ `last_seen` が60秒古い側を負けにする（`disconnect.ts:5,51`）。
  alarm でも評価されるので、片方が一度も接続しなくても**60秒後に接続した側の勝ちで自動終局**する。
- 両方来なければ引き分けになり、部屋は24時間で expire する。

🟡 残る体験上のコスト: 相手が来なかった側は**最大60秒**、駒が動かない盤を見て待つことになる。
頻度は低いので今回は許容する。気になるようになったら
「10手目までに相手が一度も接続していなければ30秒で不成立にしてキューへ戻す」等を後から足せる。

### 4.5 状態の持ち方 🟡

キュー自体は**メモリ上の配列で良い**（DOが落ちたら待機者は全員切断されるので、復元する意味がない）。
WebSocket Hibernation を使う場合は `state.getWebSockets()` から復元できるよう、
**`serializeAttachment()` に `{uid, name, queuedAt}` を持たせる**こと。

対局中カウント用の `activeRooms` だけは SQLite に置く（`state.storage.sql`）:

```sql
CREATE TABLE IF NOT EXISTS active_rooms (
  room_code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL  -- epoch ms
);
```

### 4.6 「N人が対局中」 🟡

- 定義: **直近15分に Matchmaker が作った部屋の数 × 2 + 現在の待機人数**。
- 読むたびに `created_at < now - 15分` の行を削除する。
- 部屋が実際に終わったかどうかは追わない（MatchRoom からの通知を作らない）。**近似値**であることを許容する。
- クライアントは `playing >= 1` のときだけ表示する。0人のときは行ごと出さない。

### 4.7 MatchRoom への変更（最小限）🟡

- `createRoom` のパラメータに `matchType?: "invite" | "matchmaking"`（既定 `"invite"`）を追加。
- `match` テーブルに `match_type TEXT NOT NULL DEFAULT 'invite'` を追加。**既存の部屋があるので DEFAULT 必須**。
- `MatchPayload` に `match_type: "invite" | "matchmaking"` を追加。
- 使うのはクライアントの分岐2箇所だけ（招待URLを出さない／終局後の「もう一度」が再キューになる）。
- 🔴 **本番稼働中のコードなので、変更後は §10 のリグレッション確認を必ず行う。**

### 4.8 wrangler.jsonc

```jsonc
"durable_objects": { "bindings": [
  { "name": "MATCH_ROOM", "class_name": "MatchRoom" },
  { "name": "MATCHMAKER", "class_name": "Matchmaker" }
]},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["MatchRoom"] },
  { "tag": "v2", "new_sqlite_classes": ["Matchmaker"] }
]
```
`v1` は**絶対に書き換えない**（既存クラスの再定義になる）。追記のみ。

---

## 5. 表示名とNG語フィルタ

### 5.1 入力できる文字 🟢

- **半角英数字と `_` `-` `.` のみ・最大10文字**。日本語・絵文字・ゼロ幅/制御文字は**入力段階で落とす**。
  整形はサーバー（§5.3）と同じ **NFKC → 許可文字以外を除去 → 10文字**の順（全角英数 `ＹＵＫＩ` は `YUKI` として残る）。
- 未入力のときの表示は「プレイヤー」。保存先は localStorage `shogi_player_name`。
- 文字数カウンタは**出さない**（`maxlength` で足りる）。
- **入力欄の下に注記を常時出す**（`#player-name-hint`・11.5px）: 通常は「半角英数字のみ・10文字まで」。
  文字が落ちたときだけ理由に差し替えてアクセント色にし、4.5秒で戻す
  （日本語→「日本語は使えません（半角英数字のみ）」／他→「その文字は使えません（半角英数字のみ）」／
  長さ→「10文字までです」）。**制約を画面に出さないまま黙って消すのは不可**。
- 🟢 **IME（日本語入力）の変換中は `value` を書き換えない**（2026-08-16 決定）。`input` は変換確定前にも
  発火する（`isComposing: true`）ため、そこで整形すると変換中の文字が消えて日本語が打てなくなる。
  `compositionstart` / `compositionend` で挟み、**確定後・`blur` 時**にだけ整形＋保存する
  （`blur` は変換したまま CTA を押した場合の保険。保存は `getStoredPlayerName()` が読む）。

### 5.2 フィルタの移植元 🟢

| 移植元（リバーシ） | 移植先 |
|---|---|
| `/Users/yuki/Codes/web_othello/game/static/game/name_filter.js`（10.5KB） | `name-filter.js`（ほぼそのまま） |
| 同ファイルの Python 版 `/Users/yuki/Codes/web_othello/game/name_filter.py`（10.5KB） | `src/worker/name_filter.ts`（TSへ移植） |
| `/Users/yuki/Codes/web_othello/dev/name_filter_cases.json`（4.5KB） | `test/fixtures/name_filter_cases.json` にコピーし vitest から読む（`dev/` は .gitignore 対象なので置かない） |

🟢 **参照するのは最新版**（リバーシ側リポジトリの `993617b`・2026-08-13 時点）。
`k` を `c` で綴る回避（`manco` / `chinco` / `tinco` / `unco`）を含む更新後の辞書であることを実物で確認済み。
**古い版をどこかからコピーしてこないこと。** 移植したら、ファイル冒頭に
「移植元: web_othello `game/static/game/name_filter.js` / コピー日 YYYY-MM-DD / コミット `<hash>`」を書く。

- 中身: NFKC正規化 → leet変換（`b1tch→bitch`）→ 文字伸ばし正規化（`fuuuck`）→ 部分一致辞書 → 許容リストで誤爆回避
  （`classmate` の `ass` はOK等）→ 該当部分を `＊` に伏せ字。
- **日本語文字の辞書（JP_WORDS）は移植不要**。§5.1 で日本語を入力できないため。
  ローマ字の日本語NG（`kuso` 等）は英字辞書側に入っているのでカバーされる。
- **クライアントとサーバーの両方で同じ判定を行う**。クライアントは入力プレビュー用、
  サーバーが本命（WS直叩きでの回避を防ぐ）。
- パリティは `test/fixtures/name_filter_cases.json` を vitest から読んで担保する（リバーシと同じ手法）。
  移植元は現在も更新されているので、**コピーした日付をファイル冒頭にコメントで書く**こと。

### 5.3 サーバー側の適用箇所

`src/worker/index.ts` の `normalizeDisplayName()` を次の順序に変更する:

1. `String` でなければ `null`
2. NFKC正規化 → 許可文字以外を除去 → 10文字に切る
3. `maskBadWords()`（`name_filter.ts`）を通す
4. 空文字になったら `null`

これは **create / join / match の3経路すべて**が通る唯一の入口にする（現状 create と join は同じ関数を通っている）。

### 5.4 表示名は友達対戦でも出す 🟢（2026-08-13 決定）

サーバーは既に対応済みなので、クライアント側の3点だけで済む。

1. **送る**: `ensureFriendRoom()`（`shogi.js:1219`）の body と `onlineJoinRoom()`（`shogi.js:1317`）の body に
   `displayName: getPlayerName()` を追加する。
2. **表示する**: 相手名があれば「相手の手番です。」→「**yamada さんの手番です。**」にする。
   自分の名前は出さない（画面に自分の名前を出す意味がない）。
   ⚠️ **この2番は場所を間違えている**（2026-08-17 訂正・§14「表示名の出し先」参照）。
   `updateOnlineUiState()` の状態テキストは `#online-settings` の中にあり対局中は隠れているので、
   実際の出し先は**対局者バー**と**終局ダイアログ**。
3. **入力欄はロビー共通**。§6.3 の `#player-name` 1つを、マッチング対戦と友達対戦の両方で使う。

`MatchPayload.sente_name / gote_name` から相手側の名前を選ぶヘルパを `online-match.js` ではなく
**`shogi.js` 側に置く**（友達対戦でも使うため。`/online/` 以外では呼ばれないので実害はない）。

---

## 6. クライアント設計

### 6.1 ファイル分割と `shogi.js` へのフック 🟢

新規コードは `online-match.js` に置き、`shogi.js` からは**窓口オブジェクト経由でのみ**呼ぶ
（詰将棋で使っている `tsumeBridge` と同じ考え方。読み込まれていないページでも壊れないように）。

```js
// shogi.js に追記（tsumeBridge の隣）
const matchmakingBridge = {
  start: null,        // ロビーUIの初期化（/online/ の bootGame から呼ぶ）
  onGameOver: null,   // 終局時。マッチング対戦なら「もう一度」を再キューに差し替える
  isSeeking: () => false,
};
```

`shogi.js` 側で必要な変更は次の4点だけ:

1. `<script src="/online-match.js" defer>` を `/online/` にだけ入れる（`build-pages.mjs` で分岐。詰将棋と同じ作り）。
2. `bootGame()` の `gameMode === ONLINE_MODE` の分岐で `matchmakingBridge.start?.()` を呼ぶ。
3. 終局処理で `matchmakingBridge.onGameOver?.(onlineState.match)` を呼ぶ。
4. **AI対戦の勝利時に `shogi_ai_win_count` を +1**（`shogi.js:4673` 付近の `isPlayerWin` が true のとき）。

部屋への合流は既存の仕組みに乗る。**新しい入場処理は書かない。**
`matched` には `match` 本体が載っていないので `applyOnlineMatch()` は自分では呼ばず、
**`onlineConnectWs()` の接続直後にサーバーが push してくる `state` メッセージに任せる**
（`_handleWsServerMessage()` が `type:"state"` を受けて `applyOnlineMatch()` を呼ぶ。`shogi.js:804` で確認済み）。

```js
// online-match.js 側。matched 受信時にやるのはこれだけ
onlineState.token = msg.token;
onlineState.roomCode = msg.room_code;
onlineState.side = msg.yourSide;   // 盤の向きの初期値。state 到着後に上書きされる
onlineConnectWs();                 // 接続 → state 受信 → applyOnlineMatch が走る
```

🔴 `setUrlRoom()` は**呼ばない**（マッチング対戦の部屋コードをURLに出すと、招待URLとして
使い回されてしまう）。友達対戦の `ensureFriendRoom()` / `onlineJoinRoom()` は呼んでいるので、
そこをコピーしないよう注意する。

### 6.2 状態クラス 🟢

`body` のクラスで画面を切り替える。ロビーは既存の `online-lobby` が盤を隠しているので、**待機中はそれを外す**。

| 状態 | body class | 見えるもの |
|---|---|---|
| ロビー | `mode-online online-lobby` | 表示名・CTA・チュートリアル・友達対戦カード |
| 待機中 | `mode-online online-seeking` | 状態カード・盤の見出し・**盤（詰将棋）** |
| 対局中 | `mode-online` | 既存の対局画面 |

```css
body.online-seeking #online-settings,
body.online-seeking #footer-info,
body.online-seeking #controls { display: none; }
```

### 6.3 ロビー UI

`#online-settings` の中、既存の `.friend-card` の**上**に次の順で入れる。

```html
<div class="name-row">
  <span class="name-row-label">表示名</span>
  <input type="text" id="player-name" placeholder="プレイヤー（任意）" maxlength="10"
         aria-label="表示名（任意・半角英数字10文字まで）">
</div>

<button type="button" id="mm-cta" class="mm-cta">
  <span class="mm-cta-koma"><!-- 交差する2本の剣（§6.4のSVG） --></span>
  <span class="mm-cta-text">
    <span class="mm-cta-title">だれかと対戦</span>
    <span class="mm-cta-meta">
      <span class="mm-pulse"></span><span><b>3</b>人が対局中 ・ 一手30秒</span>
    </span>
  </span>
  <span class="mm-cta-chevron"><!-- chevron --></span>
</button>

<button type="button" id="mm-tutorial" class="practice-btn">
  <span class="practice-btn-title">チュートリアル</span>
  <span class="practice-btn-chevron"><!-- chevron --></span>
</button>

<div class="or-divider">または</div>
<!-- 既存の .friend-card がこの下に続く -->
```

決定事項:

- **CTAの配色は墨×金**。朱（`#9a3b00→#7a2b00`）は「招待URLをコピー」等の通常アクションで使っているので使わない。
  背景 `radial-gradient(120% 140% at 12% 0%, rgba(240,207,130,.16), rgba(240,207,130,0) 46%), linear-gradient(160deg,#3d2718,#2a1a10,#1c1109)` /
  縁 `1px solid rgba(240,207,130,.5)` / 文字 `#f7e0a4` / 影 `0 6px 18px rgba(28,17,9,.30), inset 0 1px 0 rgba(255,240,208,.14)` /
  `border-radius: 14px` / 高さ 84px（≤600pxで78px）/ `:active` で `translateY(1px)`。
- **緑の点は `#6aa87d`**（サイトの緑 `#4a7c59` / `#2f7d4f` と同系）。明るい黄緑は使わない。波紋は `opacity:.42` から `scale(2.8)` へ1.8秒。
- **人数は1人以上のときだけ**出す。0人のときは `.mm-cta-meta` の人数部分を消して「一手30秒」だけにする。
- **チュートリアルは常設**（解放済みでも出す）。高さ **42px**（CTAは78px）・**説明文は付けない**・文字14px。
- 未解放時: CTAを `.is-locked`（`linear-gradient(160deg,#5f5044,#4b3f35,#3f342b)`・鍵アイコン+「**チュートリアルをクリアで解放**」）にし、
  **表記は一番やってほしい1つに絞る**（条件を並べると長くて読まれない）。AI対戦1勝・詰将棋1問でも解放される点は、押したときの案内ダイアログ側で説明する。§6.8 の解放条件は4つとも残すこと。
  **押せないボタンにはしない**（押したら解放条件の案内を出す）。チュートリアル側に `.is-primary`（枠2px `#9a6f52`）を付けて次の行動を示す。
- **左端にアクセント線を引くカードは使わない**（プロジェクトのデザイン方針）。状態は全周の枠＋アイコン円＋下の帯で表す。

### 6.4 CTAアイコン（交差する2本の剣）🟢

実寸40×40px、金1色 `#f2d489`。手前の剣にだけ `#241710` の縁を回して重なりを出す。

```html
<svg viewBox="0 0 46 46" aria-hidden="true">
  <g stroke="#f2d489" stroke-linecap="round" fill="none">
    <path d="M14 31.4 9.2 36.2" stroke-width="2.8"/>
    <path d="M9.7 27 18.7 36" stroke-width="2.4"/>
  </g>
  <polygon points="12.2,29.8 15.6,33.2 38.9,7.1" fill="#f2d489"/>
  <g stroke="#241710" stroke-linecap="round" stroke-width="5.4" fill="none">
    <path d="M32 31.4 36.8 36.2"/><path d="M31.5,31.5 8.2,7.6"/>
  </g>
  <g stroke="#f2d489" stroke-linecap="round" fill="none">
    <path d="M32 31.4 36.8 36.2" stroke-width="2.8"/>
    <path d="M36.3 27 27.3 36" stroke-width="2.4"/>
  </g>
  <polygon points="33.8,29.8 30.4,33.2 7.1,7.1" fill="#f2d489"/>
  <circle cx="8.2" cy="37.2" r="1.9" fill="#f2d489"/>
  <circle cx="37.8" cy="37.2" r="1.9" fill="#f2d489"/>
</svg>
```

### 6.5 待機 UI

状態カードは**「相手を探している」ことだけ**を扱う。盤に何が出ているかは**盤の見出し側**で言う
（カードの中に別機能の見出しを入れない）。

```html
<div id="online-seek" class="seek-card" role="status" aria-live="polite">
  <span class="seek-icon"><!-- 虫めがね --></span>
  <span class="seek-text">
    <b class="seek-title">対戦相手を探しています<span class="thinking-dots"><span></span><span></span><span></span></span></b>
    <span class="seek-line">
      <span class="seek-note">最長60秒で始まります</span>
      <span class="seek-timer"><b>42</b><small>秒</small></span>
    </span>
  </span>
  <button type="button" class="seek-cancel" aria-label="探すのをやめる"><!-- ✕ --></button>
</div>

<div class="wait-tsume-bar">
  <span class="wait-tsume-title">待ち時間の腕試し</span>
  <span class="wait-tsume-moves">3手詰</span>
  <span class="wait-tsume-remaining">残り<b>3</b>手</span>
</div>
<!-- この下に既存の #board-area がそのまま出る -->
```

- 枠組みは `.friend-card` と同じ（全周1px `rgba(92,61,46,.35)`・白・`border-radius:12px`・アイコン円40px）。
- 3点の明滅は**既存の `.thinking-dots` を流用**し、色だけ `#9a3b00` に上書きする（明るい盤の上で使うため）。
- タイトルは `white-space: nowrap`（折り返すとカード高さが跳ねる）。
- 秒数は**残り秒数のカウントダウン**。`font-variant-numeric: tabular-nums` で桁ゆれを防ぐ。
- 「正解N問」のような**解答数の表示は出さない**（何の数字か伝わらない）。
- 文言は「最長60秒で始まります」。フォールバックOFF設定の人だけ「見つかりしだい自動で始まります」+ 経過秒数に差し替える。
- 持ち駒レーンの見出しは、詰めチャレンジ中だけ **「相手／自分」→「玉方／攻方」** に差し替える
  （相手を探している画面で「相手の持ち駒」と出ると誤解される）。

**遷移**: CTAを押したら `#online-settings` を隠し、**CTAがあったのと同じ位置に状態カードを出す**。視線を動かさない。
成立時はカードを緑（`.is-found`・アイコン円が `#4a7c59` の塗り＋チェック）に変え、**1.5秒**そのまま見せてから
盤を初期局面へ切り替える。キャンセル（✕）は WS を閉じてロビーへ戻る。

🟢 **開始演出と効果音は既存コードが勝手に出す**。`applyOnlineMatch()` は両者が揃った状態を受け取った時点で
`showMatchStartOverlay()` と `playerJoinSound` を1回だけ実行する（`shogi.js:1074` 付近）。
**`online-match.js` から効果音を鳴らすと二重に鳴るので鳴らさない。** 緑カードの1.5秒は、
WS接続とサーバーの `state` 到着を待つ時間としてちょうど重なる。

実測値（375×812・2026-08-14 の作業ツリーで再計測）: 状態カード66px・盤の見出し25px・**盤の下端682px**・CTA78px・チュートリアル42px。スクロールせずに盤全体が見え、横スクロールも文字の溢れも無い。

### 6.6 COMフォールバック 🟡

- 60秒で `bot` が来たら**サーバーに部屋は作らず**、そのままローカルAI戦に切り替える。
- 強さは **localStorage `shogi_ai_difficulty` の値**。`isYaneuraouDifficulty()` が true の難易度
  （`master` 以上）は **`super`（超級 = standardエンジン最強）に丸める**
  ＝ `/online/` で yaneuraou WASM を読み込ませない。
- 表示は**相手名を「COM」にするだけ**。専用バナー・ダイアログ・「AIとマッチしました」等は出さない。
  人間のふりをする偽名も使わない。
- **ON/OFFトグルは設定モーダル（`#settings-modal`）に置く**（2026-08-13 決定。ロビーには出さない）。
  文言は「相手が見つからないときは自動でコンピュータと対局する（推奨）」。
  localStorage `shogi_bot_fallback`（既定 `true`・未設定はONとして扱う）。
- OFFのときは60秒で `bot` が来ても切り替えず探し続ける。待機カードの文言は
  「見つかりしだい自動で始まります」＋**経過秒数**（カウントアップ）に差し替える。
  この場合 Matchmaker は `bot` を送ったあとも**ソケットを閉じない**必要があるため、
  接続時のクエリに `bot=0` を付けて渡し、サーバー側はその接続にだけ `bot` を送らず待機を継続する。

### 6.7 チュートリアル 🟡

- **オンライン対戦と同じ画面・同じ時計（一手30秒）・同じ開始演出**。ルール説明は入れない。
- 相手名は「チュートリアル」。アイコンはSVG（絵文字は使わない）。
- **「手加減します」「あなたに合わせて」等の文言はUIに一切出さない。**
- 動的難易度: 毎手、駒得・手数・持ち時間の残りを見て**弱くする方向にだけ**強さを動かす
  （出発点はAI対戦の「初級」と同じ強さ。実装値は §14）。ユーザーがリードしても強くはしない。
- 勝利で `shogi_tutorial_done = "1"`。負けたら「もう一度」で再挑戦（強さは形勢だけで決まり、挑戦回数では変えない）。
- 🟡 実装後に数局プレイしてパラメータ調整が必要。「わざと負けている感」が出たら負け方を変える。

### 6.8 解放ゲート 🟢

次のいずれかで「だれかと対戦」を解放（localStorage・友達対戦は対象外）:

1. `shogi_tutorial_done`（チュートリアル勝利）
2. `shogi_ai_win_count >= 1`（新設・AI対戦の勝利時に加算・難易度不問）
3. **詰将棋を1問でも解いた** — `shogi_tsume_v1` の `days` のどこかに `'clean'` か `'solved'` がある
   （**過去問でも可**）
4. 既存ユーザー免除: 初回ロード時に1度だけ、`shogi_game_state` / `shogi_ai_difficulty` /
   `shogi_unlocked_levels` / `shogi_friend_side` / `shogi_tsume_v1` のいずれかがあれば免除フラグを付与
   （バージョンキー方式。リリース後の新規ユーザーには適用されない）

---

## 7. 詰めチャレンジ（待機中の出題）

### 7.1 データ源 🟢

- **公開済みの過去問だけ**を使う。当日ぶんは含めない（詰将棋ページのネタバレになる）。
- ビルド時に `build-pages.mjs` が `tsume_data/daily/*.json` から
  **「今日より前の直近30日」×「1手詰・3手詰・5手詰」**を1ファイルに集めて `dist/tsume/challenge.json` を書き出す。
  形式は `/tsume/days/*.json` と同じ項目（`id, level, moves, sfen, line, solution`）＋各問に `date` を持たせた配列
  （記録を `days[date][level]` に書くため日付が必要）。
- **手数の上限は5手詰**。7手以上は入れない。理由: 余詰（別の詰まし方）を禁止しているのは
  **5手以下だけ**（`scripts/tsume/config.ts: YOZUME_STRICT_MAX_MOVES = 5`）で、7手以上は余詰を許容している。
  §7.2 の「正解手リストと照合するだけ」の判定では、**7手以上だと利用者の正しい別解を「違います」と拒否してしまう**。
  7手以上も出したくなったら、詰将棋ページと同じ詰みソルバー（`/tsume-solver.js`・gzip 4.5KB）を
  `/online/` にも読み込む必要がある。今回はやらない。
- ストックは1手・3手・5手が**各30問**（30日ぶん）。毎日1問ずつ入れ替わる。
- 待機を開始した瞬間に `fetch('/tsume/challenge.json')` で取りに行く（QRライブラリと同じ遅延読込）。
  取得に失敗したら**盤を出さずに状態カードだけ**にする（待機自体は続ける）。
- `dist/_headers` に `/tsume/challenge.json` を `public, max-age=604800` で追加。

### 7.2 出題と判定 🟢

- 局面のセットアップに SFEN パースが必要。`shogi-tsume.js` の `parseTsumeSfen()` / `setupTsumePosition()` を
  **`shogi.js` へ移して共有する**（`shogi.js` は全ページで読まれるので +1.5KB程度）。詰将棋ページ側は呼び出し先が変わるだけ。
- 正誤判定は **`line[ply].accept` に指し手（USI）が含まれるかの照合だけ**でよい。
  5手詰までは余詰が禁止されているので、これで誤判定は起きない（§7.1）。**詰みソルバーは読み込まない。**
- 玉方の応手はデータの `defend` をそのまま指す（`TSUME_REPLY_DELAY_MS` 相当の間を置く）。
- 作意以外を指したら「その手では詰みません」を出して1手戻す。ヒント・答えを見る・棋譜は**付けない**。
- 正解したら次の問題へ。
- **解いた記録は詰将棋側と同じ場所に書く**（`shogi_tsume_v1` の `days[その問題の日付][level]`）。
  連続日数は動かさない。累計には加算する。節目の演出は待機中には出さない。

### 7.3 難易度は解けたかどうかで動かす 🟡（2026-08-13 決定）

出題する手数を **1手 → 3手 → 5手** の3段で自動調整する。段は localStorage
`shogi_wait_tsume_level`（値は `1` / `3` / `5`）に持つ。

**初期値**（キーが無いとき）は詰将棋ページの実績から推定する。`shogi_tsume_v1` の `days` を見て:

| 条件 | 初期段 |
|---|---|
| `advanced`（5手詰）を解いた記録がある | 5 |
| `intermediate`（3手詰）を解いた記録がある | 3 |
| それ以外（記録なしを含む） | 1 |

**昇降のルール**:

- **一発正解（作意から一度も外れず、やり直しもせず）が2問続いたら1段上げる**（1→3→5、上限5）。
- **不正解を1回したら1段下げる**（5→3→1、下限1）。不正解の定義は「作意から外れて巻き戻された」
  または「解けないまま次の待機に入った」。
- 昇降のカウンタ（連続一発正解数）は localStorage には持たず、**セッション内のメモリだけ**で良い。
  待機は短いので、跨いで積み上げる必要はない。
- 段を上げ下げしたときに演出は出さない（次に出る問題の手数バッジが変わるだけ）。

**出題順**: 現在の段の問題の中から**未出題のものを優先してランダム**に選ぶ。
出題済みは `shogi_wait_tsume_seen`（id の配列・最大100件でFIFO）に持つ。同じ段の在庫を使い切ったら
`seen` の古い方から再利用する。

### 7.4 唐突に見せないための工夫 🟢

1. 盤の見出しを「待ち時間の腕試し」にする（何のための盤かを言葉で言う）
2. 初回だけ盤の上に「対局が始まると自動で中断します」を数秒出す
   （詰将棋ページの `#tsume-toast` のマークアップとCSSをそのまま流用）

---

## 8. ビルドとキャッシュ

- `build.sh`: `online-match.js` と `name-filter.js` にハッシュを付ける（`shogi-tsume.js` の処理をそのまま真似る）。
- `build-pages.mjs`: `online-match.js` / `name-filter.js` の `<script>` は **`/online/` のページにだけ**入れる。
- `service-worker.js`: 新規JSと `/tsume/challenge.json` を `ASSETS_TO_CACHE` に追加し、
  `build.sh` のハッシュ書き換え対象にも追加する。
- 新ページは作らないので sitemap・robots・mode-tabs への影響は無い。

---

## 9. テスト

### 9.1 自動テスト（vitest / `@cloudflare/vitest-pool-workers`）

- `test/matchmaker.spec.ts`
  - 2人つなぐとペアが成立し、双方に別々の `token` と逆の `yourSide` が渡る
  - 同じ uid の2接続では**自分同士のマッチが成立しない**（古い方が閉じる）
  - 片方が close するとキューから消え、もう片方は待機を続ける
  - 60秒経過で `bot` が届く（時計は fake timer で進める）
  - `/api/online-stats` が待機人数+作った部屋数の近似を返す
  - レート制限超過で 429
- `test/name_filter.spec.ts`
  - `test/fixtures/name_filter_cases.json` の `ng` / `ok` 全件で、TS版が期待どおり伏せ字化する
  - クライアントJS版とTS版の**出力文字列が一致**する（同じケーステーブルで両方を回す）
- 既存の `test/match_room.spec.ts` に `match_type` の既定値が `"invite"` であるケースを追加（§4.7 の DEFAULT と一致させる。旧稿の `"friend"` は命名規則改訂前の誤記）。

### 9.2 手動確認（リリース前に必須）🔴

- 友達対戦: 招待URL発行 → 参加 → 対局 → 切断 → 再接続 → 投了（**`match_room.ts` を触るので必須**）
- 友達対戦の表示名: 双方が名前を入れた場合／片方だけ／両方未入力 の3通りで文言が壊れないこと
- 表示名にNG語を入れて、**相手の画面で伏せ字になっている**こと（自分の画面だけでなく相手側で確認する）
- AI対戦: 全難易度の起動（yaneuraou級を含む）
- 詰将棋ページ: 当日の記録が残る／過去問の✓が再読み込み後も残る／日付をまたいでも消えない
  （**`shogi.js` に SFEN パースを移すため**）
- マッチング対戦: 2端末で同時に押してマッチ → 対局 → 「もう一度」で再キュー
- 待機中: 詰将棋を解く → 成立で中断 → 対局が始まる／キャンセル → ロビーへ戻る
- 375×812 と PC幅で、横スクロールが無く盤全体が見えること

---

## 10. 実装順序

| # | 内容 | 目安 |
|---|---|---|
| 1 | Matchmaker DO + ルーティング + vitest（サーバー完結で先に固める） | 0.5日 |
| 2 | ロビーCTA + 表示名入力 + 待機カード + マッチ成立→対局→「もう一度」 | 1日 |
| 3 | NG語フィルタ移植（TS + JS + パリティテスト）+ 相手名の表示（**友達対戦も含む**） | 0.5〜1日 |
| 4 | COMフォールバック（60秒・COM表記）+ 設定トグル | 0.5日 |
| 5 | 解放ゲート（勝利カウンタ・免除シード・案内ダイアログ） | 0.5日 |
| 6 | チュートリアル（動的難易度）+ パラメータ調整 | 1〜1.5日 |
| 7 | 詰めチャレンジ（`challenge.json` + 出題・判定 + 段の自動調整） | 0.4日 |
| 8 | 「N人が対局中」/ リグレッション確認 / 記事更新 / 仕上げ | 0.5日 |

1〜5 が最小リリース可能ライン。ただし**6〜7 を含めた一括リリースを推奨**
（ゲートだけ先に出すとチュートリアルが無く新規が詰まる）。

---

## 11. 既知のリスク 🔴

1. **リリース直後はCOM戦の比率が高い**。表記は控えめ（相手名「COM」のみ）だが「人が少ない」印象は残る。
   緩和: 「もう一度」の自動再キュー／対局中人数の表示。
2. **本番稼働中のコードに触る**（`match_room.ts` / `shogi.js` / `shogi-tsume.js`）。
   [Cloudflare移行後はロールバック不可](../README.md)なので、DO migration v2 が後方互換であることを
   ローカルで確認してからデプロイする。
3. **荒らし対策は限定的**。アカウントが無いため永久BANはできない（localStorage削除で復活）。
   今回は ①解放ゲート ②一手30秒（放置の被害は最大30秒）③切断60秒で敗北（既存）④キューのレート制限
   ⑤表示名のNG語伏せ字 で抑止する。通報・ブロック・BANはスコープ外。
4. **詰めチャレンジの在庫は自動生成に依存**。GitHub Actions の生成が止まると待機画面の問題も増えない。

---

## 12. 決定履歴（2026-08-13 の確認ぶん）

前回の未決事項5件はすべて決まった。**未決事項は現在なし。**

| 論点 | 決定 |
|---|---|
| マッチ後に相手が接続してこない | **追加実装なし**。マッチするのは接続中の2人だけで、受け渡しの窓は既存の切断60秒ルールが拾う（§4.4.1） |
| 表示名を友達対戦でも出すか | **出す**（§5.4） |
| 即投了の連戦を抑えるか | **やらない** |
| 詰めチャレンジの難易度 | **解けたかどうかで1手→3手→5手を自動調整**（§7.3）。**5手詰まで**・7手以上は出さない（§7.1） |
| COMフォールバックのON/OFF | **設定モーダルに置く**（§6.6） |

実装中に判断が必要になったら、この文書に追記してから進めること。
特に 🟡 が付いている箇所（Matchmakerの状態保持・対局中人数の近似・チュートリアルの動的難易度・
詰めチャレンジの昇降ルール）は**実際に動かしてからの調整前提**なので、数値は変えて構わない。

---

## 13. 付録: 追加するCSS（全文）

モックで実測した値。**この文書が唯一の情報源**（モックのHTMLは一時ファイルだったので残っていない）。
ファーストビューに関わる `.name-row` / `.mm-cta` / `.practice-btn` / `.or-divider` は
`index.html` の Critical CSS へ、それ以外は `style.css` へ入れる。`--board-shell-width` は
既に `index.html` の `:root` にある（478px）。

```css
/* ===== ロビー: 表示名 ===== */
.name-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-height: 44px;
  margin: 0 0 12px;
  padding: 0 14px;
  border: 1.5px solid #c4b5a0;
  border-radius: 10px;
  background: #fff;
}
.name-row-label { font-size: 12.5px; color: #7a5c47; white-space: nowrap; }
.name-row input {
  min-width: 0;
  border: 0;
  background: transparent;
  color: #5c3d2e;
  font-family: inherit;
  font-size: 15px;
}
.name-row input::placeholder { color: #b0a08c; }

/* ===== ロビー: 「だれかと対戦」CTA =====
   この画面で一番押させたいボタンなので、朱色（招待URLなどの通常アクション）とは
   別の位置づけに見せる。漆塗りの駒箱のような墨色 + 金の細縁と金文字。 */
.mm-cta {
  position: relative;
  width: 100%;
  box-sizing: border-box;
  min-height: 84px;
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid rgba(240, 207, 130, .5);
  border-radius: 14px;
  background:
    radial-gradient(120% 140% at 12% 0%, rgba(240, 207, 130, .16) 0%, rgba(240, 207, 130, 0) 46%),
    linear-gradient(160deg, #3d2718 0%, #2a1a10 52%, #1c1109 100%);
  box-shadow: 0 6px 18px rgba(28, 17, 9, .30), inset 0 1px 0 rgba(255, 240, 208, .14);
  color: #f0cf82;
  font-family: "Yuji Syuku", sans-serif;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: transform .12s ease, box-shadow .18s ease, border-color .18s ease;
}
.mm-cta:hover {
  border-color: rgba(240, 207, 130, .85);
  box-shadow: 0 8px 22px rgba(28, 17, 9, .38), inset 0 1px 0 rgba(255, 240, 208, .18);
}
.mm-cta:active {
  transform: translateY(1px);
  box-shadow: 0 3px 10px rgba(28, 17, 9, .32), inset 0 1px 0 rgba(255, 240, 208, .1);
}
.mm-cta-koma { width: 46px; height: 46px; display: flex; align-items: center; justify-content: center; }
.mm-cta-koma svg { width: 44px; height: 44px; }
.mm-cta-text { min-width: 0; }
.mm-cta-title {
  display: block;
  font-size: 21px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: .04em;
  color: #f7e0a4;
}
.mm-cta-meta {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 5px;
  font-size: 12px;
  color: rgba(247, 224, 164, .72);
  /* 折り返すとボタンの高さが跳ね、「3人」が「3」「人」に割れて読めなくなる */
  white-space: nowrap;
}
.mm-cta-meta b { color: #f7e0a4; font-size: 13.5px; }
/* 対局中の人数。1人以上のときだけ出す（0人は逆効果なので出さない） */
.mm-pulse { position: relative; width: 8px; height: 8px; flex: 0 0 8px; }
.mm-pulse::before, .mm-pulse::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: #6aa87d; /* サイトの緑と同系。明るい黄緑は使わない */
}
.mm-pulse::after { opacity: .42; animation: mm-ring 1.8s ease-out infinite; }
@keyframes mm-ring { 0% { transform: scale(1); opacity: .42; } 100% { transform: scale(2.8); opacity: 0; } }
.mm-cta-chevron { width: 18px; height: 18px; color: rgba(247, 224, 164, .8); }
.mm-cta-chevron svg { width: 18px; height: 18px; }
/* 未解放。押せないボタンにはせず、押したら解放条件の案内を出す */
.mm-cta.is-locked {
  border-color: rgba(196, 181, 160, .5);
  background: linear-gradient(160deg, #5f5044 0%, #4b3f35 60%, #3f342b 100%);
  box-shadow: 0 3px 10px rgba(63, 52, 43, .2), inset 0 1px 0 rgba(255, 255, 255, .08);
  color: #e6dccd;
}
.mm-cta.is-locked .mm-cta-title { color: #efe6d8; }
.mm-cta.is-locked .mm-cta-meta { color: rgba(239, 230, 216, .8); }
.mm-cta.is-locked .mm-cta-chevron { color: rgba(239, 230, 216, .7); }
.mm-cta-lock { display: inline-flex; width: 14px; height: 14px; flex: 0 0 14px; }
.mm-cta-lock svg { width: 14px; height: 14px; }

/* ===== ロビー: チュートリアル（いつでも出す・サブ要素なので低くする） ===== */
.practice-btn {
  width: 100%;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 15px;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  margin: 9px 0 0;
  padding: 0 13px;
  border: 1.5px solid #c4b5a0;
  border-radius: 11px;
  background: #fff;
  color: #5c3d2e;
  font-family: "Yuji Syuku", sans-serif;
  text-align: left;
  cursor: pointer;
  transition: border-color .18s ease, background .18s ease;
}
.practice-btn:hover { border-color: #9a6f52; background: #fffdf8; }
/* 未解放の人にとっては、これが次にやること */
.practice-btn.is-primary { border-color: #9a6f52; border-width: 2px; background: #fffdf8; }
.practice-btn.is-primary .practice-btn-title { color: #9a3b00; }
.practice-btn-title { font-size: 14px; font-weight: 700; line-height: 1.3; }
.practice-btn-chevron { width: 15px; height: 15px; color: #9a6f52; }
.practice-btn-chevron svg { width: 15px; height: 15px; }

.or-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px 0 14px;
  color: #9b8878;
  font-size: 12px;
}
.or-divider::before, .or-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: rgba(92, 61, 46, .2);
}

/* ===== 待機中 =====
   ロビー(online-lobby)は盤を隠しているので、待機中はそこに詰将棋の盤を出す。
   対局そのものではないので、手番表示(#footer-info)と操作ボタン(#controls)は出さない */
body.online-seeking #online-settings,
body.online-seeking #footer-info,
body.online-seeking #controls { display: none; }

/* 枠組みは既存の友達対戦カード(.friend-card)と同じ作り。
   このカードは「相手を探している」ことだけを扱う（盤の話は盤の見出し側に置く） */
.seek-card {
  width: min(100%, var(--board-shell-width));
  box-sizing: border-box;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) 34px;
  align-items: center;
  gap: 12px;
  margin: 0 0 12px;
  padding: 12px 14px;
  border: 1px solid rgba(92, 61, 46, .35);
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .06);
  text-align: left;
}
.seek-icon {
  width: 40px; height: 40px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid #d4c4a8;
  border-radius: 50%;
  background: #f5f0e8;
  color: #5c3d2e;
}
.seek-icon svg { width: 21px; height: 21px; }
.seek-text { min-width: 0; }
.seek-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 15.5px;
  line-height: 1.35;
  color: #5c3d2e;
  /* 折り返すとカードの高さが跳ねるので1行に収める */
  white-space: nowrap;
}
/* 3点の明滅は既存のAI思考中インジケータ(.thinking-dots)を流用する。
   既存の色は暗い盤の上で使うクリーム色なので、明るいカード用に色だけ差し替える */
.seek-card .thinking-dots span { width: 6px; height: 6px; background: #9a3b00; }
.seek-line { display: flex; align-items: baseline; gap: 10px; margin-top: 3px; }
.seek-note { font-size: 11.5px; line-height: 1.4; color: #8a7563; }
/* 残り秒数。数字が動いても行が揺れないよう等幅の数字にする */
.seek-timer { margin-left: auto; display: flex; align-items: baseline; white-space: nowrap; color: #9a3b00; }
.seek-timer b { font-size: 17px; line-height: 1; font-variant-numeric: tabular-nums; }
.seek-timer small { margin-left: 1px; font-size: 10.5px; color: #8a7563; }
.seek-cancel {
  width: 34px; height: 34px;
  display: flex; align-items: center; justify-content: center;
  padding: 0;
  border: 1px solid #d4c4a8;
  border-radius: 50%;
  background: #fff;
  color: #7a5c47;
  cursor: pointer;
}
.seek-cancel:hover { background: #f5f0e8; }
.seek-cancel svg { width: 15px; height: 15px; }

/* 成立した瞬間。1.5秒だけ出して対局へ移る */
.seek-card.is-found { grid-template-columns: 40px minmax(0, 1fr); }
.seek-card.is-found .seek-icon { border-color: #4a7c59; background: #4a7c59; color: #fff; }
.seek-card.is-found .seek-icon svg { width: 17px; height: 17px; }
.seek-card.is-found .seek-title { color: #2f5f3f; }
.seek-card.is-found .seek-note { color: #4a7c59; }

/* ===== 盤の見出し =====
   盤に何が出ているのかは盤の側で言う。詰将棋ページの .tsume-actions と同じ位置関係 */
.wait-tsume-bar {
  width: min(100%, var(--board-shell-width));
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 7px;
  padding: 0 2px;
  font-size: 12px;
  font-weight: 600;
  color: #6b5a4c;
}
.wait-tsume-title { color: #833c15; font-size: 13.5px; white-space: nowrap; }
.wait-tsume-moves {
  padding: 2px 8px;
  border: 1px solid rgba(92, 61, 46, .2);
  border-radius: 999px;
  background: linear-gradient(180deg, #f0e6d2, #e1d7c3);
  font-size: 11px;
  color: #5c3d2e;
  white-space: nowrap;
}
.wait-tsume-remaining { margin-left: auto; white-space: nowrap; }
.wait-tsume-remaining b { margin: 0 3px; font-size: 17px; color: #5c3d2e; }
/* 成立後は詰将棋から視線を外させる（1.5秒後に盤が初期局面へ切り替わる） */
.wait-tsume-bar.is-dim { opacity: .4; }

@media screen and (max-width: 600px) {
  .seek-card { padding: 11px 12px; gap: 10px; }
  .seek-title { font-size: 14.5px; }
  .mm-cta {
    min-height: 78px;
    padding: 12px 14px;
    grid-template-columns: 42px minmax(0, 1fr) 18px;
    gap: 12px;
  }
  .mm-cta-koma { width: 42px; height: 42px; }
  .mm-cta-koma svg { width: 40px; height: 40px; }
  .mm-cta-title { font-size: 19.5px; }
}
```

### 使うSVG（CTAアイコン以外）

```html
<!-- 虫めがね（状態カード） -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>
<!-- チェック（成立） -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5.5 5.5L20 6.5"/></svg>
<!-- ✕（キャンセル） -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
<!-- chevron（CTA・チュートリアル） -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
<!-- 鍵（未解放） -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>
```

**アイコンは全てSVG。絵文字はUIアイコンとして使わない**（プロジェクト方針・全画面に適用）。

---

## 14. 実装時の追記（2026-08-15・実装セッションでの決定）

実装しながら決めた事項。本文と食い違う場合はこちらが正。

**サーバー（Matchmaker）**
- キューは in-memory 配列ではなく **Hibernation ソケットそのものをキューにする**。`acceptWebSocket(server, [uid])` + `serializeAttachment({uid, name, queuedAt, bot, matched, matchedAt})`。FIFO は queuedAt 昇順で導出（§4.5 の徹底形。休眠復元の問題が構造的に消える）
- **二重マッチ防止**: ペア確定（`matched: true`）は `createRoom` RPC を await する**前に**attachment へ同期で書く（DO の input gate は RPC 中に開くため）
- alarm は「先に tryMatch → タイムアウト処理 → 残があれば再アーム」。`matched` のまま30秒残ったソケット（DO再起動の名残）は match_failed で片付ける
- 同uidの置き換えは close(4000, "superseded")。クライアントは 4000 を**エラー表示せず静かにロビーへ戻す**（別タブで探し始めた合図なので）

**持ち時間: 開始バッファは5秒（2026-08-16 決定）**
- `MATCH_START_BUFFER_MS` を **3秒 → 5秒**（`match_room.ts`）。対戦開始オーバーレイ（3秒＋フェード0.7秒）が消えてから1秒強の余裕が残る。ローカル対局（COM戦・チュートリアル）の `LOCAL_START_BUFFER_MS` も同じ5秒に揃える
- 時計が動き出すのは従来どおり**両者が入室した瞬間（＋バッファ）**。切れ負け（total）でもバッファぶんは引かれない（`turn_started_at` が未来にあるうちは消費時間が0にクランプされる）
- **検討して見送り**: 「初手（先手の1手目）は時間無制限」案。一度実装したが、初手を指さずに居座られると対局が永久に進まない（接続は生きているので切断60秒敗北も効かない）ため取りやめ、バッファ延長だけにした

**表示名**
- クライアントは**生の入力値（許可文字のみ・10文字）をそのまま送る**。伏せ字化はサーバー（`normalizeDisplayName`）が唯一の正規化点。クライアントの `name-filter.js` は相手名を**表示する直前の防御**に使う（リバーシの「送信時にもclean」は、伏せ字の`*`が許可文字でないため当サイトでは往復で壊れる）
- §6.8-4 の免除シード: **`shogi_ai_difficulty` は使えない**（初回ロードでデフォルト値が自動保存されるため全員が免除になってしまう。実測で発覚）。実プレイでしか書かれない5キー（`shogi_game_state` / `shogi_game_state_pvp` / `shogi_unlocked_levels` / `shogi_friend_side` / `shogi_tsume_v1`）だけを見る。判定結果は `shogi_mm_exempt`（'1'=免除 / '0'=判定済み）に保存し、キーがある限り再判定しない
- 予約名 **「COM」「チュートリアル」には敬称「さん」を付けない**（「COM さんの手番です」は不自然）。人間の名前には付ける

**表示名の出し先（2026-08-17 訂正）**
- §5.4-2 の「`updateOnlineUiState()` の状態テキストに相手名を出す」は**実現しない**。この欄（`#online-status`）は
  `#online-settings` の中にあり、対局が始まると `updateOnlineUiState()` 自身がパネルごと `display:none` にするため、
  対局中は絶対に見えない。書いてあった「◯◯の手番です。」は表示されないコードだったので**削除した**
- 相手名が実際に見えるのは次の2か所だけ:
  - **対局者バー**（`getOpponentBarLabel`）: 名前欄なので未入力時は「相手：**匿名プレイヤー**」のまま
  - **終局ダイアログ**（`getOpponentSubject`）: 文中なので未入力時は「**相手**の勝利！」（「匿名プレイヤーの勝利！」だと硬い）
- 対局中の手番は文字ではなく**対局者バーの点灯＋持ち駒レーンの先手／後手の札**で示す。切断も
  バーの帯（`renderDisconnectAlert`）が「相手の接続が切れています」と出すので、どちらも名前を使わない

**ローカル対局（COM戦・チュートリアル）**
- 方式: `gameMode='online'` のまま**ローカル生成の MatchPayload を applyOnlineMatch に1回通す**。以降は online-match.js のドライバが executeAIMove/finalizeMove で進行。接合点は `onlineSubmitMove` / `onlineResign` 先頭のフック2つ。**token は常に null**（全ネットワーク経路の安全弁）
- COM戦後の「もう一度対戦する」も再キュー扱い（マッチングの一部）
- チュートリアル: 先後は**ローカルでランダム**。**手加減は ai-worker.js を一切変更せず、既存の2つのパラメータを形勢に応じて切り替えるだけで作る**（独自の指し手選択ロジックを持たない）:
  `aiDifficulty`（読みの深さ easy=1/medium=2/hard=3）と `benchmarkRandomness`（最善から `値×2` 点以内の手からランダムに選ぶ既存機能。`orderMoves` に pvMove を渡しているので最善手は必ず候補に含まれる）。
  `randomness=0` のときだけ ai-worker.js 側の既定のブレ（`maxDepth<3` なら6割の確率で上位5手からランダム）が働くため、
  **`easy` + `randomness=0` は AI対戦の「初級」とまったく同じ挙動**になる。
  ユーザー視点の駒得（エンジンの `PIECE_VALUES` と同じ尺度・歩100/銀500/金600/角800/飛900）で3段階（**緩む方向にしか動かない**）:

  | ユーザーの駒得 | difficulty | randomness | ねらい |
  |---|---|---|---|
  | −300以上（互角〜優勢） | easy | 0 | **出発点＝AI対戦の「初級」と同じ強さ** |
  | −300以下 | easy | 700 | 緩める |
  | −800以下 | easy | 1400 | 駒を渡して追いつかせる |

  🟢 **`randomness` と強さの関係は谷型で単調ではない**（2026-08-16・自己対戦で実測）。
  `randomness>0` は「最善から `値×2` 点以内」の足切りフィルタなので、値が小さいうちは
  **悪手に上限がかかって逆に強くなる**。極端に上げて初めて足切りが効かなくなり弱くなる。
  各60局・先後入替えでの `easy:0`（＝初級）から見た勝率:

  | 相手の設定 | easy:0 の勝率 | |
  |---|---|---|
  | `medium:40`（旧チュートリアルの出発点） | 0% | ← 旧実装が「強すぎる」と言われた原因 |
  | `easy:100` / `easy:200` / `easy:500` | 0% / 3% / 35% | easy:0 より**強い**帯 |
  | `easy:600` / `easy:700` / `easy:1400` | 73% / 86% / 100% | easy:0 より弱い帯 |

  反転点は 500〜600 の間。**緩和側に使ってよいのは 700 以上**（500前後は逆効果）。
  測定ハーネスは `ai-worker.js` を Node の `vm` にそのまま読み込んで自己対戦させる方式（`docs` 外・使い捨て）。

  さらに**駒得とは独立に、次の2つでも1段ずつ緩める**（いずれも緩む方向のみ）:
  - **手数**: 60手で1段目、110手で2段目。駒得で勝っていても寄せきれずに長引く＝苦戦のサインなので、駒割だけの判定を補う（`TUTORIAL_LONG_GAME_STEPS`）
  - **時間切迫**: ユーザーが持ち時間（1手30秒）の残り10秒未満で指したら1段目へ（`TUTORIAL_TIME_PRESSURE_MS`）

  狙いは「ユーザーがやや優勢のまま終盤に入る」。**挑戦回数による強さ変化は持たない**（チュートリアルは実質1回だけの導線なので不要。2026-08-16 決定）。
  **上位側（hard/medium）の段は持たない**＝ユーザーがリードしても強くならない（追い上げ廃止。2026-08-16 決定）。
  🟡 しきい値は実プレイ調整前提。変更するのは `online-match.js` の `TUTORIAL_LEVELS` / `TUTORIAL_LONG_GAME_STEPS` だけで済む
- チュートリアル勝利後のボタンは通常の「次のゲームへ」（ロビーに戻る。CTAは解放済み）。負け・引き分けは「もう一度挑戦する」で再挑戦

**詰めチャレンジ**
- 詰将棋データの level 値は `easy` ではなく **`beginner` / `intermediate` / `advanced`**（=1/3/5手）。`line` の要素は `{accept[], attack, defend|null}`
- `challenge.json` は「今日より前の直近30日ぶん」を flatten した配列（各問に `date` を付与）。**アーカイブが浅い時期は問題数が少ない**（2026-08-15時点で5日×3問=15問。日次デプロイで最大90問まで自然増）。段の在庫が無いときは近い段で代用
- **誤答は盤に適用する前に弾く**（interceptMove で照合するので「1手戻す」処理自体が不要になった）
- `#tsume-toast` はマークアップが index.html に無く動的生成（CSSはスコープ無しで共通利用可と確認済み）。online-match.js が縮小版の生成コードを持つ。初回説明トーストは `shogi_wait_tsume_hint` で1回だけ
- 正解時に小さな「正解！」トーストだけ出す（§7.2 の「節目の演出は出さない」は維持）
- challenge.json の取得失敗時は `body.mm-no-tsume` で**盤ごと隠して**状態カードだけにする

**evaluatorレビュー(2026-08-15)を受けた修正**
- Service Worker: `/tsume/challenge.json` を `NETWORK_FIRST_PATHS` に追加（cacheFirstのままだと初回キャッシュ時点の問題で恒久固定され「毎日入れ替わる」が無効になっていた）
- SVG要素に `.hidden` プロパティは無い（HTMLElementのみ）→ 状態カードのアイコン切り替えは `setAttribute('hidden')` / `removeAttribute` で行う
- 待機中のキューWS: **裏に回っている間の切断は待機状態を保持**し、画面復帰時（visibilitychange）に黙って並び直す（モバイルのタブ切替・画面ロック対策。カウントダウンは仕切り直し）。表示中の切断だけ従来どおりロビーへ戻す
- 解放案内モーダルに Escape・Tab循環・フォーカス移動/復帰を追加（既存モーダルと同水準）
- `/api/online-stats`: IPごと30回/分のレート制限 + `countPlaying` を読み取り専用化（DELETEは `getStats`/`pairUp` 側のみ）。単一グローバルDOへの無制限書き込みを防ぐ
- キューのレート制限超過は HTTP 429 ではなく**101で受けてから `{type:"error", code:"rate_limited"}` を送って閉じる**（429はWebSocketクライアントから接続失敗としか見えず文言を出し分けられない）
- 詰めチャレンジの段下げは**1問につき1回まで**（誤答のたびに下げると試行錯誤で最短1手詰まで落ちる）
- challenge.json の取得失敗は次の待機で再試行（失敗を恒久キャッシュしない）
- 表示名の「表示名」は `label for="player-name"` に（タップでフォーカスが入る）

**その他**
- `showGameOverDialog` はボタンラベルを毎回「次のゲームへ」にリセットするため、`matchmakingBridge.onGameOver` の呼び出しは showOnlineGameOver の**ダイアログ表示後**に置く
- `parseTsumeSfen` / `setupTsumePosition` / `usiMoveToMove` を shogi.js へ移設。shogi-tsume.js は `setupTsumeProblemPosition`（tsumeSession++ 付きラッパー）経由で呼ぶ
- /online/ の title / meta description / ogTitle も「だれかと対戦」対応で更新（ユーザー承認済み・§8の範囲外だが「将棋 オンライン」対策の本丸）
