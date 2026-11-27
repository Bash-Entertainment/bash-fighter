// Title-screen beacon: one 'view' when the start screen first shows, one
// 'play' on the first Play online click. Together with the viewport size
// and whether Play was on screen without scrolling, it gives the share of
// visitors who ever press Play, which session records cannot (they only
// exist once a match is joined).
import { apiRequest } from './portal.ts';
import { visitSource } from './session-report.ts';

export type TitleEvent = 'view' | 'play';

export interface TitleBeaconBody {
  event: TitleEvent;
  qa: boolean;
  w: number;
  h: number;
  touch: boolean;
  playVisible: boolean;
  source: string | null;
}

/** True when the whole element is inside the viewport without scrolling. */
export function fullyOnScreen(rect: { top: number; bottom: number }, viewportHeight: number): boolean {
  return rect.top >= 0 && rect.bottom <= viewportHeight;
}

/** playVisible is always the value measured when the title first showed,
 *  so a 'play' record says whether that visitor had to scroll to find it. */
export function titleBeaconBody(event: TitleEvent, playVisible: boolean, touch: boolean): TitleBeaconBody {
  return {
    event,
    qa: new URLSearchParams(location.search).get('qa') === '1',
    w: Math.round(window.innerWidth),
    h: Math.round(window.innerHeight),
    touch,
    playVisible,
    source: visitSource(location.search, document.referrer, location.hostname) ?? null,
  };
}

export function postTitleEvent(body: TitleBeaconBody): void {
  const api = apiRequest('/api/title');
  void fetch(api.url, {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': api.contentType },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}
