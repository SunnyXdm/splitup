import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * Connected apps & MCP: OAuth-connected assistants (Claude, ChatGPT, …),
 * personal access tokens for CLI tools, and the consent step of the OAuth
 * flow. None of it is persisted to disk (persist.ts keeps only `sync`).
 */

export type McpScope = 'splitup.read' | 'splitup.write';

export interface ConnectedApp {
  id: number;
  name: string;
  uri: string | null;
  scopes: McpScope[];
  connectedAt: string;
  lastUsedAt: string | null;
}

export interface AccessToken {
  id: number;
  name: string;
  /** Last 4 characters, for recognizing a token ("spu_…a1b2"). */
  hint: string;
  scopes: McpScope[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Connections {
  mcpUrl: string;
  apps: ConnectedApp[];
  tokens: AccessToken[];
}

export interface CreatedToken extends AccessToken {
  /** Shown once; the server keeps only its hash. */
  token: string;
}

export interface OAuthRequestPreview {
  client: { name: string; uri: string | null; redirectHost: string; loopback: boolean };
  scopes: McpScope[];
}

const KEY = ['connections'] as const;

export function useConnections() {
  return useQuery({ queryKey: KEY, queryFn: () => api<Connections>('/api/connections') });
}

function useRefresh() {
  const qc = useQueryClient();
  return { onSettled: () => qc.invalidateQueries({ queryKey: KEY }) };
}

export function useCreateToken() {
  return useMutation({
    mutationFn: (body: { name: string; scopes: McpScope[] }) =>
      api<CreatedToken>('/api/connections/tokens', { method: 'POST', body }),
    ...useRefresh(),
  });
}

export function useRevokeToken() {
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/connections/tokens/${id}`, { method: 'DELETE' }),
    ...useRefresh(),
  });
}

export function useRevokeApp() {
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/connections/apps/${id}`, { method: 'DELETE' }),
    ...useRefresh(),
  });
}

export function useOAuthRequest(id: string) {
  return useQuery({
    queryKey: ['oauth-request', id],
    queryFn: () => api<OAuthRequestPreview>(`/api/oauth/requests/${id}`),
    retry: false,
    staleTime: Infinity,
    enabled: /^[0-9a-f]{48}$/.test(id),
  });
}

export function useAnswerOAuthRequest() {
  return useMutation({
    mutationFn: ({ id, allow, scopes }: { id: string; allow: boolean; scopes?: McpScope[] }) =>
      api<{ redirectTo: string }>(`/api/oauth/requests/${id}/${allow ? 'approve' : 'deny'}`, {
        method: 'POST',
        body: allow ? { scopes } : {},
      }),
  });
}

export const scopeLabel = (scopes: McpScope[]) =>
  scopes.includes('splitup.write') ? 'Read & write' : 'Read only';

export interface ClientSnippet {
  id: 'claude-code' | 'codex' | 'cursor' | 'claude-desktop';
  label: string;
  /** Where the snippet goes. */
  where: string;
  code: string;
}

/** Copy-paste setup for the CLI / desktop clients that take a bearer token. */
export function clientSnippets(mcpUrl: string, token: string): ClientSnippet[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      where: 'Run in a terminal',
      code: `claude mcp add --transport http splitup ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      where: 'Add to ~/.codex/config.toml, and export SPLITUP_TOKEN in your shell profile',
      code: [
        '[mcp_servers.splitup]',
        `url = "${mcpUrl}"`,
        'bearer_token_env_var = "SPLITUP_TOKEN"',
        '',
        `# ~/.zshrc or ~/.bashrc:`,
        `# export SPLITUP_TOKEN="${token}"`,
      ].join('\n'),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      where: 'Add to ~/.cursor/mcp.json',
      code: JSON.stringify(
        {
          mcpServers: {
            splitup: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      where:
        'Easiest: Settings → Connectors → Add custom connector with the URL above (no token). ' +
        'Or add to claude_desktop_config.json (needs Node.js):',
      code: JSON.stringify(
        {
          mcpServers: {
            splitup: {
              command: 'npx',
              args: ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization:${SPLITUP_AUTH}'],
              env: { SPLITUP_AUTH: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
    },
  ];
}
