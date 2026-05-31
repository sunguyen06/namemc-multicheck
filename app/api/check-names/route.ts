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

const MAX_REQUEUE_ATTEMPTS = 5;
const MAX_REQUEUE_DELAY_MS = 30_000;

type CacheEntry = {
  expiresAt: number;
  value: CheckNameResult;
};

type LookupValue = CheckNameResult | LookupOutcome;

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

type QueueItem = {
  name: string;
  attempts: number;
  availableAt: number;
};

const lookupCache = new Map<string, CacheEntry>();
const inflightLookups = new Map<string, Promise<LookupValue>>();

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

  const pending = inflightLookups.get(cacheKey);
  if (pending) {
    const pendingResult = await pending;
    if ("kind" in pendingResult) {
      return pendingResult;
    }

    return {
      kind: "result",
      result: pendingResult,
    };
  }

  const request = fetch(
    `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(normalizedName)}`,
    {
      headers: {
        Accept: "application/json",
      },
    },
  ).then(async (response) => {
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

        return result;
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

      return result;
    }

    if (response.status === 429 || response.status === 503) {
      const retryAfterMs =
        parseRetryAfter(response.headers.get("retry-after")) ??
        Math.min(MAX_REQUEUE_DELAY_MS, THROTTLE_DELAY_MS * 2);

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
      name: normalizedName,
      normalizedName,
      status: "Error",
      message: `Mojang responded with HTTP ${response.status}.`,
      retriable: true,
    };
  });

  inflightLookups.set(cacheKey, request);

  try {
    const result = await request;
    if ("kind" in result) {
      return result;
    }

    lookupCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return {
      kind: "result",
      result,
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
  } finally {
    inflightLookups.delete(cacheKey);
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
  let nextRequestAt = Date.now();
  const queue: QueueItem[] = uniqueNames.map((name) => ({
    name,
    attempts: 0,
    availableAt: 0,
  }));

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: CheckNamesResponseEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      while (queue.length > 0) {
        queue.sort((left, right) => left.availableAt - right.availableAt);
        const nextItem = queue.shift();

        if (!nextItem) {
          break;
        }

        const waitUntil = Math.max(nextItem.availableAt, nextRequestAt);
        const waitMs = Math.max(0, waitUntil - Date.now());
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        const normalizedName = normalizeUsername(nextItem.name);

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
          nextItem.attempts += 1;

          if (nextItem.attempts > MAX_REQUEUE_ATTEMPTS) {
            const result: CheckNameResult = {
              name: normalizedName,
              normalizedName,
              status: "Error",
              message: `${lookup.message} Requeue limit reached after ${MAX_REQUEUE_ATTEMPTS} attempts.`,
              retriable: true,
            };

            processed += 1;
            errors += 1;
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

          const retryInMs = Math.max(THROTTLE_DELAY_MS, lookup.retryAfterMs);
          nextItem.availableAt = Date.now() + retryInMs;
          queue.push(nextItem);

          write({
            type: "requeue",
            name: normalizedName,
            attempts: nextItem.attempts,
            retryInMs,
            message: lookup.message,
          });

          nextRequestAt = Date.now() + THROTTLE_DELAY_MS;
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
