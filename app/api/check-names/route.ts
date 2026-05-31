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

const lookupCache = new Map<string, CacheEntry>();
const inflightLookups = new Map<string, Promise<CheckNameResult>>();
let throttleChain: Promise<void> = Promise.resolve();

function enqueueLookup(task: () => Promise<CheckNameResult>) {
  const run = throttleChain.then(async () => {
    try {
      return await task();
    } finally {
      await new Promise((resolve) => setTimeout(resolve, THROTTLE_DELAY_MS));
    }
  });

  throttleChain = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

async function fetchMojangProfile(name: string): Promise<CheckNameResult> {
  const normalizedName = normalizeUsername(name);
  const cacheKey = toCacheKey(normalizedName);
  const now = Date.now();
  const cached = lookupCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const pending = inflightLookups.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = enqueueLookup(async () => {
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

    if (response.status === 429) {
      return {
        name: normalizedName,
        normalizedName,
        status: "Error",
        message: "Mojang rate-limited this request. Try again later.",
        retriable: true,
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
    lookupCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return result;
  } catch (error) {
    return {
      name: normalizedName,
      normalizedName,
      status: "Error",
      message: error instanceof Error ? error.message : "Unexpected network error.",
      retriable: true,
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

  const validNames = uniqueNames.filter((name) => isValidMinecraftUsername(name));
  const invalidNames = uniqueNames.length - validNames.length;
  let processed = 0;
  let taken = 0;
  let available = 0;
  let errors = 0;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: CheckNamesResponseEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      for (const name of uniqueNames) {
        const normalizedName = normalizeUsername(name);
        let result: CheckNameResult;

        if (!isValidMinecraftUsername(normalizedName)) {
          result = {
            name: normalizedName,
            normalizedName,
            status: "Invalid",
            message: getValidationMessage(normalizedName),
          };
        } else {
          result = await fetchMojangProfile(normalizedName);
        }

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
