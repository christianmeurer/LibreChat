import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

function findUpPackageJson(fromDir) {
  const out = [];
  let dir = fromDir;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    out.push(path.join(dir, 'package.json'));
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return out;
}

function candidateBaseFiles() {
  /** @type {string[]} */
  const out = [];
  const appRoot = process.env.LIBRECHAT_APP_ROOT;
  if (typeof appRoot === 'string' && appRoot.length > 0) {
    out.push(`${appRoot.replace(/\/+$/, '')}/package.json`);
  }
  out.push('/app/package.json', '/app/api/package.json', '/workspace/package.json');

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    out.push(...findUpPackageJson(here));
  } catch {
    // ignore
  }

  return Array.from(new Set(out));
}

export async function importMcpSdk(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    const baseFiles = candidateBaseFiles();
    for (const baseFile of baseFiles) {
      try {
        if (!fs.existsSync(baseFile)) {
          continue;
        }
        const req = createRequire(baseFile);
        const resolved = req.resolve(specifier);
        return await import(pathToFileURL(resolved).href);
      } catch {
        continue;
      }
    }
    throw new Error(
      `Unable to resolve MCP SDK module '${specifier}'. This is expected outside the LibreChat container.`,
      { cause: error },
    );
  }
}

