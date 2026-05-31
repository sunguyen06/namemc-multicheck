import express from 'express';
import next from 'next';
import {
  CACHE_TTL_MS,
  CheckNameResult,
  CheckNamesResponseEvent,
  THROTTLE_DELAY_MS,
  getValidationMessage,
  isValidMinecraftUsername,
  normalizeUsername,
  toCacheKey,
} from './lib/minecraft';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number.parseInt(process.env.PORT || '3000', 10);
const dev = !process.argv.includes('--prod');

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
      await delay(THROTTLE_DELAY_MS);
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
          Accept: 'application/json',
        },
      },
    );

    if (response.ok) {
      const data = (await response.json()) as { id?: string; name?: string };

      if (data.id && data.name) {
        const result: CheckNameResult = {
          name: normalizedName,
          normalizedName,
          status: 'Taken',
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
        status: 'Available',
        message: 'Mojang returned no profile for this username.',
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
        status: 'Error',
        message: 'Mojang rate-limited this request. Try again later.',
        retriable: true,
      };
    }

    return {
      name: normalizedName,
      normalizedName,
      status: 'Error',
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
      status: 'Error',
      message: error instanceof Error ? error.message : 'Unexpected network error.',
      retriable: true,
    };
  } finally {
    inflightLookups.delete(cacheKey);
  }
}

async function streamCheckNames(
  names: string[],
  res: express.Response,
): Promise<void> {
  const cleanedNames = names
    .map((name) => normalizeUsername(String(name)))
    .filter(Boolean);
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

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders?.();

  let processed = 0;
  let taken = 0;
  let available = 0;
  let errors = 0;

  for (const name of uniqueNames) {
    const normalizedName = normalizeUsername(name);
    let result: CheckNameResult;

    if (!isValidMinecraftUsername(normalizedName)) {
      result = {
        name: normalizedName,
        normalizedName,
        status: 'Invalid',
        message: getValidationMessage(normalizedName),
      };
    } else {
      result = await fetchMojangProfile(normalizedName);
    }

    processed += 1;
    if (result.status === 'Taken') taken += 1;
    if (result.status === 'Available') available += 1;
    if (result.status === 'Error') errors += 1;

    const progressEvent: CheckNamesResponseEvent = {
      type: 'progress',
      processed,
      total: uniqueNames.length,
    };
    res.write(`${JSON.stringify(progressEvent)}\n`);

    const resultEvent: CheckNamesResponseEvent = {
      type: 'result',
      result,
    };
    res.write(`${JSON.stringify(resultEvent)}\n`);
  }

  const summaryEvent: CheckNamesResponseEvent = {
    type: 'summary',
    total: uniqueNames.length,
    processed,
    taken,
    available,
    invalid: invalidNames,
    errors,
  };
  res.write(`${JSON.stringify(summaryEvent)}\n`);
  res.write(`${JSON.stringify({ type: 'done' } satisfies CheckNamesResponseEvent)}\n`);
  res.end();
}

async function main() {
  const nextApp = next({ dev });
  const handle = nextApp.getRequestHandler();

  await nextApp.prepare();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '16kb' }));

  app.post('/api/check-names', async (req, res) => {
    try {
      const rawNames = req.body?.names;

      if (!Array.isArray(rawNames)) {
        res.status(400).json({
          error: 'Request body must be a JSON object with a names array.',
        });
        return;
      }

      const cleanedNames = rawNames
        .map((name) => normalizeUsername(String(name)))
        .filter(Boolean);

      await streamCheckNames(cleanedNames, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Unexpected server error.',
        });
        return;
      }

      res.end();
    }
  });

  app.use((req, res) => {
    void handle(req, res);
  });

  app.listen(port, () => {
    console.log(`> Server listening on http://localhost:${port} (${dev ? 'development' : 'production'})`);
  });
}

void main();
