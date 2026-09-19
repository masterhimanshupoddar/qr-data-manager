import { defineConfig, loadEnv } from "vite";

// Stop private credentials at build time, before they can enter a public bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const key = env.VITE_SUPABASE_ANON_KEY?.trim();
  const url = env.VITE_SUPABASE_URL?.trim();
  const hasKey = Boolean(key && !key.startsWith("YOUR-"));
  const hasUrl = Boolean(url && !url.includes("YOUR-PROJECT"));
  if (hasKey !== hasUrl) {
    throw new Error(
      "Set both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, or leave both unset for the setup screen.",
    );
  }
  if (hasKey) {
    let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key!);
    if (!publicKey) {
      try {
        publicKey =
          key!.split(".").length === 3 &&
          JSON.parse(
            Buffer.from(key!.split(".")[1], "base64url").toString("utf8"),
          ).role === "anon";
      } catch {
        publicKey = false;
      }
    }
    if (!publicKey) {
      throw new Error(
        "Only a Supabase publishable or legacy anon key may be used in VITE_SUPABASE_ANON_KEY. Private keys are not allowed in browser builds.",
      );
    }
    let validUrl = false;
    try {
      const parsed = new URL(url!);
      validUrl =
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash &&
        parsed.pathname === "/";
    } catch {
      /* Report a safe configuration message without logging credentials. */
    }
    if (!validUrl)
      throw new Error(
        "VITE_SUPABASE_URL must be an HTTPS project origin, for example https://your-project.supabase.co.",
      );
  }
  return {};
});
