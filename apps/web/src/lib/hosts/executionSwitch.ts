// Registered by the mounted execution UI. Bootstrap escape has no mounted
// editor buffers and must remain available without contacting either server.
let guard:
  | { flush: () => Promise<boolean>; recover: () => void; drafts?: () => unknown[] }
  | undefined;
export function registerExecutionSwitchGuard(value: NonNullable<typeof guard>): void {
  guard = value;
}
export async function flushBeforeExecutionSwitch(): Promise<void> {
  if (guard && !(await guard.flush()))
    throw new Error("Save or recover the unsaved editor drafts before switching computers.");
}
export function recoverBeforeLocalEscape(): void {
  guard?.recover();
}

export function readUnsavedExecutionDrafts(): unknown[] {
  return guard?.drafts?.() ?? [];
}
