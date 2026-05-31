import {
  CACHE_TTL_MS,
  CheckNameResult,
  CheckNamesResponseEvent,
  THROTTLE_DELAY_MS,
  getValidationMessage,
  isValidMinecraftUsername,
  normalizeUsername,
  toCacheKey,
} from "@/lib/minecraft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CacheEntry = {
  expiresAt: number;
  value: CheckNameResult;
};

type LookupOutcome =
  | {
      kind: "result";
      result: CheckNameResult;
    }
  | {
      kind: "rate-limited";
      retryAfterMs: number;
      message: string;
    };

const lookupCache = new Map<string, CacheEntry>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null) {
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const retryAt = Date.parse(header);
  if (!Number.isNaN(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return null;
}

async function lookupMojangProfile(name: string): Promise<LookupOutcome> {
  const normalizedName = normalizeUsername(name);
  const cacheKey = toCacheKey(normalizedName);
  const now = Date.now();
  const cached = lookupCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return {
      kind: "result",
      result: cached.value,
    };
  }

  try {
    const response = await fetch(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(normalizedName)}`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );

    if (response.ok) {
      const data = (await response.json()) as { id?: string; name?: string };

      if (data.id && data.name) {
        const result: CheckNameResult = {
          name: normalizedName,
          normalizedName,
          status: "Taken",
          uuid: data.id,
        };

        lookupCache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });

        return {
          kind: "result",
          result,
        };
      }
    }

    if (response.status === 204 || response.status === 404) {
      const result: CheckNameResult = {
        name: normalizedName,
        normalizedName,
        status: "Available",
        message: "Mojang returned no profile for this username.",
      };

      lookupCache.set(cacheKey, {
        value: result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return {
        kind: "result",
        result,
      };
    }

    if (response.status === 429 || response.status === 503) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? THROTTLE_DELAY_MS * 2;

      return {
        kind: "rate-limited",
        retryAfterMs,
        message:
          response.status === 429
            ? "Mojang rate-limited this request."
            : "Mojang temporarily rejected this request.",
      };
    }

    return {
      kind: "result",
      result: {
        name: normalizedName,
        normalizedName,
        status: "Error",
        message: `Mojang responded with HTTP ${response.status}.`,
        retriable: true,
      },
    };
  } catch (error) {
    return {
      kind: "result",
      result: {
        name: normalizedName,
        normalizedName,
        status: "Error",
        message: error instanceof Error ? error.message : "Unexpected network error.",
        retriable: true,
      },
    };
  }
}

async function streamCheckNames(names: string[]) {
  const cleanedNames = names.map((name) => normalizeUsername(String(name))).filter(Boolean);
  const uniqueNames: string[] = [];
  const seen = new Set<string>();

  for (const name of cleanedNames) {
    const key = toCacheKey(name);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueNames.push(name);
  }

  const invalidNames = uniqueNames.filter((name) => !isValidMinecraftUsername(name)).length;
  let processed = 0;
  let taken = 0;
  let available = 0;
  let errors = 0;
  let requeued = 0;
  let nextRequestAt = Date.now();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: CheckNamesResponseEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      for (const name of uniqueNames) {
        const waitMs = Math.max(0, nextRequestAt - Date.now());
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        const normalizedName = normalizeUsername(name);

        if (!isValidMinecraftUsername(normalizedName)) {
          const result: CheckNameResult = {
            name: normalizedName,
            normalizedName,
            status: "Invalid",
            message: getValidationMessage(normalizedName),
          };

          processed += 1;
          write({
            type: "progress",
            processed,
            total: uniqueNames.length,
          });
          write({
            type: "result",
            result,
          });
          nextRequestAt = Date.now() + THROTTLE_DELAY_MS;
          continue;
        }

        const lookup = await lookupMojangProfile(normalizedName);

        if (lookup.kind === "rate-limited") {
          requeued += 1;
          write({
            type: "requeue",
            name: normalizedName,
            attempts: 1,
            retryInMs: lookup.retryAfterMs,
            message: lookup.message,
          });

          nextRequestAt = Date.now() + Math.max(THROTTLE_DELAY_MS, lookup.retryAfterMs);
          continue;
        }

        const result = lookup.result;
        processed += 1;
        if (result.status === "Taken") taken += 1;
        if (result.status === "Available") available += 1;
        if (result.status === "Error") errors += 1;

        write({
          type: "progress",
          processed,
          total: uniqueNames.length,
        });

        write({
          type: "result",
          result,
        });
      }

      write({
        type: "summary",
        total: uniqueNames.length,
        processed,
        taken,
        available,
        invalid: invalidNames,
        requeued,
        errors,
      });

      write({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { names?: unknown };

    if (!Array.isArray(body.names)) {
      return Response.json(
        { error: "Request body must be a JSON object with a names array." },
        { status: 400 },
      );
    }

    return streamCheckNames(body.names.map((name) => String(name)));
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unexpected server error.",
      },
      { status: 500 },
    );
  }
}
