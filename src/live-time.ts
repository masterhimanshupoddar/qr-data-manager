const SLOT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LivePayload {
  text: string;
  originalTime: string;
  qrTime: string;
  currentTime: string;
  nextUpdateMs: number;
  originalTimestamp: string;
  currentTimestamp: string;
  elapsedMs: number;
  roundedElapsedSeconds: number;
  scannedAtIso: string;
  scannedAtLocal: string;
}

/** Old records cannot reconstruct the device time at which decoding succeeded. */
export class MissingScanTimeError extends Error {
  constructor() {
    super(
      "This saved QR has no recorded scan time. Scan or upload the QR again to start its 15-second clock.",
    );
    this.name = "MissingScanTimeError";
  }
}

/** A recoverable clock mismatch; retry when the current device catches up. */
export class FutureScanTimeError extends Error {
  constructor(
    public readonly scannedAtIso: string,
    public readonly scannedAtLocal: string,
    public readonly elapsedMs: number,
    public readonly originalTimestamp?: string,
  ) {
    super(
      "The saved scan time is ahead of this device’s clock. Check the device clock, or wait until it catches up.",
    );
    this.name = "FutureScanTimeError";
  }
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
  );
}

function localTimestamp(date: Date, includeMilliseconds = false): string {
  const day = [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  const time = formatTime(
    date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds(),
  );
  const fraction =
    includeMilliseconds && date.getMilliseconds() !== 0
      ? `.${String(date.getMilliseconds()).padStart(3, "0")}`
      : "";
  return `${day} ${time}${fraction}`;
}

function parseScanTime(scannedAt: string | null): Date {
  if (!scannedAt) throw new MissingScanTimeError();
  // Accept device toISOString() and PostgreSQL timestamptz JSON, with an
  // explicit offset only. Validate before Date.parse can normalize bad dates.
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      scannedAt,
    );
  const invalid = () =>
    new Error(
      "The saved scan time is invalid or has no timezone. Scan or upload the QR again to record a valid scan time.",
    );
  if (!match) throw invalid();
  const [, year, month, day, hour, minute, second, , zone] = match;
  if (
    !validCalendarDate(Number(year), Number(month), Number(day)) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== "Z" &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  )
    throw invalid();
  const epoch = Date.parse(scannedAt);
  if (!Number.isFinite(epoch)) throw invalid();
  // Browser clocks have millisecond precision. PostgreSQL may serialize the
  // same device value using six fractional digits; Date retains its milliseconds.
  return new Date(epoch);
}

function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [hours, minutes, seconds % 60]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

/**
 * Replace only HH:mm:ss in one # separated timestamp field. A field may also
 * touch the start or end of the source. Never rewrite or normalize other text.
 *
 * The saved system time captured when decoding succeeded is the elapsed
 * baseline. The QR's encoded date/time is plain text and an initial clock
 * value, not an epoch: future QR dates and local DST gaps are allowed.
 * Every call adds completed 15-second intervals since the persisted scan
 * instant to that initial clock. Reloads and other devices use the same instant.
 *
 * The encoded date deliberately stays unchanged after midnight and on later
 * days. For example, 15 seconds after 23:59:57 produces 00:00:12 on the unchanged
 * source date. Epoch arithmetic counts actual elapsed intervals across DST.
 */
export function createLivePayload(
  source: string,
  scannedAt: string | null,
  now: Date = new Date(),
): LivePayload {
  const scanTime = parseScanTime(scannedAt);
  // The trailing delimiter is a lookahead so adjacent timestamp fields are
  // counted separately rather than sharing a consumed delimiter.
  const fields = [
    ...source.matchAll(/(^|#)(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?=#|$)/g),
  ];
  if (fields.length === 0) {
    throw new Error(
      "No timestamp field was found. Scan a QR containing one YYYY-MM-DD HH:mm:ss field separated by # characters.",
    );
  }
  if (fields.length !== 1) {
    throw new Error(
      "This QR contains more than one timestamp field. Use a QR with exactly one YYYY-MM-DD HH:mm:ss field.",
    );
  }

  const field = fields[0];
  const timestamp = field[2];
  const year = Number(timestamp.slice(0, 4));
  const month = Number(timestamp.slice(5, 7));
  const day = Number(timestamp.slice(8, 10));
  const originalTime = timestamp.slice(11);
  const [hours, minutes, seconds] = originalTime.split(":").map(Number);
  if (!validCalendarDate(year, month, day)) {
    throw new Error(
      "The timestamp contains an invalid date. Use a valid calendar date in YYYY-MM-DD format.",
    );
  }
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error(
      "The timestamp contains an invalid time. Hours must be 00–23, and minutes and seconds must be 00–59.",
    );
  }
  if (!Number.isFinite(now.getTime())) {
    throw new Error(
      "Your device clock could not be read. Check the device date and time, then try again.",
    );
  }

  const scannedAtIso = scanTime.toISOString();
  const scannedAtLocal = localTimestamp(scanTime, true);
  const elapsedMs = now.getTime() - scanTime.getTime();
  if (elapsedMs < 0)
    throw new FutureScanTimeError(
      scannedAtIso,
      scannedAtLocal,
      elapsedMs,
      timestamp,
    );
  const roundedElapsedSeconds = Math.floor(elapsedMs / SLOT_MS) * 15;
  const originalSeconds = hours * 3600 + minutes * 60 + seconds;
  const daySeconds = DAY_MS / 1000;
  const qrTime = formatTime(
    (originalSeconds + (roundedElapsedSeconds % daySeconds)) % daySeconds,
  );
  const currentSeconds =
    now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const currentTime = formatTime(currentSeconds);
  const timeStart = field.index! + field[1].length + 11;

  return {
    text: source.slice(0, timeStart) + qrTime + source.slice(timeStart + 8),
    originalTime,
    qrTime,
    currentTime,
    // At the exact boundary, include that slot and schedule the next in 15s.
    nextUpdateMs: SLOT_MS - (elapsedMs % SLOT_MS),
    originalTimestamp: timestamp,
    currentTimestamp: localTimestamp(now),
    elapsedMs,
    roundedElapsedSeconds,
    scannedAtIso,
    scannedAtLocal,
  };
}
