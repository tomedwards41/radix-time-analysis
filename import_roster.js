/**
 * import_roster.js — Import roster from Excel into Cloudflare D1
 * Usage: node import_roster.js
 */

const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

// Load .env
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

const CF_API_TOKEN  = process.env.CF_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const DB_ID         = process.env.CF_DB_ID || 'f676a4b3-c78f-43c2-b2e7-751251886910';

if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
  console.error('Missing CF_API_TOKEN or CF_ACCOUNT_ID in .env');
  process.exit(1);
}

async function d1Query(sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${DB_ID}/query`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = await resp.json();
  if (!data.success) {
    throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

function getDefaultAlloc(subCategory, company) {
  if (subCategory === 'Sub - 3Pillar'  || company === '3Pillar')        return '100%';
  if (subCategory === 'Sub - Testing'  || company === 'Testing Xperts') return '100%';
  return 'BT';
}

function getPrimaryBucket(subCategory, company) {
  if (subCategory === 'Sub - 3Pillar'  || company === '3Pillar')        return 'Enc R&D';
  if (subCategory === 'Sub - Testing'  || company === 'Testing Xperts') return 'Enc R&D';
  return null;
}

async function main() {
  const xlsxPath = path.join(__dirname, '3.2026 Labor Analysis - PS & R&D.xlsx');
  console.log(`Reading ${path.basename(xlsxPath)}...`);

  const wb = XLSX.readFile(xlsxPath, { cellDates: true });
  const ws = wb.Sheets['Roster - Labor Rates'];

  if (!ws) {
    console.error('Sheet "Roster - Labor Rates" not found.');
    console.error('Available sheets:', wb.SheetNames.join(', '));
    process.exit(1);
  }

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const roster = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 9) continue;

    const name = row[8] ? String(row[8]).trim() : null;
    if (!name || name === 'Name') continue;

    const empType     = row[10] ? String(row[10]).trim() : '';
    const dept        = row[11] ? String(row[11]).trim() : '';
    const company     = row[12] ? String(row[12]).trim() : '';
    const subCategory = row[13] ? String(row[13]).trim() : null;
    const annual      = row[14] != null ? parseFloat(row[14]) : null;
    const monthly     = row[15] != null ? parseFloat(row[15]) : null;
    const hourly      = row[16] != null ? parseFloat(row[16]) : null;

    if (!empType && !dept) continue;

    roster.push({
      name,
      emp_type:          empType,
      dept,
      company,
      sub_category:      subCategory || null,
      default_alloc:     getDefaultAlloc(subCategory, company),
      primary_nc_bucket: getPrimaryBucket(subCategory, company),
      hourly_rate:       (hourly  != null && !isNaN(hourly))  ? hourly  : null,
      annual_salary:     (annual  != null && !isNaN(annual))  ? annual  : null,
      monthly_rate:      (monthly != null && !isNaN(monthly)) ? monthly : null,
    });
  }

  console.log(`Parsed ${roster.length} roster entries. Importing...`);

  for (const r of roster) {
    await d1Query(
      `INSERT OR REPLACE INTO roster
         (name, emp_type, dept, company, sub_category, default_alloc, primary_nc_bucket,
          hourly_rate, annual_salary, monthly_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.name, r.emp_type, r.dept, r.company, r.sub_category,
       r.default_alloc, r.primary_nc_bucket,
       r.hourly_rate, r.annual_salary, r.monthly_rate]
    );

    // Seed initial rate history at 2026-01-01
    if (r.hourly_rate != null || r.monthly_rate != null) {
      await d1Query(
        `INSERT OR IGNORE INTO roster_rate_history
           (name, effective_date, hourly_rate, monthly_rate)
         VALUES (?, '2026-01-01', ?, ?)`,
        [r.name, r.hourly_rate, r.monthly_rate]
      );
    }

    console.log(`  ✓ ${r.name} (${r.company || '—'}) — ${r.default_alloc}`);
  }

  console.log(`\nDone! ${roster.length} people imported.`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
