import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

/**
 * End-to-end: the real server against a throwaway database, with
 * ANTHROPIC_BASE_URL pointed at a local fake of the Messages API that
 * streams scripted SSE. Covers the event stream, escalation, and that a
 * client disconnect aborts the upstream request.
 */

const SERVER_DIR = path.join(import.meta.dirname, '..', '..');
let dir: string;
let child: ChildProcess;
let base: string;
let token: string;

// ------------------------------------------------------------- fake Claude

interface Script {
  thinking?: string;
  json?: unknown;
  /** Hold the response open (to test cancellation). */
  hang?: boolean;
}
let scripts: Script[] = [];
let requests: { model: string; effort: string; userText: string; thinking: unknown }[] = [];
let upstreamClosed = 0;
let fake: Server;

function sse(res: ServerResponse, type: string, data: object) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function startFake(): Promise<string> {
  fake = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const params = JSON.parse(body);
      const userText = params.messages[0].content.find(
        (b: { type: string }) => b.type === 'text',
      ).text;
      requests.push({
        model: params.model,
        effort: params.output_config.effort,
        userText,
        thinking: params.thinking,
      });
      const script = scripts.shift() ?? {};
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.on('close', () => {
        if (!res.writableFinished) upstreamClosed += 1;
      });
      sse(res, 'message_start', {
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: params.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 1 },
        },
      });
      let i = 0;
      if (script.thinking) {
        sse(res, 'content_block_start', {
          index: i,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
        sse(res, 'content_block_delta', {
          index: i,
          delta: { type: 'thinking_delta', thinking: script.thinking },
        });
        sse(res, 'content_block_delta', {
          index: i,
          delta: { type: 'signature_delta', signature: 'sig' },
        });
        sse(res, 'content_block_stop', { index: i });
        i += 1;
      }
      if (script.hang) return; // never finishes
      const text = JSON.stringify(script.json);
      sse(res, 'content_block_start', { index: i, content_block: { type: 'text', text: '' } });
      for (let at = 0; at < text.length; at += 40) {
        sse(res, 'content_block_delta', {
          index: i,
          delta: { type: 'text_delta', text: text.slice(at, at + 40) },
        });
      }
      sse(res, 'content_block_stop', { index: i });
      sse(res, 'message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 400 },
      });
      sse(res, 'message_stop', {});
      res.end();
    });
  });
  return new Promise((resolve) => {
    fake.listen(0, '127.0.0.1', () => {
      const addr = fake.address();
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
    });
  });
}

const receipt = (over: Record<string, unknown> = {}) => ({
  merchant: 'Chaayos',
  location: 'Connaught Place, New Delhi',
  gstin: null,
  date_raw: '03/10/2026',
  date: '2026-10-03',
  currency_raw: 'Rs',
  currency: 'INR',
  line_items: [
    {
      raw_text: '2 x Masala Chai Rs 240.00',
      name: 'Masala Chai',
      quantity: 2,
      amount_minor: 24000,
    },
    { raw_text: '3 x Bun Maska Rs 420.00', name: 'Bun Maska', quantity: 3, amount_minor: 42000 },
  ],
  subtotal_minor: 66000,
  discounts: [],
  taxes: [],
  fees: [],
  total_raw: 'Rs 660.00',
  total_minor: 66000,
  category: 'food',
  confidence: 'high',
  illegible_fields: [],
  uncertain_fields: [],
  notes: null,
  ...over,
});

// ------------------------------------------------------------------ server

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') return reject(new Error('no port'));
      srv.close(() => resolve(addr.port));
    });
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      await fetch(`${base}/api/sync`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('server did not start');
}

const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')}`;

function scan(body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/api/receipts/scan`, {
    method: 'POST',
    headers: {
      cookie: `splitup_session=${token}`,
      'x-csrf': '1',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function events(res: Response): Promise<{ type: string; [k: string]: any }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((f) => f.includes('data: '))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)));
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'splitup-scan-'));
  const fakeUrl = await startFake();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DB_PATH: path.join(dir, 'test.db'),
      PORT: String(port),
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key',
      ANTHROPIC_BASE_URL: fakeUrl,
      CODEX_BIN: '/nonexistent',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForServer();
  const seed = new Database(path.join(dir, 'test.db'));
  const now = new Date().toISOString();
  const uid = Number(
    seed
      .prepare(
        "INSERT INTO users (shoo_sub, email, name, default_currency, created_at) VALUES ('s', 'a@example.com', 'Asha', 'INR', ?)",
      )
      .run(now).lastInsertRowid,
  );
  token = randomBytes(32).toString('hex');
  seed
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      uid,
      now,
      new Date(Date.now() + 86_400_000).toISOString(),
    );
  seed.close();
});

after(() => {
  child?.kill('SIGKILL');
  fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  scripts = [];
  requests = [];
});

describe('POST /api/receipts/scan (anthropic, streamed)', () => {
  it('advertises the feature in /api/sync', async () => {
    const res = await fetch(`${base}/api/sync`, {
      headers: { cookie: `splitup_session=${token}` },
    });
    const data = (await res.json()) as { features: { receiptScan: boolean } };
    assert.equal(data.features.receiptScan, true);
  });

  it('streams status, thinking, partial fields and a result', async () => {
    scripts = [{ thinking: 'Reading the totals… CGST and SGST match.', json: receipt() }];
    const res = await scan({ image: JPEG, currency: 'INR', locale: 'en-IN' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    const evs = await events(res);
    const types = evs.map((e) => (e.type === 'status' ? `status:${e.stage}` : e.type));
    assert.deepEqual(types.slice(0, 3), ['status:reading', 'status:thinking', 'thinking']);
    assert.equal(
      evs.find((e) => e.type === 'thinking')!.text,
      'Reading the totals… CGST and SGST match.',
    );
    assert.ok(types.includes('status:extracting'));
    assert.ok(types.includes('status:checking'));
    const partials = evs.filter((e) => e.type === 'partial');
    assert.ok(partials.length >= 1);
    assert.equal(partials.at(-1)!.fields.merchant, 'Chaayos');
    const result = evs.at(-1)!;
    assert.equal(result.type, 'result');
    assert.equal(result.draft.totalCents, 66000);
    assert.equal(result.model, 'claude-sonnet-5-5');
    assert.equal(result.modelLabel, 'Sonnet 5.5');
    assert.equal(result.escalated, false);
    assert.deepEqual(result.warnings, []);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.model, 'claude-sonnet-5-5');
    assert.equal(requests[0]!.effort, 'low');
    assert.deepEqual(requests[0]!.thinking, { type: 'adaptive', display: 'summarized' });
    assert.match(requests[0]!.userText, /added in INR/);
    assert.match(requests[0]!.userText, /en-IN/);
  });

  it('escalates once to Opus when the checks fail, and says why', async () => {
    scripts = [
      { json: receipt({ total_minor: 70000, total_raw: 'Rs 700.00' }) },
      { thinking: 'Re-reading the total line.', json: receipt() },
    ];
    const evs = await events(await scan({ image: JPEG }));
    assert.ok(
      evs.some(
        (e) => e.type === 'status' && e.stage === 'escalating' && e.model === 'claude-opus-5-5',
      ),
    );
    const result = evs.at(-1)!;
    assert.equal(result.type, 'result');
    assert.equal(result.escalated, true);
    assert.equal(result.model, 'claude-opus-5-5');
    assert.equal(result.draft.totalCents, 66000);
    assert.deepEqual(
      requests.map((r) => r.model),
      ['claude-sonnet-5-5', 'claude-opus-5-5'],
    );
    assert.equal(requests[1]!.effort, 'medium');
    assert.match(requests[1]!.userText, /failed these checks/);
  });

  it('returns the draft with warnings when the re-check fails too', async () => {
    const bad = receipt({ total_minor: 70000, total_raw: 'Rs 700.00' });
    scripts = [{ json: bad }, { json: bad }];
    const result = (await events(await scan({ image: JPEG }))).at(-1)!;
    assert.equal(result.type, 'result');
    assert.equal(result.escalated, true);
    assert.equal(result.draft.totalCents, 70000);
    assert.deepEqual(result.warningFields, ['total']);
    assert.match(result.warnings[0], /add up/);
  });

  it('aborts the upstream request when the client disconnects', async () => {
    scripts = [{ thinking: 'Looking…', hang: true }];
    const ctrl = new AbortController();
    const res = await scan({ image: JPEG }, ctrl.signal);
    const reader = res.body!.getReader();
    await reader.read(); // first frame arrived: the upstream call is live
    const before = upstreamClosed;
    ctrl.abort();
    for (let i = 0; i < 100 && upstreamClosed === before; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(upstreamClosed, before + 1);
    // The concurrency slot was released: another scan goes through.
    scripts = [{ json: receipt() }];
    const ok = (await events(await scan({ image: JPEG }))).at(-1)!;
    assert.equal(ok.type, 'result');
  });

  it('rejects bad input with plain JSON errors before streaming', async () => {
    const bad = await scan({ image: 'data:image/gif;base64,R0lGODlh' });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /JPEG, PNG or WebP/);
    const cur = await scan({ image: JPEG, currency: 'XYZ' });
    assert.equal(cur.status, 400);
    const anon = await fetch(`${base}/api/receipts/scan`, {
      method: 'POST',
      headers: { 'x-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ image: JPEG }),
    });
    assert.equal(anon.status, 401);
  });
});
