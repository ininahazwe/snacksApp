-- ============================================
-- DOUCEURS POS — Schéma Supabase
-- À exécuter dans : Supabase > SQL Editor
-- ============================================

-- 1. PRODUITS
create table public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  price       integer not null,           -- en F CFA
  stock       integer not null default 0,
  barcode     text unique,                -- code-barres scanné
  emoji       text default '🍬',
  color       text default '#F5C842',
  created_at  timestamptz default now()
);

-- 2. CLIENTS
create table public.clients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  debt        integer not null default 0, -- dette en F CFA
  created_at  timestamptz default now()
);

-- 3. VENTES
create table public.sales (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid references public.products(id) on delete set null,
  client_id   uuid references public.clients(id) on delete set null,
  qty         integer not null default 1,
  amount      integer not null,           -- prix total en F CFA
  type        text not null check (type in ('cash', 'dette')),
  created_at  timestamptz default now()
);

-- 4. MOUVEMENTS DE STOCK
create table public.stock_movements (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid references public.products(id) on delete cascade,
  delta       integer not null,           -- positif = entrée, négatif = sortie
  reason      text,                       -- 'vente', 'correction', 'réapprovisionnement'
  created_at  timestamptz default now()
);

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- Seuls les utilisateurs connectés peuvent lire/écrire
-- ============================================

alter table public.products       enable row level security;
alter table public.clients        enable row level security;
alter table public.sales          enable row level security;
alter table public.stock_movements enable row level security;

-- Politique : tout utilisateur authentifié peut tout faire
create policy "Authenticated full access" on public.products
  for all using (auth.role() = 'authenticated');

create policy "Authenticated full access" on public.clients
  for all using (auth.role() = 'authenticated');

create policy "Authenticated full access" on public.sales
  for all using (auth.role() = 'authenticated');

create policy "Authenticated full access" on public.stock_movements
  for all using (auth.role() = 'authenticated');

-- ============================================
-- DONNÉES DE TEST (optionnel)
-- ============================================

insert into public.products (name, price, stock, emoji, color) values
  ('Caramel Fleur de Sel', 500, 42, '🍬', '#F5C842'),
  ('Bonbon Framboise',     250, 18, '🍓', '#E84B6E'),
  ('Nougat Pistache',      750, 31, '🟩', '#5BAD72'),
  ('Marshmallow Vanille',  300,  7, '☁️', '#C4A8E0'),
  ('Chocolat Lait',        600, 23, '🍫', '#8B5E3C');

insert into public.clients (name, phone, debt) values
  ('Aminata Diallo',    '07 12 34 56', 2500),
  ('Kofi Mensah',       '05 98 76 54', 0),
  ('Fatou Traoré',      '01 23 45 67', 1200),
  ('Ibrahim Coulibaly', '07 65 43 21', 750);
