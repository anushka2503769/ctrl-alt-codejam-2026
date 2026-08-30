import type { AgentRun, Message } from "./types";

export function replaceRun(runs: AgentRun[], next: AgentRun): AgentRun[] {
  const index = runs.findIndex((run) => run.id === next.id);
  if (index === -1) return [next, ...runs];
  return runs.map((run) => (run.id === next.id ? next : run));
}

export function resolvedRunId(
  current: string | null,
  runs: AgentRun[],
): string | null {
  if (current && runs.some((run) => run.id === current)) return current;
  return runs[0]?.id ?? null;
}

export function lastMessageIndexes(messages: Message[]): Map<string, number> {
  const indexes = new Map<string, number>();
  messages.forEach((message, index) => indexes.set(message.runId, index));
  return indexes;
}

export function runsWithoutMessages(
  runs: AgentRun[],
  messages: Message[],
): AgentRun[] {
  const represented = new Set(messages.map((message) => message.runId));
  return runs
    .filter((run) => !represented.has(run.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
