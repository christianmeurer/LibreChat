import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExecToolInput } from '../exec-server/core.mjs';

test('exec parse: allowlisted commands only', () => {
  assert.throws(() => parseExecToolInput({ command: 'bash', args: [] }));
  assert.doesNotThrow(() => parseExecToolInput({ command: 'git', args: ['status'] }));
});

test('exec parse: blocks cwd override args', () => {
  assert.throws(() => parseExecToolInput({ command: 'git', args: ['-C', '/'] }));
  assert.throws(() => parseExecToolInput({ command: 'npm', args: ['--prefix', '/'] }));
});

