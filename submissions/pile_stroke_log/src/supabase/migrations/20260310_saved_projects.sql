-- Saved projects metadata + XML storage index for hybrid local/cloud project directory.
-- Run in Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.saved_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_key text not null,
  name text not null,
  location text,
  contractor text,
  inspector text,
  substructure_element text,
  pile_number text,
  last_updated timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists saved_projects_user_key_idx
  on public.saved_projects (user_id, project_key);

create table if not exists public.saved_project_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references public.saved_projects (id) on delete cascade,
  file_name text not null,
  extension text not null,
  local_path text not null,
  storage_path text,
  size_bytes bigint,
  saved_at timestamptz not null default timezone('utc', now()),
  upload_status text not null check (upload_status in ('pending', 'uploaded', 'failed')),
  upload_attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists saved_project_files_user_local_path_idx
  on public.saved_project_files (user_id, local_path);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_saved_projects_updated_at on public.saved_projects;
create trigger trg_saved_projects_updated_at
before update on public.saved_projects
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_saved_project_files_updated_at on public.saved_project_files;
create trigger trg_saved_project_files_updated_at
before update on public.saved_project_files
for each row execute procedure public.set_updated_at();

alter table public.saved_projects enable row level security;
alter table public.saved_project_files enable row level security;

drop policy if exists saved_projects_select_own on public.saved_projects;
create policy saved_projects_select_own
on public.saved_projects
for select
using (auth.uid() = user_id);

drop policy if exists saved_projects_insert_own on public.saved_projects;
create policy saved_projects_insert_own
on public.saved_projects
for insert
with check (auth.uid() = user_id);

drop policy if exists saved_projects_update_own on public.saved_projects;
create policy saved_projects_update_own
on public.saved_projects
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists saved_projects_delete_own on public.saved_projects;
create policy saved_projects_delete_own
on public.saved_projects
for delete
using (auth.uid() = user_id);

drop policy if exists saved_project_files_select_own on public.saved_project_files;
create policy saved_project_files_select_own
on public.saved_project_files
for select
using (auth.uid() = user_id);

drop policy if exists saved_project_files_insert_own on public.saved_project_files;
create policy saved_project_files_insert_own
on public.saved_project_files
for insert
with check (auth.uid() = user_id);

drop policy if exists saved_project_files_update_own on public.saved_project_files;
create policy saved_project_files_update_own
on public.saved_project_files
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists saved_project_files_delete_own on public.saved_project_files;
create policy saved_project_files_delete_own
on public.saved_project_files
for delete
using (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('project-xml', 'project-xml', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists project_xml_select_own on storage.objects;
create policy project_xml_select_own
on storage.objects
for select
using (
  bucket_id = 'project-xml'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists project_xml_insert_own on storage.objects;
create policy project_xml_insert_own
on storage.objects
for insert
with check (
  bucket_id = 'project-xml'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists project_xml_update_own on storage.objects;
create policy project_xml_update_own
on storage.objects
for update
using (
  bucket_id = 'project-xml'
  and split_part(name, '/', 1) = auth.uid()::text
)
with check (
  bucket_id = 'project-xml'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists project_xml_delete_own on storage.objects;
create policy project_xml_delete_own
on storage.objects
for delete
using (
  bucket_id = 'project-xml'
  and split_part(name, '/', 1) = auth.uid()::text
);
