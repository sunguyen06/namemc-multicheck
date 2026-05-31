import { CACHE_TTL_MS, CheckNameResult, normalizeUsername, toCacheKey } from "@/lib/minecraft";

type CacheEntry = {
  expiresAt: number;
  value: CheckNameResult;
};

const lookupCache = new Map<string, CacheEntry>();
const inflightLookups = new Map<string, Promise<CheckNameResult>>();
let throttleChain: Promise<void> = Promise.resolve();

const LOOKUP_DELAY_MS = 750;

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function enqueueLookup(task: () => Promise<CheckNameResult>) {
  const run = throttleChain.then(async () => {
    try {
      return await task();
    } finally {
      await delay(LOOKUP_DELAY_MS);
    }
  });

  throttleChain = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

export async function fetchMojangProfile(name: string): Promise<CheckNameResult> {
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

