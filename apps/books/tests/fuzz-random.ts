/**
 * Seeded PRNG + input generators shared by the money-core fuzz suites.
 *
 * Every case seeds its own mulberry32 stream from (suite seed ^ salt) + case
 * index, so any failing case is reproducible from the seed and the case
 * index alone — no replay harness needed. Deterministic across runs and
 * machines: no Date.now(), no Math.random(), no ambient state.
 */

/** Deterministic 32-bit PRNG (mulberry32). Same seed -> same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** An amount expressed in integer cents — the unit every money assertion uses. */
export function cents(x: number): number {
  return Math.round(x * 100)
}

export interface Fuzz {
  float(): number
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  /** True with probability p. */
  chance(p: number): boolean
  /** A 2-decimal amount with cent granularity in [min, max]. */
  money(min: number, max: number): number
  /** A 2-decimal amount shifted onto a half-cent rounding boundary (±0.005). */
  nudged(amount: number): number
  /** Weighted pick over [value, weight] entries. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T
  /** An exchange rate from the adversarial pool plus random 2-decimal ones. */
  fxRate(): number
  /** A YYYY-MM-DD in 2026. */
  isoDate(): string
}

export function makeFuzz(seed: number): Fuzz {
  const float = mulberry32(seed)
  const int = (min: number, max: number): number => min + Math.floor(float() * (max - min + 1))
  const pick = <T,>(items: readonly T[]): T => items[int(0, items.length - 1)] as T
  const money = (min: number, max: number): number => int(Math.round(min * 100), Math.round(max * 100)) / 100
  return {
    float,
    int,
    pick,
    chance: (p: number) => float() < p,
    money,
    nudged: (amount: number) => amount + (float() < 0.5 ? 0.005 : -0.005),
    weighted: <T,>(entries: readonly (readonly [T, number])[]): T => {
      const total = entries.reduce((s, [, w]) => s + w, 0)
      let roll = float() * total
      for (const [value, weight] of entries) {
        roll -= weight
        if (roll < 0) return value
      }
      return entries[entries.length - 1][0]
    },
    fxRate: () => {
      const roll = float()
      if (roll < 0.55) return int(1, 30) / 100 + 0 // 0.01 .. 0.30 style small rates
      if (roll < 0.8) return int(50, 400) / 100 // 0.50 .. 4.00
      if (roll < 0.92) return 18.25 // mission-mandated odd rate
      if (roll < 0.96) return 0.62
      if (roll < 0.98) return 1.37
      return 20
    },
    isoDate: () => `2026-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
  }
}
