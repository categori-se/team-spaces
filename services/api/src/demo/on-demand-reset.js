// @ts-check

/**
 * No background timer: an expired demo is refreshed only when its API is used.
 * @param {{pointer: {nextResetAt?: string, resetLeaseUntil?: number}, now: number, claim: (leaseUntil: number) => unknown | Promise<unknown>, invoke: () => unknown | Promise<unknown>}} options
 */
export async function requestResetOnAccess({pointer, now, claim, invoke}) {
  const deadline = Date.parse(pointer?.nextResetAt ?? "");
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) throw new Error("Demo reset deadline unavailable");
  if (now < deadline) return false;
  if (Number(pointer.resetLeaseUntil) > now) return true;
  try {
    await claim(now + 120000);
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException") return true;
    throw error;
  }
  // Keep the short lease if invocation fails, to bound retry traffic.
  await invoke();
  return true;
}
