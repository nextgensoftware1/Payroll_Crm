const enabled = () => process.env.HR_PERF_LOG === "1";

export async function measure<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled()) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    // Deliberately log only operation and duration: never values, employees,
    // tokens, salaries, or authentication data.
    console.info(`[empire-hr:perf] ${operation} ${Math.round(performance.now() - start)}ms`);
  }
}

export async function measureQuery<T>(queryName: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled()) return fn();
  const start = performance.now();
  try {
    const result = await fn();
    const rows = Array.isArray(result) ? result.length : 0;
    console.info(`[empire-hr:perf:query] ${queryName} ${Math.round(performance.now() - start)}ms rows=${rows}`);
    return result;
  } catch (error) {
    console.error(`[empire-hr:perf:query] ${queryName} ${Math.round(performance.now() - start)}ms error=true`);
    throw error;
  }
}
