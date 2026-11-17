-- SECURITY HARDENING (audit 2026-11-17). Each section is independent.
-- STATUS (checked read-only against the live project on 2026-11-17): sections 1 and 2 are ALREADY APPLIED
-- (schema_migrations version 20261117001602 "audit_20261117_profiles_guard_and_backup_lockdown"; trigger
-- profiles_guard_privileged exists, guardian_contacts_bak_20261115 has RLS on and no authenticated SELECT).
-- Sections 3, 4 and 5 are NOT applied: review, then run them in the Supabase SQL editor (ideally on a branch /
-- after a backup). Re-running 1 and 2 is harmless (create or replace / drop if exists).

-- 1) Stop privilege self-escalation through profiles.
--    Policy p_self_upd lets a user UPDATE their own row (and any staff member update ANY row) with no column
--    restriction, and `authenticated` holds UPDATE on role/roles/is_active. A parent could therefore run
--    sb.from('profiles').update({ role: 'admin' }).eq('id', <own id>) and become an admin. full_name/email are
--    also used by edge functions as permission allow-lists, so they are guarded too. The web app never updates
--    profiles directly (all changes go through service-role edge functions), so this does not break it.
create or replace function parent_hub.guard_profile_privileged_cols()
returns trigger language plpgsql security definer set search_path = parent_hub, public as $$
begin
  -- service-role (edge functions) and direct SQL (no JWT) are trusted
  if coalesce(auth.role(), '') = 'service_role' or auth.uid() is null then return new; end if;
  -- active admins may change anything
  if exists (select 1 from parent_hub.profiles p where p.id = auth.uid() and p.role = 'admin' and p.is_active) then return new; end if;
  if new.id is distinct from old.id
     or new.role is distinct from old.role
     or new.roles is distinct from old.roles
     or new.is_active is distinct from old.is_active
     or new.email is distinct from old.email
     or new.full_name is distinct from old.full_name then
    raise exception 'not allowed to change id, role, roles, is_active, email or full_name' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function parent_hub.guard_profile_privileged_cols() from public, anon, authenticated;
drop trigger if exists profiles_guard_privileged on parent_hub.profiles;
create trigger profiles_guard_privileged before update on parent_hub.profiles
  for each row execute function parent_hub.guard_profile_privileged_cols();

-- 2) Backup table with RLS DISABLED: every signed-in user can read/modify all guardian names + mobiles.
alter table parent_hub.guardian_contacts_bak_20261115 enable row level security;
revoke all on parent_hub.guardian_contacts_bak_20261115 from anon, authenticated;
-- Once you've confirmed the backup isn't needed:
-- drop table parent_hub.guardian_contacts_bak_20261115;

-- 3) staff_access is readable by everyone (sa_read USING true). The app only reads its own row.
drop policy if exists sa_read on parent_hub.staff_access;
create policy sa_read on parent_hub.staff_access for select
  using (user_id = auth.uid() or parent_hub.is_staff());

-- 4) Storage bucket "attachments": att_sel lets ANY signed-in user read/list EVERY file (other families'
--    message attachments, praise certificates at praise/<period>/<pupil_id>.pdf, behaviour statement photos).
--    New rule: staff read everything; a parent reads files they uploaded, or files a member of staff attached
--    to a message in the parent's own conversation. Announcement files are served via signed URLs from the
--    my-announcements edge function (service role), so they don't need a parent policy.
drop policy if exists att_sel on storage.objects;
create policy att_sel on storage.objects for select to authenticated using (
  bucket_id = 'attachments' and (
    parent_hub.is_staff()
    or owner_id = auth.uid()::text
    or exists (
      select 1 from parent_hub.messages m
      join parent_hub.conversations c on c.id = m.conversation_id
      where m.attachment_path = storage.objects.name and m.sender_role = 'staff' and c.parent_id = auth.uid()
    )
  )
);
--    Parents may only upload into conversation folders, not the staff-only prefixes.
drop policy if exists att_ins on storage.objects;
create policy att_ins on storage.objects for insert to authenticated with check (
  bucket_id = 'attachments' and (
    parent_hub.is_staff()
    or split_part(name, '/', 1) not in ('behaviour', 'announcements', 'praise')
  )
);

-- 5) SECURITY DEFINER helpers exposed over the REST API (Supabase advisor 0028/0029).
--    handle_new_user is a trigger function — triggers still fire after EXECUTE is revoked.
revoke execute on function public.handle_new_user() from anon, authenticated, public;
