-- SPDX-License-Identifier: GPL-3.0-only

-- 届いた意見を Claude に読ませた結果。NULL は審査していない投稿（導入前のもの・鍵が無いとき）。
-- review_verdict: pass（原文を通知）/ summary（要約を通知）/ discard（通知しない）/ unreviewed（審査に失敗して原文を通知）
-- review_reason:  判定の理由。unreviewed のときは失敗の種類
-- review_summary: verdict が summary のときの要約
ALTER TABLE feedback ADD COLUMN review_verdict TEXT;
ALTER TABLE feedback ADD COLUMN review_reason TEXT;
ALTER TABLE feedback ADD COLUMN review_summary TEXT;
