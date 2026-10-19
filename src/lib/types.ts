// UI-facing types come straight from the server services (type-only
// imports are erased at build time), so the UI and the SQL can't drift.
import type { getBatch } from "@/server/services/attendance";
import type { getEmployee } from "@/server/services/employees";
import type { me } from "@/server/services/dashboard";

export type { Role } from "@/server/context";
export type { EmployeeRow as EmployeeListItem, TimelineEvent } from "@/server/services/employees";
export type { ChecklistItem, DocVersion } from "@/server/services/documents";
export type { Batch, Device, Flag, PersonSummary, Punch } from "@/server/services/attendance";
export type { Approval } from "@/server/services/approvals";
export type { Reference, Summary as DashboardSummary } from "@/server/services/dashboard";
export type EmployeeDetail = Awaited<ReturnType<typeof getEmployee>>;
export type BatchDetail = Awaited<ReturnType<typeof getBatch>>;
export type Me = Awaited<ReturnType<typeof me>>;
