import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual } from '../src/security/safeEqual.js';

const SECRET = 's3cr3t-webhook-value';

test('correct secret passes', () => {
  assert.equal(safeEqual(SECRET, SECRET), true);
});

test('wrong secret of the same length is rejected', () => {
  assert.equal(safeEqual('s3cr3t-webhook-valuX', SECRET), false);
});

test('secret of a different length is rejected', () => {
  assert.equal(safeEqual(SECRET.slice(0, -1), SECRET), false);
  assert.equal(safeEqual(SECRET + 'x', SECRET), false);
});

test('empty or missing secret is rejected', () => {
  assert.equal(safeEqual('', SECRET), false);
  assert.equal(safeEqual(undefined, SECRET), false);
  assert.equal(safeEqual(null, SECRET), false);
});

test('unset WEBHOOK_SECRET rejects everything, including an empty header', () => {
  assert.equal(safeEqual(SECRET, undefined), false);
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual('', undefined), false);
});

test('non-string values (e.g. repeated query params) are rejected', () => {
  assert.equal(safeEqual([SECRET], SECRET), false);
  assert.equal(safeEqual(12345, '12345'), false);
});
