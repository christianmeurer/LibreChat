import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp } from '../fetch-server/core.mjs';

test('isPrivateIp blocks common private ranges', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('isPrivateIp blocks IPv6 local ranges', () => {
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('fc00::1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
});

