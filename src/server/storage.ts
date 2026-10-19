import "server-only";
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.ts";

/** File storage. Write-once everywhere: no overwrite, no delete. */
export interface Storage {
  upload(bucket: string, objectPath: string, data: Uint8Array, contentType: string): Promise<void>;
  signedUrl(bucket: string, objectPath: string, ttlSeconds: number): Promise<string | null>; // null = stream instead
  read(bucket: string, objectPath: string): Promise<Uint8Array>;
}

/** Supabase Storage through a given client. For user requests pass the
 *  SESSION client: storage.objects RLS then applies as a second layer. */
export class SupabaseStorage implements Storage {
  private readonly sb: SupabaseClient;
  constructor(sb: SupabaseClient) {
    this.sb = sb;
  }
  async upload(bucket: string, objectPath: string, data: Uint8Array, contentType: string) {
    const { error } = await this.sb.storage.from(bucket).upload(objectPath, data, { contentType, upsert: false });
    if (error) throw new Error(`storage upload failed: ${error.message}`);
  }
  async signedUrl(bucket: string, objectPath: string, ttl: number) {
    const { data, error } = await this.sb.storage.from(bucket).createSignedUrl(objectPath, ttl);
    if (error) throw new Error(`storage signing failed: ${error.message}`);
    return data.signedUrl;
  }
  async read(bucket: string, objectPath: string) {
    const { data, error } = await this.sb.storage.from(bucket).download(objectPath);
    if (error) throw new Error(`storage download failed: ${error.message}`);
    return new Uint8Array(await data.arrayBuffer());
  }
}

/** Development and tests only; refused in production by config(). */
export class LocalStorage implements Storage {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  private file(bucket: string, p: string) {
    const f = path.resolve(this.root, bucket, p);
    if (!f.startsWith(this.root + path.sep)) throw new Error("path escapes storage root");
    return f;
  }
  async upload(bucket: string, p: string, data: Uint8Array) {
    const f = this.file(bucket, p);
    await mkdir(path.dirname(f), { recursive: true });
    const h = await open(f, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); // write-once
    try { await h.write(data); } finally { await h.close(); }
  }
  async signedUrl() { return null; }
  async read(bucket: string, p: string) { return new Uint8Array(await readFile(this.file(bucket, p))); }
}

/** Service-role storage for cron jobs ONLY (bypasses storage RLS). */
export function serviceStorage(): Storage {
  const c = config();
  if (c.STORAGE_BACKEND === "local") return new LocalStorage(c.LOCAL_STORAGE_DIR);
  if (!c.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for background jobs");
  return new SupabaseStorage(createClient(c.NEXT_PUBLIC_SUPABASE_URL, c.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }));
}
