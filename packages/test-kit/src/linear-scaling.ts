export type ExpectLinearScalingOptions = {
  run: (size: number) => unknown;
  sizes?: readonly number[];
  repeats?: number;
  maxGrowthFactor?: number;
};

const defaultSizes = [1, 4, 16] as const;
const defaultRepeats = 5;
const defaultMaxGrowthFactor = 2.5;

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

/** Assert relative run-time growth without imposing a machine-speed budget. */
export const expectLinearScaling = async ({
  run,
  sizes = defaultSizes,
  repeats = defaultRepeats,
  maxGrowthFactor = defaultMaxGrowthFactor,
}: ExpectLinearScalingOptions): Promise<void> => {
  validateOptions(sizes, repeats, maxGrowthFactor);
  const medians: number[] = [];

  for (const size of sizes) {
    await run(size);
    const samples: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const started = performance.now();
      await run(size);
      samples.push(performance.now() - started);
    }
    medians.push(median(samples));
  }

  for (let index = 1; index < sizes.length; index += 1) {
    const previousSize = sizes.at(index - 1);
    const size = sizes.at(index);
    const previousMedian = medians.at(index - 1);
    const currentMedian = medians.at(index);
    if (
      previousSize === undefined ||
      size === undefined ||
      previousMedian === undefined ||
      currentMedian === undefined
    )
      throw new Error("expectLinearScaling measurement result is incomplete");
    const sizeGrowth = size / previousSize;
    const allowedGrowth = maxGrowthFactor * sizeGrowth;
    let timeGrowth = currentMedian / previousMedian;
    if (previousMedian === 0)
      timeGrowth = currentMedian === 0 ? 1 : Number.POSITIVE_INFINITY;
    if (timeGrowth >= allowedGrowth) {
      throw new Error(
        `Expected run time from size ${previousSize} (median ${previousMedian.toFixed(3)} ms) to size ${size} (median ${currentMedian.toFixed(3)} ms) to grow by less than ${allowedGrowth.toFixed(2)}x; observed ${timeGrowth.toFixed(2)}x`,
      );
    }
  }
};
