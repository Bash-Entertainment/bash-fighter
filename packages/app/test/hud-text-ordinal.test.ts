// Direct edge-case coverage for ordinal() and koStandingLineText() in
// hud-text.ts (issue #47). hud-match-status.test.ts only reaches
// ordinal() through eliminationFeedLine and a few koStandingLineText
// samples, so the teen special case (11th/12th/13th, also 111th/112th)
// and the singular/plural KO wording had no test of their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ordinal, koStandingLineText } from '../src/ui/hud-text.ts';

test('ordinal uses st/nd/rd for 1, 2, 3 and th for 4', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
});

test('ordinal uses th for the teens 11, 12, 13', () => {
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
});

test('ordinal goes back to st/nd/rd after the teens', () => {
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(22), '22nd');
  assert.equal(ordinal(23), '23rd');
});

test('ordinal applies the teen rule to the last two digits past 100', () => {
  assert.equal(ordinal(101), '101st');
  assert.equal(ordinal(111), '111th');
  assert.equal(ordinal(112), '112th');
});

test('koStandingLineText says "1 KO" for one knockout and "KOs" for any other count', () => {
  assert.equal(koStandingLineText(1, 1, 20, 1), '1 KO · 1st of 20');
  assert.equal(koStandingLineText(2, 1, 20, 2), '2 KOs · 1st of 20');
  assert.equal(koStandingLineText(0, 1, 20, 0), '0 KOs · 1st of 20');
});

test('koStandingLineText omits the leader part at rank 1', () => {
  const line = koStandingLineText(5, 1, 20, 5);
  assert.equal(line, '5 KOs · 1st of 20');
  assert.ok(!line.includes('leader'));
});

test('koStandingLineText includes the leader count below rank 1, singular and plural', () => {
  assert.equal(koStandingLineText(0, 2, 20, 1), '0 KOs · 2nd of 20 · leader has 1 KO');
  assert.equal(koStandingLineText(1, 3, 20, 4), '1 KO · 3rd of 20 · leader has 4 KOs');
});

test('koStandingLineText formats the rank with ordinal, teens included', () => {
  assert.equal(koStandingLineText(0, 11, 20, 3), '0 KOs · 11th of 20 · leader has 3 KOs');
  assert.equal(koStandingLineText(0, 12, 20, 3), '0 KOs · 12th of 20 · leader has 3 KOs');
  assert.equal(koStandingLineText(0, 13, 20, 3), '0 KOs · 13th of 20 · leader has 3 KOs');
});
