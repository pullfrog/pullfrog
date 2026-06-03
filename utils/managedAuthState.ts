export const MANAGED_AUTH_WRITEBACK_STATE = "managed_auth_writebacks";

export interface CodexManagedAuthWriteback {
  kind: "codex";
  apiToken: string;
  secretName: "CODEX_AUTH_JSON";
  authPath: string;
  originalRefresh: string;
}

export type ManagedAuthWriteback = CodexManagedAuthWriteback;

export function stringifyManagedAuthWritebacks(writebacks: ManagedAuthWriteback[]): string {
  return JSON.stringify(writebacks);
}

export function parseManagedAuthWritebacks(raw: string): ManagedAuthWriteback[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  const writebacks: ManagedAuthWriteback[] = [];
  for (const item of parsed) {
    const writeback = parseManagedAuthWriteback(item);
    if (!writeback) return null;
    writebacks.push(writeback);
  }

  return writebacks;
}

function parseManagedAuthWriteback(value: unknown): ManagedAuthWriteback | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  if (v.kind === "codex") {
    if (typeof v.apiToken !== "string" || v.apiToken.length === 0) return null;
    if (v.secretName !== "CODEX_AUTH_JSON") return null;
    if (typeof v.authPath !== "string" || v.authPath.length === 0) return null;
    if (typeof v.originalRefresh !== "string" || v.originalRefresh.length === 0) return null;
    return {
      kind: "codex",
      apiToken: v.apiToken,
      secretName: "CODEX_AUTH_JSON",
      authPath: v.authPath,
      originalRefresh: v.originalRefresh,
    };
  }

  return null;
}
