import { MAX_DATA_BYTES, type CloudConfig } from "./config";

export type QrCapture = { qr_data: string; scanned_at: string };
export type QrState = {
  qr_data: string | null;
  scanned_at: string | null;
  updated_at: string | null;
};

export class CloudStore {
  constructor(private config: CloudConfig) {}

  private async request(
    method: "GET" | "PATCH",
    capture?: QrCapture,
  ): Promise<QrState> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const headers: Record<string, string> = { apikey: this.config.key };
      // Publishable keys are not JWTs. Legacy anon keys may also be used as Bearer tokens.
      if (!this.config.key.startsWith("sb_publishable_"))
        headers.Authorization = `Bearer ${this.config.key}`;
      if (method === "PATCH") {
        headers["Content-Type"] = "application/json";
        headers.Prefer = "return=representation";
      }
      const response = await fetch(
        `${this.config.url}/rest/v1/qr_state?id=eq.1&select=*`,
        {
          method,
          headers,
          cache: "no-store",
          signal: controller.signal,
          ...(method === "PATCH" ? { body: JSON.stringify(capture) } : {}),
        },
      );
      if (!response.ok) {
        if (response.status === 400) {
          const details = await response.json().catch(() => null);
          if (details?.code === "PGRST204" || details?.code === "42703") {
            throw new Error(
              "The database needs its scan-time update. Run supabase/migrations/20260918_add_scanned_at.sql in the Supabase SQL Editor, then choose Save again. Your original scan time is retained.",
            );
          }
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            "Cloud access was denied. Check the public Supabase key and database policies in the setup guide.",
          );
        }
        if (response.status === 404)
          throw new Error(
            "The cloud table is unavailable. Run supabase/schema.sql in the Supabase SQL Editor.",
          );
        throw new Error(
          method === "GET"
            ? "Could not load the latest QR data. Check your connection and try Refresh."
            : "Could not confirm the cloud save. Your decoded text is still here. Check your connection and try Save again.",
        );
      }
      const rows: unknown = await response.json();
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw new Error(
          "The shared cloud record is missing or inaccessible. Check the database setup and policies.",
        );
      }
      const raw = rows[0];
      // Reading an older table remains possible so the stored text is not lost.
      // A missing capture time is never inferred from the QR or server save time.
      const row: QrState = {
        qr_data: raw?.qr_data,
        updated_at: raw?.updated_at,
        scanned_at: raw?.scanned_at ?? null,
      };
      if (
        !row ||
        (row.qr_data !== null &&
          (typeof row.qr_data !== "string" || row.qr_data.length === 0)) ||
        (row.updated_at !== null &&
          (typeof row.updated_at !== "string" ||
            !Number.isFinite(Date.parse(row.updated_at)))) ||
        (row.qr_data !== null && row.updated_at === null) ||
        (row.scanned_at !== null &&
          (typeof row.scanned_at !== "string" ||
            !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.scanned_at) ||
            !Number.isFinite(Date.parse(row.scanned_at)))) ||
        (row.qr_data === null && row.scanned_at !== null)
      ) {
        throw new Error(
          "The cloud returned an unexpected record. Check the database schema in the setup guide.",
        );
      }
      return row;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(
          method === "GET"
            ? "The cloud took too long to respond. Try Refresh again."
            : "The save timed out, so it could not be confirmed. Try Save again when your connection is restored.",
        );
      }
      if (error instanceof TypeError)
        throw new Error(
          "Cannot reach cloud storage. Check your internet connection and Supabase configuration, then try again.",
        );
      if (error instanceof SyntaxError)
        throw new Error(
          "Cloud storage returned an unreadable response. Check the Supabase configuration.",
        );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  read(): Promise<QrState> {
    return this.request("GET");
  }
  save(capture: QrCapture): Promise<QrState> {
    if (capture.qr_data.length === 0)
      return Promise.reject(
        new Error("This QR code contains empty data. Try another code."),
      );
    if (new TextEncoder().encode(capture.qr_data).length > MAX_DATA_BYTES) {
      return Promise.reject(
        new Error(
          "This QR contains too much text to store. The limit is 8 KB.",
        ),
      );
    }
    if (
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(capture.scanned_at) ||
      !Number.isFinite(Date.parse(capture.scanned_at))
    ) {
      return Promise.reject(
        new Error(
          "The scan time could not be read. Check your device clock and scan again.",
        ),
      );
    }
    return this.request("PATCH", capture);
  }
}
