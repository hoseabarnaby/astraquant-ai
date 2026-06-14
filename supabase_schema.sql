-- AstraQuant AI V8 Supabase Online Schema
-- Jalankan ulang semua SQL ini di Supabase SQL Editor.
-- Aman untuk project baru. Kalau dari versi lama, tabel akan di-upgrade dengan kolom user_id.

create extension if not exists pgcrypto;

create table if not exists ai_signals (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default 'demo_user',
  coin text not null,
  symbol text not null,
  side text not null,
  score numeric not null,
  confidence numeric default 0,
  entry numeric,
  sl numeric,
  tp numeric,
  price numeric,
  timeframe text,
  source text,
  technical jsonb,
  fundamental jsonb,
  why jsonb,
  chart jsonb,
  price_action jsonb default '{}'::jsonb,
  fib jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists ai_positions (
  id text primary key,
  user_id text not null default 'demo_user',
  coin text not null,
  symbol text not null,
  side text not null,
  entry numeric not null,
  sl numeric not null,
  tp numeric not null,
  qty numeric not null,
  margin numeric not null,
  score numeric not null,
  status text default 'OPEN',
  signal_id text,
  reason text,
  max_hold_hours numeric default 6,
  last numeric,
  unrealized numeric default 0,
  pnl_pct numeric default 0,
  opened_at timestamptz default now(),
  closed_at timestamptz
);

create table if not exists ai_trade_history (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default 'demo_user',
  position_id text,
  coin text not null,
  symbol text not null,
  side text not null,
  entry numeric not null,
  exit numeric not null,
  sl numeric,
  tp numeric,
  qty numeric,
  margin numeric,
  score numeric,
  pnl numeric,
  pnl_pct numeric,
  close_reason text,
  mistake_tags jsonb,
  lesson text,
  opened_at timestamptz,
  closed_at timestamptz default now()
);

create table if not exists ai_memory (
  key text not null,
  user_id text not null default 'demo_user',
  coin text not null,
  side text not null,
  trades int default 0,
  wins int default 0,
  losses int default 0,
  avg_pnl_pct numeric default 0,
  weight_adjustment numeric default 0,
  mistake_tags jsonb default '[]'::jsonb,
  notes jsonb default '[]'::jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, key)
);

create table if not exists ai_bot_state (
  id text not null default 'main',
  user_id text not null default 'demo_user',
  balance numeric default 1000,
  equity numeric default 1000,
  risk_per_trade numeric default 0.06,
  updated_at timestamptz default now(),
  primary key (user_id, id)
);

-- Upgrade untuk tabel lama kalau sudah pernah dibuat.
alter table ai_signals add column if not exists user_id text not null default 'demo_user';
alter table ai_signals add column if not exists price_action jsonb default '{}'::jsonb;
alter table ai_signals add column if not exists fib jsonb default '{}'::jsonb;

alter table ai_positions add column if not exists user_id text not null default 'demo_user';
alter table ai_positions add column if not exists signal_id text;
alter table ai_positions add column if not exists reason text;
alter table ai_positions add column if not exists max_hold_hours numeric default 6;

alter table ai_trade_history add column if not exists user_id text not null default 'demo_user';
alter table ai_memory add column if not exists user_id text not null default 'demo_user';
alter table ai_bot_state add column if not exists user_id text not null default 'demo_user';

create index if not exists idx_ai_signals_user_created on ai_signals(user_id, created_at desc);
create index if not exists idx_ai_positions_user_status on ai_positions(user_id, status);
create index if not exists idx_ai_history_user_closed on ai_trade_history(user_id, closed_at desc);
create index if not exists idx_ai_memory_user on ai_memory(user_id);

insert into ai_bot_state(user_id, id, balance, equity, risk_per_trade)
values ('demo_user', 'main', 1000, 1000, 0.06)
on conflict (user_id, id) do nothing;