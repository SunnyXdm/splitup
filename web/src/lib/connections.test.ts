import { describe, expect, it } from 'vitest';
import { clientSnippets, scopeLabel } from './connections';

const URL = 'https://splitup.example/mcp';
const TOKEN = 'spu_abc123';

describe('clientSnippets', () => {
  const byId = Object.fromEntries(clientSnippets(URL, TOKEN).map((s) => [s.id, s]));

  it('gives Claude Code a one-line http transport command with the bearer header', () => {
    expect(byId['claude-code'].code).toBe(
      `claude mcp add --transport http splitup ${URL} --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it('keeps the Codex token in an env var, not in config.toml', () => {
    const code = byId.codex.code;
    expect(code).toContain('[mcp_servers.splitup]');
    expect(code).toContain(`url = "${URL}"`);
    expect(code).toContain('bearer_token_env_var = "SPLITUP_TOKEN"');
    expect(
      code
        .split('\n')
        .filter((l) => !l.startsWith('#'))
        .join('\n'),
    ).not.toContain(TOKEN);
  });

  it('emits valid JSON for Cursor and Claude Desktop', () => {
    const cursor = JSON.parse(byId.cursor.code);
    expect(cursor.mcpServers.splitup).toEqual({
      url: URL,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const desktop = JSON.parse(byId['claude-desktop'].code);
    expect(desktop.mcpServers.splitup.args).toContain(URL);
    expect(desktop.mcpServers.splitup.env.SPLITUP_AUTH).toBe(`Bearer ${TOKEN}`);
  });
});

describe('scopeLabel', () => {
  it('names write access only when granted', () => {
    expect(scopeLabel(['splitup.read'])).toBe('Read only');
    expect(scopeLabel(['splitup.read', 'splitup.write'])).toBe('Read & write');
  });
});
