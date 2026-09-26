/** One provider's post-run writeback plan, handed from the opencode harness to
 * `entryPost.ts` via `core.saveState`. Type-only across that boundary, so it
 * does not violate entryPost's stdlib-only import rule. */
export interface OAuthWriteback {
  /** Pullfrog secret to PUT the rotated chain back into. */
  secretName: string;
  /** opencode auth.json provider key this chain lives under. */
  provider: "openai" | "xai";
  authPath: string;
  originalRefresh: string;
  /** codex only — opencode's auth entry has no slot for it. see below. */
  originalIdToken?: string | undefined;
}

/** Detect a mid-run Codex OAuth rotation from an on-disk auth.json and render
 * it in the Codex CLI shape the Pullfrog secret store holds. Returns null when
 * the file carries no usable OAuth entry or the refresh token is unchanged from
 * `originalRefresh`. Lives in its own module so `entryPost.ts` can import it
 * without pulling in `codexHome.ts` (which imports `./cli.ts` and node fs
 * helpers).
 *
 * Two on-disk shapes reach here, one per harness:
 *   - codex CLI  — `{auth_mode, tokens: {id_token, access_token, refresh_token}}`,
 *     already the storage shape, so it round-trips verbatim.
 *   - opencode   — `{openai: {type: "oauth", access, refresh, accountId}}`, which
 *     has no slot for `id_token`. The caller passes the pre-run value through
 *     `originalIdToken` so the rotated blob keeps it: the codex CLI REFUSES an
 *     auth.json without `tokens.id_token` (`missing field 'id_token'`), so
 *     dropping it here would silently disqualify the account from ever running
 *     on the codex harness. `id_token` is an identity claim that a refresh does
 *     not rotate — the server-side `refreshCodexAuthBody` carries the old one
 *     forward the same way. */
export function detectCodexRefresh(params: {
  authFileContent: string;
  originalRefresh: string;
  originalIdToken?: string | undefined;
}): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.authFileContent);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;

  const tokens = readCodexTokens(root) ?? readOpenCodeTokens(root);
  if (!tokens) return null;
  if (tokens.refresh_token === params.originalRefresh) return null;

  const idToken = tokens.id_token ?? params.originalIdToken;
  const codexShape = {
    auth_mode: "chatgpt",
    tokens: {
      ...(idToken ? { id_token: idToken } : {}),
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      ...(tokens.account_id ? { account_id: tokens.account_id } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
  return `${JSON.stringify(codexShape, null, 2)}\n`;
}

interface RotatedTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string | undefined;
  account_id?: string | undefined;
}

function readCodexTokens(root: Record<string, unknown>): RotatedTokens | null {
  if (root.auth_mode !== "chatgpt") return null;
  const tokens = root.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const t = tokens as Record<string, unknown>;
  if (typeof t.access_token !== "string" || typeof t.refresh_token !== "string") return null;
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    id_token: typeof t.id_token === "string" ? t.id_token : undefined,
    account_id: typeof t.account_id === "string" ? t.account_id : undefined,
  };
}

function readOpenCodeTokens(root: Record<string, unknown>): RotatedTokens | null {
  const oauth = root.openai;
  if (!oauth || typeof oauth !== "object") return null;
  const o = oauth as Record<string, unknown>;
  if (o.type !== "oauth") return null;
  if (typeof o.refresh !== "string" || typeof o.access !== "string") return null;
  return {
    access_token: o.access,
    refresh_token: o.refresh,
    id_token: undefined,
    account_id: typeof o.accountId === "string" ? o.accountId : undefined,
  };
}

/** Detect a mid-run Grok OAuth rotation and render it in the storage shape.
 * Simpler than the Codex twin: opencode's `xai` entry carries the whole chain,
 * there is no second on-disk shape to reconcile and no identity claim to
 * re-attach. Returns null when the entry is missing or unrotated. */
export function detectXaiRefresh(params: {
  authFileContent: string;
  originalRefresh: string;
}): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.authFileContent);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const oauth = (parsed as Record<string, unknown>).xai;
  if (!oauth || typeof oauth !== "object") return null;
  const o = oauth as Record<string, unknown>;
  if (o.type !== "oauth") return null;
  if (typeof o.access !== "string" || typeof o.refresh !== "string") return null;
  if (o.refresh === params.originalRefresh) return null;
  const grokShape = {
    auth_mode: "grok",
    tokens: { access_token: o.access, refresh_token: o.refresh },
    last_refresh: new Date().toISOString(),
  };
  return `${JSON.stringify(grokShape, null, 2)}\n`;
}
