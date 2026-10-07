/**
 * Receipt scanning via the OpenAI Codex CLI, signed in with the owner's
 * ChatGPT plan (auth.json in $CODEX_HOME). One short-lived `codex exec` per
 * scan, no shell, private temp dir, hard timeout, process-group kill.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HTTPException } from 'hono/http-exception';
import { RECEIPT_JSON_SCHEMA, RECEIPT_PROMPT, type DecodedImage } from './lib/receipt';

const CODEX_BIN = process.env.CODEX_BIN?.trim() || 'codex';
const CODEX_HOME = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
const word = (v: string | undefined, fallback: string) =>
  v && /^[A-Za-z0-9._-]{1,64}$/.test(v.trim()) ? v.trim() : fallback;
export const RECEIPT_MODEL = word(process.env.RECEIPT_MODEL, 'gpt-5.6-luna');
const RECEIPT_EFFORT = word(process.env.RECEIPT_EFFORT, 'low');
const SCAN_SETTING = (process.env.RECEIPT_SCAN ?? '').trim().toLowerCase();

const TIMEOUT_MS = 90_000;
const MAX_CONCURRENT = 2;
const PER_HOUR = 20;
const PER_DAY = 60;

function resolveBinary(bin: string): string | null {
  const isExec = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (bin.includes('/')) return isExec(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && isExec(path.join(dir, bin))) return path.join(dir, bin);
  }
  return null;
}
const resolvedBin = resolveBinary(CODEX_BIN);

/**
 * RECEIPT_SCAN=0 forces off, =1 forces on; unset enables it only when the
 * codex binary resolves AND $CODEX_HOME/auth.json exists. auth.json is checked
 * per call so a `codex login` inside the container takes effect without a restart.
 */
export function receiptScanEnabled(): boolean {
  if (/^(0|false|no|off)$/.test(SCAN_SETTING)) return false;
  if (resolvedBin === null) return false;
  if (/^(1|true|yes|on)$/.test(SCAN_SETTING)) return true;
  return existsSync(path.join(CODEX_HOME, 'auth.json'));
}

// ------------------------------------------------------------------ limits

let active = 0;
const history = new Map<number, number[]>();

/** Reserve a slot for this user, or throw 429. Call release() when done. */
export function acquireScanSlot(userId: number, now = Date.now()): () => void {
  const DAY = 24 * 60 * 60 * 1000;
  const stamps = (history.get(userId) ?? []).filter((t) => now - t < DAY);
  if (stamps.length >= PER_DAY || stamps.filter((t) => now - t < DAY / 24).length >= PER_HOUR) {
    history.set(userId, stamps);
    throw new HTTPException(429, { message: 'scan limit reached' });
  }
  if (active >= MAX_CONCURRENT) throw new HTTPException(429, { message: 'busy' });
  active += 1;
  stamps.push(now);
  history.set(userId, stamps);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active -= 1;
    }
  };
}

// ------------------------------------------------------------------ runner

/**
 * Run codex on the image and return the raw text of its final message.
 * Throws HTTPException with a client-safe message on any failure.
 */
export async function runReceiptScan(image: DecodedImage, signal?: AbortSignal): Promise<string> {
  if (resolvedBin === null) throw new HTTPException(503, { message: 'receipt scanning unavailable' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'splitup-receipt-'));
  try {
    const imagePath = path.join(dir, `receipt.${image.ext}`);
    const schemaPath = path.join(dir, 'schema.json');
    const outPath = path.join(dir, 'out.json');
    await writeFile(imagePath, image.bytes, { mode: 0o600 });
    await writeFile(schemaPath, JSON.stringify(RECEIPT_JSON_SCHEMA), { mode: 0o600 });

    const args = [
      'exec',
      '-m',
      RECEIPT_MODEL,
      '-c',
      `model_reasoning_effort=${RECEIPT_EFFORT}`,
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '--ephemeral', // don't persist the session (and the image) under CODEX_HOME
      '--ignore-rules',
      '--ignore-user-config', // the operator's MCP servers/plugins have no business here
      // The Docker image omits the code-mode host binary; don't try to spawn it.
      '--disable',
      'code_mode_host',
      '--color',
      'never',
      '-C',
      dir,
      '-i',
      imagePath,
      '--output-schema',
      schemaPath,
      '-o',
      outPath,
      RECEIPT_PROMPT,
    ];
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? os.homedir(),
      CODEX_HOME,
    };

    const { code, stderr, reason } = await new Promise<{
      code: number | null;
      stderr: string;
      reason: 'exit' | 'timeout' | 'aborted' | 'spawn';
    }>((resolve) => {
      let reason: 'exit' | 'timeout' | 'aborted' | 'spawn' = 'exit';
      let tail = '';
      // detached → own process group, so a kill also reaches the native
      // binary that the npm wrapper (bin/codex.js) spawns.
      const child = spawn(resolvedBin, args, {
        cwd: dir,
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
        shell: false,
      });
      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      child.stderr.on('data', (d: Buffer) => {
        tail = (tail + d.toString('utf8')).slice(-4000);
      });
      const timer = setTimeout(() => {
        reason = 'timeout';
        killGroup();
      }, TIMEOUT_MS);
      const onAbort = () => {
        reason = 'aborted';
        killGroup();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = (code: number | null) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ code, stderr: tail, reason });
      };
      child.on('error', () => {
        reason = 'spawn';
        done(null);
      });
      child.on('close', (code) => done(code));
    });

    if (reason === 'timeout') throw new HTTPException(504, { message: 'receipt scan timed out' });
    if (reason === 'aborted') throw new HTTPException(400, { message: 'cancelled' });
    if (reason === 'spawn') {
      console.error('receipt scan: failed to start codex');
      throw new HTTPException(503, { message: 'receipt scanning unavailable' });
    }
    if (code !== 0) {
      // stderr is codex's own log (prompt + errors), never the image bytes.
      const lastLines = stderr.trim().split('\n').slice(-5).join(' | ').slice(0, 600);
      console.error(`receipt scan: codex exited ${code}: ${lastLines}`);
      if (/not logged in|login|unauthori[sz]ed|401|refresh token/i.test(stderr)) {
        throw new HTTPException(503, { message: 'receipt scanning unavailable' });
      }
      if (/usage limit|rate limit|429/i.test(stderr)) {
        throw new HTTPException(429, { message: 'scan limit reached' });
      }
      throw new HTTPException(502, { message: "couldn't read the receipt" });
    }
    try {
      return await readFile(outPath, 'utf8');
    } catch {
      throw new HTTPException(502, { message: "couldn't read the receipt" });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
