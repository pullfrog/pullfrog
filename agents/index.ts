import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { dsh } from "./dsh.ts";
import { opencode } from "./opencode.ts";
import type { Agent } from "./shared.ts";

export type { Agent, AgentUsage } from "./shared.ts";

export const agents = { claude, codex, dsh, opencode } satisfies Record<string, Agent>;
