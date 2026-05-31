import {
  CheckNameResult,
  getValidationMessage,
  isValidMinecraftUsername,
  normalizeUsername,
  toCacheKey,
} from "@/lib/minecraft";

export type JobRow = CheckNameResult & {
  rowKey: string;
};

export function buildInitialRows(names: string[]) {
  const cleanedNames = names.map((name) => normalizeUsername(String(name))).filter(Boolean);
  const seen = new Set<string>();
  const rows: JobRow[] = [];
  const validNames: string[] = [];
  let duplicateCount = 0;

  for (const name of cleanedNames) {
    const key = toCacheKey(name);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(key);

    if (!isValidMinecraftUsername(name)) {
      rows.push({
        rowKey: `invalid:${key}`,
        name,
        normalizedName: name,
        status: "Invalid",
        message: getValidationMessage(name),
      });
      continue;
    }

    validNames.push(name);
    rows.push({
      rowKey: `pending:${key}`,
      name,
      normalizedName: name,
      status: "Pending",
      message: "Waiting in queue.",
    });
  }

  return {
    rows,
    validNames,
    duplicateCount,
    totalSubmitted: cleanedNames.length,
    invalidCount: rows.filter((row) => row.status === "Invalid").length,
  };
}

