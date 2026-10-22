// Best-effort metadata-only cleanup. The workflow checks out this helper from
// the default branch; the validation job keeps its own read-only token.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const CI_PATH = ".github/workflows/ci.yml";
const ADMISSION_JOB = "Check duplicate feature push";
const VALIDATION_JOB = "Pi 1.4.0";

export async function cancelDuplicatePush({ repository, runId, pullNumber, trustedRef, mergeRef, request, sleep = delay, log = console.log }) {
  let cancellationAttempted = false;
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(runId) || runId < 1
      || !Number.isSafeInteger(pullNumber) || pullNumber < 1
      || !/^[a-f0-9]{40}$/.test(trustedRef) || !/^[a-f0-9]{40}$/.test(mergeRef)) return false;
    const base = `/repos/${repository}`;
    const repo = await request("GET", base);
    const workflow = await request("GET", `${base}/actions/workflows/ci.yml`);
    if (!Number.isSafeInteger(repo.id) || repo.id < 1 || !repo.default_branch
      || !Number.isSafeInteger(workflow.id) || workflow.id < 1 || workflow.path !== CI_PATH || workflow.state !== "active") return false;
    const sameRepo = value => value?.id === repo.id && value?.full_name === repository;
    const activeRun = run => run.status === "in_progress" && run.run_attempt === 1
      && run.workflow_id === workflow.id && run.path === CI_PATH
      && sameRepo(run.repository) && sameRepo(run.head_repository);
    const sourceMatches = run => run.id === runId && run.event === "pull_request"
      && activeRun(run) && run.head_branch !== repo.default_branch;
    const source = await request("GET", `${base}/actions/runs/${runId}`);
    if (!sourceMatches(source) || !/^[a-f0-9]{40}$/.test(source.head_sha)
      || !source.head_branch || !Number.isFinite(Date.parse(source.created_at))) return false;
    const head = source.head_sha;
    const branch = source.head_branch;
    const pullMatches = pull => pull.number === pullNumber && pull.state === "open" && pull.mergeable === true
      && sameRepo(pull.head?.repo) && sameRepo(pull.base?.repo) && pull.base?.ref === repo.default_branch
      && pull.head?.ref === branch && pull.head?.sha === head && pull.merge_commit_sha === mergeRef;
    const pull = await request("GET", `${base}/pulls/${pullNumber}`);
    if (!pullMatches(pull)) return false;
    // A PR changing CI policy cannot authorize cancellation under that new policy.
    const trusted = await request("GET", `${base}/contents/${CI_PATH}`, { ref: trustedRef });
    const proposed = await request("GET", `${base}/contents/${CI_PATH}`, { ref: head });
    const merged = await request("GET", `${base}/contents/${CI_PATH}`, { ref: mergeRef });
    if (trusted.type !== "file" || proposed.type !== "file" || merged.type !== "file"
      || !/^[a-f0-9]{40}$/.test(trusted.sha) || trusted.sha !== proposed.sha || trusted.sha !== merged.sha) return false;
    const jobs = async id => (await request("GET", `${base}/actions/runs/${id}/jobs`, { filter: "latest", per_page: "100" })).jobs;
    const hasActiveValidation = (values, id) => values.some(job => job.name === VALIDATION_JOB && job.run_id === id
      && job.run_attempt === 1 && job.head_sha === head && job.status === "in_progress" && job.runner_id > 0);
    let active = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(2000);
      if (hasActiveValidation(await jobs(runId), runId)) { active = true; break; }
    }
    if (!active) return false;
    const listed = await request("GET", `${base}/actions/workflows/${workflow.id}/runs`, {
      event: "push", branch, head_sha: head, status: "in_progress", per_page: "100",
    });
    const pushMatches = (run, prRun) => Number.isSafeInteger(run.id) && run.id > 0 && run.id !== runId
      && run.event === "push" && activeRun(run) && run.head_branch === branch && run.head_sha === head
      && Number.isFinite(Date.parse(run.created_at)) && Date.parse(run.created_at) < Date.parse(prRun.created_at);
    // Bound work to one older push; never scan history or poll a resident job.
    const candidate = listed.workflow_runs.filter(run => pushMatches(run, source))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (!candidate) return false;
    const pushJobs = await jobs(candidate.id);
    // The trusted admission condition runs only for non-default *branch* pushes.
    // Tags can share a branch name/SHA, so names alone are not enough.
    if (!pushJobs.some(job => job.run_id === candidate.id && job.run_attempt === 1 && job.head_sha === head
      && job.name === ADMISSION_JOB && job.status === "completed" && job.conclusion === "success")) return false;
    if (!hasActiveValidation(pushJobs, candidate.id)) return false;
    // Recheck live ownership immediately before the only external mutation.
    const currentPull = await request("GET", `${base}/pulls/${pullNumber}`);
    const currentSource = await request("GET", `${base}/actions/runs/${runId}`);
    const target = await request("GET", `${base}/actions/runs/${candidate.id}`);
    if (!pullMatches(currentPull) || !sourceMatches(currentSource) || currentSource.head_sha !== head || currentSource.head_branch !== branch
      || target.id !== candidate.id || !pushMatches(target, currentSource) || !hasActiveValidation(await jobs(runId), runId)) return false;
    cancellationAttempted = true;
    await request("POST", `${base}/actions/runs/${target.id}/cancel`);
    log(`Requested cancellation of duplicate feature push ${target.id}; PR ${pullNumber} validation ${runId} remains authoritative.`);
    return true;
  } catch {
    log(cancellationAttempted
      ? "::warning::Cancellation response unconfirmed; do not retry blindly. PR validation remains required."
      : "::warning::Duplicate-push cleanup unavailable; retaining full validation.");
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (process.env.GITHUB_EVENT_NAME === "pull_request") {
      const request = async (method, path, query = {}) => {
        const url = new URL(`${process.env.GITHUB_API_URL}${path}`);
        url.search = new URLSearchParams(query).toString();
        const response = await fetch(url, { method, headers: {
          authorization: `Bearer ${process.env.GH_TOKEN}`,
          accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
        }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
        return response.status === 204 || response.status === 202 ? undefined : response.json();
      };
      const confirmed = await cancelDuplicatePush({ repository: process.env.GITHUB_REPOSITORY, runId: Number(process.env.GITHUB_RUN_ID),
        pullNumber: event.pull_request?.number, trustedRef: process.env.TRUSTED_CI_REF, mergeRef: process.env.GITHUB_SHA, request });
      if (!confirmed) console.log("No cancellation confirmed; complete PR validation remains required.");
    }
  } catch {
    console.log("::warning::Duplicate-push cleanup unavailable; retaining full validation.");
  }
}
