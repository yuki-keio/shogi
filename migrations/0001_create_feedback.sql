-- SPDX-License-Identifier: GPL-3.0-only

-- Feedback submitted from the in-game フィードバック form.
-- No IP or personal info is stored; UA (truncated server-side) helps triage bug reports.
CREATE TABLE feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    message    TEXT NOT NULL CHECK (length(message) <= 2000),
    ua         TEXT
);

CREATE INDEX idx_feedback_created_at ON feedback (created_at);
