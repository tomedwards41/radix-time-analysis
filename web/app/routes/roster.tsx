import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/roster";
import { requireAccess } from "~/lib/auth";
import {
  getRosterWithCurrentRates,
  getRateHistoryForPerson,
  upsertRosterPerson,
  addRateHistoryEntry,
} from "~/lib/queries";
import type { RosterWithRate } from "~/lib/queries";
import { formatCurrencyFull } from "~/lib/formatters";
import Badge from "~/components/ui/Badge";

export function meta() {
  return [{ title: "Roster Admin | Labor Analysis" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  await requireAccess(env.AUTH, request);

  const url = new URL(request.url);
  const selectedPerson = url.searchParams.get("person") ?? null;

  const roster = await getRosterWithCurrentRates(env.DB);
  const rateHistory = selectedPerson
    ? await getRateHistoryForPerson(env.DB, selectedPerson)
    : [];

  return { roster, selectedPerson, rateHistory };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env;
  await requireAccess(env.AUTH, request);

  const formData = await request.formData();
  const _action = formData.get("_action") as string;

  if (_action === "add_person") {
    await upsertRosterPerson(env.DB, {
      name:               (formData.get("name") as string).trim(),
      emp_type:           (formData.get("emp_type") as string).trim(),
      dept:               (formData.get("dept") as string).trim(),
      company:            (formData.get("company") as string).trim(),
      sub_category:       (formData.get("sub_category") as string)?.trim() || null,
      default_alloc:      (formData.get("default_alloc") as string).trim(),
      primary_nc_bucket:  (formData.get("primary_nc_bucket") as string)?.trim() || null,
      hourly_rate:        formData.get("hourly_rate") ? parseFloat(formData.get("hourly_rate") as string) : null,
    });
  } else if (_action === "add_rate") {
    const name          = (formData.get("name") as string).trim();
    const effectiveDate = (formData.get("effective_date") as string).trim();
    const hourlyRate    = parseFloat(formData.get("hourly_rate") as string);
    if (name && effectiveDate && !isNaN(hourlyRate)) {
      await addRateHistoryEntry(env.DB, name, effectiveDate, hourlyRate);
    }
  }

  return null;
}

const ALLOC_BADGE: Record<string, "green" | "blue" | "purple" | "gray"> = {
  "100%": "purple",
  "BT":   "blue",
};

export default function RosterRoute({ loaderData }: Route.ComponentProps) {
  const { roster, selectedPerson, rateHistory } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const companies = [...new Set(roster.map((r) => r.company))].sort();
  const subCategories = [
    "W-2 - Ops", "W-2 - R&D", "W-2 - G&A",
    "Sub - Ops", "Sub - R&D", "Sub - 3Pillar", "Sub - Testing",
  ];

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="text-lg font-heading font-semibold text-dash-text">Roster Admin</h1>
        <p className="text-xs text-dash-text-muted font-ui">
          Manage staff members and update hourly rates. Rate history is used to resolve costs for all months.
        </p>
      </div>

      {/* Roster table */}
      <div className="bg-dash-surface rounded-lg border border-dash-border overflow-hidden">
        <div className="px-4 py-2.5 border-b border-dash-border flex items-center justify-between">
          <h2 className="text-[11px] font-ui font-semibold uppercase tracking-wider text-dash-text-secondary">
            Staff ({roster.length})
          </h2>
          <span className="text-[11px] text-dash-text-muted font-ui">Click a name to view rate history</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-dash-border bg-dash-surface-raised">
                <TH>Name</TH>
                <TH>Company</TH>
                <TH>Dept</TH>
                <TH>Type</TH>
                <TH>Category</TH>
                <TH>Alloc</TH>
                <TH right>Hourly Rate</TH>
                <TH right>Rate As Of</TH>
              </tr>
            </thead>
            <tbody>
              {roster.map((person, i) => (
                <tr
                  key={person.name}
                  className={`border-b border-dash-border/40 cursor-pointer transition-colors ${
                    person.name === selectedPerson
                      ? "bg-dash-accent/10"
                      : i % 2 === 0
                      ? "hover:bg-dash-surface-raised/60"
                      : "bg-dash-surface-raised/30 hover:bg-dash-surface-raised/70"
                  }`}
                >
                  <td className="py-1.5 px-3">
                    <a
                      href={`/roster?person=${encodeURIComponent(person.name)}`}
                      className="font-mono text-dash-accent hover:underline"
                    >
                      {person.name}
                    </a>
                  </td>
                  <td className="py-1.5 px-3 text-dash-text-secondary">{person.company}</td>
                  <td className="py-1.5 px-3 text-dash-text-secondary">{person.dept}</td>
                  <td className="py-1.5 px-3 text-dash-text-secondary">{person.emp_type}</td>
                  <td className="py-1.5 px-3">
                    {person.sub_category ? (
                      <Badge label={person.sub_category} variant="gray" />
                    ) : (
                      <span className="text-dash-text-muted">—</span>
                    )}
                  </td>
                  <td className="py-1.5 px-3">
                    <Badge
                      label={person.default_alloc}
                      variant={ALLOC_BADGE[person.default_alloc] ?? "gray"}
                    />
                  </td>
                  <td className="py-1.5 px-3 text-right font-mono text-dash-text">
                    {person.current_hourly_rate != null
                      ? formatCurrencyFull(person.current_hourly_rate)
                      : <span className="text-dash-text-muted">—</span>}
                  </td>
                  <td className="py-1.5 px-3 text-right font-mono text-dash-text-secondary">
                    {person.rate_as_of ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Rate history for selected person */}
      {selectedPerson && (
        <div className="bg-dash-surface rounded-lg border border-dash-accent/30 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-dash-border flex items-center justify-between">
            <h2 className="text-[11px] font-ui font-semibold uppercase tracking-wider text-dash-text-secondary">
              Rate History — <span className="text-dash-accent font-mono normal-case">{selectedPerson}</span>
            </h2>
            <a href="/roster" className="text-[11px] text-dash-text-muted hover:text-dash-text font-ui">✕ Close</a>
          </div>
          <div className="p-4 space-y-3">
            {rateHistory.length === 0 ? (
              <p className="text-xs text-dash-text-muted italic">No rate history on file.</p>
            ) : (
              <table className="w-full text-xs border-collapse border border-dash-border rounded overflow-hidden">
                <thead>
                  <tr className="bg-dash-surface-raised border-b border-dash-border">
                    <TH>Effective Date</TH>
                    <TH right>Hourly Rate</TH>
                    <TH right>Monthly Rate</TH>
                  </tr>
                </thead>
                <tbody>
                  {rateHistory.map((row, i) => (
                    <tr key={row.id} className={i % 2 === 0 ? "" : "bg-dash-surface-raised/40"}>
                      <td className="py-1.5 px-3 font-mono text-dash-text">{row.effective_date}</td>
                      <td className="py-1.5 px-3 text-right font-mono text-dash-text">
                        {row.hourly_rate != null ? formatCurrencyFull(row.hourly_rate) : "—"}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono text-dash-text-secondary">
                        {row.monthly_rate != null ? formatCurrencyFull(row.monthly_rate) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Add rate entry */}
            <Form method="POST" className="flex items-end gap-2 flex-wrap pt-1">
              <input type="hidden" name="_action" value="add_rate" />
              <input type="hidden" name="name" value={selectedPerson} />
              <Field label="Effective Date">
                <input
                  type="date"
                  name="effective_date"
                  required
                  className={INPUT_CLS}
                />
              </Field>
              <Field label="Hourly Rate ($)">
                <input
                  type="number"
                  name="hourly_rate"
                  step="0.01"
                  min="0"
                  required
                  placeholder="0.00"
                  className={INPUT_CLS + " w-28"}
                />
              </Field>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-1.5 text-xs font-ui font-medium bg-dash-accent text-white rounded hover:opacity-90 disabled:opacity-50 mb-0.5"
              >
                {saving ? "Saving…" : "Add Rate Entry"}
              </button>
            </Form>
          </div>
        </div>
      )}

      {/* Add person form */}
      <div className="bg-dash-surface rounded-lg border border-dash-border overflow-hidden">
        <div className="px-4 py-2.5 border-b border-dash-border">
          <h2 className="text-[11px] font-ui font-semibold uppercase tracking-wider text-dash-text-secondary">Add / Update Person</h2>
        </div>
        <Form method="POST" className="p-4 space-y-3">
          <input type="hidden" name="_action" value="add_person" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Field label="Full Name *">
              <input type="text" name="name" required placeholder="Jane Smith" className={INPUT_CLS} />
            </Field>
            <Field label="Company *">
              <input
                type="text"
                name="company"
                required
                list="company-list"
                placeholder="Radix"
                className={INPUT_CLS}
              />
              <datalist id="company-list">
                {companies.map((c) => <option key={c} value={c} />)}
              </datalist>
            </Field>
            <Field label="Dept">
              <input type="text" name="dept" placeholder="Engineering" className={INPUT_CLS} />
            </Field>
            <Field label="Emp Type">
              <select name="emp_type" className={INPUT_CLS}>
                <option value="W-2">W-2</option>
                <option value="Contractor">Contractor</option>
                <option value="1099">1099</option>
              </select>
            </Field>
            <Field label="Sub Category">
              <select name="sub_category" className={INPUT_CLS}>
                <option value="">— none —</option>
                {subCategories.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Default Alloc">
              <select name="default_alloc" className={INPUT_CLS}>
                <option value="BT">BT (BigTime hours)</option>
                <option value="100%">100% (173.33 hrs/mo)</option>
              </select>
            </Field>
            <Field label="Primary N/C Bucket">
              <select name="primary_nc_bucket" className={INPUT_CLS}>
                <option value="">— none —</option>
                <option value="Enc R&D">Enc R&D</option>
                <option value="R&D">R&D</option>
                <option value="Chargeable">Chargeable</option>
                <option value="OH">OH</option>
              </select>
            </Field>
            <Field label="Hourly Rate ($)">
              <input
                type="number"
                name="hourly_rate"
                step="0.01"
                min="0"
                placeholder="0.00"
                className={INPUT_CLS}
              />
            </Field>
          </div>
          <p className="text-[11px] text-dash-text-muted font-ui">
            If the person already exists, this will update all fields. Use the rate history section above to add time-stamped rate changes.
          </p>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-1.5 text-xs font-ui font-medium bg-dash-accent text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Person"}
          </button>
        </Form>
      </div>
    </div>
  );
}

const INPUT_CLS =
  "w-full bg-dash-surface-raised border border-dash-border rounded px-2.5 py-1.5 text-xs text-dash-text font-ui focus:outline-none focus:border-dash-accent";

function TH({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`py-2 px-3 text-dash-text-muted font-ui uppercase tracking-wider text-[10px] font-semibold ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-ui font-semibold uppercase tracking-wider text-dash-text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
