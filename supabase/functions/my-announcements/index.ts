// my-announcements — returns the signed-in parent's own announcements (those actually sent to them),
// newest first, each with its attachments as time-limited signed download URLs.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "parent_hub" } });
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { db: { schema: "parent_hub" }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "not signed in" }, 401);
    const { data: recs } = await svc.from("announcement_recipients").select("announcement_id").eq("parent_id", user.id);
    const ids = [...new Set((recs ?? []).map((r: any) => r.announcement_id))];
    if (!ids.length) return json({ announcements: [] });
    const { data: anns } = await svc.from("announcements").select("id,title,body,priority,publish_at").in("id", ids).eq("status", "published").order("publish_at", { ascending: false });
    const { data: atts } = await svc.from("announcement_attachments").select("announcement_id,storage_path,file_name,mime_type").in("announcement_id", ids);
    const byAnn: Record<string, any[]> = {};
    for (const a of atts ?? []) {
      const { data: su } = await svc.storage.from("attachments").createSignedUrl(a.storage_path, 604800);
      (byAnn[a.announcement_id] = byAnn[a.announcement_id] || []).push({ name: a.file_name, url: su?.signedUrl || null, type: a.mime_type });
    }
    const out = (anns ?? []).map((a: any) => ({ id: a.id, title: a.title, body: a.body, priority: a.priority, publish_at: a.publish_at, attachments: byAnn[a.id] || [] }));
    return json({ announcements: out });
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
});
