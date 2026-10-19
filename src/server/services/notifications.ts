import "server-only";
import type { Ctx } from "../context.ts";

export async function myNotifications(ctx: Ctx) {
  return ctx.tx<{ id: string; title: string; body: string; created_at: string; read_at: string | null }[]>`
    select id, title, body, created_at, read_at from hr.notification
    where recipient_auth_user_id = hr.current_auth_user() order by created_at desc limit 12`;
}
export async function markAllRead(ctx: Ctx) {
  await ctx.tx`update hr.notification set read_at = now() where recipient_auth_user_id = hr.current_auth_user() and read_at is null`;
}
