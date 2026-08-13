-- SPDX-License-Identifier: GPL-3.0-only

-- フィードバックの原因調査用コンテキスト。
-- modes: ユーザーが任意選択した「問題が起きたモード」(JSON配列, 例: ["ai","tsume"])
-- meta:  クライアントが自動添付した診断情報のJSON（モード・ビルド・手数・直近JSエラー等。個人情報は含めない）
ALTER TABLE feedback ADD COLUMN modes TEXT;
ALTER TABLE feedback ADD COLUMN meta TEXT;
