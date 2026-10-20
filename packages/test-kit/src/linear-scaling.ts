export type ExpectLinearScalingOptions = {
  run: (size: number) => unknown;
  sizes: readonly number[];
  repeats?: number;
  maxGrowthFactor?: number;
};

const defaultRepeats = 5;
const defaultMaxGrowthFactor = 2.5;
const minimumSampleDurationMs = 5;
const maximumCalibrationCalls = 2 ** 24;

const median = (samples: number[]): number => {
  samples.sort((left, right) => left - right);
  const middle = Math.floor(samples.length / 2);
  const upper = samples.at(middle);
  if (upper === undefined)
    throw new Error("Cannot take the median of no samples");
  if (samples.length % 2 === 1) return upper;
  const lower = samples.at(middle - 1);
  if (lower === undefined)
    throw new Error("Cannot take the median of no samples");
  return (lower + upper) / 2;
};

const validateOptions = (
  sizes: readonly number[],
  repeats: number,
  maxGrowthFactor: number,
) => {
  if (sizes.length < 2)
    throw new TypeError("expectLinearScaling requires at least two sizes");
  if (
    sizes.some(
      (size, index) =>
        !Number.isFinite(size) ||
        size <= 0 ||
        (index > 0 && size <= (sizes.at(index - 1) ?? Number.NaN)),
    )
  )
    throw new TypeError(
      "expectLinearScaling sizes must be finite, positive, and strictly increasing",
    );
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new TypeError(
      "expectLinearScaling repeats must be a positive integer",
    );
  if (!Number.isFinite(maxGrowthFactor) || maxGrowthFactor <= 0)
    throw new TypeError(
      "expectLinearScaling maxGrowthFactor must be finite and positive",
    );
  for (let index = 1; index < sizes.length; index += 1) {
    const previousSize = sizes[index - 1];
    const size = sizes[index];
    if (
      previousSize !== undefined &&
      size !== undefined &&
      size / previousSize <= maxGrowthFactor
    )
      throw new TypeError(
        `expectLinearScaling sizes ${previousSize} and ${size} must have a ratio greater than ${maxGrowthFactor} to distinguish quadratic growth`,
      );
  }
};

type MeasurementClock = {
  minimumSampleDurationMs: number;
  now: () => number;
};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

const measurementModeError = (
  from: "synchronous" | "asynchronous",
  size: number,
) =>
  new TypeError(
    `expectLinearScaling callback switched from ${from} to ${from === "synchronous" ? "asynchronous" : "synchronous"} at size ${size}`,
  );

const measureSynchronousSample = (
  run: (size: number) => unknown,
  size: number,
  clock: MeasurementClock,
) => {
  let calls = 1;
  for (;;) {
    const started = clock.now();
    for (let call = 0; call < calls; call += 1) {
      const result = run(size);
      if (result !== undefined && isThenable(result)) {
        void Promise.resolve(result).catch(() => {});
        throw measurementModeError("synchronous", size);
      }
    }
    const elapsed = clock.now() - started;
    if (elapsed >= clock.minimumSampleDurationMs) return elapsed / calls;
    if (calls >= maximumCalibrationCalls)
      throw new TypeError(
        `expectLinearScaling could not measure size ${size} because the clock did not advance; fake timers may be active`,
      );
    calls *= 2;
  }
};

const measureAsynchronousSample = async (
  run: (size: number) => unknown,
  size: number,
  clock: MeasurementClock,
) => {
  const started = clock.now();
  let calls = 0;
  let elapsed: number;
  do {
    const result = run(size);
    if (!isThenable(result)) throw measurementModeError("asynchronous", size);
    await result;
    calls += 1;
    elapsed = clock.now() - started;
    if (
      elapsed < clock.minimumSampleDurationMs &&
      calls >= maximumCalibrationCalls
    )
      throw new TypeError(
        `expectLinearScaling could not measure size ${size} because the clock did not advance; fake timers may be active`,
      );
  } while (elapsed < clock.minimumSampleDurationMs);
  return elapsed / calls;
};

const expectLinearScalingWithClock = async (
  {
    run,
    sizes,
    repeats = defaultRepeats,
    maxGrowthFactor = defaultMaxGrowthFactor,
  }: ExpectLinearScalingOptions,
  clock: MeasurementClock,
) => {
  validateOptions(sizes, repeats, maxGrowthFactor);
  let previousSize: number | undefined;
  let previousMedian: number | undefined;

  for (const size of sizes) {
    const probe = run(size);
    const asynchronous = isThenable(probe);
    if (asynchronous) await probe;
    const samples: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const sample = asynchronous
        ? await measureAsynchronousSample(run, size, clock)
        : measureSynchronousSample(run, size, clock);
      samples.push(sample);
    }
    const currentMedian = median(samples);
    if (!Number.isFinite(currentMedian) || currentMedian <= 0)
      throw new TypeError(
        `expectLinearScaling measured a non-positive or non-finite duration for size ${size}`,
      );

    if (previousSize !== undefined && previousMedian !== undefined) {
      const allowedGrowth = maxGrowthFactor * (size / previousSize);
      const timeGrowth = currentMedian / previousMedian;
      if (timeGrowth >= allowedGrowth)
        throw new Error(
          `Expected run time from size ${previousSize} (median ${previousMedian.toFixed(3)} ms) to size ${size} (median ${currentMedian.toFixed(3)} ms) to grow by less than ${allowedGrowth.toFixed(2)}x; observed ${timeGrowth.toFixed(2)}x`,
        );
    }

    previousSize = size;
    previousMedian = currentMedian;
  }
};

/**
 * Assert relative run-time growth without imposing a machine-speed budget.
 * Async callbacks include per-call await overhead; batch async work inside `run`
 * when that overhead could obscure the work being measured.
 */
export const expectLinearScaling = (
  options: ExpectLinearScalingOptions,
): Promise<void> =>
  expectLinearScalingWithClock(options, {
    minimumSampleDurationMs,
    now: () => performance.now(),
  });

/** @internal Test seam for deterministic measurement behavior. */
export const linearScalingTestInternals = { expectLinearScalingWithClock };
