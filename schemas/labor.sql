-- Radix Labor Analysis — D1 Schema
-- Database: radix-labor

-- Raw BigTime time entries (after N/C reclassification)
CREATE TABLE IF NOT EXISTS time_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project       TEXT    NOT NULL,
  staff_member  TEXT    NOT NULL,
  date          TEXT    NOT NULL, -- ISO YYYY-MM-DD
  month         INTEGER NOT NULL, -- 1-12
  year          INTEGER NOT NULL,
  hours         REAL    NOT NULL DEFAULT 0,
  nc_original   TEXT,             -- value from BigTime export
  nc_mapped     TEXT    NOT NULL, -- after rule application: Chargeable | R&D | Enc R&D | OH
  notes         TEXT,
  labor_rate    REAL,
  labor_cost    REAL,
  dept          TEXT,
  vendor        TEXT,
  imported_at   TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_time_entries_year_month ON time_entries(year, month);
CREATE INDEX IF NOT EXISTS idx_time_entries_nc_mapped  ON time_entries(nc_mapped);
CREATE INDEX IF NOT EXISTS idx_time_entries_staff      ON time_entries(staff_member);

-- Staff roster with labor rates and classifications
CREATE TABLE IF NOT EXISTS roster (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL UNIQUE,
  emp_type          TEXT    NOT NULL, -- W-2 | Sub
  dept              TEXT    NOT NULL, -- Ops | R&D | G&A | Fin
  company           TEXT    NOT NULL, -- Radix | 3Pillar | Testing Xperts | Contractor
  sub_category      TEXT,             -- W-2 - Ops | W-2 - R&D | Sub - Ops | Sub - R&D | Sub - 3Pillar | Sub - Testing
  default_alloc     TEXT    NOT NULL DEFAULT 'BT', -- BT = hours×rate from BigTime; 100% = fixed monthly rate
  primary_nc_bucket TEXT,             -- for 100% people: which bucket they belong to (e.g. 'Enc R&D')
  hourly_rate       REAL,
  annual_salary     REAL,
  monthly_rate      REAL,
  updated_at        TEXT    DEFAULT (datetime('now'))
);

-- Historical labor rates (effective_date based — pick most recent rate <= last day of month)
CREATE TABLE IF NOT EXISTS roster_rate_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  effective_date TEXT    NOT NULL, -- ISO YYYY-MM-DD
  hourly_rate    REAL,
  monthly_rate   REAL,
  UNIQUE(name, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_rate_history_name ON roster_rate_history(name, effective_date);

-- Monthly allocation overrides: flip a person from their default_alloc for a specific month
-- If no row exists for a person/month, roster.default_alloc is used instead.
CREATE TABLE IF NOT EXISTS monthly_overrides (
  staff_member     TEXT    NOT NULL,
  year             INTEGER NOT NULL,
  month            INTEGER NOT NULL,
  nc_bucket        TEXT    NOT NULL,
  use_monthly_rate INTEGER NOT NULL DEFAULT 0, -- 0 = BT, 1 = 100% monthly rate
  PRIMARY KEY (staff_member, year, month, nc_bucket)
);

-- Project → N/C bucket mapping rules (applied in order of priority DESC)
CREATE TABLE IF NOT EXISTS project_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_pattern TEXT    NOT NULL UNIQUE,
  nc_bucket       TEXT    NOT NULL, -- Chargeable | R&D | Enc R&D | OH
  priority        INTEGER NOT NULL DEFAULT 0
);

-- Seed the rules from the user's defined list
INSERT OR IGNORE INTO project_rules (project_pattern, nc_bucket, priority) VALUES
  ('Radix - Research and Development Project | Radix - Research and Development Project:Radix - Research and Development Project', 'R&D',       100),
  ('Radix R&D - Telco. | Radix R&D - Telco.:Radix R&D - Telco.',                                                                  'R&D',       100),
  ('Mango Core | Mango Core:Mango Core',                                                                                           'R&D',       100),
  ('enCompass | Compass Datacenters:enCompass',                                                                                    'Enc R&D',   100),
  ('CenterSquare errProof Implementation | Centersquare Data Centers:CenterSquare errProof Implementation',                        'Enc R&D',   100),
  ('enCompass Platform | Compass Datacenters:enCompass Platform',                                                                  'Enc R&D',   100),
  ('Radix - Overhead Costs | Radix - Overhead Costs:Radix - Overhead Costs',                                                      'OH',        100);

-- Monthly payroll tax & benefits allocation percentages (applied to W-2 wages only)
CREATE TABLE IF NOT EXISTS tax_bene_rates (
  year  INTEGER NOT NULL,
  month INTEGER NOT NULL,
  rate  REAL    NOT NULL, -- decimal, e.g. 0.30 for 30%
  PRIMARY KEY (year, month)
);

-- Seed 2026 rates from the spreadsheet
INSERT OR IGNORE INTO tax_bene_rates (year, month, rate) VALUES
  (2026,  1, 0.300),
  (2026,  2, 0.240),
  (2026,  3, 0.259),
  (2026,  4, 0.226),
  (2026,  5, 0.246),
  (2026,  6, 0.226),
  (2026,  7, 0.223),
  (2026,  8, 0.233),
  (2026,  9, 0.234),
  (2026, 10, 0.218),
  (2026, 11, 0.209),
  (2026, 12, 0.286);

-- Fixed monthly vendor invoices (Innoscale, Power BI)
CREATE TABLE IF NOT EXISTS vendor_invoices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor    TEXT    NOT NULL,
  month     INTEGER NOT NULL,
  year      INTEGER NOT NULL,
  amount    REAL    NOT NULL,
  nc_bucket TEXT    NOT NULL  -- which sheet this vendor cost belongs to
);

-- Seed recurring 2026 vendor amounts
INSERT OR IGNORE INTO vendor_invoices (vendor, month, year, amount, nc_bucket)
SELECT 'Innoscale', m.month, 2026, 6055.00, 'Enc R&D'
FROM (
  SELECT 1 AS month UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
  UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8
  UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12
) m
WHERE NOT EXISTS (SELECT 1 FROM vendor_invoices WHERE vendor='Innoscale' AND month=m.month AND year=2026);

INSERT OR IGNORE INTO vendor_invoices (vendor, month, year, amount, nc_bucket)
SELECT 'Power BI', m.month, 2026, 4250.00, 'Enc R&D'
FROM (
  SELECT 1 AS month UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
  UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8
  UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12
) m
WHERE NOT EXISTS (SELECT 1 FROM vendor_invoices WHERE vendor='Power BI' AND month=m.month AND year=2026);

INSERT OR IGNORE INTO vendor_invoices (vendor, month, year, amount, nc_bucket)
SELECT 'Innoscale', m.month, 2026, 6055.00, 'Radix R&D'
FROM (
  SELECT 1 AS month UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
  UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8
  UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12
) m
WHERE NOT EXISTS (SELECT 1 FROM vendor_invoices WHERE vendor='Innoscale' AND month=m.month AND year=2026 AND nc_bucket='Radix R&D');

INSERT OR IGNORE INTO vendor_invoices (vendor, month, year, amount, nc_bucket)
SELECT 'Power BI', m.month, 2026, 4250.00, 'Radix R&D'
FROM (
  SELECT 1 AS month UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
  UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8
  UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12
) m
WHERE NOT EXISTS (SELECT 1 FROM vendor_invoices WHERE vendor='Power BI' AND month=m.month AND year=2026 AND nc_bucket='Radix R&D');
