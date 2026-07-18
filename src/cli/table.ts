// Minimal equivalent of Go's text/tabwriter (minwidth 0, padding 2):
// pads each column to the widest cell plus two spaces.
export function renderTable(rows: string[][], indent = '  '): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map(
      (row) =>
        indent +
        row
          .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + 2)))
          .join('')
          .trimEnd(),
    )
    .join('\n');
}
