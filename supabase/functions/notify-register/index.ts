// notify-register — when a teacher completes a register, push the admin(s)
// with who did it, the time, and a LATE flag if it was taken after the cutoff.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

const CUTOFF: Record<string, string> = { morning: "08:20", afternoon: "13:15", evening: "18:05" };
const LABEL: Record<string, string> = { morning: "morning", afternoon: "afternoon", evening: "evening (Mutala)", night: "night" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role,full_name").eq("id", user.id).single();
    if (!me || !["admin", "staff"].includes(me.role)) return json({ error: "staff only" }, 403);

    const { phase, scope_name, present = 0, late = 0, absent = 0, total = 0 } = await req.json();

    // time now, in school local time
    const now = new Date();
    const hhmm = now.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
    const cutoff = CUTOFF[phase];
    const isLate = cutoff ? hhmm > cutoff : false;

    // recipients: all admins with devices
    const { data: admins } = await svc.from("profiles").select("id").eq("role", "admin");
    const adminIds = (admins ?? []).map((a: any) => a.id);
    if (!adminIds.length) return json({ ok: true, pushed: 0 });

    const { data: cfgRows } = await svc.from("app_config").select("key,value");
    const cfg: Record<string, string> = {};
    (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
    webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);

    const who = (me.full_name || "A teacher").trim();
    const sess = LABEL[phase] || phase;
    const title = (isLate ? "⚠️ Late register — " : "✓ Register done — ") + (scope_name || sess);
    const bodyTxt = `${who} took the ${sess} register at ${hhmm}${isLate ? " (LATE — after " + cutoff + ")" : ""}. ` +
      `${present} present, ${late} late, ${absent} absent (of ${total}).`;
    const payload = JSON.stringify({ title, body: bodyTxt, url: "/", kind: "register" });

    let pushed = 0;
    for (const id of adminIds) {
      const { data: subs } = await svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", id);
      for (const s of subs ?? []) {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); pushed++; }
        catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); }
      }
    }
    return json({ ok: true, pushed, late: isLate, at: hhmm });
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
