import { expect, test } from '@playwright/test';

test.use({ timezoneId: 'Asia/Kolkata' });

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('actual saved scan time is the elapsed baseline, independent of the encoded date and clock', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    return createLivePayload('CUSTOMER#2026-09-16 16:09:12#OFFICE', '2026-09-18T11:59:37Z', new Date('2026-09-18T13:20:02Z'));
  });
  expect(result).toEqual({
    text: 'CUSTOMER#2026-09-16 17:29:27#OFFICE', originalTime: '16:09:12', qrTime: '17:29:27', currentTime: '18:50:02',
    nextUpdateMs: 5000, originalTimestamp: '2026-09-16 16:09:12', currentTimestamp: '2026-09-18 18:50:02',
    elapsedMs: 4_825_000, roundedElapsedSeconds: 4815, scannedAtIso: '2026-09-18T11:59:37.000Z', scannedAtLocal: '2026-09-18 17:29:37',
  });
});

test('at the scan instant even a future encoded date and different clock stay exactly unchanged', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    const scannedAt = '2026-09-18T11:59:37.123Z';
    return createLivePayload('#2099-09-16 06:09:12#', scannedAt, new Date(scannedAt));
  });
  expect(result.text).toBe('#2099-09-16 06:09:12#');
  expect(result.elapsedMs).toBe(0);
  expect(result.roundedElapsedSeconds).toBe(0);
  expect(result.nextUpdateMs).toBe(15000);
  expect(result.scannedAtLocal).toBe('2026-09-18 17:29:37.123');
  expect(result.currentTime).toBe('17:29:37');
});

test('accepts the exact single-digit-hour QR and preserves all other fields across the first interval', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    const source = 'F1080239Z2691818531842#2026-09-18 8:58:25# 1 x Assam Tea#570';
    const scannedAt = '2026-09-18T11:59:37.123Z';
    return [0, 14999, 15000].map(delta =>
      createLivePayload(source, scannedAt, new Date(Date.parse(scannedAt) + delta)));
  });
  expect(results.map(value => value.text)).toEqual([
    'F1080239Z2691818531842#2026-09-18 8:58:25# 1 x Assam Tea#570',
    'F1080239Z2691818531842#2026-09-18 8:58:25# 1 x Assam Tea#570',
    'F1080239Z2691818531842#2026-09-18 8:58:40# 1 x Assam Tea#570',
  ]);
  expect(results.map(value => value.originalTime)).toEqual(Array(3).fill('8:58:25'));
  expect(results.map(value => value.originalTimestamp)).toEqual(Array(3).fill('2026-09-18 8:58:25'));
  expect(results.map(value => value.qrTime)).toEqual(['8:58:25', '8:58:25', '8:58:40']);
  expect(results.map(value => value.roundedElapsedSeconds)).toEqual([0, 0, 15]);
});

test('preserves hour padding and the suffix when the generated hour grows or wraps at midnight', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    const scannedAt = '2026-09-18T11:59:37Z';
    const cases = [
      { time: '08:58:25', delta: 15_000 },
      { time: '9:59:55', delta: 15_000 },
      { time: '8:59:55', delta: 54_015_000 },
      { time: '08:59:55', delta: 54_015_000 },
    ];
    return cases.map(({ time, delta }) =>
      createLivePayload(`prefix#2026-09-18 ${time}# 1 x Assam Tea#570`, scannedAt, new Date(Date.parse(scannedAt) + delta)).text);
  });
  expect(results).toEqual([
    'prefix#2026-09-18 08:58:40# 1 x Assam Tea#570',
    'prefix#2026-09-18 10:00:10# 1 x Assam Tea#570',
    'prefix#2026-09-18 0:00:10# 1 x Assam Tea#570',
    'prefix#2026-09-18 00:00:10# 1 x Assam Tea#570',
  ]);
});

test('single-digit support still rejects malformed times and adjacent mixed-width timestamp fields', async ({ page }) => {
  const errors = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    const sources = [
      '#2026-09-18 24:00:00#',
      '#2026-09-18 008:58:25#',
      '#2026-09-18 8:9:25#',
      '#2026-09-18 8:58:5#',
      '#2026-09-18 8:58:25#2026-09-18 08:58:25#',
      '#2026-09-18 08:58:25#2026-09-18 8:58:25#',
    ];
    return sources.map(source => {
      try { createLivePayload(source, '2026-09-18T11:59:37Z', new Date('2026-09-18T11:59:52Z')); return 'unexpected success'; }
      catch (error) { return (error as Error).message; }
    });
  });
  expect(errors[0]).toContain('invalid time');
  for (const message of errors.slice(1, 4)) expect(message).toContain('No timestamp field');
  for (const message of errors.slice(4)) expect(message).toContain('more than one');
});

test('0, 14999, 15000, and 15001 ms use exact intervals from the recorded millisecond', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    const scannedAt = '2026-09-18T11:59:37.123Z';
    return [0, 14999, 15000, 15001].map(delta => createLivePayload('#2040-02-29 16:09:12#', scannedAt, new Date(Date.parse(scannedAt) + delta)));
  });
  expect(results.map(value => value.elapsedMs)).toEqual([0, 14999, 15000, 15001]);
  expect(results.map(value => value.roundedElapsedSeconds)).toEqual([0, 0, 15, 15]);
  expect(results.map(value => value.qrTime)).toEqual(['16:09:12', '16:09:12', '16:09:27', '16:09:27']);
  expect(results.map(value => value.nextUpdateMs)).toEqual([15000, 1, 15000, 14999]);
});

test('the first change occurs at the captured millisecond rather than a wall-clock second', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    return ['2026-09-18T11:59:52.122Z', '2026-09-18T11:59:52.123Z'].map(now =>
      createLivePayload('#2026-01-01 16:09:12#', '2026-09-18T11:59:37.123Z', new Date(now)));
  });
  expect(results.map(value => value.qrTime)).toEqual(['16:09:12', '16:09:27']);
  expect(results.map(value => value.nextUpdateMs)).toEqual([1, 15000]);
});

test('encoded time wraps at midnight without changing its date or the scan baseline', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    return createLivePayload('prefix#2040-02-29 23:59:57#suffix', '2026-09-18T11:59:37Z', new Date('2026-09-18T11:59:52Z'));
  });
  expect(result.text).toBe('prefix#2040-02-29 00:00:12#suffix');
  expect(result.elapsedMs).toBe(15000);
  expect(result.scannedAtIso).toBe('2026-09-18T11:59:37.000Z');
});

test('multiple days count in raw elapsed duration and preserve every source date character', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    return createLivePayload('prefix#2023-09-16 16:09:12#suffix', '2026-09-18T11:59:37Z', new Date('2026-09-20T12:00:08.123Z'));
  });
  expect(result.elapsedMs).toBe(172_831_123);
  expect(result.roundedElapsedSeconds).toBe(172_830);
  expect(result.nextUpdateMs).toBe(13877);
  expect(result.text).toBe('prefix#2023-09-16 16:09:42#suffix');
});

test('only the timestamp time changes; Unicode, CRLF, whitespace, and other clock text survive', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    const source = '  नमस्ते 🌍\r\nother=16:09:12#2040-02-29 16:09:12#日本語\t café e\u0301 #  \r\n';
    return { source, payload: createLivePayload(source, '2026-09-18T11:59:37Z', new Date('2026-09-18T11:59:52Z')) };
  });
  expect(result.payload.text).toBe(result.source.replace('#2040-02-29 16:09:12#', '#2040-02-29 16:09:27#'));
});

test('timestamp fields work at either string boundary or as the entire source', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    return ['2040-02-29 16:09:12#suffix', 'prefix#2040-02-29 16:09:12', '2040-02-29 16:09:12', '#2040-02-29 16:09:12#']
      .map(source => createLivePayload(source, '2026-09-18T11:59:37Z', new Date('2026-09-18T11:59:52Z')).text);
  });
  expect(results).toEqual(['2040-02-29 16:09:27#suffix', 'prefix#2040-02-29 16:09:27', '2040-02-29 16:09:27', '#2040-02-29 16:09:27#']);
});

test('encoded timestamp syntax, calendar date, and time ranges remain validated', async ({ page }) => {
  const errors = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    const sources = ['missing', 'embedded 2040-02-29 16:09:12 text', '#2040-02-29 16:09:12#2040-02-29 16:09:27#', '#2040-02-29T16:09:12#', '#2026-02-29 16:09:12#', '#1900-02-29 16:09:12#', '#2026-04-31 16:09:12#', '#2026-13-01 16:09:12#', '#2026-01-00 16:09:12#', '#0000-01-01 16:09:12#', '#2040-02-29 24:00:00#', '#2040-02-29 12:60:00#', '#2040-02-29 12:00:60#'];
    return sources.map(source => {
      try { createLivePayload(source, '2026-09-18T11:59:37Z', new Date('2026-09-18T11:59:52Z')); return 'unexpected success'; }
      catch (error) { return (error as Error).message; }
    });
  });
  expect(errors[0]).toContain('No timestamp field');
  expect(errors[1]).toContain('No timestamp field');
  expect(errors[2]).toContain('more than one');
  expect(errors[3]).toContain('No timestamp field');
  for (const message of errors.slice(4, 10)) expect(message).toContain('invalid date');
  for (const message of errors.slice(10)) expect(message).toContain('invalid time');
});

test('valid encoded leap dates require no relationship to the actual scan date', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    return ['#2000-02-29 16:09:12#', '#2040-02-29 16:09:12#'].map(source =>
      createLivePayload(source, '2026-09-18T11:59:37Z', new Date('2026-09-18T11:59:52Z')).text);
  });
  expect(results).toEqual(['#2000-02-29 16:09:27#', '#2040-02-29 16:09:27#']);
});

test('missing scan time requires a new scan and cannot fall back to the QR timestamp', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { createLivePayload, MissingScanTimeError } = await import('/src/live-time.ts');
    return [null, ''].map(scannedAt => {
      try { createLivePayload('#2020-01-01 00:00:00#', scannedAt, new Date('2026-09-18T11:59:52Z')); return { unexpected: true }; }
      catch (error) { return { typed: error instanceof MissingScanTimeError, message: (error as Error).message }; }
    });
  });
  for (const result of results) { expect(result.typed).toBe(true); expect(result.message).toContain('Scan or upload'); }
});

test('saved scan time rejects malformed, naive, normalized invalid, and bad-offset ISO strings', async ({ page }) => {
  const errors = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    const scans = ['not a date', '2026-09-18T11:59:37', '2026-09-18 11:59:37Z', '2026-02-30T11:59:37Z', '1900-02-29T11:59:37Z', '2026-13-01T11:59:37Z', '2026-01-00T11:59:37Z', '2026-09-18T24:00:00Z', '2026-09-18T11:60:00Z', '2026-09-18T11:59:60Z', '2026-09-18T11:59:37+24:00', '2026-09-18T11:59:37+05:60', '2026-09-18T11:59:37.1234567Z'];
    return scans.map(scannedAt => {
      try { createLivePayload('#2040-02-29 16:09:12#', scannedAt, new Date('2026-09-18T11:59:52Z')); return 'unexpected success'; }
      catch (error) { return (error as Error).message; }
    });
  });
  for (const message of errors) expect(message).toContain('saved scan time is invalid');
});

test('Z and positive or negative offsets plus PostgreSQL fractions represent the same instant', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    return ['2026-09-18T11:59:37.123Z', '2026-09-18T17:29:37.123+05:30', '2026-09-18T07:59:37.123-04:00', '2026-09-18T11:59:37.123000+00:00'].map(scannedAt =>
      createLivePayload('#2040-02-29 16:09:12#', scannedAt, new Date('2026-09-18T11:59:52.123Z')));
  });
  for (const result of results) expect(result).toEqual(results[0]);
  expect(results[0].scannedAtIso).toBe('2026-09-18T11:59:37.123Z');
  expect(results[0].scannedAtLocal).toBe('2026-09-18 17:29:37.123');
  expect(results[0].qrTime).toBe('16:09:27');
});

test('a current device clock behind the scan returns typed negative metadata and recovers at zero', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createLivePayload, FutureScanTimeError } = await import('/src/live-time.ts');
    const scannedAt = '2026-09-18T11:59:37.123Z';
    let failure;
    try { createLivePayload('#2099-09-16 16:09:12#', scannedAt, new Date('2026-09-18T11:59:37.122Z')); }
    catch (error) {
      const typed = error as InstanceType<typeof FutureScanTimeError>;
      failure = { typed: error instanceof FutureScanTimeError, name: typed.name, message: typed.message, scannedAtIso: typed.scannedAtIso, scannedAtLocal: typed.scannedAtLocal, elapsedMs: typed.elapsedMs, originalTimestamp: typed.originalTimestamp };
    }
    return { failure, recovered: createLivePayload('#2099-09-16 16:09:12#', scannedAt, new Date(scannedAt)) };
  });
  expect(result.failure).toMatchObject({ typed: true, name: 'FutureScanTimeError', scannedAtIso: '2026-09-18T11:59:37.123Z', scannedAtLocal: '2026-09-18 17:29:37.123', elapsedMs: -1, originalTimestamp: '2099-09-16 16:09:12' });
  expect(result.failure?.message).toContain('ahead');
  expect(result.recovered.elapsedMs).toBe(0);
  expect(result.recovered.text).toBe('#2099-09-16 16:09:12#');
});

test('backward or forward clocks recompute from the same persisted scan instead of incrementing output', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    const scannedAt = '2026-09-18T11:59:37Z';
    return [3600000, 30000, 60000, 30000].map(delta => createLivePayload('#2040-02-29 16:09:12#', scannedAt, new Date(Date.parse(scannedAt) + delta)));
  });
  expect(results.map(value => value.qrTime)).toEqual(['17:09:12', '16:09:42', '16:10:12', '16:09:42']);
  expect(results.map(value => value.elapsedMs)).toEqual([3600000, 30000, 60000, 30000]);
});

test('an invalid device clock is rejected with a readable error', async ({ page }) => {
  const message = await page.evaluate(async () => {
    const { createLivePayload } = await import('/src/live-time.ts');
    try { createLivePayload('#2040-02-29 16:09:12#', '2026-09-18T11:59:37Z', new Date(Number.NaN)); return 'unexpected success'; }
    catch (error) { return (error as Error).message; }
  });
  expect(message).toContain('device clock');
});

test('different device timezones produce identical QR text and elapsed duration for the same saved instant', async ({ browser, baseURL }) => {
  const results = [];
  for (const timezoneId of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
    const context = await browser.newContext({ timezoneId });
    try {
      const page = await context.newPage(); await page.goto(baseURL!);
      results.push(await page.evaluate(async () => {
        const { createLivePayload } = await import('/src/live-time.ts');
        return createLivePayload('#2040-02-29 16:09:12#', '2026-09-18T11:59:37.123Z', new Date('2026-09-18T12:00:07.123Z'));
      }));
    } finally { await context.close(); }
  }
  expect(results.map(value => value.text)).toEqual(Array(3).fill('#2040-02-29 16:09:42#'));
  expect(results.map(value => value.elapsedMs)).toEqual([30000, 30000, 30000]);
  expect(results.map(value => value.scannedAtLocal)).toEqual(['2026-09-18 11:59:37.123', '2026-09-18 17:29:37.123', '2026-09-18 07:59:37.123']);
});

test('an encoded time inside a local DST gap is plain text and remains allowed', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ timezoneId: 'America/New_York' });
  try {
    const page = await context.newPage(); await page.goto(baseURL!);
    const result = await page.evaluate(async () => {
      const { createLivePayload } = await import('/src/live-time.ts');
      return createLivePayload('#2026-03-08 02:30:00#', '2026-09-18T11:59:37Z', new Date('2026-09-18T11:59:52Z'));
    });
    expect(result.text).toBe('#2026-03-08 02:30:15#');
    expect(result.elapsedMs).toBe(15000);
  } finally { await context.close(); }
});

test('saved epoch duration stays correct while the current device crosses a DST clock jump', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ timezoneId: 'America/New_York' });
  try {
    const page = await context.newPage(); await page.goto(baseURL!);
    const result = await page.evaluate(async () => {
      const { createLivePayload } = await import('/src/live-time.ts');
      return createLivePayload('#2040-02-29 16:09:12#', '2026-03-08T06:59:57Z', new Date('2026-03-08T07:00:12Z'));
    });
    expect(result.elapsedMs).toBe(15000);
    expect(result.text).toBe('#2040-02-29 16:09:27#');
    expect(result.scannedAtLocal).toBe('2026-03-08 01:59:57');
    expect(result.currentTimestamp).toBe('2026-03-08 03:00:12');
  } finally { await context.close(); }
});
