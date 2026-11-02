// null means ignore the Range header and send the full representation.
// Only one byte range is supported; malformed and multi-range fields fall back to 200.
export function parseByteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  const length = BigInt(size);
  let start, end;
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n || length === 0n) return { unsatisfiable: true };
    start = suffix >= length ? 0n : length - suffix;
    end = length - 1n;
  } else {
    start = BigInt(match[1]);
    end = match[2] ? BigInt(match[2]) : length - 1n;
    if (match[2] && start > end) return null;
    if (start >= length) return { unsatisfiable: true };
    if (end >= length) end = length - 1n;
  }
  return { start: Number(start), end: Number(end) };
}
