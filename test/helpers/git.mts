// Small resource constructors; callers own every mutation and expected result.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "./temp-dir.mjs";
import { createGitChangesTracker } from "../../src/git-changes.ts";

export function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}


export function committedRepository(t: TestContext, files: Record<string, string | Uint8Array>): string {
  const dir = temporaryDirectory(t, "metis-pi-git-");
  git(dir, "init", "-q", "-b", "main");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

export function trackedRepo(t: TestContext, cwd: string, deps: Partial<Parameters<typeof createGitChangesTracker>[0]> = {}) {
  const tracker = createGitChangesTracker({ getCwd: () => cwd, intervalMs: 60_000, ...deps });
  t.after(() => tracker.dispose());
  return tracker;
}

export async function refreshAndExpectSample(tracker: ReturnType<typeof createGitChangesTracker>, additions: number, deletions: number, files: number) {
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions, deletions, files });
}
