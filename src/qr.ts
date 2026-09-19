import jsQR from "jsqr";
import QRCode from "qrcode";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 24_000_000;
const MAX_IMAGE_EDGE = 16_384;
const MAX_DECODE_PIXELS = 6_000_000;

type ImageDimensions = { width: number; height: number };

/** Read dimensions before asking the browser to allocate a decoded image. */
async function inspectImage(file: File): Promise<ImageDimensions> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let dimensions: ImageDimensions | undefined;
  let supported = false;

  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  ) {
    supported = true;
    dimensions = { width: view.getUint32(16), height: view.getUint32(20) };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    supported = true;
    // JPEG dimensions live in a start-of-frame segment, after optional metadata.
    let offset = 2;
    while (offset + 1 < bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        length >= 8 &&
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        dimensions = {
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
        };
        break;
      }
      offset += length;
    }
  } else if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    supported = true;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      const length = view.getUint32(offset + 4, true);
      const data = offset + 8;
      if (data + length > bytes.length) break;
      if (kind === "VP8X" && length >= 10) {
        dimensions = {
          width:
            1 +
            bytes[data + 4] +
            (bytes[data + 5] << 8) +
            (bytes[data + 6] << 16),
          height:
            1 +
            bytes[data + 7] +
            (bytes[data + 8] << 8) +
            (bytes[data + 9] << 16),
        };
      } else if (kind === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
        dimensions = {
          width: 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8),
          height:
            1 +
            (bytes[data + 2] >> 6) +
            (bytes[data + 3] << 2) +
            ((bytes[data + 4] & 0x0f) << 10),
        };
      } else if (
        kind === "VP8 " &&
        length >= 10 &&
        bytes[data + 3] === 0x9d &&
        bytes[data + 4] === 0x01 &&
        bytes[data + 5] === 0x2a
      ) {
        dimensions = {
          width: view.getUint16(data + 6, true) & 0x3fff,
          height: view.getUint16(data + 8, true) & 0x3fff,
        };
      }
      if (dimensions) break;
      offset = data + length + (length % 2);
    }
  }

  if (!supported) throw new Error("Choose a JPG, JPEG, PNG, or WebP image.");
  if (!dimensions || !dimensions.width || !dimensions.height) {
    throw new Error(
      "This image could not be read. Try a different image or export it again.",
    );
  }
  checkDimensions(dimensions.width, dimensions.height);
  return dimensions;
}

function checkDimensions(width: number, height: number): void {
  if (
    width * height > MAX_IMAGE_PIXELS ||
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE
  ) {
    throw new Error(
      "This image is too large. Resize it to 24 megapixels or fewer and no more than 16,384 pixels per side.",
    );
  }
}

/** Decode one QR code locally. Its text is returned exactly, without trimming. */
export async function decodeImage(file: File): Promise<string> {
  if (!(file instanceof Blob) || file.size === 0)
    throw new Error(
      "This file is empty. Choose an image containing a QR code.",
    );
  if (file.size > MAX_FILE_BYTES)
    throw new Error(
      "This file is too large. Choose an image smaller than 20 MB.",
    );
  try {
    await inspectImage(file);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("This image could not be read. Choose another file.");
  }

  const url = URL.createObjectURL(file);
  const source = new Image();
  const canvas = document.createElement("canvas");
  try {
    await new Promise<void>((resolve, reject) => {
      source.onload = () => resolve();
      source.onerror = () =>
        reject(
          new Error(
            "This image could not be opened. Try a different image or export it again.",
          ),
        );
      source.decoding = "async";
      source.src = url;
    });
    const width = source.naturalWidth;
    const height = source.naturalHeight;
    if (!width || !height)
      throw new Error(
        "This image has no readable pixels. Choose another image.",
      );
    checkDimensions(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context)
      throw new Error(
        "Your browser cannot read images here. Try a current version of Chrome, Edge, Firefox, or Safari.",
      );

    // Start with a fast scan, then increase detail without allocating an unbounded canvas.
    const maximumScale = Math.min(
      1,
      Math.sqrt(MAX_DECODE_PIXELS / (width * height)),
      4096 / Math.max(width, height),
    );
    const scales = [
      ...new Set(
        [1600, 2600, 4096].map((edge) =>
          Math.min(maximumScale, edge / Math.max(width, height)),
        ),
      ),
    ];
    for (const scale of scales) {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(pixels.data, pixels.width, pixels.height, {
        inversionAttempts: "attemptBoth",
      });
      if (result) {
        if (result.data.length === 0)
          throw new Error(
            "This QR code is empty. Choose a QR code containing text.",
          );
        return result.data;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(
      "No readable QR code was found. Try a sharper image, or crop the image closer to the QR code.",
    );
  } finally {
    URL.revokeObjectURL(url);
    source.onload = null;
    source.onerror = null;
    source.src = "";
    canvas.width = 0;
    canvas.height = 0;
  }
}

function cameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access was denied. Allow camera access in your browser settings, or upload a QR image.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera was found on this device. You can upload a QR image instead.";
  }
  if (
    name === "NotReadableError" ||
    name === "TrackStartError" ||
    name === "AbortError"
  ) {
    return "The camera could not start. Close other apps using it, then try again or upload a QR image.";
  }
  return "The camera could not start in this browser. Try again, or upload a QR image.";
}

/** Owns one camera stream; stop() also invalidates pending permission requests. */
export class CameraScanner {
  private stream: MediaStream | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly canvas = document.createElement("canvas");
  private frame = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onDecoded: (text: string) => void,
    private readonly onError: (message: string) => void,
  ) {}

  /** Camera failures are delivered through onError; stale starts resolve quietly. */
  async start(): Promise<void> {
    this.stop();
    const generation = this.generation;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.onError(
        "Camera scanning needs HTTPS or localhost and a browser with camera support. You can upload a QR image instead.",
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.autoplay = true;
      stream.getVideoTracks().forEach((track) =>
        track.addEventListener(
          "ended",
          () => {
            if (generation !== this.generation) return;
            this.stop();
            this.onError(
              "The camera disconnected. Start the camera again or upload a QR image.",
            );
          },
          { once: true },
        ),
      );
      await this.video.play();
      if (generation !== this.generation) return;
      this.frame = 0;
      this.scan(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      this.onError(cameraError(error));
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  private scan(generation: number): void {
    if (generation !== this.generation) return;
    let decoded: string | undefined;
    try {
      if (
        this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        this.video.videoWidth &&
        this.video.videoHeight
      ) {
        const scale = Math.min(
          1,
          1280 / Math.max(this.video.videoWidth, this.video.videoHeight),
        );
        const width = Math.max(1, Math.round(this.video.videoWidth * scale));
        const height = Math.max(1, Math.round(this.video.videoHeight * scale));
        if (this.canvas.width !== width) this.canvas.width = width;
        if (this.canvas.height !== height) this.canvas.height = height;
        const context = this.canvas.getContext("2d", {
          willReadFrequently: true,
        });
        if (!context) throw new Error("Canvas is unavailable");
        context.drawImage(this.video, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        const result = jsQR(pixels.data, width, height, {
          inversionAttempts:
            this.frame++ % 4 === 0 ? "attemptBoth" : "dontInvert",
        });
        if (result) decoded = result.data;
      }
    } catch {
      this.stop();
      this.onError(
        "The camera image could not be read. Try starting the camera again, or upload a QR image.",
      );
      return;
    }
    if (decoded !== undefined) {
      this.stop();
      if (decoded.length === 0)
        this.onError("This QR code is empty. Try a QR code containing text.");
      else this.onDecoded(decoded);
      return;
    }
    // Decode at most about seven frames per second, leaving time for the interface.
    this.timer = setTimeout(() => this.scan(generation), 150);
  }
}

/** Generate a standard, opaque PNG with a four-module quiet zone. */
export async function generateQr(text: string): Promise<string> {
  if (text.length === 0)
    throw new Error("There is no saved content to turn into a QR code.");
  // Even a numeric-only version 40 symbol cannot exceed this length at level M.
  if (text.length > 5596)
    throw new Error(
      "This content is too long for one QR code. Shorten the content and try again.",
    );
  try {
    return await QRCode.toDataURL(text, {
      type: "image/png",
      width: 768,
      margin: 4,
      errorCorrectionLevel: "M",
      color: { dark: "#000000ff", light: "#ffffffff" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/amount of data|too big|capacity|code length|too long/i.test(message)) {
      throw new Error(
        "This content is too long for one QR code. Shorten the content and try again.",
      );
    }
    throw new Error(
      "The QR code could not be generated. Try again with shorter content.",
    );
  }
}
