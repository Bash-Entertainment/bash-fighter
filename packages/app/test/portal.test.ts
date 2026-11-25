import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, isOffOrigin, outboundLinksAllowed, portalName } from '../src/portal.ts';

test('the normal build is not a portal build: same-origin JSON, links allowed', () => {
  assert.equal(portalName(), undefined);
  assert.deepEqual(apiRequest('/api/feedback', 'www.crazygames.com'), { url: '/api/feedback', contentType: 'application/json' });
  assert.equal(outboundLinksAllowed(), true);
});

test('isOffOrigin', () => {
  assert.equal(isOffOrigin('bashfighter.com'), false);
  assert.equal(isOffOrigin('www.bashfighter.com'), false);
  assert.equal(isOffOrigin('www.crazygames.com'), true);
  assert.equal(isOffOrigin('notbashfighter.com'), true);
});
