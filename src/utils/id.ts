/** Monotonic-ish id generator that works in both browser and Node. */
let counter = 0;

export function nowMs(): number {
  return Date.now();
}

export function nextSeq(): number {
  counter = (counter + 1) & 0x7fffffff;
  return counter;
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${nextSeq()}`;
}
