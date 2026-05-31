"use client";

import { useMemo, useState } from "react";
import {
  MAX_BATCH_SIZE,
  CheckNameResult,
  getStatusTone,
  getValidationMessage,
  isValidMinecraftUsername,
  normalizeUsername,
  toCacheKey,
} from "@/lib/minecraft";

type Row = CheckNameResult & {
  rowKey: string;
  isDuplicate?: boolean;
};

type ExportFilter = "Available" | "Taken" | "Error";

type StreamEvent =
  | { type: "progress"; processed: number; total: number }
  | { type: "result"; result: CheckNameResult }
  | {
      type: "requeue";
      name: string;
      attempts: number;
      retryInMs: number;
      message: string;
    }
  | {
      type: "summary";
      total: number;
      processed: number;
      taken: number;
      available: number;
      invalid: number;
      requeued: number;
      errors: number;
    }
  | { type: "done" };

export default function Home() {
  const MAX_RETRY_PASSES = 5;
  const exportFilters: ExportFilter[] = ["Available", "Taken", "Error"];
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("Ready.");
  const [isChecking, setIsChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportFilter, setExportFilter] = useState<ExportFilter>("Error");
  const [summary, setSummary] = useState<{
    processed: number;
    taken: number;
    available: number;
    invalid: number;
    errors: number;
  } | null>(null);

  const inputCount = useMemo(
    () => input.split(/\r?\n/).map((line) => normalizeUsername(line)).filter(Boolean).length,
    [input],
  );

  const counts = useMemo(() => {
    const next = { taken: 0, available: 0, invalid: 0, error: 0 };
    for (const row of rows) {
      if (row.status === "Taken") next.taken += 1;
      if (row.status === "Available") next.available += 1;
      if (row.status === "Invalid") next.invalid += 1;
      if (row.status === "Error") next.error += 1;
    }
    return next;
  }, [rows]);

  const errorNames = useMemo(
    () => rows.filter((row) => row.status === "Error").map((row) => row.name),
    [rows],
  );

  const exportableNames = useMemo(() => {
    return rows.filter((row) => row.status === exportFilter).map((row) => row.name);
  }, [exportFilter, rows]);

  async function readNdjson(response: Response, onEvent: (event: StreamEvent) => void) {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Streaming response not supported in this browser.");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line) continue;
        onEvent(JSON.parse(line) as StreamEvent);
      }
    }

    const tail = buffer.trim();
    if (tail) onEvent(JSON.parse(tail) as StreamEvent);
  }

  function parseBatch(text: string) {
    const entries = text.split(/\r?\n/).map((line) => normalizeUsername(line)).filter(Boolean);
    const seen = new Set<string>();
    const unique: string[] = [];
    const rows: Row[] = [];
    let duplicates = 0;

    for (const entry of entries) {
      const key = toCacheKey(entry);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }

      seen.add(key);

      if (!isValidMinecraftUsername(entry)) {
        rows.push({
          rowKey: `invalid:${key}`,
          name: entry,
          normalizedName: entry,
          status: "Invalid",
          message: getValidationMessage(entry),
        });
        continue;
      }

      unique.push(entry);
      rows.push({
        rowKey: `pending:${key}`,
        name: entry,
        normalizedName: entry,
        status: "Pending",
        message: "Waiting in queue.",
      });
    }

    return { unique, rows, duplicates };
  }

  function chunkNames(names: string[]) {
    const chunks: string[][] = [];

    for (let index = 0; index < names.length; index += MAX_BATCH_SIZE) {
      chunks.push(names.slice(index, index + MAX_BATCH_SIZE));
    }

    return chunks;
  }

  async function runCheck(targetNames?: string[]) {
    const source = targetNames ?? input.split(/\r?\n/);
    const { unique, rows: initialRows, duplicates } = parseBatch(source.join("\n"));

    setNotice(duplicates ? `Removed ${duplicates} duplicate${duplicates === 1 ? "" : "s"}.` : null);
    setRows(initialRows);
    setSummary(null);
    setProgress(0);
    setIsChecking(true);

    try {
      let passNames = unique;
      let passNumber = 1;
      let taken = 0;
      let available = 0;
      const invalid = initialRows.filter((row) => row.status === "Invalid").length;
      let errors = 0;

      if (passNames.length === 0) {
        setProgress(100);
        setProgressText("Done. 0 checked.");
        setSummary({
          processed: 0,
          taken: 0,
          available: 0,
          invalid,
          errors: 0,
        });
        return;
      }

      while (passNames.length > 0 && passNumber <= MAX_RETRY_PASSES) {
        const chunks = chunkNames(passNames);
        const retryQueue = new Set<string>();

        setProgressText(
          passNumber === 1
            ? `Checking ${passNames.length} username${passNames.length === 1 ? "" : "s"}...`
            : `Retry pass ${passNumber}: checking ${passNames.length} requeued username${
                passNames.length === 1 ? "" : "s"
              }...`,
        );

        let completedInPass = 0;

        for (const chunk of chunks) {
          let chunkCompleted = 0;
          const response = await fetch("/api/check-names", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ names: chunk }),
          });

          if (!response.ok) {
            const data = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(data?.error ?? `Request failed with HTTP ${response.status}.`);
          }

          await readNdjson(response, (event) => {
            if (event.type === "progress") {
              const overallProcessed = completedInPass + event.processed;
              const percent = passNames.length === 0 ? 100 : Math.round((overallProcessed / passNames.length) * 100);
              setProgress(percent);
              setProgressText(
                passNumber === 1
                  ? `Processed ${overallProcessed}/${passNames.length}`
                  : `Retry pass ${passNumber}: ${overallProcessed}/${passNames.length}`,
              );
              return;
            }

            if (event.type === "result") {
              setRows((current) =>
                current.map((row) =>
                  row.name.toLowerCase() === event.result.name.toLowerCase()
                    ? { ...event.result, rowKey: `done:${toCacheKey(event.result.name)}` }
                    : row,
                ),
              );

              if (event.result.status === "Taken") taken += 1;
              if (event.result.status === "Available") available += 1;
              if (event.result.status === "Error") errors += 1;
              return;
            }

            if (event.type === "requeue") {
              retryQueue.add(normalizeUsername(event.name));
              setNotice(
                `Queued ${retryQueue.size} name${retryQueue.size === 1 ? "" : "s"} for retry pass ${
                  passNumber + 1
                }.`,
              );
              setProgressText(
                `${event.name} was rate-limited. Retrying in ${Math.max(1, Math.ceil(event.retryInMs / 1000))}s.`,
              );
              return;
            }

            if (event.type === "summary") {
              chunkCompleted = event.processed;
              return;
            }
          });

          completedInPass += chunkCompleted;
        }

        const nextPass = Array.from(retryQueue);
        if (nextPass.length === 0) {
          break;
        }

        passNames = nextPass;
        passNumber += 1;
      }

      if (passNames.length > 0) {
        const stillPending = passNames.map((name) => name.toLowerCase());
        setRows((current) =>
          current.map((row) =>
            stillPending.includes(row.name.toLowerCase()) && row.status === "Pending"
              ? {
                  ...row,
                  status: "Error",
                  message: `Still rate-limited after ${MAX_RETRY_PASSES} retry passes.`,
                  retriable: true,
                  rowKey: `done:${toCacheKey(row.name)}`,
                }
              : row,
          ),
        );
        errors += passNames.length;
        setNotice(`Some names stayed rate-limited after ${MAX_RETRY_PASSES} passes.`);
      }

      const processed = taken + available + invalid + errors;
      setProgress(100);
      setProgressText(`Done. ${processed} checked.`);
      setSummary({
        processed,
        taken,
        available,
        invalid,
        errors,
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unexpected client error.");
      setProgressText("Check failed.");
    } finally {
      setIsChecking(false);
    }
  }

  const retryErrors = () => {
    if (errorNames.length > 0) void runCheck(errorNames);
  };

  const downloadFilteredNames = () => {
    if (exportableNames.length === 0) {
      return;
    }

    const blob = new Blob([exportableNames.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${exportFilter.toLowerCase()}-names.txt`;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

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
            </div>
          </div>
          <div className="hidden text-xs text-[#9aa1a8] sm:block">
            Requests are split into {MAX_BATCH_SIZE}-name chunks
          </div>
        </header>

        <section className="mx-auto w-full max-w-4xl py-8">
          <div className="border-4 border-[#2b2e29] bg-[#1b1f1b] p-4 shadow-[6px_6px_0_0_rgba(0,0,0,0.35)] sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-white">Minecraft username bulk checker</h1>
                <p className="mt-1 text-sm leading-6 text-[#a7adb5]">
                  Paste one username per line, then check the list. Invalid names are flagged right away, duplicates are
                  removed, and results come back one by one.
                </p>
              </div>
              <div className="border-2 border-[#2b3138] bg-[#111418] px-3 py-2 text-xs text-[#c3c8cd]">
                {progressText}
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
                Press Enter to add more lines. Large lists are queued and slowed automatically if the upstream API
                starts rate limiting.
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => void runCheck()}
                disabled={isChecking}
                className="border-4 border-[#0b0e0c] bg-[#9acb63] px-5 py-2.5 text-sm font-semibold text-[#0b0e0c] shadow-[4px_4px_0_0_rgba(0,0,0,0.35)] transition hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[3px_3px_0_0_rgba(0,0,0,0.35)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isChecking ? "Checking..." : "Check names"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setInput("");
                  setRows([]);
                  setProgress(0);
                  setProgressText("Ready.");
                  setNotice(null);
                  setSummary(null);
                }}
                className="border-4 border-[#2a2f2a] bg-[#222622] px-5 py-2.5 text-sm font-semibold text-white shadow-[4px_4px_0_0_rgba(0,0,0,0.25)] transition hover:translate-x-[1px] hover:translate-y-[1px]"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={retryErrors}
                disabled={isChecking || errorNames.length === 0}
                className="border-4 border-[#2a2f2a] bg-[#222622] px-5 py-2.5 text-sm font-semibold text-white shadow-[4px_4px_0_0_rgba(0,0,0,0.25)] transition hover:translate-x-[1px] hover:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Retry errors
              </button>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9aa1a8]">
                  Export filter
                </label>
                <select
                  value={exportFilter}
                  onChange={(event) => setExportFilter(event.target.value as ExportFilter)}
                  className="border-4 border-[#2a2f2a] bg-[#111418] px-4 py-2.5 text-sm font-semibold text-white shadow-[4px_4px_0_0_rgba(0,0,0,0.25)] outline-none"
                >
                  {exportFilters.map((filter) => (
                    <option key={filter} value={filter}>
                      {filter}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={downloadFilteredNames}
                  disabled={exportableNames.length === 0}
                  className="border-4 border-[#2a2f2a] bg-[#222622] px-5 py-2.5 text-sm font-semibold text-white shadow-[4px_4px_0_0_rgba(0,0,0,0.25)] transition hover:translate-x-[1px] hover:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Export filtered names
                </button>
              </div>
            </div>

            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between text-xs text-[#9aa1a8]">
                <span>{progressText}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-3 border-2 border-[#2a2f2a] bg-[#0f1317]">
                <div
                  className="h-full bg-[#9acb63] transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            {notice ? (
              <div className="mt-4 border-4 border-[#5a4a14] bg-[#2a2208] px-4 py-3 text-sm text-[#f4d06f]">
                {notice}
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap gap-2 text-xs text-[#c5cad0]">
              <Pill label={`Taken ${counts.taken}`} />
              <Pill label={`Available ${counts.available}`} />
              <Pill label={`Invalid ${counts.invalid}`} />
              <Pill label={`Errors ${counts.error}`} />
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
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-4 py-10 text-center text-[#78808a]">
                        Results will appear here.
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.rowKey}>
                        <td className="px-4 py-3 text-white">
                          <div className="font-medium">{row.name}</div>
                          {row.isDuplicate ? <div className="text-xs text-[#78808a]">Duplicate removed</div> : null}
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
              <div className="space-y-1 font-mono text-sm text-[#e5e7eb]">
                {rows.length === 0 ? (
                  <div className="text-[#78808a]">No output yet.</div>
                ) : (
                  rows.map((row) => <div key={`output:${row.rowKey}`}>{`${row.name} : ${row.status}`}</div>)
                )}
              </div>
            </div>

            {summary ? (
              <div className="mt-5 text-xs text-[#9aa1a8]">
                Checked {summary.processed}. Taken {summary.taken}. Available {summary.available}. Invalid{" "}
                {summary.invalid}. Errors {summary.errors}.
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

function StatusBadge({ status }: { status: CheckNameResult["status"] }) {
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
