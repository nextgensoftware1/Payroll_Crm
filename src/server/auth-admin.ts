import "server-only";
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";
import { AppError } from "./errors.ts";

/** Supabase Auth admin operations (server only: uses the service-role key).
 *  `must_change_password` lives in app_metadata, which users cannot edit
 *  themselves, and is carried in their sign-in token. */
export interface AuthAdmin {
  createUser(a: { email: string; password: string }): Promise<{ id: string }>;
  deleteUser(id: string): Promise<void>;
  setTemporaryPassword(id: string, password: string): Promise<void>;
  clearMustChange(id: string): Promise<void>;
}

export class SupabaseAuthAdmin implements AuthAdmin {
  private client() {
    const c = config();
    if (!c.SUPABASE_SERVICE_ROLE_KEY) throw new AppError(500, "not_configured", "SUPABASE_SERVICE_ROLE_KEY is not set on the server.");
    return createClient(c.NEXT_PUBLIC_SUPABASE_URL, c.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  async createUser(a: { email: string; password: string }) {
    const { data, error } = await this.client().auth.admin.createUser({
      email: a.email, password: a.password, email_confirm: true, app_metadata: { must_change_password: true } });
    if (error) {
      if (/already|registered|exists/i.test(error.message))
        throw new AppError(409, "email_taken", "A login with that email already exists. Use \"Link an existing login\" with its user ID instead.");
      if (/password/i.test(error.message)) throw new AppError(422, "weak_password", `Supabase rejected the password: ${error.message}`);
      throw new AppError(502, "auth_failed", `Supabase could not create the login: ${error.message}`);
    }
    return { id: data.user.id };
  }
  async deleteUser(id: string) { await this.client().auth.admin.deleteUser(id); }
  async setTemporaryPassword(id: string, password: string) {
    const { error } = await this.client().auth.admin.updateUserById(id, { password, app_metadata: { must_change_password: true } });
    if (error) throw new AppError(502, "auth_failed", `Supabase could not reset the password: ${error.message}`);
  }
  async clearMustChange(id: string) {
    const { error } = await this.client().auth.admin.updateUserById(id, { app_metadata: { must_change_password: false } });
    if (error) throw new AppError(502, "auth_failed", `Supabase could not update the account: ${error.message}`);
  }
}
