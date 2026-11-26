// End-of-match Share: turns the private-lobby invite link into a brag a
// player can send. Phones get the native share sheet; elsewhere the text
// and link go to the clipboard. The link carries ref=share so arrivals
// show up as their own source in the stats.
import { copyToClipboard } from './join-link.ts';
import { apiRequest } from './portal.ts';

export function shareMessage(placement: number, totalFighters: number): string {
  return placement === 1
    ? `I won a ${totalFighters}-player Bash Fighter match. Think you can beat me?`
    : `I finished #${placement} of ${totalFighters} in Bash Fighter. Think you can beat me?`;
}

export function withShareRef(link: string): string {
  const url = new URL(link);
  url.searchParams.set('ref', 'share');
  return url.toString();
}

/** Resolves to 'shared', 'copied' or 'failed'. A dismissed share sheet
 *  counts as 'failed' so the button doesn't claim success. */
export async function shareResult(text: string, link: string): Promise<'shared' | 'copied' | 'failed'> {
  const nav = globalThis.navigator as Navigator | undefined;
  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share({ title: 'Bash Fighter', text, url: link });
      return 'shared';
    } catch {
      // AbortError (dismissed) or blocked in an iframe: fall back to copy.
    }
  }
  return (await copyToClipboard(`${text} ${link}`)) ? 'copied' : 'failed';
}

/** Counts one Share click server-side. Fire-and-forget. */
export function postShareClick(): void {
  const api = apiRequest('/api/share');
  const qa = new URLSearchParams(location.search).get('qa') === '1';
  void fetch(api.url, {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': api.contentType },
    body: JSON.stringify({ qa }),
  }).catch(() => undefined);
}
