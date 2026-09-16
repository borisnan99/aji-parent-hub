// send-announcement — publishes an announcement and fans it out.
// Channel policy (school decision): Web Push to everyone with the app (free);
// email ONLY to parents without push, and ALWAYS email for 'urgent'.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });

    // 1) authenticate caller and require staff
    const authHeader = req.headers.get("Authorization") ?? "";
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      db: { schema: "parent_hub" }, global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: me } = await svc.from("profiles").select("role").eq("id", user.id).single();
    if (!me || !["admin", "staff"].includes(me.role)) return json({ error: "staff only" }, 403);

    const { title, body = "", priority = "normal", group_ids = [] } = await req.json();
    if (!title || !Array.isArray(group_ids) || group_ids.length === 0)
      return json({ error: "title and at least one group required" }, 400);

    // 2) load secrets from the locked config table (service role only)
    const { data: cfgRows } = await svc.from("app_config").select("key,value");
    const cfg: Record<string, string> = {};
    (cfgRows ?? []).forEach((r: any) => (cfg[r.key] = r.value));
    webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
    const brevoReady = cfg.brevo_api_key && cfg.brevo_sender_email && cfg.brevo_sender_email !== "PENDING";

    // 3) create the announcement + targets
    const { data: ann, error: annErr } = await svc.from("announcements")
      .insert({ title, body, priority, status: "published", publish_at: new Date().toISOString(), created_by: user.id })
      .select().single();
    if (annErr) return json({ error: annErr.message }, 500);
    await svc.from("announcement_targets").insert(group_ids.map((g: string) => ({ announcement_id: ann.id, group_id: g })));

    // 4) resolve the distinct parents across the chosen groups
    const parentIds = new Set<string>();
    for (const g of group_ids) {
      const { data } = await svc.rpc("resolve_group_parents", { g_id: g });
      (data ?? []).forEach((r: any) => parentIds.add(r.parent_id));
    }

    let pushSent = 0, emailsSent = 0;
    const isUrgent = priority === "urgent";

    for (const pid of parentIds) {
      const [{ data: subs }, { data: prof }, { data: pref }] = await Promise.all([
        svc.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", pid),
        svc.from("profiles").select("email,full_name").eq("id", pid).single(),
        svc.from("parent_preferences").select("email_opt_in").eq("parent_id", pid).maybeSingle(),
      ]);
      const hasPush = (subs ?? []).length > 0;

      // free channel: web push to every device
      for (const s of subs ?? []) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ title, body, priority, id: ann.id }),
          );
          pushSent++;
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410)
            await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); // prune dead
        }
      }

      // email only if (no push) OR urgent — and the parent hasn't opted out
      const wantEmail = (!hasPush || isUrgent) && pref?.email_opt_in !== false;
      let emailStatus = "pending";
      if (wantEmail && brevoReady && prof?.email) {
        try {
          const r = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "api-key": cfg.brevo_api_key, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              sender: { name: cfg.brevo_sender_name, email: cfg.brevo_sender_email },
              to: [{ email: prof.email, name: prof.full_name }],  // individual send — never exposes other parents
              subject: (isUrgent ? "[URGENT] " : "") + title,
              htmlContent: `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto">
                <h2 style="color:#14294D">${title}</h2><p style="white-space:pre-wrap">${body}</p>
                <hr style="border:none;border-top:1px solid #E8E3D6"/>
                <p style="color:#6E6A60;font-size:12px">Al Jamiatul Islamiyah — Bolton Darul Uloom</p></div>`,
            }),
          });
          emailStatus = r.ok ? "sent" : "failed";
          if (r.ok) emailsSent++;
        } catch { emailStatus = "failed"; }
      } else if (wantEmail && !brevoReady) {
        emailStatus = "skipped_no_sender";
      } else {
        emailStatus = "skipped_has_push";
      }

      await svc.from("announcement_recipients")
        .upsert({ announcement_id: ann.id, parent_id: pid, email_status: emailStatus,
                  delivered_at: hasPush ? new Date().toISOString() : null });
    }

    return json({ ok: true, announcement_id: ann.id, recipients: parentIds.size, push_sent: pushSent, emails_sent: emailsSent });
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
