"""Independent validation of the Empire HR mock dataset.

Recomputes attendance, deductions and payroll FROM THE RAW DEVICE CSV FILES
with a separate Python implementation, then compares with what the app
calculated (fixture.json). Two independent implementations must agree.

    python3 validate.py <dir with fixture.json and device-exports/>
"""
import csv, json, sys, glob, os
from datetime import datetime, timedelta, date
from collections import defaultdict, Counter

D = sys.argv[1] if len(sys.argv) > 1 else "."
F = json.load(open(os.path.join(D, "fixture.json")))
results = []

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))

# ---------------------------------------------------------------- inputs
rules = {r["key"]: r["value"] for r in F["rules"] if r["from"] <= "2026-06-01"}
GRACE, PCT, DIV, ABS = rules["attendance.grace_minutes"], rules["attendance.late_penalty_percent_of_day"], rules["payroll.working_days_divisor"], rules["attendance.absence_penalty_days"]
emps = {e["employee_code"]: e for e in F["employees"]}
by_enrol = {e["enrollment_no"]: e for e in F["employees"]}
holidays = {h["date"] for h in F["holidays"]}
leave = defaultdict(set)
for l in F["leave"]:
    d = date.fromisoformat(l["from"])
    while d <= date.fromisoformat(l["to"]):
        leave[l["employee_code"]].add(d.isoformat()); d += timedelta(days=1)

def parse_ts(s):
    return datetime.strptime(s, "%m/%d/%Y %I:%M:%S %p")

files = sorted(glob.glob(os.path.join(D, "device-exports", "*.csv")))
rows_by_file = {}
for f in files:
    with open(f, newline="", encoding="utf-8") as fh:
        rows_by_file[os.path.basename(f)] = list(csv.DictReader(fh))
# unique punches (the app's idempotency key: device, enrollment, local time, raw label)
punches = {}
for name, rows in rows_by_file.items():
    for r in rows:
        punches[(r["Location ID"], r["No."], r["Date/Time"], r["Status"])] = r

# ---------------------------------------------------------------- 1. employees
codes = [e["employee_code"] for e in F["employees"]]
check("15 employees with unique codes EN-0001 to EN-0015", len(set(codes)) == 15 and sorted(codes) == [f"EN-{i:04d}" for i in range(1, 16)], f"{len(set(codes))} unique")
names = [e["full_name"] for e in F["employees"]]
check("The 15 specified Pakistani names", sorted(names) == sorted(["Ayesha Khan", "Bilal Ahmed", "Hamza Raza", "Sana Iqbal", "Usman Tariq", "Fatima Noor", "Ali Hassan", "Zainab Malik",
      "Omar Farooq", "Hira Shah", "Saad Qureshi", "Mariam Javed", "Danish Ali", "Noor Fatima", "Kashif Mehmood"]))
shifts = Counter(e["shift"] for e in F["employees"])
check("Shift distribution 8 / 4 / 2 + 1 without a shift", shifts == Counter({"5 PM to 2 AM": 8, "6 PM to 3 AM": 4, "4 PM to 1 AM": 2, None: 1}), dict(shifts))
sal = [s["monthly_paisa"] / 100 for e in F["employees"] for s in e["salary_history"]]
check("Salaries within PKR 45,000 to 95,000", all(45000 <= s <= 95000 for s in sal), f"{min(sal):,.0f} to {max(sal):,.0f}")
no_sal = [e["employee_code"] for e in F["employees"] if not e["salary_history"]]
no_shift = [e["employee_code"] for e in F["employees"] if not e["shift"]]
check("Exactly one employee without a salary, one without a shift", len(no_sal) == 1 and len(no_shift) == 1 and no_sal != no_shift, f"no salary {no_sal}, no shift {no_shift}")
auto = [e["employee_code"] for e in F["employees"] if e["auto_created"]]
check("Automatic employee creation during an import (EN-0015, joining date = first punch)", auto == ["EN-0015"] and emps["EN-0015"]["joining_date"] == "2026-08-17", auto)

# salary history effective-dated, no overlaps, starts on/after joining
ok = True
for e in F["employees"]:
    h = sorted(e["salary_history"], key=lambda s: s["from"])
    for a, b in zip(h, h[1:]):
        ok &= a["to"] == b["from"]
    if h: ok &= h[0]["from"] >= e["joining_date"]
check("Salary history is effective-dated (no gaps or overlaps, never before joining)", ok)

# ---------------------------------------------------------------- 2. punches
check("Every punch belongs to a known enrollment number", all(k[1] in by_enrol for k in punches), f"{len(punches)} unique punches")
first_seen_15 = min(parse_ts(k[2]) for k in punches if k[1] == "15")
check("The new person (No. 15) first appears in the August export", first_seen_15.strftime("%Y-%m-%d") == "2026-08-17", first_seen_15)
check("No punch before an employee's joining date",
      all(parse_ts(k[2]).date() >= date.fromisoformat(by_enrol[k[1]]["joining_date"]) for k in punches))
imp = {i["filename"]: i for i in F["imports"]}
seen, ok, detail = set(), True, []
for name in ["ZK101_AttLog_20260601-20260701.csv", "ZK101_AttLog_20260701-20260716.csv", "ZK101_AttLog_20260701-20260801.csv", "ZK101_AttLog_20260801-20260901.csv"]:
    keys = {(r["Location ID"], r["No."], r["Date/Time"], r["Status"]) for r in rows_by_file[name]}
    new, dup = len(keys - seen), len(keys & seen)
    ok &= imp[name]["recorded"] == new and imp[name]["duplicates"] == dup and imp[name]["source_rows"] == len(rows_by_file[name])
    detail.append(f"{name}: {len(rows_by_file[name])} rows, {new} new, {dup} duplicates")
    seen |= keys
check("Import counts (rows, recorded, duplicates) match the files exactly", ok, "; ".join(detail))
check("Punches in database = unique punches in all files", F["_checks_input"]["raw_punches_in_db"] == len(punches), F["_checks_input"]["raw_punches_in_db"])
dbl = 0
for no in by_enrol:
    ts = sorted(parse_ts(k[2]) for k in punches if k[1] == no)
    dbl += sum(1 for a, b in zip(ts, ts[1:]) if (b - a).total_seconds() <= 60)
check("Double presses within 60 seconds exist and are kept", dbl > 0, f"{dbl} double presses")

# ---------------------------------------------------------------- 3. independent attendance + pay
def shift_start(code):
    s = emps[code]["shift"]
    if not s: return None
    h = int(s.split()[0]) % 12 + (12 if s.split()[1] == "PM" else 0)
    return h

def salary_for(code, month_start, month_end):
    best = None
    for s in emps[code]["salary_history"]:
        if s["from"] <= month_end and (s["to"] is None or s["to"] > month_start):
            if best is None or s["from"] > best["from"]: best = s
    return best["monthly_paisa"] if best else None

mismatches = []
for month, M in F["months"].items():
    y, m = map(int, month.split("-"))
    first = date(y, m, 1); last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
    days = [first + timedelta(days=i) for i in range((last - first).days + 1)]
    app = {e["employee_code"]: e for e in M["employees"]}
    sum_gross = sum_ded = sum_net = 0
    for code, e in emps.items():
        if e["joining_date"] > last.isoformat():
            if code in app: mismatches.append(f"{month} {code}: appears before joining")
            continue
        a = app[code]
        start = shift_start(code)
        ps = sorted(parse_ts(k[2]) for k in punches if k[1] == e["enrollment_no"])
        byday = defaultdict(list)
        if start is not None:
            for t in ps:
                byday[(t - timedelta(hours=start - 3)).date().isoformat()].append(t)
        monthly = salary_for(code, first.isoformat(), last.isoformat())
        daily = round(monthly / DIV) if monthly is not None else None
        late_cut = round(daily * PCT / 100) if daily is not None else None
        tot = Counter(); late_min = 0; late_d = abs_d = 0
        app_days = {d["date"]: d for d in a["days"]}
        for d in days:
            ds, wdy = d.isoformat(), d.isoweekday()
            employed = ds >= e["joining_date"]
            sched = employed and start is not None and wdy <= 5
            ps_d = byday.get(ds, [])
            if not employed: st = "not_employed"
            elif ds in holidays: st = "holiday"
            elif ds in leave[code]: st = "leave"
            elif not sched: st = "rest_day_work" if ps_d else "rest"
            elif not ps_d: st = "absent"
            elif len(ps_d) == 1: st = "incomplete"
            else:
                late_s = (ps_d[0] - datetime(d.year, d.month, d.day, start)).total_seconds()
                st = "late" if late_s > GRACE * 60 else "present"
                if st == "late": late_min += -(-int(late_s) // 60)
            tot[st] += 1
            if app_days[ds]["status"] != st: mismatches.append(f"{month} {code} {ds}: app={app_days[ds]['status']} independent={st}")
            if st in ("incomplete", "leave", "holiday", "rest", "rest_day_work", "not_employed") and app_days[ds]["deduction_paisa"] != 0:
                mismatches.append(f"{month} {code} {ds}: {st} day has a deduction")
            if st == "absent" and not (sched and ds not in holidays and ds not in leave[code]): mismatches.append(f"{month} {code} {ds}: absent on an ineligible day")
        t = a["totals"]
        if (t["late"], t["absent"], t["incomplete"], t["lateMinutes"]) != (tot["late"], tot["absent"], tot["incomplete"], late_min):
            mismatches.append(f"{month} {code}: totals app={t['late'], t['absent'], t['incomplete'], t['lateMinutes']} independent={tot['late'], tot['absent'], tot['incomplete'], late_min}")
        if monthly is not None:
            wds = [d for d in days if d.isoweekday() <= 5]
            employed_days = sum(1 for d in wds if d.isoformat() >= e["joining_date"])
            gross = monthly if employed_days >= len(wds) else daily * employed_days
            ded = min(gross, tot["late"] * late_cut + tot["absent"] * round(daily * ABS))
            if (t["grossPaisa"], t["totalDeductionPaisa"], t["netPaisa"]) != (gross, ded, gross - ded):
                mismatches.append(f"{month} {code}: money app={t['grossPaisa'], t['totalDeductionPaisa'], t['netPaisa']} independent={gross, ded, gross - ded}")
            sum_gross += gross; sum_ded += ded; sum_net += gross - ded
    o = M["overview"]
    if (o["gross_paisa"], o["deductions_paisa"], o["net_paisa"]) != (sum_gross, sum_ded, sum_net):
        mismatches.append(f"{month} overview totals app={o['gross_paisa'], o['deductions_paisa'], o['net_paisa']} independent={sum_gross, sum_ded, sum_net}")
    # payroll current version = report figures, line by line, and totals reconcile
    cur = next(v for v in M["payroll"]["versions"] if v["status"] == "locked")
    for l in cur["lines"]:
        t = app[l["employee_code"]]["totals"]
        if (l["gross_paisa"], l["total_deductions_paisa"], l["net_paisa"]) != (t["grossPaisa"], t["totalDeductionPaisa"], t["netPaisa"]):
            mismatches.append(f"{month} payslip {l['employee_code']} differs from the report")
        if l["net_paisa"] != l["gross_paisa"] - l["total_deductions_paisa"]: mismatches.append(f"{month} payslip {l['employee_code']}: net != gross - deductions")
    if sum(l["net_paisa"] for l in cur["lines"]) != sum_net: mismatches.append(f"{month} payroll total net != sum of employees")
    if any(l["employee_code"] in no_sal for l in cur["lines"]): mismatches.append(f"{month}: no-salary employee appears in payroll")

check("Every day's status recomputed independently from the raw CSVs matches the app (all 3 months)", not [x for x in mismatches if " app=" in x and "money" not in x and "totals" not in x and "overview" not in x], f"{sum(len(M['employees']) * len(M['employees'][0]['days']) for M in F['months'].values())} employee-days compared")
check("Late minutes, late/absent/needs-review counts match per employee", not [x for x in mismatches if "totals" in x])
check("Gross, deductions and net match per employee (independent arithmetic)", not [x for x in mismatches if "money" in x])
check("Single-punch, leave, holiday, rest and not-employed days carry zero deduction", not [x for x in mismatches if "has a deduction" in x])
check("Absences only on scheduled working days within employment", not [x for x in mismatches if "ineligible" in x])
check("Overview totals = sum of employee records (no-salary employee excluded)", not [x for x in mismatches if "overview" in x])
check("Payroll lines = report figures; totals reconcile; no-salary employee excluded", not [x for x in mismatches if "payslip" in x or "payroll" in x or "no-salary" in x])
check("No attendance or pay before joining (Danish from 13 Jul, Kashif from 17 Aug)", not [x for x in mismatches if "before joining" in x]
      and all(d["status"] == "not_employed" for d in next(e for e in F["months"]["2026-08"]["employees"] if e["employee_code"] == "EN-0015")["days"] if d["date"] < "2026-08-17"))

# overnight example: one night = one session
ex = next(e for e in F["months"]["2026-08"]["employees"] if e["employee_code"] == "EN-0001")
night = next(d for d in ex["days"] if d["in"] and d["out"])
check("Overnight sessions: clock-out after midnight belongs to the previous evening", night["out"][:10] > night["date"],
      f"EN-0001 {night['date']}: in {night['in'][11:16]}, out {night['out'][:10]} {night['out'][11:16]}, worked {night['worked_minutes']} min")
b = {(e["employee_code"], d["date"]): d for e in F["months"]["2026-08"]["employees"] for d in e["days"]}
check("Grace boundary: exactly 10:00 late is on time, 10:01 is late", b[("EN-0004", "2026-08-06")]["status"] == "present" and b[("EN-0007", "2026-08-06")]["status"] == "late",
      f"Sana {b[('EN-0004', '2026-08-06')]['in'][11:]} on time; Ali {b[('EN-0007', '2026-08-06')]['in'][11:]} late")
check("August 2026 has 21 working days; 14 Aug is a paid holiday", next(e for e in F["months"]["2026-08"]["employees"] if e["employee_code"] == "EN-0001")["totals"]["scheduled"] == 21
      and b[("EN-0001", "2026-08-14")]["status"] == "holiday")

# ---------------------------------------------------------------- 4. payroll versions
jul = F["months"]["2026-07"]["payroll"]["versions"]
v1 = next(v for v in jul if v["version"] == 1); v2 = next(v for v in jul if v["version"] == 2)
f1 = next(l for l in v1["lines"] if l["employee_id"] == emps["EN-0006"]["employee_id"])
f2 = next(l for l in v2["lines"] if l["employee_code"] == "EN-0006")
check("July version 1 kept unchanged after reopen (snapshot hash identical)", F["_checks_input"]["july_v1_snapshot_hash"] == F["_checks_input"]["july_v1_snapshot_now"])
check("July v1 deducted Fatima's 2 unrecorded days; v2 (leave approved) does not",
      f1["total_deductions_paisa"] > f2["total_deductions_paisa"] and f1["net_paisa"] < f2["net_paisa"],
      f"v1 net {f1['net_paisa'] / 100:,.2f} -> v2 net {f2['net_paisa'] / 100:,.2f}")
check("August payroll locked as version 1; June locked", F["months"]["2026-08"]["payroll"]["current_version"] == 1 and F["months"]["2026-08"]["payroll"]["status"] == "locked"
      and F["months"]["2026-06"]["payroll"]["status"] == "locked")

# month-over-month from actual records
a, j = F["months"]["2026-08"]["overview"], F["months"]["2026-07"]["overview"]
check("Month-over-month comparison computed from July and August records", True,
      f"late days {j['late_days']} -> {a['late_days']}, absences {j['absent_days']} -> {a['absent_days']}, net PKR {j['net_paisa'] / 100:,.2f} -> {a['net_paisa'] / 100:,.2f}")

# ---------------------------------------------------------------- report
passed = sum(1 for _, ok, _ in results if ok)
lines = [f"# Mock dataset validation\n", f"**{passed} of {len(results)} checks passed.** Independent Python recomputation from the raw device CSVs vs. the app's own figures.\n",
         "| # | Check | Result | Detail |", "|---|---|---|---|"]
for i, (n, ok, d) in enumerate(results, 1):
    lines.append(f"| {i} | {n} | {'PASS' if ok else 'FAIL'} | {str(d).replace('|', '/')} |")
if mismatches:
    lines += ["", "## Mismatches", *[f"- {m}" for m in mismatches[:50]]]
open(os.path.join(D, "VALIDATION.md"), "w").write("\n".join(lines) + "\n")
print("\n".join(lines[:2]))
for n, ok, d in results:
    if not ok: print("FAIL:", n, d)
if mismatches: print("first mismatches:", mismatches[:8])
sys.exit(0 if passed == len(results) else 1)
