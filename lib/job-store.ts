import { kv } from "@vercel/kv";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JobRow } from "@/lib/job-utils";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export type JobRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  totalSubmitted: number;
  duplicateCount: number;
  validCount: number;
  invalidCount: number;
  processedCount: number;
  takenCount: number;
  availableCount: number;
  errorsCount: number;
  rows: JobRow[];
  nextRowIndex: number;
  lastError?: string;
};

const jobsDir = path.join(process.cwd(), ".data", "jobs");
const JOB_INDEX_KEY = "mc:jobs:index";
const JOB_KEY_PREFIX = "mc:jobs:job:";
const CRON_LOCK_KEY = "mc:jobs:process-lock";

const hasKv = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

async function ensureJobsDir() {
  await fs.mkdir(jobsDir, { recursive: true });
}

function jobPath(jobId: string) {
  return path.join(jobsDir, `${jobId}.json`);
}

async function readLocalJob(jobId: string): Promise<JobRecord | null> {
  await ensureJobsDir();
  try {
    const raw = await fs.readFile(jobPath(jobId), "utf8");
    return JSON.parse(raw) as JobRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function saveLocalJob(job: JobRecord) {
  await ensureJobsDir();
  const filePath = jobPath(job.id);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
  return job;
}

export async function listJobIds() {
  if (hasKv) {
    return ((await kv.smembers(JOB_INDEX_KEY)) as string[]) ?? [];
  }

  await ensureJobsDir();
  const entries = await fs.readdir(jobsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5));
}

export async function readJob(jobId: string): Promise<JobRecord | null> {
  if (hasKv) {
    return (await kv.get<JobRecord>(`${JOB_KEY_PREFIX}${jobId}`)) ?? null;
  }

  return readLocalJob(jobId);
}

export async function saveJob(job: JobRecord) {
  job.updatedAt = Date.now();

  if (hasKv) {
    await kv.set(`${JOB_KEY_PREFIX}${job.id}`, job);
    await kv.sadd(JOB_INDEX_KEY, job.id);
    return job;
  }

  return saveLocalJob(job);
}

export async function createJob(
  input: Omit<
    JobRecord,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "status"
    | "processedCount"
    | "takenCount"
    | "availableCount"
    | "errorsCount"
    | "nextRowIndex"
    | "lastError"
  >,
) {
  const job: JobRecord = {
    id: randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "queued",
    processedCount: 0,
    takenCount: 0,
    availableCount: 0,
    errorsCount: 0,
    nextRowIndex: 0,
    ...input,
  };

  await saveJob(job);
  return job;
}

export async function acquireCronLock(ttlSeconds = 55) {
  if (!hasKv) {
    return { acquired: true, token: "local" };
  }

  const token = randomUUID();
  const acquired = await kv.set(CRON_LOCK_KEY, token, { nx: true, ex: ttlSeconds });
  return acquired ? { acquired: true, token } : { acquired: false, token: null };
}

export async function releaseCronLock(token: string | null) {
  if (!hasKv || !token) {
    return;
  }

  const current = await kv.get<string>(CRON_LOCK_KEY);
  if (current === token) {
    await kv.del(CRON_LOCK_KEY);
  }
}

export { hasKv };
