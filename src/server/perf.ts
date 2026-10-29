import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const traceStore = new AsyncLocalStorage<string>();
const enabled = () => process.env.HR_PERF_LOG === "1";
export const createPerfTraceId = () => randomUUID();
export const runWithPerfTrace = <T>(traceId: string, fn: () => Promise<T>): Promise<T> =>
  traceStore.run(traceId, fn);
export const perfTraceId = () => traceStore.getStore();
const tracePrefix = () => {
  const traceId = traceStore.getStore();
  return traceId ? `trace=${traceId} ` : "";
};

export async function measure<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled()) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    // Deliberately log only operation and duration: never values, employees,
    // tokens, salaries, or authentication data.
    console.info(`[empire-hr:perf] ${tracePrefix()}operation=${operation} elapsed=${Math.round(performance.now() - start)}ms`);
  }
}

export async function measureQuery<T>(queryName: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled()) return fn();
  const start = performance.now();
  try {
    const result = await fn();
    const rows = Array.isArray(result) ? result.length : 0;
    console.info(`[empire-hr:perf:query] ${tracePrefix()}operation=${queryName} elapsed=${Math.round(performance.now() - start)}ms rows=${rows}`);
    return result;
  } catch (error) {
    console.error(`[empire-hr:perf:query] ${tracePrefix()}operation=${queryName} elapsed=${Math.round(performance.now() - start)}ms error=true`);
    throw error;
  }
}
