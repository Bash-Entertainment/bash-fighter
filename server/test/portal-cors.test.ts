import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPortalOrigin } from '../src/portal-cors.ts';

test('portal CORS allows the portal CDNs and nothing else', () => {
  for (const ok of ['https://www.crazygames.com', 'https://bash-fighter.game-files.crazygames.com', 'https://html-classic.itch.zone', 'https://v6p9d9t4.ssl.hwcdn.net']) {
    assert.equal(isPortalOrigin(ok), true, ok);
  }
  for (const bad of [undefined, 'http://www.crazygames.com', 'https://crazygames.com.evil.example', 'https://evilcrazygames.com', 'https://example.com']) {
    assert.equal(isPortalOrigin(bad), false, String(bad));
  }
});
