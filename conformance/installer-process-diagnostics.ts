import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Event =
  | 'launch'
  | 'spawn-return'
  | 'spawn'
  | 'first-stdout'
  | 'first-stderr'
  | 'deadline'
  | 'forced-termination'
  | 'termination-close'
  | 'spawn-error'
  | 'exit'
  | 'close';
type Entry = {
  event: Event;
  ms: number;
  pid?: number;
  code?: number | null;
  signal?: NodeJS.Signals | null;
};
export class ProcessTimeline {
  private readonly start = performance.now();
  readonly entries: Entry[] = [];
  record(event: Event, pid?: number, code?: number | null, signal?: NodeJS.Signals | null) {
    this.entries.push({
      event,
      ms: Math.round(performance.now() - this.start),
      ...(pid === undefined ? {} : { pid }),
      ...(code === undefined ? {} : { code }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

// An absent witness does not prove script entry never happened: witness I/O can
// itself fail. Observation must not turn an otherwise successful probe into failure.
export type MarkerWitness = 'absent' | 'before-emission' | 'after-emission' | 'unavailable';
export const shellMarker = `try { [IO.File]::WriteAllText($env:SEALBRIDGE_TEST_MARKER, 'before-emission') } catch {}
[Console]::Error.WriteLine('[installer phase] shell started')
try { [IO.File]::WriteAllText($env:SEALBRIDGE_TEST_MARKER, 'after-emission') } catch {}`;

export async function withMarkerWitness<T>(
  run: (marker: string) => Promise<T>,
): Promise<T & { witness: MarkerWitness }> {
  const directory = await mkdtemp(join(tmpdir(), 'sealbridge-marker-'));
  const marker = join(directory, 'witness');
  try {
    const result = await run(marker);
    let witness: MarkerWitness = 'unavailable';
    try {
      const value = await readFile(marker, 'utf8');
      if (value === 'before-emission' || value === 'after-emission') witness = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') witness = 'absent';
    }
    return { ...result, witness };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Deliberately serialize no streams, command/arguments, environment or Error text.
export function processDetails(result: {
  timedOut: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  timeline: ProcessTimeline;
  witness?: MarkerWitness;
}) {
  return JSON.stringify({
    timedOut: result.timedOut,
    exit: result.status,
    signal: result.signal,
    spawnError: result.error !== undefined,
    witness: result.witness,
    timeline: result.timeline.entries,
  });
}
