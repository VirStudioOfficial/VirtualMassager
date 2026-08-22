-- My Messenger - Supabase schema
-- Run this whole file in Supabase -> SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (char_length(username) between 3 and 30),
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'private' check (type in ('private', 'group')),
  created_at timestamptz not null default now()
);

create table if not exists public.chat_members (
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 5000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create index if not exists chat_members_user_idx
  on public.chat_members(user_id);

create index if not exists messages_chat_created_idx
  on public.messages(chat_id, created_at);

-- Create profile automatically after signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  base_username text;
  final_username text;
begin
  base_username := lower(coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8)));
  final_username := base_username;

  if exists (select 1 from public.profiles where username = final_username) then
    final_username := base_username || '_' || substr(new.id::text, 1, 6);
  end if;

  insert into public.profiles (id, username, display_name)
  values (new.id, final_username, final_username);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Enable RLS.
alter table public.profiles enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;

-- Profiles: authenticated users can search/view profiles.
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
on public.profiles for select
to authenticated
using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- Chats: only members can read.
drop policy if exists "chats_select_member" on public.chats;
create policy "chats_select_member"
on public.chats for select
to authenticated
using (
  exists (
    select 1 from public.chat_members cm
    where cm.chat_id = chats.id
      and cm.user_id = auth.uid()
  )
);

-- A logged-in user can create a chat.
drop policy if exists "chats_insert_authenticated" on public.chats;
create policy "chats_insert_authenticated"
on public.chats for insert
to authenticated
with check (true);

-- Only members can delete chats (not used by current UI).
drop policy if exists "chats_delete_member" on public.chats;
create policy "chats_delete_member"
on public.chats for delete
to authenticated
using (
  exists (
    select 1 from public.chat_members cm
    where cm.chat_id = chats.id
      and cm.user_id = auth.uid()
  )
);

-- Chat members: a user can see memberships of chats they belong to.
drop policy if exists "members_select_member" on public.chat_members;
create policy "members_select_member"
on public.chat_members for select
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1 from public.chat_members mine
    where mine.chat_id = chat_members.chat_id
      and mine.user_id = auth.uid()
  )
);

-- Allow the current user to add themselves OR add another member to a chat
-- after the current user is already a member.
drop policy if exists "members_insert_allowed" on public.chat_members;
create policy "members_insert_allowed"
on public.chat_members for insert
to authenticated
with check (
  user_id = auth.uid()
  or exists (
    select 1 from public.chat_members mine
    where mine.chat_id = chat_members.chat_id
      and mine.user_id = auth.uid()
  )
);

drop policy if exists "members_delete_self" on public.chat_members;
create policy "members_delete_self"
on public.chat_members for delete
to authenticated
using (user_id = auth.uid());

-- Messages: only chat members can read.
drop policy if exists "messages_select_member" on public.messages;
create policy "messages_select_member"
on public.messages for select
to authenticated
using (
  exists (
    select 1 from public.chat_members cm
    where cm.chat_id = messages.chat_id
      and cm.user_id = auth.uid()
  )
);

-- A member can send as themselves.
drop policy if exists "messages_insert_member" on public.messages;
create policy "messages_insert_member"
on public.messages for insert
to authenticated
with check (
  sender_id = auth.uid()
  and exists (
    select 1 from public.chat_members cm
    where cm.chat_id = messages.chat_id
      and cm.user_id = auth.uid()
  )
);

-- Only the sender can edit.
drop policy if exists "messages_update_sender" on public.messages;
create policy "messages_update_sender"
on public.messages for update
to authenticated
using (sender_id = auth.uid())
with check (sender_id = auth.uid());

-- Only the sender can delete.
drop policy if exists "messages_delete_sender" on public.messages;
create policy "messages_delete_sender"
on public.messages for delete
to authenticated
using (sender_id = auth.uid());

-- Realtime for messages.
alter table public.messages replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
end $$;
