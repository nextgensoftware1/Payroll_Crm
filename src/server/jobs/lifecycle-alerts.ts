import "server-only";
import { randomUUID } from "node:crypto";
import { withRls } from "../db.ts";
import { configValue } from "../services/dashboard.ts";

/** Probation / contract end alerts. NEVER change dates, status or pay.
 *  unique (source_id, end_date, stage) makes reruns harmless; a revised end
 *  date is a new revision id, so it gets its own alert while the old one
 *  stays in history. */
export async function runLifecycleAlerts(todayIso: string): Promise<number> {
  return withRls("worker", null, `alerts-${randomUUID()}`, async (tx) => {
    const lead = Number((await configValue(tx, "alerts.probation_contract_lead_days", todayIso))?.value ?? 15);
    const admins = (await tx<{ u: string }[]>`
      select distinct ur.auth_user_id as u from hr.user_role ur join hr.real_admins ra on ra.auth_user_id = ur.auth_user_id
      where ur.role = 'admin' and ur.revoked_at is null and ur.valid_during @> ${todayIso}::date`).map((r) => r.u);
    const created = await tx<{ id: string; employee_code: string; full_name: string; kind: string; end_date: string; days: number }[]>`
      with due as (
        select 'probation_end' as kind, 'probation_period' as source_table, p.id as source_id, p.employee_id, p.probation_end as end_date
        from hr.current_probation p join hr.employee e on e.id = p.employee_id and e.status = 'active'
        where p.probation_end between ${todayIso}::date and ${todayIso}::date + ${lead}::int
        union all
        select 'contract_end', 'employment_contract', c.id, c.employee_id, c.contract_end
        from hr.current_contract c join hr.employee e on e.id = c.employee_id and e.status = 'active'
        where c.contract_end between ${todayIso}::date and ${todayIso}::date + ${lead}::int),
      ins as (
        insert into hr.lifecycle_alert (employee_id, kind, source_table, source_id, end_date, stage, due_on)
        select employee_id, kind, source_table, source_id, end_date, 'initial', ${todayIso}::date from due
        on conflict (source_id, end_date, stage) do nothing
        returning id, employee_id, kind, end_date)
      select ins.id, e.employee_code, e.full_name, ins.kind, ins.end_date, (ins.end_date - ${todayIso}::date) as days
      from ins join hr.employee e on e.id = ins.employee_id`;
    const notes = created.flatMap((a) => admins.map((u) => {
      const label = a.kind === "probation_end" ? "Probation" : "Contract";
      return { u, id: a.id, title: `${label} ends in ${a.days} days: ${a.full_name}`,
               body: `${a.employee_code} ${a.full_name}: ${label.toLowerCase()} ends ${a.end_date}. Decide: confirm, extend, renew, revise or end.` };
    }));
    if (notes.length)
      await tx`insert into hr.notification (recipient_auth_user_id, kind, subject_table, subject_id, title, body)
               select u, 'lifecycle_alert', 'lifecycle_alert', id, title, body
               from jsonb_to_recordset(${tx.json(notes as never)}) as x(u uuid, id uuid, title text, body text)`;
    return created.length;
  });
}
