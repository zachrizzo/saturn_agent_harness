import path from "node:path";

export function automationsRoot(): string {
  const root = process.env.AUTOMATIONS_ROOT;
  if (!root) {
    throw new Error("AUTOMATIONS_ROOT env var is required");
  }
  return root;
}

export function jobsFile(): string {
  return path.join(automationsRoot(), "jobs", "jobs.json");
}

export function runsRoot(): string {
  return path.join(automationsRoot(), "runs");
}

export function agentsFile(): string {
  return path.join(automationsRoot(), "agents.json");
}

export function settingsFile(): string {
  return path.join(automationsRoot(), "settings.json");
}

export function mcpConfigFile(): string {
  return path.join(automationsRoot(), "mcps.json");
}

export function slicesFile(): string {
  return path.join(automationsRoot(), "slices.json");
}

export function sessionsRoot(): string {
  return path.join(automationsRoot(), "sessions");
}

export function memoryRoot(): string {
  return path.join(automationsRoot(), "memory");
}

export function workingDirectoriesFile(): string {
  return path.join(automationsRoot(), "working-directories.json");
}

export function binDir(): string {
  return path.join(automationsRoot(), "bin");
}

export function tasksDir(): string {
  return path.join(automationsRoot(), "tasks");
}

export function taskDir(id: string): string {
  return path.join(tasksDir(), id);
}

export function taskMetaPath(id: string): string {
  return path.join(taskDir(id), "meta.json");
}

export function taskActivityPath(id: string): string {
  return path.join(taskDir(id), "activity.jsonl");
}

export function taskClaimPath(id: string): string {
  return path.join(taskDir(id), "claim.lock");
}

export function sliceFixturesDir(sliceId: string): string {
  return path.join(automationsRoot(), "slice-fixtures", sliceId);
}
