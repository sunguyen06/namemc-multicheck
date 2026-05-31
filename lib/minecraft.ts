export const MAX_BATCH_SIZE = 20;
export const CACHE_TTL_MS = 10 * 60 * 1000;
export const THROTTLE_DELAY_MS = 750;

export type NameStatus = 'Taken' | 'Available' | 'Invalid' | 'Error' | 'Pending';

export type CheckNameResult = {
  name: string;
  normalizedName: string;
  status: NameStatus;
  uuid?: string;
  message?: string;
  retriable?: boolean;
};

export type CheckNamesResponseEvent =
  | {
      type: 'progress';
      processed: number;
      total: number;
    }
  | {
      type: 'result';
      result: CheckNameResult;
    }
  | {
      type: 'summary';
      total: number;
      processed: number;
      taken: number;
      available: number;
      invalid: number;
      errors: number;
    }
  | {
      type: 'done';
    };

export function normalizeUsername(name: string) {
  return name.trim();
}

export function isValidMinecraftUsername(name: string) {
  return /^[A-Za-z0-9_]{3,16}$/.test(name);
}

export function getValidationMessage(name: string) {
  if (name.length < 3 || name.length > 16) {
    return 'Minecraft Java usernames must be 3-16 characters.';
  }

  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return 'Only letters, numbers, and underscores are allowed.';
  }

  return '';
}

export function toCacheKey(name: string) {
  return normalizeUsername(name).toLowerCase();
}

export function getStatusTone(status: NameStatus) {
  switch (status) {
    case 'Taken':
      return 'taken';
    case 'Available':
      return 'available';
    case 'Invalid':
      return 'invalid';
    case 'Error':
      return 'error';
    case 'Pending':
      return 'pending';
    default:
      return 'pending';
  }
}
