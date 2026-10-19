import { redirect } from "next/navigation";
import { withSession } from "@/server/session";

export default async function Home() {
  const roles = await withSession(async (c) => c.roles);
  redirect(roles.has("admin") || roles.has("hr") ? "/dashboard" : roles.has("manager") ? "/employees" : "/me");
}
