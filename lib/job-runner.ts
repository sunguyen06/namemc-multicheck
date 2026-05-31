import { fetchMojangProfile } from "@/lib/mojang";
import {
  acquireCronLock,
  listJobIds,
  readJob,
  releaseCronLock,
  saveJob,
  type JobRecord,
} from "@/lib/job-store";

export type ProcessStepResult = {
  jobId: string;
  processed: number;
  completed: boolean;
  status: JobRecord["status"];
};

const DEFAULT_STEP_SIZE = 20;
const DEFAULT_TIME_BUDGET_MS = 45_000;
const RETRY_LIMIT = 3;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(name: string) {
  let attempt = 0;

  while (attempt < RETRY_LIMIT) {
    attempt += 1;
    const result = await fetchMojangProfile(name);

    if (!result.retriable || result.status !== "Error") {
      return result;
    }

    await sleep(attempt * 2000);
  }

  return fetchMojangProfile(name);
}

export async function processJobStep(
  jobId: string,
  options?: {
    maxRows?: number;
    timeBudgetMs?: number;
  },
): Promise<ProcessStepResult | null> {
  const job = await readJob(jobId);
  if (!job) {
    return null;
  }

  if (job.status === "completed") {
    return {
      jobId,
      processed: 0,
      completed: true,
      status: job.status,
    };
  }

  const maxRows = options?.maxRows ?? DEFAULT_STEP_SIZE;
  const timeBudgetMs = options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const deadline = Date.now() + timeBudgetMs;

  job.status = "running";
  job.lastError = undefined;
  await saveJob(job);

  let processed = 0;

  for (let index = job.nextRowIndex; index < job.rows.length; index += 1) {
    if (processed >= maxRows || Date.now() >= deadline) {
      break;
    }

    const row = job.rows[index];

    if (row.status !== "Pending") {
      job.nextRowIndex = index + 1;
      await saveJob(job);
      continue;
    }

    const result = await fetchWithRetry(row.name);
    job.rows[index] = {
      ...result,
      rowKey: row.rowKey,
    };

    job.processedCount += 1;
    if (result.status === "Taken") job.takenCount += 1;
    if (result.status === "Available") job.availableCount += 1;
    if (result.status === "Error") job.errorsCount += 1;
    job.nextRowIndex = index + 1;
    processed += 1;
    await saveJob(job);
  }

  job.status = job.nextRowIndex >= job.rows.length ? "completed" : "running";
  await saveJob(job);

  return {
    jobId,
    processed,
    completed: job.status === "completed",
    status: job.status,
  };
}

export async function processQueuedJobs(options?: {
  maxRowsPerJob?: number;
  timeBudgetMs?: number;
}) {
  const lock = await acquireCronLock();
  if (!lock.acquired) {
    return {
      processedJobs: 0,
      skipped: true,
    };
  }

  const startedAt = Date.now();
  const results: ProcessStepResult[] = [];

  try {
    const jobIds = await listJobIds();
    for (const jobId of jobIds) {
      if (Date.now() - startedAt > (options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS)) {
        break;
      }

      const job = await readJob(jobId);
      if (!job || (job.status !== "queued" && job.status !== "running")) {
        continue;
      }

      const result = await processJobStep(jobId, {
        maxRows: options?.maxRowsPerJob ?? DEFAULT_STEP_SIZE,
        timeBudgetMs: Math.max(5_000, (options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS) - (Date.now() - startedAt)),
      });

      if (result) {
        results.push(result);
      }
    }
  } catch (error) {
    return {
      processedJobs: results.length,
      skipped: false,
      error: error instanceof Error ? error.message : "Unexpected worker error.",
    };
  } finally {
    await releaseCronLock(lock.token);
  }

  return {
    processedJobs: results.length,
    skipped: false,
    results,
  };
}

