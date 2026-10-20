import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const migrationDir = path.join(root, "supabase", "migrations");
const outputPath = path.join(root, "db", "export_supabase.sql");
const migrations = readdirSync(migrationDir)
  .filter((file) => /^\d{14}_.+\.sql$/.test(file))
  .sort();

if (migrations.length === 0) {
  throw new Error(`No migration files found in ${migrationDir}`);
}

const header = [
  "-- Generated from supabase/migrations by `npm run db:export`.",
  "-- Run once on a fresh Supabase project as the database owner (postgres).",
  "-- Do not run on a database where these migrations have already been applied.",
  "-- This file contains the application schema and Supabase Storage setup only.",
  "-- Login roles, initial Admin users, and development seed data are separate setup steps.",
  "",
].join("\n");

const body = migrations
  .map((file) => `-- Source: supabase/migrations/${file}\n${readFileSync(path.join(migrationDir, file), "utf8").trimEnd()}`)
  .join("\n\n");

const trackingRows = migrations
  .map((file) => {
    const [version, ...name] = file.replace(/\.sql$/, "").split("_");
    return `  ('${version}', ARRAY[]::text[], '${name.join("_")}')`;
  })
  .join(",\n");
const tracking = [
  "-- Record the included migrations so the Supabase CLI and scripts/migrate.ts",
  "-- do not try to apply them again after this SQL Editor setup.",
  "create schema if not exists supabase_migrations;",
  "create table if not exists supabase_migrations.schema_migrations (",
  "  version text primary key,",
  "  statements text[],",
  "  name text",
  ");",
  "insert into supabase_migrations.schema_migrations (version, statements, name) values",
  `${trackingRows}`,
  "on conflict (version) do nothing;",
].join("\n");

writeFileSync(outputPath, `${header}${body}\n\n${tracking}\n`, "utf8");
console.log(`Exported ${migrations.length} migrations to ${path.relative(root, outputPath)}`);
