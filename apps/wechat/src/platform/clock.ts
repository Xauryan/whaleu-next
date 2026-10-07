import type { Clock } from './contracts';

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(callback, milliseconds) {
    const id = setTimeout(callback, milliseconds);
    return () => clearTimeout(id);
  },
};
