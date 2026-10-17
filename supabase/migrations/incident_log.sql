-- Incident / injury log + parent notifications
-- Access is via the report-incident edge function (service role); table is locked down (RLS on, no public policies).
create table if not exists parent_hub.incident_log (
  id uuid primary key default gen_random_uuid(),
  pupil_id uuid not null references parent_hub.pupils(id) on delete cascade,
  body_area text not null,
  what_happened text not null,
  action_taken text,
  logged_by uuid references parent_hub.profiles(id),
  notified_parents int default 0,
  notify_emailed int default 0,
  notify_pushed int default 0,
  created_at timestamptz not null default now()
);
create index if not exists incident_log_pupil_idx on parent_hub.incident_log(pupil_id);
create index if not exists incident_log_created_idx on parent_hub.incident_log(created_at desc);
alter table parent_hub.incident_log enable row level security;
