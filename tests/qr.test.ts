import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('generated PNG preserves exact Unicode, whitespace, and special characters', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { generateQr, decodeImage } = await import('/src/qr.ts');
    const inputs = [
      '  leading and trailing spaces  \nsecond line\r\n\tlast line\t',
      'नमस्ते 🌍 · 日本語 · café · مرحبا · e\u0301',
      'https://example.com/?a=%20&b=<script>alert("hello")</script>',
      '   ',
    ];
    const results = [];
    for (const input of inputs) {
      const url = await generateQr(input);
      const image = new Image();
      image.src = url;
      await image.decode();
      const blob = await (await fetch(url)).blob();
      const decoded = await decodeImage(new File([blob], 'round-trip.png', { type: 'image/png' }));
      results.push({ input, decoded, width: image.width, height: image.height, png: url.startsWith('data:image/png;base64,') });
    }
    return results;
  });
  for (const result of results) {
    expect(result.decoded).toBe(result.input);
    expect(result.png).toBe(true);
    expect(result.width).toBe(768);
    expect(result.height).toBe(768);
  }
});

test('uploaded JPEG and WebP images decode', async ({ page }) => {
  const decoded = await page.evaluate(async () => {
    const { generateQr, decodeImage } = await import('/src/qr.ts');
    const input = 'QR upload formats ✓';
    const image = new Image();
    image.src = await generateQr(input);
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 768;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    const results = [];
    for (const type of ['image/jpeg', 'image/webp']) {
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), type, 1));
      results.push(await decodeImage(new File([blob], type === 'image/jpeg' ? 'upload.jpg' : 'upload.webp', { type })));
    }
    return results;
  });
  expect(decoded).toEqual(['QR upload formats ✓', 'QR upload formats ✓']);
});

test('invalid, oversized, and QR-free images fail with actionable errors', async ({ page }) => {
  const messages = await page.evaluate(async () => {
    const { decodeImage } = await import('/src/qr.ts');
    const hugeHeader = new Uint8Array(24);
    hugeHeader.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(hugeHeader.buffer);
    view.setUint32(16, 6000);
    view.setUint32(20, 5000);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, 96, 96);
    const blank = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!)));
    const files = [
      new File([], 'empty.png', { type: 'image/png' }),
      new File(['not an image'], 'invalid.png', { type: 'image/png' }),
      new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }),
      new File([hugeHeader], 'dimensions.png', { type: 'image/png' }),
      new File([blank], 'blank.png', { type: 'image/png' }),
    ];
    const results = [];
    for (const file of files) {
      try { await decodeImage(file); results.push('unexpected success'); }
      catch (error) { results.push((error as Error).message); }
    }
    return results;
  });
  expect(messages[0]).toContain('empty');
  expect(messages[1]).toContain('JPG, JPEG, PNG, or WebP');
  expect(messages[2]).toContain('20 MB');
  expect(messages[3]).toContain('24 megapixels');
  expect(messages[4]).toContain('No readable QR code');
});

test('generation reports empty and over-capacity payloads', async ({ page }) => {
  const messages = await page.evaluate(async () => {
    const { generateQr } = await import('/src/qr.ts');
    const results = [];
    for (const input of ['', 'a'.repeat(3000), '1'.repeat(6000)]) {
      try { await generateQr(input); results.push('unexpected success'); }
      catch (error) { results.push((error as Error).message); }
    }
    return results;
  });
  expect(messages[0]).toContain('no saved content');
  expect(messages[1]).toContain('too long');
  expect(messages[2]).toContain('too long');
});

test('stopping a pending camera request releases the late stream without callbacks', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { CameraScanner } = await import('/src/qr.ts');
    let resolveStream!: (stream: MediaStream) => void;
    let stopped = 0;
    const callbacks: string[] = [];
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => new Promise<MediaStream>((resolve) => { resolveStream = resolve; }) },
    });
    const video = document.createElement('video');
    const scanner = new CameraScanner(video, (text) => callbacks.push(text), (error) => callbacks.push(error));
    const started = scanner.start();
    scanner.stop();
    resolveStream({ getTracks: () => [{ stop: () => { stopped += 1; } }] } as unknown as MediaStream);
    await started;
    return { stopped, callbacks, attached: video.srcObject !== null };
  });
  expect(result).toEqual({ stopped: 1, callbacks: [], attached: false });
});

test('camera permission errors explain how to continue', async ({ page }) => {
  const messages = await page.evaluate(async () => {
    const { CameraScanner } = await import('/src/qr.ts');
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } },
    });
    const messages: string[] = [];
    const scanner = new CameraScanner(document.createElement('video'), () => messages.push('unexpected decode'), (error) => messages.push(error));
    await scanner.start();
    return messages;
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('Camera access was denied');
  expect(messages[0]).toContain('upload');
});

test('camera decodes a video stream and stops every track', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { CameraScanner, generateQr } = await import('/src/qr.ts');
    const expected = '  camera round trip 🌍\n';
    const image = new Image();
    image.src = await generateQr(expected);
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 768;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    const stream = canvas.captureStream(10);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => stream },
    });
    const video = document.createElement('video');
    document.body.append(video);
    let resolveResult!: (value: { text?: string; error?: string }) => void;
    const completed = new Promise<{ text?: string; error?: string }>((resolve) => { resolveResult = resolve; });
    const scanner = new CameraScanner(video, (text) => resolveResult({ text }), (error) => resolveResult({ error }));
    const timeout = setTimeout(() => resolveResult({ error: 'Camera test timed out' }), 8000);
    try {
      await scanner.start();
      const value = await completed;
      return { ...value, expected, trackStates: stream.getTracks().map((track) => track.readyState), detached: video.srcObject === null };
    } finally {
      clearTimeout(timeout);
      scanner.stop();
      video.remove();
    }
  });
  expect(result.error).toBeUndefined();
  expect(result.text).toBe(result.expected);
  expect(result.trackStates.every((state) => state === 'ended')).toBe(true);
  expect(result.detached).toBe(true);
});
