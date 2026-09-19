import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';

type SharedRow = { qr_data: string | null; updated_at: string | null; scanned_at: string | null };
type Capture = { qr_data: string; scanned_at: string };
const NOW = '2026-09-18T17:29:37+05:30';
const NOW_ISO = '2026-09-18T11:59:37.000Z';
const source = (label: string) => `${label} #2026-09-18 16:09:12#`;
const atQrTime = (text: string, time: string) => text.replace('16:09:12', time);

/** One server-side row; separate browser contexts share the same captured instant. */
function cloudMock(initial: string | null = null, scannedAt: string | null = NOW_ISO) {
  let row: SharedRow = {
    qr_data: initial,
    // Intentionally differs from scanned_at: a database save is not the scan baseline.
    updated_at: initial === null ? null : '2026-09-18T10:00:00.000Z',
    scanned_at: initial === null ? null : scannedAt,
  };
  let writes = 0;
  const mock = {
    denyRead: false,
    denySave: false,
    omitScannedAt: false,
    saveGate: null as Promise<void> | null,
    attempts: [] as Capture[],
    get row() { return row; },
    get writes() { return writes; },
    async attach(context: BrowserContext) {
      await context.route('https://qr-test.supabase.co/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname !== '/rest/v1/qr_state') { await route.abort(); return; }
        const headers = {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET, PATCH, OPTIONS',
          'content-type': 'application/json',
        };
        if (request.method() === 'OPTIONS') {
          await route.fulfill({ status: 204, headers, body: '' });
          return;
        }
        expect(url.searchParams.get('id')).toBe('eq.1');
        expect(url.searchParams.get('select')).toBe('*');
        expect(request.headers().apikey).toBe('sb_publishable_test_browser_key');
        expect(request.headers().authorization).toBeUndefined();
        const isSave = request.method() === 'PATCH';
        let capture: Capture | null = null;
        if (isSave) {
          capture = request.postDataJSON() as Capture;
          expect(Object.keys(capture).sort()).toEqual(['qr_data', 'scanned_at']);
          expect(typeof capture.qr_data).toBe('string');
          expect(typeof capture.scanned_at).toBe('string');
          expect(Number.isFinite(Date.parse(capture.scanned_at))).toBe(true);
          mock.attempts.push({ ...capture });
        } else { expect(request.method()).toBe('GET'); }
        if (isSave ? mock.denySave : mock.denyRead) {
          await route.fulfill({ status: 403, headers, body: JSON.stringify({ message: 'Denied by test policy' }) });
          return;
        }
        if (capture) {
          if (mock.saveGate) await mock.saveGate;
          writes += 1;
          row = { ...capture, updated_at: new Date(Date.UTC(2026, 8, 18, 10, writes)).toISOString() };
        }
        const responseRow: Partial<SharedRow> = { ...row };
        if (mock.omitScannedAt) delete responseRow.scanned_at;
        await route.fulfill({ status: 200, headers, body: JSON.stringify([responseRow]) });
      });
    },
  };
  return mock;
}

async function uploadQr(page: Page, text: string) {
  await page.locator('#qr-file').setInputFiles({
    name: 'source-qr.png', mimeType: 'image/png',
    buffer: await QRCode.toBuffer(text, { width: 768, margin: 4, errorCorrectionLevel: 'M' }),
  });
}
async function expectExactText(page: Page, selector: string, text: string) {
  await expect.poll(() => page.locator(selector).textContent()).toBe(text);
}
async function decodeGeneratedQr(page: Page) {
  return page.evaluate(async () => {
    const src = (document.querySelector('#generated-qr') as HTMLImageElement).src;
    const blob = await (await fetch(src)).blob();
    const modulePath = '/src/qr.ts';
    const { decodeImage } = await import(modulePath);
    return decodeImage(new File([blob], 'generated.png', { type: 'image/png' })) as Promise<string>;
  });
}
async function freezeClock(page: Page, at = NOW) {
  await page.clock.install({ time: new Date(new Date(at).getTime() - 60_000) });
  await page.clock.pauseAt(new Date(at));
}

test.beforeEach(async ({ page }) => { await freezeClock(page); });

test('uses actual system scan time rather than the QR timestamp or database save time', async ({ page, context }) => {
  const original = 'future encoded date #2027-04-11 16:09:12# fixed fields';
  const cloud = cloudMock(original, '2026-09-18T11:30:00.000Z');
  await cloud.attach(context);
  await page.clock.setSystemTime(new Date('2026-09-18T17:01:07+05:30'));
  await page.goto('/');
  const updated = atQrTime(original, '16:10:12');
  await expectExactText(page, '#combined-data', updated);
  expect(await decodeGeneratedQr(page)).toBe(updated);
  await expect(page.locator('#baseline-timestamp')).toContainText('2026-09-18 17:00:00');
  await expect(page.locator('#original-timestamp')).toContainText('2027-04-11 16:09:12');
  await expect(page.locator('#current-timestamp')).toContainText('2026-09-18 17:01:07');
  await expect(page.locator('#baseline-interpretation')).toContainText('2026-09-18T11:30:00.000Z');
  await expect(page.locator('#elapsed-duration')).toContainText('00:01:07');
  await expect(page.locator('#rounded-duration')).toContainText('00:01:00');
  await expectExactText(page, '#source-data', original);
  expect(cloud.writes).toBe(0);
});

test('uploads exact original text and captures the system instant, then downloads and copies the live QR', async ({ page, context }) => {
  const cloud = cloudMock();
  await cloud.attach(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page.locator('#source-empty')).toBeVisible();
  await expect(page.locator('#generate-btn')).toBeDisabled();
  const original = '  東京 <img src=x onerror="window.__qrXss=true"> other=16:09:12 #2025-04-11 16:09:12#\n  unchanged suffix  ';
  await uploadQr(page, original);
  await expect.poll(() => cloud.row.scanned_at).toBe(NOW_ISO);
  await expectExactText(page, '#source-data', original);
  expect(await page.locator('#source-data img').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__qrXss)).toBeUndefined();
  await expectExactText(page, '#combined-data', original);
  await page.clock.runFor(15_000);
  const updated = original.replace('#2025-04-11 16:09:12#', '#2025-04-11 16:09:27#');
  await expectExactText(page, '#combined-data', updated);
  expect(await decodeGeneratedQr(page)).toBe(updated);
  await expect(page.locator('#baseline-timestamp')).toContainText('2026-09-18 17:29:37');
  await expect(page.locator('#clock-timezone')).toContainText(/Asia\/(?:Kolkata|Calcutta)/);
  await expect(page.locator('#settings-panel')).toHaveCount(0);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#download-btn').click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.png$/i);
  expect((await readFile((await download.path())!)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  await page.locator('#copy-btn').click();
  // Windows clipboard normalizes LF to CRLF; saved and QR-encoded text above stays exact.
  await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(updated);
  await page.reload();
  await expectExactText(page, '#source-data', original);
  await expectExactText(page, '#combined-data', updated);
  expect(cloud.row.qr_data).toBe(original);
  expect(cloud.row.scanned_at).toBe(NOW_ISO);
  expect(cloud.writes).toBe(1);
});

test('captures milliseconds before a delayed cloud response and never resets the baseline on save completion', async ({ page, context }) => {
  const cloud = cloudMock();
  let releaseSave!: () => void;
  cloud.saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await cloud.attach(context);
  await page.clock.setSystemTime(new Date('2026-09-18T17:29:37.250+05:30'));
  await page.goto('/');
  const original = source('delayed save');
  await uploadQr(page, original);
  await expect.poll(() => cloud.attempts.length).toBe(1);
  expect(cloud.attempts[0]).toEqual({ qr_data: original, scanned_at: '2026-09-18T11:59:37.250Z' });
  await page.clock.runFor(8_000); // Stay within the cloud request's 12-second timeout.
  expect(cloud.row.qr_data).toBeNull();
  await expect(page.locator('#generated-qr')).toBeHidden();
  releaseSave();
  await expectExactText(page, '#combined-data', original);
  await page.clock.runFor(12_000);
  await expectExactText(page, '#combined-data', atQrTime(original, '16:09:27'));
  expect(cloud.row.scanned_at).toBe('2026-09-18T11:59:37.250Z');
  expect(cloud.writes).toBe(1);
});

test('refreshes exactly 15 seconds after a fractional system capture instant', async ({ page, context }) => {
  const original = source('millisecond boundary');
  const cloud = cloudMock(original, '2026-09-18T11:59:37.250Z');
  await cloud.attach(context);
  await page.clock.setSystemTime(new Date('2026-09-18T17:29:37.250+05:30'));
  await page.goto('/');
  await expectExactText(page, '#combined-data', original);
  const firstImage = await page.locator('#generated-qr').getAttribute('src');
  await page.clock.runFor(14_999);
  await expectExactText(page, '#combined-data', original);
  expect(await page.locator('#generated-qr').getAttribute('src')).toBe(firstImage);
  await page.clock.runFor(1);
  await expectExactText(page, '#combined-data', atQrTime(original, '16:09:27'));
  expect(await decodeGeneratedQr(page)).toBe(atQrTime(original, '16:09:27'));
  await page.clock.runFor(15_000);
  await expectExactText(page, '#combined-data', atQrTime(original, '16:09:42'));
  expect(cloud.row.qr_data).toBe(original);
  expect(cloud.writes).toBe(0);
});

test('a delayed background timer recomputes elapsed time from the saved system capture', async ({ page, context }) => {
  const original = source('resume after suspension');
  const cloud = cloudMock(original);
  await cloud.attach(context);
  await page.goto('/');
  await expectExactText(page, '#combined-data', original);
  await page.clock.fastForward(5 * 60_000 + 12_000);
  await expectExactText(page, '#combined-data', atQrTime(original, '16:14:12'));
  await expect(page.locator('#elapsed-duration')).toContainText('00:05:12');
  await expect(page.locator('#rounded-duration')).toContainText('00:05:00');
  expect(cloud.row.scanned_at).toBe(NOW_ISO);
  expect(cloud.writes).toBe(0);
});

test('scanning the same QR again captures a new system time and restarts its elapsed counter', async ({ page, context }) => {
  const original = source('same QR rescanned');
  const cloud = cloudMock();
  await cloud.attach(context);
  await page.goto('/');
  await uploadQr(page, original);
  await expect.poll(() => cloud.writes).toBe(1);
  await page.clock.runFor(20_000);
  await expectExactText(page, '#combined-data', atQrTime(original, '16:09:27'));
  await uploadQr(page, original);
  await expect.poll(() => cloud.writes).toBe(2);
  await expectExactText(page, '#combined-data', original);
  expect(cloud.row.scanned_at).toBe('2026-09-18T11:59:57.000Z');
  await expect(page.locator('#baseline-timestamp')).toContainText('2026-09-18 17:29:57');
  await page.clock.runFor(15_000);
  await expectExactText(page, '#combined-data', atQrTime(original, '16:09:27'));
  expect(cloud.writes).toBe(2);
});

test('another browser and timezone uses the retained capture instant after reload', async ({ browser, page, context }) => {
  const original = source('shared capture instant');
  const cloud = cloudMock();
  await cloud.attach(context);
  await page.goto('/');
  await uploadQr(page, original);
  await expect.poll(() => cloud.row.scanned_at).toBe(NOW_ISO);
  const secondContext = await browser.newContext({ timezoneId: 'UTC' });
  try {
    await cloud.attach(secondContext);
    const secondPage = await secondContext.newPage();
    await freezeClock(secondPage, '2026-09-18T12:00:44.000Z');
    await secondPage.goto('http://127.0.0.1:4173/');
    const updated = atQrTime(original, '16:10:12');
    await expectExactText(secondPage, '#combined-data', updated);
    await expect(secondPage.locator('#baseline-interpretation')).toContainText(NOW_ISO);
    await expect(secondPage.locator('#baseline-timestamp')).toContainText('2026-09-18 11:59:37');
    await expect(secondPage.locator('#elapsed-duration')).toContainText('00:01:07');
    await secondPage.reload();
    await expectExactText(secondPage, '#combined-data', updated);
    await page.clock.setSystemTime(new Date('2026-09-18T12:00:44.000Z'));
    await page.locator('#generate-btn').click();
    await expectExactText(page, '#combined-data', updated);
    expect(cloud.writes).toBe(1);
    expect(cloud.row.scanned_at).toBe(NOW_ISO);
  } finally { await secondContext.close(); }
});

for (const missingColumn of [false, true]) {
  test(`legacy record with ${missingColumn ? 'missing' : 'null'} scan time requires a new scan instead of guessing a baseline`, async ({ page, context }) => {
    const original = source('legacy saved value');
    const cloud = cloudMock(original, null);
    cloud.omitScannedAt = missingColumn;
    await cloud.attach(context);
    await page.goto('/');
    await expectExactText(page, '#source-data', original);
    await expect(page.locator('#output-message')).toContainText(/scan time|scan again|rescan|re-scan/i);
    await expect(page.locator('#generated-qr')).toBeHidden();
    await expect(page.locator('#download-btn')).toHaveAttribute('aria-disabled', 'true');
    await page.clock.runFor(30_000);
    expect(cloud.writes).toBe(0);
    cloud.omitScannedAt = false; // The migration has been applied before recapture.
    await uploadQr(page, original);
    await expectExactText(page, '#combined-data', original);
    expect(cloud.row.scanned_at).toBe('2026-09-18T12:00:07.000Z');
    expect(cloud.writes).toBe(1);
  });
}

test('a failed save retries the same captured instant after time has elapsed', async ({ page, context }) => {
  const previous = source('previously saved');
  const pending = source('pending exact data\n  with spaces  ');
  const cloud = cloudMock(previous);
  cloud.denySave = true;
  await cloud.attach(context);
  await page.goto('/');
  await expectExactText(page, '#combined-data', previous);
  await uploadQr(page, pending);
  await expect(page.locator('#capture-message')).toContainText(/denied/i);
  await expectExactText(page, '#source-data', pending);
  await expect(page.locator('#source-badge')).toHaveText('Not saved to cloud');
  await expect(page.locator('#generated-qr')).toBeHidden();
  await page.clock.runFor(20_000);
  cloud.denySave = false;
  await page.locator('#retry-save').click();
  await expectExactText(page, '#combined-data', atQrTime(pending, '16:09:27'));
  expect(cloud.attempts).toEqual([
    { qr_data: pending, scanned_at: NOW_ISO },
    { qr_data: pending, scanned_at: NOW_ISO },
  ]);
  expect(cloud.row.scanned_at).toBe(NOW_ISO);
  await expect(page.locator('#retry-save')).toBeHidden();
  await page.clock.runFor(30_000);
  expect(cloud.row.qr_data).toBe(pending);
  expect(cloud.writes).toBe(1);
});

test('a clock behind the actual scan time hides stale output and recovers at that instant', async ({ page, context }) => {
  const original = source('system clock behind capture');
  const cloud = cloudMock(original, '2026-09-18T11:59:42.000Z');
  await cloud.attach(context);
  await page.goto('/');
  await expect(page.locator('#output-message')).toContainText(/future|ahead|before|behind/i);
  await expect(page.locator('#generated-qr')).toBeHidden();
  await page.clock.runFor(5_000);
  await expectExactText(page, '#combined-data', original);
  await expect(page.locator('#generated-qr')).toBeVisible();
  await page.clock.setSystemTime(new Date(NOW));
  await page.clock.runFor(1_000);
  await expect(page.locator('#generated-qr')).toBeHidden();
  await expect(page.locator('#copy-btn')).toBeDisabled();
  await page.clock.runFor(4_000);
  await expectExactText(page, '#combined-data', original);
  await page.clock.runFor(15_000);
  await expectExactText(page, '#combined-data', atQrTime(original, '16:09:27'));
  expect(cloud.writes).toBe(0);
});

for (const example of [
  { label: 'missing', text: 'no delimited timestamp in this QR' },
  { label: 'invalid', text: 'bad time #2026-09-18 25:61:12#' },
  { label: 'ambiguous', text: '#2026-09-18 16:09:12# plus #2026-09-18 13:02:05#' },
]) {
  test(`${example.label} encoded timestamp disables output and explains the problem`, async ({ page, context }) => {
    const cloud = cloudMock(example.text);
    await cloud.attach(context);
    await page.goto('/');
    await expectExactText(page, '#source-data', example.text);
    await expect(page.locator('#output-message')).toContainText(/timestamp|HH:mm:ss|time|multiple/i);
    await expect(page.locator('#generated-qr')).toBeHidden();
    await expect(page.locator('#download-btn')).toHaveAttribute('aria-disabled', 'true');
    await page.clock.runFor(30_000);
    expect(cloud.writes).toBe(0);
  });
}

test('an image with no QR shows a useful error and preserves the cloud record', async ({ page, context }) => {
  const original = source('keep this record');
  const cloud = cloudMock(original);
  await cloud.attach(context);
  await page.goto('/');
  await expectExactText(page, '#source-data', original);
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 300;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 300, 300);
    return canvas.toDataURL('image/png');
  });
  await page.clock.resume(); // Allow decoder timer yields while trying other scales.
  await page.locator('#qr-file').setInputFiles({ name: 'blank.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
  await expect(page.locator('#capture-message')).toContainText(/no (?:readable )?QR|could not find|couldn.t find/i);
  await expectExactText(page, '#source-data', original);
  expect(cloud.writes).toBe(0);
});

test('a failed cloud read can be retried without creating a new system scan time', async ({ page, context }) => {
  const original = source('saved on another device');
  const cloud = cloudMock(original);
  cloud.denyRead = true;
  await cloud.attach(context);
  await page.goto('/');
  await expect(page.locator('#cloud-message')).toContainText(/denied/i);
  await expect(page.locator('#generated-qr')).toBeHidden();
  await page.clock.runFor(20_000);
  cloud.denyRead = false;
  await page.locator('#refresh-btn').click();
  await expectExactText(page, '#combined-data', atQrTime(original, '16:09:27'));
  expect(cloud.row.scanned_at).toBe(NOW_ISO);
  expect(cloud.writes).toBe(0);
});

test('discarding a failed capture restores the saved original and its earlier scan baseline', async ({ page, context }) => {
  const original = source('stable saved value');
  const cloud = cloudMock(original);
  cloud.denySave = true;
  await cloud.attach(context);
  await page.goto('/');
  await expectExactText(page, '#combined-data', original);
  await page.clock.runFor(20_000);
  await uploadQr(page, source('discard this pending capture'));
  await expect(page.locator('#discard-pending')).toBeVisible();
  await page.locator('#discard-pending').click();
  await expectExactText(page, '#source-data', original);
  await expectExactText(page, '#combined-data', atQrTime(original, '16:09:27'));
  expect(cloud.row.scanned_at).toBe(NOW_ISO);
  expect(cloud.writes).toBe(0);
});

test('camera permission denial is explained without changing the saved capture', async ({ page, context }) => {
  const original = source('keep after denial');
  const cloud = cloudMock(original);
  await cloud.attach(context);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => { throw new DOMException('Permission denied by test', 'NotAllowedError'); },
    });
  });
  await page.goto('/');
  await expectExactText(page, '#source-data', original);
  await page.locator('#scan-btn').click();
  await expect(page.locator('#camera-message')).toContainText(/camera.*(?:denied|permission|blocked)|(?:denied|permission|blocked).*camera/i);
  expect(cloud.row.scanned_at).toBe(NOW_ISO);
  expect(cloud.writes).toBe(0);
});

test('narrow screens remain usable with long original text, capture details and live QR', async ({ page, context }) => {
  const original = source('long-content-'.repeat(22));
  const cloud = cloudMock(original);
  await cloud.attach(context);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expectExactText(page, '#source-data', original);
  await expect(page.locator('#generated-qr')).toBeVisible();
  const width = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
  await expect(page.locator('#baseline-timestamp')).toBeVisible();
  await expect(page.locator('#scan-btn')).toBeVisible();
});
