// API HUNTER — boot hook
// Arms the hunter the instant the server starts, BEFORE any browser opens the
// dashboard: token vault restore + 24/7 chain re-engage (if it was engaged).
// The hunt never depends on an open tab — "kabi b nahi rukna chahiye".
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { ensureInit } = await import("@/lib/settings");
      await ensureInit();
    } catch {
      /* DB might not be ready during build — API routes re-run ensureInit */
    }
  }
}
