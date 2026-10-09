/**
 * Receipt scanning providers.
 *
 * - anthropic (default when ANTHROPIC_API_KEY is set): the Claude Messages
 *   API, streamed. Structured output (output_config.format) for the JSON,
 *   adaptive thinking with summarized display streamed to the client, and one
 *   escalation to a stronger model when the deterministic checks fail.
 * - codex (fallback): one short-lived `codex exec` per scan signed in with the
 *   owner's ChatGPT plan (auth.json in $CODEX_HOME). No shell, private temp
 *   dir, hard timeout, process-group kill. Not streamed.
 *
 * Privacy: images, thinking text and model output are never logged; the one
 * log line per model call carries the model, duration and token counts only.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { HTTPException } from 'hono/http-exception';
import { parsePartialJson } from './lib/partial-json';
import {
  codexPrompt,
  normalizeReceipt,
  parseModelOutput,
  partialFields,
  RECEIPT_INSTRUCTIONS,
  RECEIPT_JSON_SCHEMA,
  receiptUserPrompt,
  type DecodedImage,
  type NormalizedReceipt,
  type ScanHints,
} from './lib/receipt';
import { modelLabel, type ScanErrorCode, type ScanEvent } from './lib/scan-events';

// ------------------------------------------------------------------ config

export type Provider = 'anthropic' | 'codex';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ReceiptConfig {
  /** null = scanning disabled. */
  provider: Provider | null;
  model: string;
  /** Second, stronger model for a failed first read; null = never escalate. */
  escalateModel: string | null;
  effort: Effort;
  escalateEffort: Effort;
  codexModel: string;
}

const word = (v: string | undefined, fallback: string) =>
  v && /^[A-Za-z0-9._-]{1,64}$/.test(v.trim()) ? v.trim() : fallback;
const effortOf = (v: string | undefined, fallback: Effort): Effort =>
  (EFFORTS as readonly string[]).includes(v?.trim() ?? '') ? (v!.trim() as Effort) : fallback;
const isOff = (v: string | undefined) => /^(0|false|no|off)$/i.test((v ?? '').trim());

/**
 * Pure: resolve the scanning setup from the environment. RECEIPT_PROVIDER
 * picks explicitly; unset = anthropic when ANTHROPIC_API_KEY is set, else
 * codex when its binary is installed, else disabled. RECEIPT_SCAN=0 turns
 * everything off.
 */
export function receiptConfig(env: NodeJS.ProcessEnv, codexInstalled: boolean): ReceiptConfig {
  const hasKey = (env.ANTHROPIC_API_KEY ?? '').trim() !== '';
  const asked = (env.RECEIPT_PROVIDER ?? '').trim().toLowerCase();
  let provider: Provider | null;
  if (isOff(env.RECEIPT_SCAN)) provider = null;
  else if (asked === 'anthropic') provider = hasKey ? 'anthropic' : null;
  else if (asked === 'codex') provider = codexInstalled ? 'codex' : null;
  else provider = hasKey ? 'anthropic' : codexInstalled ? 'codex' : null;

  const requested = word(env.RECEIPT_MODEL, '');
  // A pre-Claude deploy may still set RECEIPT_MODEL=gpt-…: that names the
  // Codex model, never a Claude one.
  const model = requested.startsWith('claude-') ? requested : 'claude-sonnet-5-5';
  const codexModel = word(
    env.CODEX_MODEL,
    requested && !requested.startsWith('claude-') ? requested : 'gpt-5.6-luna',
  );
  const esc = env.RECEIPT_ESCALATE_MODEL;
  const escalateModel =
    esc === undefined ? 'claude-opus-5-5' : esc.trim() === '' ? null : word(esc, 'claude-opus-5-5');
  return {
    provider,
    model,
    escalateModel: escalateModel === model ? null : escalateModel,
    effort: effortOf(env.RECEIPT_EFFORT, 'low'),
    escalateEffort: effortOf(env.RECEIPT_ESCALATE_EFFORT, 'medium'),
    codexModel,
  };
}

const CODEX_BIN = process.env.CODEX_BIN?.trim() || 'codex';
const CODEX_HOME = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
const SCAN_SETTING = (process.env.RECEIPT_SCAN ?? '').trim().toLowerCase();

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

export const CONFIG = receiptConfig(process.env, resolvedBin !== null);
if (
  (process.env.RECEIPT_PROVIDER ?? '').trim() !== '' &&
  CONFIG.provider === null &&
  !isOff(SCAN_SETTING)
) {
  console.warn(
    `receipt scan: RECEIPT_PROVIDER=${process.env.RECEIPT_PROVIDER} is not usable; scanning is off`,
  );
}
/** The model a scan starts with (shown in the UI). */
export const RECEIPT_MODEL = CONFIG.provider === 'codex' ? CONFIG.codexModel : CONFIG.model;

/**
 * Anthropic: on whenever the provider resolved (the key is set). Codex:
 * RECEIPT_SCAN=1 forces it on; otherwise it needs $CODEX_HOME/auth.json,
 * checked per call so a `codex login` takes effect without a restart.
 */
export function receiptScanEnabled(): boolean {
  if (CONFIG.provider === 'anthropic') return true;
  if (CONFIG.provider !== 'codex' || resolvedBin === null) return false;
  if (/^(1|true|yes|on)$/.test(SCAN_SETTING)) return true;
  return existsSync(path.join(CODEX_HOME, 'auth.json'));
}

// ------------------------------------------------------------------ limits

const TIMEOUT_MS = 90_000; // codex
const MAX_CONCURRENT = 2;
const PER_HOUR = 20;
const PER_DAY = 60;

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

// --------------------------------------------------------------- anthropic

/** Room for adaptive thinking plus a long itemized bill; caps cost per call. */
const MAX_TOKENS = 12_000;
const ATTEMPT_TIMEOUT_MS = 75_000;
/** Re-parse the streaming JSON at most this often. */
const PARTIAL_EVERY_MS = 120;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // Reads ANTHROPIC_API_KEY from the environment; never logged or echoed.
  client ??= new Anthropic({ maxRetries: 1, timeout: ATTEMPT_TIMEOUT_MS });
  return client;
}

type Emit = (event: ScanEvent) => void;

class ScanFailure extends Error {
  constructor(
    readonly code: ScanErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const FRIENDLY: Record<ScanErrorCode, string> = {
  unavailable: 'Receipt scanning is unavailable right now.',
  rate_limited: 'The scanner is busy — try again in a moment.',
  timeout: 'Reading the receipt took too long — try a clearer photo.',
  unreadable: "Couldn't read that receipt — try another photo or enter it by hand.",
  refused: "Couldn't read that receipt — try another photo or enter it by hand.",
  cancelled: 'Cancelled.',
  failed: "Couldn't read that receipt — try another photo or enter it by hand.",
};
const fail = (code: ScanErrorCode) => new ScanFailure(code, FRIENDLY[code]);

/** Map an SDK error to a client-safe failure (and log its class/status only). */
function sdkFailure(err: unknown, signal: AbortSignal, model: string): ScanFailure {
  if (err instanceof ScanFailure) return err;
  if (signal.aborted) return fail('cancelled');
  if (
    err instanceof Anthropic.APIUserAbortError ||
    err instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return fail('timeout');
  }
  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  console.error(
    `receipt scan: ${model} failed: ${err instanceof Error ? err.constructor.name : 'error'}${status ? ` ${status}` : ''}`,
  );
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return fail('unavailable');
  }
  if (err instanceof Anthropic.RateLimitError || status === 529) return fail('rate_limited');
  return fail('failed');
}

interface Attempt {
  model: string;
  result: NormalizedReceipt;
}

/** One streamed Claude call; emits thinking/partial events, returns the vetted draft. */
async function claudeAttempt(
  model: string,
  effort: Effort,
  image: DecodedImage,
  hints: ScanHints,
  recheck: string[],
  signal: AbortSignal,
  emit: Emit,
): Promise<Attempt> {
  const started = Date.now();
  const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
  let text = '';
  let thinkingSeen = false;
  let textSeen = false;
  let lastParse = 0;
  let lastPartial = '';
  const pushPartial = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastParse < PARTIAL_EVERY_MS) return;
    lastParse = now;
    let fields;
    try {
      fields = partialFields(parsePartialJson(text));
    } catch {
      return; // malformed mid-stream; the final parse decides
    }
    const key = fields ? JSON.stringify(fields) : '';
    if (fields && key !== lastPartial) {
      lastPartial = key;
      emit({ type: 'partial', fields });
    }
  };

  let message: Anthropic.Message;
  try {
    const stream = anthropic().messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: {
          effort,
          format: {
            type: 'json_schema',
            schema: RECEIPT_JSON_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        system: RECEIPT_INSTRUCTIONS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.mime,
                  data: image.bytes.toString('base64'),
                },
              },
              { type: 'text', text: receiptUserPrompt(hints, recheck) },
            ],
          },
        ],
      },
      { signal: attemptSignal },
    );
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
        if (!thinkingSeen) {
          thinkingSeen = true;
          emit({ type: 'status', stage: 'thinking', model });
        }
        emit({ type: 'thinking', text: event.delta.thinking });
      } else if (event.delta.type === 'text_delta') {
        if (!textSeen) {
          textSeen = true;
          emit({ type: 'status', stage: 'extracting', model });
        }
        text += event.delta.text;
        pushPartial(false);
      }
    }
    message = await stream.finalMessage();
  } catch (err) {
    if (attemptSignal.aborted) {
      // Usage isn't reported for an aborted stream; log the call for cost tracking anyway.
      const why = signal.aborted ? 'cancelled' : 'timeout';
      console.log(`receipt scan: provider=anthropic model=${model} ${why} ms=${Date.now() - started}`);
      if (!signal.aborted) throw fail('timeout');
    }
    throw sdkFailure(err, signal, model);
  }
  pushPartial(true);

  const u = message.usage;
  console.log(
    `receipt scan: provider=anthropic model=${model} effort=${effort} ms=${Date.now() - started}` +
      ` in=${u.input_tokens} out=${u.output_tokens}` +
      ` thinking=${u.output_tokens_details?.thinking_tokens ?? 0}` +
      ` cache_read=${u.cache_read_input_tokens ?? 0} stop=${message.stop_reason}`,
  );
  if (message.stop_reason === 'refusal') throw fail('refused');
  if (message.stop_reason === 'max_tokens') throw fail('unreadable');

  emit({ type: 'status', stage: 'checking', model });
  try {
    const out = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { model, result: normalizeReceipt(parseModelOutput(out), hints.today) };
  } catch {
    console.error(`receipt scan: ${model} output failed validation`);
    throw fail('unreadable');
  }
}

/** Fewer recheck reasons wins; ties go to the (stronger) second read. */
export function pickBetter(
  first: NormalizedReceipt | null,
  second: NormalizedReceipt | null,
): 'first' | 'second' | null {
  if (second && (!first || second.recheck.length <= first.recheck.length)) return 'second';
  return first ? 'first' : null;
}

async function scanWithClaude(
  image: DecodedImage,
  hints: ScanHints,
  signal: AbortSignal,
  emit: Emit,
): Promise<void> {
  emit({ type: 'status', stage: 'reading', model: CONFIG.model });
  let first: Attempt | null = null;
  let firstError: ScanFailure | null = null;
  try {
    first = await claudeAttempt(CONFIG.model, CONFIG.effort, image, hints, [], signal, emit);
  } catch (err) {
    firstError = err instanceof ScanFailure ? err : fail('failed');
  }
  if (firstError?.code === 'cancelled') throw firstError;

  // Escalate once: on a failed read that a stronger model might fix, or when
  // the checks found something wrong. Auth/rate/timeout failures won't improve.
  const retryable =
    firstError !== null && ['unreadable', 'refused', 'failed'].includes(firstError.code);
  const shouldEscalate =
    CONFIG.escalateModel !== null &&
    (retryable || (first !== null && first.result.recheck.length > 0));
  if (!shouldEscalate) {
    if (!first) throw firstError ?? fail('failed');
    emit(resultEvent(first, false));
    return;
  }

  const escalateModel = CONFIG.escalateModel!;
  emit({ type: 'status', stage: 'escalating', model: escalateModel });
  let second: Attempt | null = null;
  try {
    second = await claudeAttempt(
      escalateModel,
      CONFIG.escalateEffort,
      image,
      hints,
      first?.result.recheck ?? [],
      signal,
      emit,
    );
  } catch (err) {
    if (err instanceof ScanFailure && err.code === 'cancelled') throw err;
    if (!first) throw err instanceof ScanFailure ? err : fail('failed');
  }
  const pick = pickBetter(first?.result ?? null, second?.result ?? null);
  emit(resultEvent(pick === 'second' ? second! : first!, true));
}

function resultEvent(a: Attempt, escalated: boolean): ScanEvent {
  return {
    type: 'result',
    draft: a.result.draft,
    warnings: a.result.warnings,
    warningFields: a.result.warningFields,
    model: a.model,
    modelLabel: modelLabel(a.model),
    escalated,
  };
}

// ------------------------------------------------------------------- codex

async function scanWithCodex(
  image: DecodedImage,
  hints: ScanHints,
  signal: AbortSignal,
  emit: Emit,
): Promise<void> {
  emit({ type: 'status', stage: 'reading', model: CONFIG.codexModel });
  const started = Date.now();
  let text: string;
  try {
    text = await runCodexScan(image, hints, signal);
  } catch (err) {
    if (signal.aborted) throw fail('cancelled');
    const status = err instanceof HTTPException ? err.status : 502;
    throw fail(
      status === 429
        ? 'rate_limited'
        : status === 503
          ? 'unavailable'
          : status === 504
            ? 'timeout'
            : 'failed',
    );
  }
  console.log(`receipt scan: provider=codex model=${CONFIG.codexModel} ms=${Date.now() - started}`);
  emit({ type: 'status', stage: 'checking', model: CONFIG.codexModel });
  let result: NormalizedReceipt;
  try {
    result = normalizeReceipt(parseModelOutput(text), hints.today);
  } catch {
    console.error('receipt scan: model output failed validation');
    throw fail('unreadable');
  }
  emit(resultEvent({ model: CONFIG.codexModel, result }, false));
}

// -------------------------------------------------------------- entrypoint

/**
 * Scan one receipt, reporting progress through `emit`. Always ends with
 * exactly one `result` or `error` event (none when the client went away).
 */
export async function runScan(
  image: DecodedImage,
  hints: ScanHints,
  signal: AbortSignal,
  emit: Emit,
): Promise<void> {
  try {
    if (CONFIG.provider === 'anthropic') await scanWithClaude(image, hints, signal, emit);
    else if (CONFIG.provider === 'codex') await scanWithCodex(image, hints, signal, emit);
    else throw fail('unavailable');
  } catch (err) {
    const f = err instanceof ScanFailure ? err : fail('failed');
    if (!(err instanceof ScanFailure)) console.error('receipt scan: unexpected failure');
    if (f.code !== 'cancelled') emit({ type: 'error', code: f.code, message: f.message });
  }
}

// ------------------------------------------------------------ codex runner

/**
 * Codex: run codex on the image and return the raw text of its final message.
 * Throws HTTPException with a client-safe message on any failure.
 */
export async function runCodexScan(
  image: DecodedImage,
  hints: ScanHints,
  signal?: AbortSignal,
): Promise<string> {
  if (resolvedBin === null)
    throw new HTTPException(503, { message: 'receipt scanning unavailable' });
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
      CONFIG.codexModel,
      '-c',
      `model_reasoning_effort=${CONFIG.effort === 'max' ? 'xhigh' : CONFIG.effort}`,
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
      codexPrompt(hints),
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
