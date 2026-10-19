import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { withSession } from "@/server/session";
import { reference as getReference } from "@/server/services/dashboard";
import { listEmployees } from "@/server/services/employees";
import { NewEmployeeForm } from "./NewEmployeeForm";

export const metadata: Metadata = { title: "Add employee" };

export default async function NewEmployee() {
  const { reference, people } = await withSession(async (c) => ({
    reference: await getReference(c),
    people: await listEmployees(c, { status: "active", pageSize: 200 }),
  }), { roles: ["admin", "hr"] });
  return (
    <>
      <PageHeader title="Add employee" lede="Creates the record, first placement, probation and contract dates, and requests the documents this employment type needs." />
      <NewEmployeeForm reference={reference} managers={people.items} />
    </>
  );
}
