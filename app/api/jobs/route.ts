import { buildInitialRows } from "@/lib/job-utils";
import { createJob, readJob, saveJob } from "@/lib/job-store";
import { processJobStep } from "@/lib/job-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { names?: unknown };

    if (!Array.isArray(body.names)) {
      return Response.json(
        { error: "Request body must be a JSON object with a names array." },
        { status: 400 },
      );
    }

    const initial = buildInitialRows(body.names.map((name) => String(name)));
    const job = await createJob({
      totalSubmitted: initial.totalSubmitted,
      duplicateCount: initial.duplicateCount,
      validCount: initial.validNames.length,
      invalidCount: initial.invalidCount,
      rows: initial.rows,
    });

    if (initial.validNames.length === 0) {
      job.status = "completed";
      job.processedCount = 0;
      job.takenCount = 0;
      job.availableCount = 0;
      job.errorsCount = 0;
      await saveJob(job);
    } else {
      await processJobStep(job.id, {
        maxRows: 20,
        timeBudgetMs: 30_000,
      });
    }

    const latestJob = (await readJob(job.id)) ?? job;

    return Response.json({
      jobId: job.id,
      job: latestJob,
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unexpected server error.",
      },
      { status: 500 },
    );
  }
}
