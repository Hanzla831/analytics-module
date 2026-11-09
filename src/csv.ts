import type { ReportResult } from './types.js';

/**
 * CSV export.
 *
 * Two escaping concerns, and they are different problems:
 *
 *  1. RFC 4180 quoting, so a value containing a comma, quote or newline does
 *     not shift every later column.
 *  2. Formula injection. A cell beginning `=`, `+`, `-` or `@` is executed by
 *     Excel and Sheets when the file is opened — `=HYPERLINK(...)` or a DDE
 *     payload turns an innocuous export into remote code execution on the
 *     analyst's machine. The fix is to prefix the value with a single quote.
 */
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = value instanceof Date ? value.toISOString() : String(value);

  if (text.length > 0 && FORMULA_PREFIXES.has(text[0]!)) {
    text = `'${text}`;
  }

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsvRow(cells: readonly unknown[]): string {
  return cells.map(escapeCsvCell).join(',');
}

/** Renders a report as CSV, including grouped series when present. */
export function reportToCsv(report: ReportResult): string {
  const lines: string[] = [];

  if (report.groups) {
    lines.push(toCsvRow(['bucket', 'start', 'end', 'group', 'value', 'samples']));
    for (const group of report.groups) {
      for (const bucket of group.buckets) {
        lines.push(
          toCsvRow([bucket.label, bucket.start, bucket.end, group.key, bucket.value, bucket.sampleCount]),
        );
      }
    }
  } else {
    lines.push(toCsvRow(['bucket', 'start', 'end', 'value', 'samples']));
    for (const bucket of report.buckets) {
      lines.push(toCsvRow([bucket.label, bucket.start, bucket.end, bucket.value, bucket.sampleCount]));
    }
  }

  // CRLF per RFC 4180; Excel on Windows mis-renders bare LF in some locales.
  return lines.join('\r\n');
}

/** Quotes the filename so a metric containing a comma cannot break the header. */
export function contentDisposition(metric: string, from: Date, to: Date): string {
  const stamp = (date: Date): string => date.toISOString().slice(0, 10);
  const safe = metric.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `attachment; filename="${safe}_${stamp(from)}_${stamp(to)}.csv"`;
}
