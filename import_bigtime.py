"""
import_bigtime.py — Load a BigTime CSV export into the radix-labor D1 database.

Usage:
  python import_bigtime.py <path_to_csv> [--year 2026] [--remote]
  python import_bigtime.py --roster <path_to_xlsx> [--remote]

Options:
  --remote   Write to Cloudflare D1 (requires CF_API_TOKEN + CF_ACCOUNT_ID in .env)
             Default: local wrangler D1

The script applies the project → N/C bucket rules defined in project_rules table
(and hardcoded below as a fallback) to reclassify time entries before import.
"""

import csv
import json
import os
import sys
import argparse
import subprocess
from datetime import datetime
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

CF_API_TOKEN  = os.getenv("CF_API_TOKEN", "")
CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "")
DB_NAME       = "radix_accounting"

# ── N/C reclassification rules (same as project_rules table seed) ─────────────
# Checked in order; first match wins. Anything not matched → Chargeable.
NC_RULES: list[tuple[str, str]] = [
    ("Radix - Research and Development Project | Radix - Research and Development Project:Radix - Research and Development Project", "R&D"),
    ("Radix R&D - Telco. | Radix R&D - Telco.:Radix R&D - Telco.",                                                                  "R&D"),
    ("Mango Core | Mango Core:Mango Core",                                                                                           "R&D"),
    ("enCompass | Compass Datacenters:enCompass",                                                                                    "Enc R&D"),
    ("enCompass Platform | Compass Datacenters:enCompass Platform",                                                                  "Enc R&D"),
    ("Radix - Overhead Costs | Radix - Overhead Costs:Radix - Overhead Costs",                                                      "OH"),
]


def classify_nc(project: str, nc_original: str) -> str:
    for pattern, bucket in NC_RULES:
        if project.strip() == pattern.strip():
            return bucket
    return "Chargeable"


def parse_money(val: str) -> float | None:
    if not val:
        return None
    cleaned = val.replace("$", "").replace(",", "").replace(" ", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_date(val: str) -> tuple[str, int, int] | None:
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            d = datetime.strptime(val.strip(), fmt)
            return d.strftime("%Y-%m-%d"), d.month, d.year
        except ValueError:
            continue
    return None


# ── D1 helpers ────────────────────────────────────────────────────────────────

DB_ID: str | None = None

def _get_db_id() -> str:
    global DB_ID
    if DB_ID:
        return DB_ID
    import urllib.request
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {CF_API_TOKEN}"})
    with urllib.request.urlopen(req) as r:
        dbs = json.loads(r.read())["result"]
    DB_ID = next((d["uuid"] for d in dbs if d["name"] == DB_NAME), None)
    if not DB_ID:
        raise RuntimeError(f"D1 database '{DB_NAME}' not found.")
    return DB_ID


def d1_execute_remote(sql: str, params: list | None = None) -> dict:
    import urllib.request
    db_id = _get_db_id()
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{db_id}/query"
    body = json.dumps({"sql": sql, "params": params or []}).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())




def d1_execute_local(sql: str) -> None:
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB_NAME, "--local", "--command", sql],
        capture_output=True, text=True, cwd=Path(__file__).parent / "web"
    )
    if result.returncode != 0:
        raise RuntimeError(f"wrangler d1 execute failed:\n{result.stderr}")


def batch_insert_remote(rows: list[dict]) -> None:
    if not rows:
        return

    def esc(v):
        if v is None:
            return "NULL"
        if isinstance(v, (int, float)):
            return str(v)
        return "'" + str(v).replace("'", "''") + "'"

    chunk_size = 100  # rows per INSERT statement (~1 API call per chunk)
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i:i + chunk_size]
        values_parts = [
            f"({esc(r['project'])}, {esc(r['staff_member'])}, {esc(r['date'])}, "
            f"{r['month']}, {r['year']}, {r['hours']}, "
            f"{esc(r['nc_original'])}, {esc(r['nc_mapped'])}, "
            f"{esc(r['notes'])}, {esc(r['labor_rate'])}, {esc(r['labor_cost'])}, "
            f"{esc(r['dept'])}, {esc(r['vendor'])})"
            for r in chunk
        ]
        sql = (
            "INSERT OR REPLACE INTO time_entries "
            "(project, staff_member, date, month, year, hours, nc_original, nc_mapped, "
            "notes, labor_rate, labor_cost, dept, vendor) VALUES "
            + ", ".join(values_parts)
        )
        d1_execute_remote(sql)
        print(f"  Inserted rows {i+1}–{min(i+chunk_size, len(rows))} of {len(rows)}")


def batch_insert_local(rows: list[dict]) -> None:
    if not rows:
        return
    chunk_size = 50
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i:i + chunk_size]
        values_parts = []
        for row in chunk:
            def esc(v):
                if v is None:
                    return "NULL"
                if isinstance(v, (int, float)):
                    return str(v)
                return "'" + str(v).replace("'", "''") + "'"
            values_parts.append(
                f"({esc(row['project'])}, {esc(row['staff_member'])}, {esc(row['date'])}, "
                f"{row['month']}, {row['year']}, {row['hours']}, "
                f"{esc(row['nc_original'])}, {esc(row['nc_mapped'])}, "
                f"{esc(row['notes'])}, {esc(row['labor_rate'])}, {esc(row['labor_cost'])}, "
                f"{esc(row['dept'])}, {esc(row['vendor'])})"
            )
        sql = (
            "INSERT OR REPLACE INTO time_entries "
            "(project, staff_member, date, month, year, hours, nc_original, nc_mapped, "
            "notes, labor_rate, labor_cost, dept, vendor) VALUES "
            + ", ".join(values_parts)
        )
        d1_execute_local(sql)
        print(f"  Inserted rows {i+1}–{min(i+chunk_size, len(rows))} of {len(rows)}")


# ── CSV import ────────────────────────────────────────────────────────────────

def import_csv(path: str, remote: bool, year_filter: int | None) -> None:
    rows: list[dict] = []
    seen: set[tuple] = set()  # dedup key: (staff_member, date, project, hours)
    skipped = 0
    dupes = 0

    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for line in reader:
            project      = line.get("Project", "").strip()
            staff_member = line.get("Staff Member", "").strip()
            raw_date     = line.get("Date", "").strip()
            nc_original  = line.get("N/C", "").strip()
            notes        = line.get("Notes", "").strip() or None
            dept         = line.get("Dept", "").strip() or None
            vendor       = line.get("Vendor", "").strip() or None

            hours      = parse_money(line.get("Input", ""))
            labor_rate = None  # not imported — rates come from roster table
            labor_cost = None  # computed in app as hours × hourly_rate from roster
            parsed_date = parse_date(raw_date)

            if not project or not staff_member or not parsed_date or hours is None:
                skipped += 1
                continue

            iso_date, month, year = parsed_date

            if year_filter and year != year_filter:
                continue

            # Skip exact duplicate rows (BigTime exports each entry twice)
            dedup_key = (staff_member, iso_date, project, hours, notes or "")
            if dedup_key in seen:
                dupes += 1
                continue
            seen.add(dedup_key)

            nc_mapped = classify_nc(project, nc_original)

            rows.append({
                "project":      project,
                "staff_member": staff_member,
                "date":         iso_date,
                "month":        month,
                "year":         year,
                "hours":        hours or 0.0,
                "nc_original":  nc_original or None,
                "nc_mapped":    nc_mapped,
                "notes":        notes,
                "labor_rate":   labor_rate,
                "labor_cost":   labor_cost,
                "dept":         dept,
                "vendor":       vendor,
            })

    print(f"Parsed {len(rows)} rows ({skipped} skipped, {dupes} duplicates removed).")

    if remote:
        print("Inserting into remote D1...")
        batch_insert_remote(rows)
    else:
        print("Inserting into local D1...")
        batch_insert_local(rows)

    print("Done.")


# ── Roster import (from Excel) ────────────────────────────────────────────────

def import_roster(path: str, remote: bool) -> None:
    try:
        import openpyxl
    except ImportError:
        print("openpyxl required: pip install openpyxl")
        sys.exit(1)

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["Roster - Labor Rates"]

    rows: list[dict] = []
    # The active roster is in columns I–R (right-hand table), starting row 2
    # Col I=Name, J=Title, K=Type, L=Dept, M=Contractor/Company, N=sub_category,
    # O=Annual, P=Monthly, Q=Hourly (some columns vary — parse defensively)
    for row in ws.iter_rows(min_row=2, values_only=True):
        # Right-hand roster table starts at col 9 (I)
        name = row[8] if len(row) > 8 else None
        if not name or str(name).strip() in ("", "Name"):
            continue
        emp_type     = str(row[10]).strip() if len(row) > 10 and row[10] else ""
        dept         = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        company      = str(row[12]).strip() if len(row) > 12 and row[12] else ""
        sub_category = str(row[13]).strip() if len(row) > 13 and row[13] else None
        annual       = float(row[14]) if len(row) > 14 and row[14] and str(row[14]).replace(".", "").isdigit() else None
        monthly      = float(row[15]) if len(row) > 15 and row[15] else None
        hourly       = float(row[16]) if len(row) > 16 and row[16] else None

        if not emp_type and not dept:
            continue

        # Determine default_alloc and primary_nc_bucket from company/sub_category
        if sub_category in ("Sub - 3Pillar",) or company == "3Pillar":
            default_alloc     = "100%"
            primary_nc_bucket = "Enc R&D"
        elif sub_category in ("Sub - Testing",) or company == "Testing Xperts":
            default_alloc     = "100%"
            primary_nc_bucket = "Enc R&D"
        else:
            default_alloc     = "BT"
            primary_nc_bucket = None

        rows.append({
            "name":             str(name).strip(),
            "emp_type":         emp_type,
            "dept":             dept,
            "company":          company,
            "sub_category":     sub_category or None,
            "default_alloc":    default_alloc,
            "primary_nc_bucket": primary_nc_bucket,
            "hourly_rate":      hourly,
            "annual_salary":    annual,
            "monthly_rate":     monthly,
        })

    print(f"Parsed {len(rows)} roster entries.")

    for r in rows:
        def esc(v):
            if v is None:
                return "NULL"
            if isinstance(v, (int, float)):
                return str(v)
            return "'" + str(v).replace("'", "''") + "'"

        sql = (
            "INSERT OR REPLACE INTO roster "
            "(name, emp_type, dept, company, sub_category, default_alloc, primary_nc_bucket, "
            "hourly_rate, annual_salary, monthly_rate) VALUES "
            f"({esc(r['name'])}, {esc(r['emp_type'])}, {esc(r['dept'])}, {esc(r['company'])}, "
            f"{esc(r['sub_category'])}, {esc(r['default_alloc'])}, {esc(r['primary_nc_bucket'])}, "
            f"{esc(r['hourly_rate'])}, {esc(r['annual_salary'])}, {esc(r['monthly_rate'])})"
        )
        if remote:
            d1_execute_remote(sql)
        else:
            d1_execute_local(sql)

        # Seed initial rate history at 2026-01-01 (use INSERT OR IGNORE — won't overwrite existing history)
        if r["hourly_rate"] or r["monthly_rate"]:
            hist_sql = (
                "INSERT OR IGNORE INTO roster_rate_history "
                "(name, effective_date, hourly_rate, monthly_rate) VALUES "
                f"({esc(r['name'])}, '2026-01-01', {esc(r['hourly_rate'])}, {esc(r['monthly_rate'])})"
            )
            if remote:
                d1_execute_remote(hist_sql)
            else:
                d1_execute_local(hist_sql)

    print("Roster import done.")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Import BigTime data into radix-labor D1")
    parser.add_argument("csv", nargs="?", help="Path to BigTime CSV export")
    parser.add_argument("--roster", metavar="XLSX", help="Import roster from Excel file")
    parser.add_argument("--year", type=int, default=None, help="Filter to a specific year")
    parser.add_argument("--remote", action="store_true", help="Write to remote Cloudflare D1")
    args = parser.parse_args()

    if args.roster:
        import_roster(args.roster, args.remote)
    elif args.csv:
        import_csv(args.csv, args.remote, args.year)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
