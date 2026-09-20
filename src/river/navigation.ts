/** The query changes before scrolling; geometry from a different range is never used. */
export function decadeSelection(range: string, year: number) {
  const month = year * 12;
  return range === "all" ||
    (Number(range) <= month && month <= Number(range) + 119)
    ? { range, scroll: true }
    : { range: String(month), scroll: false };
}
