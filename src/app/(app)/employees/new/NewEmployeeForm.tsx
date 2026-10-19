"use client";
import { useActionState, useState } from "react";
import { FormMessage, SubmitButton } from "@/components/forms";
import type { EmployeeListItem, Reference } from "@/lib/types";
import { createEmployee } from "../actions";

const CATEGORIES = [
  ["fixed_monthly", "Fixed monthly"], ["fixed_plus_incentive", "Fixed + commission/incentive"], ["commission_only", "Commission only"],
  ["probationary_trainee", "Probationary / trainee"], ["contractor", "Contractor"], ["consultant", "Consultant"],
] as const;

export function NewEmployeeForm({ reference, managers }: { reference: Reference; managers: EmployeeListItem[] }) {
  const [state, action] = useActionState(createEmployee, undefined);
  const [dept, setDept] = useState("");
  const teams = reference.teams.filter((t) => t.department_id === dept);
  return (
    <form action={action} className="panel grid gap-5 p-6 md:grid-cols-2">
      <fieldset className="contents">
        <legend className="col-span-full text-[17px] font-semibold">Person</legend>
        <div><label className="label" htmlFor="employee_code">Employee code</label>
          <input className="field uppercase" id="employee_code" name="employee_code" placeholder="EN-0048" required /></div>
        <div><label className="label" htmlFor="full_name">Full name</label>
          <input className="field" id="full_name" name="full_name" required /></div>
        <div><label className="label" htmlFor="work_email">Work email</label>
          <input className="field" id="work_email" name="work_email" type="email" /></div>
        <div><label className="label" htmlFor="phone">Phone</label>
          <input className="field" id="phone" name="phone" inputMode="tel" placeholder="+92 3xx xxxxxxx" /></div>
      </fieldset>
      <fieldset className="contents">
        <legend className="col-span-full mt-2 text-[17px] font-semibold">Role and placement</legend>
        <div><label className="label" htmlFor="employment_category">Employment type</label>
          <select className="field" id="employment_category" name="employment_category" required>
            {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div><label className="label" htmlFor="job_title">Job title</label>
          <input className="field" id="job_title" name="job_title" required /></div>
        <div><label className="label" htmlFor="department_id">Department</label>
          <select className="field" id="department_id" name="department_id" required value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">Choose…</option>{reference.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
        <div><label className="label" htmlFor="team_id">Team</label>
          <select className="field" id="team_id" name="team_id" disabled={!teams.length}>
            <option value="">{teams.length ? "None" : "No teams in this department"}</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <div><label className="label" htmlFor="manager_employee_id">Manager</label>
          <select className="field" id="manager_employee_id" name="manager_employee_id">
            <option value="">None</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.full_name} ({m.employee_code})</option>)}</select></div>
        <div><label className="label" htmlFor="calendar_id">Work calendar</label>
          <select className="field" id="calendar_id" name="calendar_id">
            <option value="">Assign later</option>{reference.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      </fieldset>
      <fieldset className="contents">
        <legend className="col-span-full mt-2 text-[17px] font-semibold">Dates</legend>
        <div><label className="label" htmlFor="joining_date">Joining date</label>
          <input className="field" id="joining_date" name="joining_date" type="date" required /></div>
        <div><label className="label" htmlFor="probation_end">Probation ends</label>
          <input className="field" id="probation_end" name="probation_end" type="date" /></div>
        <div><label className="label" htmlFor="contract_end">Contract ends</label>
          <input className="field" id="contract_end" name="contract_end" type="date" />
          <p className="mt-1 text-[13px] text-ink-3">Leave empty for an open-ended contract.</p></div>
      </fieldset>
      <div className="col-span-full flex flex-col gap-3 border-t border-line pt-4">
        <p className="text-[13.5px] text-ink-2">Salary and bank details are added separately and need Admin approval.</p>
        <FormMessage state={state} />
        <div><SubmitButton pendingText="Adding…">Add employee</SubmitButton></div>
      </div>
    </form>
  );
}
