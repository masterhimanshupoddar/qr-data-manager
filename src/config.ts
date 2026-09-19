export const MAX_DATA_BYTES = 8192;
export type CloudConfig = { url: string; key: string };
export function cloudConfig(): CloudConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !key || url.includes("YOUR-PROJECT") || key.startsWith("YOUR-"))
    return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "")
    )
      return null;
    if (!key.startsWith("sb_publishable_")) {
      // This inspects a public key's role only; it is not authentication or signature verification.
      const payload = key.split(".")[1];
      if (
        !payload ||
        JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).role !==
          "anon"
      )
        return null;
    }
    return { url: parsed.origin, key };
  } catch {
    return null;
  }
}
