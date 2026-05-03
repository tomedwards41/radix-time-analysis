-- Migration v2: rate history + monthly overrides + roster default_alloc
-- Run this if you already created the database with labor.sql.
-- If starting fresh, just run labor.sql (it already includes these).

ALTER TABLE roster ADD COLUMN default_alloc TEXT NOT NULL DEFAULT 'BT';
ALTER TABLE roster ADD COLUMN primary_nc_bucket TEXT;

CREATE TABLE IF NOT EXISTS roster_rate_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  effective_date TEXT    NOT NULL, -- ISO YYYY-MM-DD
  hourly_rate    REAL,
  monthly_rate   REAL,
  UNIQUE(name, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_rate_history_name ON roster_rate_history(name, effective_date);

CREATE TABLE IF NOT EXISTS monthly_overrides (
  staff_member     TEXT    NOT NULL,
  year             INTEGER NOT NULL,
  month            INTEGER NOT NULL,
  nc_bucket        TEXT    NOT NULL,
  use_monthly_rate INTEGER NOT NULL DEFAULT 0, -- 0 = BT hours×rate, 1 = fixed monthly rate
  PRIMARY KEY (staff_member, year, month, nc_bucket)
);
