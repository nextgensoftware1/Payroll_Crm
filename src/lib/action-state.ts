/** Result shape every Server Action returns to its form (useActionState). */
export type ActionState = { ok?: boolean; error?: string; code?: string; extra?: Record<string, unknown>; message?: string } | undefined;
