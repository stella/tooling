export type ExpectLinearScalingOptions = {
  run: (size: number) => unknown;
  sizes: readonly number[];
  repeats?: number;
  maxGrowthFactor?: number;
};

const defaultRepeats = 5;
const defaultMaxGrowthFactor = 2.5;
const minimumSampleDurationMs = 5;

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
};

type MeasurementClock = {
  minimumSampleDurationMs: number;
  now: () => number;
};

const measureSample = async (
  run: (size: number) => unknown,
  size: number,
  clock: MeasurementClock,
) => {
  const started = clock.now();
  let calls = 0;
  let elapsed: number;
  do {
    await run(size);
    calls += 1;
    elapsed = clock.now() - started;
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
    await run(size);
    const samples: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1)
      samples.push(await measureSample(run, size, clock));
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

/** Assert relative run-time growth without imposing a machine-speed budget. */
export const expectLinearScaling = (
  options: ExpectLinearScalingOptions,
): Promise<void> =>
  expectLinearScalingWithClock(options, {
    minimumSampleDurationMs,
    now: () => performance.now(),
  });

/** @internal Test seam for deterministic measurement behavior. */
export const linearScalingTestInternals = { expectLinearScalingWithClock };
