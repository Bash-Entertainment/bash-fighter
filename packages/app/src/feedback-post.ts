import type { LeaveReasonId } from './leave-prompt.ts';
import { recentErrors } from './error-buffer.ts';
import { readBuildSha } from './ui/feedback-panel.ts';

export interface LeaveReasonExtra {
  trigger?: string;
  matchAgeSec?: number;
  matchIndex?: number;
}

/** Posts one leave-reason record. Fire-and-forget, keepalive so it survives the tab closing. */
export function postLeaveReason(reason: LeaveReasonId, comment: string, touchControls: boolean, extra: LeaveReasonExtra = {}): void {
  const buildSha = readBuildSha();
  const errors = recentErrors();
  void fetch('/api/feedback', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(new URLSearchParams(location.search).get('qa') === '1' ? { qa: true } : {}),
      kind: 'leave-reason',
      reason,
      comment: comment.length > 0 ? comment : undefined,
      context: {
        touchControls,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        ...(buildSha ? { buildSha } : {}),
        ...extra,
        ...(errors.length > 0 ? { errors } : {}),
      },
    }),
  }).catch(() => undefined);
}
