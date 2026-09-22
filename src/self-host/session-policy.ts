export type SessionPolicyState = {
  closing: boolean;
  activeRequests: number;
  openStreams: number;
  lastActivityAt: number;
};

export function isSessionEvictable(
  context: SessionPolicyState,
): boolean {
  return (
    !context.closing &&
    context.activeRequests === 0 &&
    context.openStreams === 0
  );
}

export function isSessionIdle(
  context: SessionPolicyState,
  now: number,
  idleMs: number,
): boolean {
  return (
    isSessionEvictable(context) &&
    now - context.lastActivityAt >= idleMs
  );
}
