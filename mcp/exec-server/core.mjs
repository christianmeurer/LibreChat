import { spawn } from 'node:child_process';
import process from 'node:process';

export const EXEC_TOOL_NAME = 'exec';
export const WORKSPACE_CWD = '/workspace';

const ALLOWED_COMMANDS = new Set(['git', 'npm', 'node']);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;

const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const MAX_MAX_OUTPUT_BYTES = 1_000_000;

const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 8192;
const MAX_STDIN_BYTES = 200_000;

export class ToolError extends Error {
  /** @type {string} */
  code;

  /** @type {unknown} */
  details;

  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function getExecToolDefinition() {
  return {
    name: EXEC_TOOL_NAME,
    description:
      'Run an allowlisted command (git/npm/node) with fixed cwd=/workspace, timeout, and output caps.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          enum: ['git', 'npm', 'node'],
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          default: [],
        },
        stdin: {
          type: 'string',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
          default: DEFAULT_TIMEOUT_MS,
        },
        maxOutputBytes: {
          type: 'integer',
          minimum: 1024,
          maximum: MAX_MAX_OUTPUT_BYTES,
          default: DEFAULT_MAX_OUTPUT_BYTES,
        },
      },
    },
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBoundedInt(value, { field, min, max, defaultValue }) {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolError('INVALID_INPUT', `${field} must be an integer`, { field });
  }
  if (value < min || value > max) {
    throw new ToolError('INVALID_INPUT', `${field} must be between ${min} and ${max}`, {
      field,
      min,
      max,
    });
  }
  return value;
}

function parseArgs(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ToolError('INVALID_INPUT', 'args must be an array of strings');
  }
  if (value.length > MAX_ARGS) {
    throw new ToolError('INVALID_INPUT', `args length must be <= ${MAX_ARGS}`, {
      maxArgs: MAX_ARGS,
    });
  }
  for (const arg of value) {
    if (arg.length > MAX_ARG_LENGTH) {
      throw new ToolError('INVALID_INPUT', `arg too long (>${MAX_ARG_LENGTH})`, {
        maxArgLength: MAX_ARG_LENGTH,
      });
    }
    if (arg.includes('\u0000')) {
      throw new ToolError('INVALID_INPUT', 'args must not contain NUL bytes');
    }
  }
  return value;
}

function validateDisallowedCwdArgs(command, args) {
  const deny = (arg, reason) => {
    throw new ToolError('DISALLOWED_ARGUMENT', `Disallowed argument: ${arg}`, { reason });
  };

  const isExact = (a, target) => a === target;
  const isPrefixed = (a, prefix) => a.startsWith(prefix);

  if (command === 'git') {
    for (const a of args) {
      if (isExact(a, '-C') || (isPrefixed(a, '-C') && a.length > 2)) {
        deny(a, 'cwd override');
      }
      if (isExact(a, '--git-dir') || isPrefixed(a, '--git-dir=')) {
        deny(a, 'cwd override');
      }
      if (isExact(a, '--work-tree') || isPrefixed(a, '--work-tree=')) {
        deny(a, 'cwd override');
      }
    }
  }

  if (command === 'npm') {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (isExact(a, '--prefix') || isPrefixed(a, '--prefix=')) {
        deny(a, 'cwd override');
      }
      if (isExact(a, '--global') || isExact(a, '-g') || isPrefixed(a, '--location=global')) {
        deny(a, 'global location');
      }
      if (isExact(a, '--location') && args[i + 1] === 'global') {
        deny('--location global', 'global location');
      }
    }
  }
}

export function parseExecToolInput(raw) {
  if (!isPlainObject(raw)) {
    throw new ToolError('INVALID_INPUT', 'arguments must be an object');
  }

  const command = raw.command;
  if (typeof command !== 'string' || !ALLOWED_COMMANDS.has(command)) {
    throw new ToolError('COMMAND_NOT_ALLOWED', 'command must be one of: git, npm, node', {
      allowed: [...ALLOWED_COMMANDS],
    });
  }

  const args = parseArgs(raw.args);
  validateDisallowedCwdArgs(command, args);

  const timeoutMs = parseBoundedInt(raw.timeoutMs, {
    field: 'timeoutMs',
    min: 1,
    max: MAX_TIMEOUT_MS,
    defaultValue: DEFAULT_TIMEOUT_MS,
  });

  const maxOutputBytes = parseBoundedInt(raw.maxOutputBytes, {
    field: 'maxOutputBytes',
    min: 1024,
    max: MAX_MAX_OUTPUT_BYTES,
    defaultValue: DEFAULT_MAX_OUTPUT_BYTES,
  });

  const stdin = raw.stdin;
  if (stdin !== undefined && typeof stdin !== 'string') {
    throw new ToolError('INVALID_INPUT', 'stdin must be a string');
  }
  if (stdin && Buffer.byteLength(stdin, 'utf8') > MAX_STDIN_BYTES) {
    throw new ToolError('INVALID_INPUT', `stdin too large (>${MAX_STDIN_BYTES} bytes)`, {
      maxStdinBytes: MAX_STDIN_BYTES,
    });
  }

  return {
    command,
    args,
    stdin,
    timeoutMs,
    maxOutputBytes,
  };
}

function createCollector(maxBytes) {
  /** @type {Buffer[]} */
  const chunks = [];
  let bytes = 0;
  let truncated = false;

  return {
    onData(chunk) {
      if (!Buffer.isBuffer(chunk)) {
        return;
      }
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - bytes;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytes = maxBytes;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    stats() {
      return { bytes, truncated };
    },
  };
}

function killProcessGroup(child) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      return;
    }
  }
}

export async function runExecTool(input, { signal } = {}) {
  const startedAt = Date.now();
  const stdoutCollector = createCollector(input.maxOutputBytes);
  const stderrCollector = createCollector(input.maxOutputBytes);

  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let child;
  try {
    child = spawn(input.command, input.args, {
      cwd: WORKSPACE_CWD,
      env: process.env,
      shell: false,
      detached: true,
      windowsHide: true,
    });
  } catch (error) {
    throw new ToolError('SPAWN_FAILED', 'Failed to spawn process', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child);
  }, input.timeoutMs);

  const abortHandler = () => {
    killProcessGroup(child);
  };
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      killProcessGroup(child);
      throw new ToolError('ABORTED', 'Request aborted');
    }
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  child.stdout.on('data', (chunk) => stdoutCollector.onData(chunk));
  child.stderr.on('data', (chunk) => stderrCollector.onData(chunk));

  if (input.stdin !== undefined) {
    child.stdin.write(input.stdin);
  }
  child.stdin.end();

  const exit = await new Promise((resolve, reject) => {
    child.once('error', (error) => {
      reject(error);
    });
    child.once('close', (code, sig) => {
      resolve({ code, signal: sig });
    });
  }).catch((error) => {
    throw new ToolError('EXEC_FAILED', 'Process execution failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  clearTimeout(timeoutId);
  if (signal) {
    signal.removeEventListener('abort', abortHandler);
  }

  const stdoutStats = stdoutCollector.stats();
  const stderrStats = stderrCollector.stats();
  const durationMs = Date.now() - startedAt;

  const result = {
    cwd: WORKSPACE_CWD,
    command: input.command,
    args: input.args,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    durationMs,
    stdout: stdoutCollector.text(),
    stderr: stderrCollector.text(),
    stdoutTruncated: stdoutStats.truncated,
    stderrTruncated: stderrStats.truncated,
  };

  if (timedOut) {
    throw new ToolError('TIMEOUT', `Process timed out after ${input.timeoutMs}ms`, result);
  }
  if (exit.code !== 0) {
    throw new ToolError('NON_ZERO_EXIT', 'Process exited with non-zero status', result);
  }

  return result;
}

