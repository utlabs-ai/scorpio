export function integerTicks(max: number): number[] {
  const step = Math.max(1, Math.ceil(max / 4));
  const ticks = [];
  for (let value = 0; value < max; value += step) ticks.push(value);
  ticks.push(max);
  return ticks;
}

export const chartY = (value: number, max: number, bottom: number, height: number) => bottom - value / max * height;
