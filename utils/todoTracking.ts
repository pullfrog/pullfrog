import { TODO_SPINNER_URL } from "./leapingComment.ts";
import { log } from "./log.ts";

type TodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
};

function isValidTodoStatus(value: string): value is TodoItem["status"] {
  return (
    value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled"
  );
}

function parseTodowriteInput(input: unknown): { todos: unknown[]; merge: boolean } | undefined {
  if (!input || typeof input !== "object" || !("todos" in input)) return undefined;
  if (!Array.isArray(input.todos)) return undefined;
  const merge = "merge" in input && input.merge === true;
  return { todos: input.todos, merge };
}

function parseTodoItem(entry: unknown, index: number): TodoItem | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  if (!("content" in entry) || typeof entry.content !== "string") return undefined;
  const id = "id" in entry && typeof entry.id === "string" ? entry.id : String(index);
  const status =
    "status" in entry && typeof entry.status === "string" && isValidTodoStatus(entry.status)
      ? entry.status
      : "pending";
  return { id, content: entry.content, status };
}

function renderTodoMarkdown(todos: TodoItem[]): string {
  return todos
    .map((todo) => {
      switch (todo.status) {
        case "completed":
          return `- [x] ${todo.content}`;
        case "cancelled":
          return `- ~~${todo.content}~~`;
        case "in_progress":
          return `- [ ] <picture><img src="${TODO_SPINNER_URL}" width="12" height="12" /></picture> ${todo.content}`;
        case "pending":
          return `- [ ] ${todo.content}`;
        default:
          todo.status satisfies never;
          return `- [ ] ${todo.content}`;
      }
    })
    .join("\n");
}

export type TodoTracker = {
  update: (input: unknown) => void;
  flush: () => Promise<void>;
  cancel: () => void;
  /** resolves when any in-flight onUpdate call completes */
  settled: () => Promise<void>;
  /** mark in-progress items as completed (for final snapshot before review/progress post) */
  completeInProgress: () => void;
  renderCollapsible: (options?: { completeInProgress?: boolean }) => string;
  readonly enabled: boolean;
  /** true after the tracker has successfully called onUpdate at least once */
  readonly hasPublished: boolean;
};

const DEBOUNCE_MS = 2000;

export function createTodoTracker(onUpdate: (body: string) => Promise<void>): TodoTracker {
  const state = new Map<string, TodoItem>();
  let enabled = true;
  let hasPublished = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inflightPromise: Promise<void> = Promise.resolve();

  function scheduleUpdate() {
    if (!enabled) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!enabled || state.size === 0) return;
      const markdown = renderTodoMarkdown(Array.from(state.values()));
      inflightPromise = inflightPromise
        .then(async () => {
          if (!enabled) return;
          await onUpdate(markdown);
          hasPublished = true;
        })
        .catch((err) => {
          log.debug(`todo progress update failed: ${err}`);
        });
    }, DEBOUNCE_MS);
  }

  return {
    update(input: unknown) {
      if (!enabled) return;
      const parsed = parseTodowriteInput(input);
      if (!parsed) return;
      if (!parsed.merge) state.clear();
      for (const [index, entry] of parsed.todos.entries()) {
        const item = parseTodoItem(entry, index);
        if (item) state.set(item.id, item);
      }
      log.debug(`» todowrite: ${state.size} items tracked`);
      scheduleUpdate();
    },

    async flush() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (!enabled || state.size === 0) return;
      const markdown = renderTodoMarkdown(Array.from(state.values()));
      inflightPromise = inflightPromise
        .then(async () => {
          if (!enabled) return;
          await onUpdate(markdown);
          hasPublished = true;
        })
        .catch((err) => {
          log.debug(`todo progress flush failed: ${err}`);
        });
      await inflightPromise;
    },

    cancel() {
      enabled = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },

    async settled() {
      await inflightPromise;
    },

    completeInProgress() {
      for (const item of state.values()) {
        if (item.status === "in_progress") item.status = "completed";
      }
    },

    renderCollapsible(options?: { completeInProgress?: boolean }): string {
      if (state.size === 0) return "";
      const shouldCompleteInProgress = options?.completeInProgress === true;
      const todos = Array.from(state.values()).map((item) =>
        shouldCompleteInProgress && item.status === "in_progress"
          ? { ...item, status: "completed" as const }
          : item
      );
      const completed = todos.filter((t) => t.status === "completed").length;
      const markdown = renderTodoMarkdown(todos);
      return `<details>\n<summary>Task list (${completed}/${todos.length} completed)</summary>\n\n${markdown}\n\n</details>`;
    },

    get enabled() {
      return enabled;
    },

    get hasPublished() {
      return hasPublished;
    },
  };
}
