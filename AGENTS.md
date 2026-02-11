将棋を遊べるWebアプリです

Netlify:ホスティング
Supabase:通信対戦
YaneuraOu 改造版:高難易度AIのベース
url: https://shogi.yuki-lab.com/

1) DB 反映（マイグレーション適用）が必要な変更
対象: *.sql に入るべき変更

テーブル/カラム/インデックス/制約の追加・変更
RLSポリシーの追加・変更
트リガー/SQL関数/ビューの追加・変更
Realtime publication へのテーブル追加（今回だと supabase_realtime）
やること:

新しい migration ファイルを追加（既に適用済みの migration を編集しない）
リモートへ適用: npx supabase db push

2) Functions の deploy が必要な変更
対象: supabase/functions/** の変更

やること（このプロジェクトの標準）:

for f in config create-room join-room get-match submit-move heartbeat resign; do
  npx supabase functions deploy "$f" --project-ref <project-ref> --no-verify-jwt
done