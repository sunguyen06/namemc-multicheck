"use client";

import { useEffect, useMemo, useState } from "react";
import { buildInitialRows, type JobRow } from "@/lib/job-utils";
import type { JobRecord } from "@/lib/job-store";
import { getStatusTone, normalizeUsername } from "@/lib/minecraft";

type JobResponse = {
  jobId: string;
  job: JobRecord;
};

const STORAGE_KEY = "namemc-multicheck:last-job-id";

export default function Home() {
  const [input, setInput] = useState("");
  const [jobId, setJobId] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    return window.localStorage.getItem(STORAGE_KEY);
  });
  const [job, setJob] = useState<JobRecord | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("Ready.");
  const [error, setError] = useState<string | null>(null);

  const inputCount = useMemo(
    () => input.split(/\r?\n/).map((line) => normalizeUsername(line)).filter(Boolean).length,
    [input],
  );

  const stats = useMemo(() => {
    if (!job) {
      return {
        total: 0,
        pending: 0,
        taken: 0,
        available: 0,
        invalid: 0,
        errors: 0,
        progress: 0,
      };
    }

    const pending = job.rows.filter((row) => row.status === "Pending").length;
    return {
      total: job.rows.length,
      pending,
      taken: job.takenCount,
      available: job.availableCount,
      invalid: job.invalidCount,
      errors: job.errorsCount,
      progress: job.validCount === 0 ? 100 : Math.round((job.processedCount / job.validCount) * 100),
    };
  }, [job]);

  const visibleRows = job?.rows ?? [];

  useEffect(() => {
    if (!jobId) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Job lookup failed with HTTP ${response.status}.`);
        }

        const data = (await response.json()) as JobResponse;
        if (cancelled) {
          return;
        }

        setJob(data.job);
        setStatusMessage(
          data.job.status === "completed"
            ? "Job completed."
            : data.job.status === "running"
              ? `Running. ${data.job.processedCount}/${data.job.validCount} valid names processed.`
              : "Job queued and waiting for the worker.",
        );

        if (data.job.status === "completed" || data.job.status === "failed") {
          return;
        }

        timer = setTimeout(poll, 5000);
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : "Failed to load job status.");
          timer = setTimeout(poll, 10000);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [jobId]);

  async function startJob() {
    const initial = buildInitialRows(input.split(/\r?\n/));
    setIsCreating(true);
    setError(null);
    setStatusMessage("Creating background job...");

    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ names: input.split(/\r?\n/) }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Request failed with HTTP ${response.status}.`);
      }

      const data = (await response.json()) as JobResponse;
      setJobId(data.jobId);
      setJob(data.job);
      window.localStorage.setItem(STORAGE_KEY, data.jobId);

      const duplicateCount = initial.duplicateCount;
      setStatusMessage(
        data.job.status === "completed"
          ? "Nothing to process. All names were invalid or duplicates."
          : `Job started. ${duplicateCount ? `Removed ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}. ` : ""}This run will continue in the background.`,
      );
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create job.");
      setStatusMessage("Ready.");
    } finally {
      setIsCreating(false);
    }
  }

  function clearAll() {
    setInput("");
    setJobId(null);
    setJob(null);
    setError(null);
    setStatusMessage("Ready.");
    window.localStorage.removeItem(STORAGE_KEY);
  }

  return (
    <main className="min-h-screen bg-[#141816] text-[#f4f4f2]">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between border-b-4 border-[#2e312b] pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center border-2 border-[#0b0e0c] bg-[#9acb63] text-[#0b0e0c] font-black shadow-[4px_4px_0_0_rgba(0,0,0,0.35)]">
              N
            </div>
            <div>
              <div className="text-lg font-semibold leading-none">Bulk MC Name Check</div>
              <div className="text-xs text-[#9aa1a8]">Background jobs for overnight runs</div>
            </div>
          </div>
          <div className="hidden text-xs text-[#9aa1a8] sm:block">
            {job ? `${job.validCount} valid names in progress` : "Queue-based, resumable processing"}
          </div>
        </header>

        <section className="mx-auto w-full max-w-4xl py-8">
          <div className="border-4 border-[#2b2e29] bg-[#1b1f1b] p-4 shadow-[6px_6px_0_0_rgba(0,0,0,0.35)] sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-white">Minecraft username bulk checker</h1>
                <p className="mt-1 text-sm leading-6 text-[#a7adb5]">
                  Paste as many names as you want, start a background job, and let it continue overnight. You can close
                  the page and reopen it later to resume the same run.
                </p>
              </div>
              <div className="border-2 border-[#2b3138] bg-[#111418] px-3 py-2 text-xs text-[#c3c8cd]">
                {statusMessage}
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex justify-end">
                <div className="border-2 border-[#2a2f2a] bg-[#111418] px-3 py-1 text-xs font-semibold text-[#c3c8cd] shadow-[3px_3px_0_0_rgba(0,0,0,0.25)]">
                  {inputCount} names
                </div>
              </div>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Paste usernames here, one per line"
                className="min-h-48 w-full border-4 border-[#2a2f2a] bg-[#101311] px-4 py-3 text-sm leading-6 text-white outline-none placeholder:text-[#6b7280] focus:border-[#8bbf5a]"
              />
              <div className="mt-2 text-xs text-[#8b929b]">
                The app will create a background job and keep saving progress automatically.
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => void startJob()}
                disabled={isCreating}
                className="border-4 border-[#0b0e0c] bg-[#9acb63] px-5 py-2.5 text-sm font-semibold text-[#0b0e0c] shadow-[4px_4px_0_0_rgba(0,0,0,0.35)] transition hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[3px_3px_0_0_rgba(0,0,0,0.35)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreating ? "Starting..." : "Check names"}
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="border-4 border-[#2a2f2a] bg-[#222622] px-5 py-2.5 text-sm font-semibold text-white shadow-[4px_4px_0_0_rgba(0,0,0,0.25)] transition hover:translate-x-[1px] hover:translate-y-[1px]"
              >
                Clear
              </button>
            </div>

            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between text-xs text-[#9aa1a8]">
                <span>
                  {job
                    ? `${job.status.toUpperCase()} · ${job.processedCount}/${job.validCount} valid processed`
                    : "No job started yet."}
                </span>
                <span>{stats.progress}%</span>
              </div>
              <div className="h-3 border-2 border-[#2a2f2a] bg-[#0f1317]">
                <div className="h-full bg-[#9acb63] transition-all duration-300" style={{ width: `${stats.progress}%` }} />
              </div>
            </div>

            {error ? (
              <div className="mt-4 border-4 border-[#7f1d1d] bg-[#241316] px-4 py-3 text-sm text-[#fda4af]">
                {error}
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap gap-2 text-xs text-[#c5cad0]">
              <Pill label={`Taken ${stats.taken}`} />
              <Pill label={`Available ${stats.available}`} />
              <Pill label={`Invalid ${stats.invalid}`} />
              <Pill label={`Errors ${stats.errors}`} />
              <Pill label={`Pending ${stats.pending}`} />
            </div>

            <div className="mt-6 overflow-hidden border-4 border-[#2a2f2a]">
              <table className="min-w-full divide-y divide-[#2a3037] text-left text-sm">
                <thead className="bg-[#111418] text-[#9aa1a8]">
                  <tr>
                    <th className="px-4 py-3 font-medium">Username</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2a3037] bg-[#0f1317]">
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-4 py-10 text-center text-[#78808a]">
                        Results will appear here once the job starts.
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((row) => (
                      <tr key={row.rowKey}>
                        <td className="px-4 py-3 text-white">
                          <div className="font-medium">{row.name}</div>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={row.status} />
                        </td>
                        <td className="px-4 py-3 text-[#b6bcc3]">
                          {row.status === "Taken" ? (
                            <span className="font-mono text-xs break-all">UUID: {row.uuid}</span>
                          ) : (
                            row.message ?? "-"
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-5 border-4 border-[#2a2f2a] bg-[#0f1317] px-4 py-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#9aa1a8]">Output</div>
              <div className="max-h-72 space-y-1 overflow-auto font-mono text-sm text-[#e5e7eb]">
                {visibleRows.length === 0 ? (
                  <div className="text-[#78808a]">No output yet.</div>
                ) : (
                  visibleRows.map((row) => <div key={`output:${row.rowKey}`}>{`${row.name} : ${row.status}`}</div>)
                )}
              </div>
            </div>

            {job ? (
              <div className="mt-5 text-xs text-[#9aa1a8]">
                Job ID: {jobId}
                {" · "}
                Submitted {job.totalSubmitted}. Duplicates removed {job.duplicateCount}.{" "}
                {job.status === "completed"
                  ? "The job is finished."
                  : "The job will keep advancing automatically through cron."}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function Pill({ label }: { label: string }) {
  return <span className="border-2 border-[#2a3037] bg-[#111418] px-3 py-1">{label}</span>;
}

function StatusBadge({ status }: { status: JobRow["status"] }) {
  const tone = getStatusTone(status);
  const classes: Record<string, string> = {
    taken: "border-[#2f6f4b] bg-[#102118] text-[#86efac]",
    available: "border-[#5d6b2f] bg-[#171d10] text-[#d9f99d]",
    invalid: "border-[#4b5563] bg-[#171b21] text-[#cbd5e1]",
    error: "border-[#7f1d1d] bg-[#241316] text-[#fda4af]",
    pending: "border-[#334155] bg-[#141a22] text-[#bae6fd]",
  };

  return <span className={`inline-flex border-2 px-3 py-1 text-xs font-semibold ${classes[tone]}`}>{status}</span>;
}
