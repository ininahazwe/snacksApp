-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 1 — Rôles (admin / manager / cashier) + sécurité au niveau base
-- ═══════════════════════════════════════════════════════════════════════════
-- À exécuter UNE FOIS dans Supabase → SQL Editor, AVANT de déployer le nouveau
-- front. Le script est transactionnel : s'il échoue, rien n'est modifié.
--
-- ⚠️  ÉTAPE OBLIGATOIRE : remplacer REMPLACER_PAR_EMAIL_ADMIN par
--     l'email du compte qui devient ADMIN (compte technique), à l'étape 0
--     (une seule occurrence). Tant que la valeur d'origine est présente, le
--     script s'arrête volontairement.
--
-- Ce que fait ce script :
--   1. crée la table public.profiles (source de vérité des rôles, remplace
--      user_metadata.role qui est modifiable par l'utilisateur lui-même) ;
--   2. migre les comptes existants (gerant → manager, vendeur → cashier) ;
--   3. nomme l'admin ;
--   4. crée un profil automatique (cashier, INACTIF) pour tout nouveau compte ;
--   5. remplace toutes les politiques RLS par des règles basées sur le rôle ;
--   6. ajoute des garde-fous (triggers) : un cashier ne peut modifier que ce
--      que son travail exige (stock produit, dette/avoir client, épuisement lot) ;
--   7. fournit les fonctions réservées à l'admin (liste équipe, rôle, activation) ;
--   8. supprime l'ancienne fonction update_user_role et la vue users_view.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- 0. Configuration : email du compte ADMIN + garde-fou ------------------------
--    ⬇⬇⬇  SEUL ENDROIT À MODIFIER  ⬇⬇⬇
create temp table _phase1_cfg on commit drop as
  select 'REMPLACER_PAR_EMAIL_ADMIN'::text as admin_email;   -- ← ton email admin ici

do $$
declare
  v_admin_email text := (select admin_email from _phase1_cfg);
begin
  if left(v_admin_email, 9) = 'REMPLACER' then
    raise exception 'Renseigne l''email du compte admin à l''étape 0 avant d''exécuter ce script.';
  end if;
  if not exists (select 1 from auth.users where lower(email) = lower(v_admin_email)) then
    raise exception 'Aucun compte auth.users avec l''email % — vérifie l''orthographe.', v_admin_email;
  end if;
end $$;

-- 1. Table profiles -----------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  role         text not null default 'cashier' check (role in ('admin', 'manager', 'cashier')),
  active       boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- 2. Migration des comptes existants (actifs) --------------------------------
insert into public.profiles (id, email, role, active)
select u.id,
       u.email,
       case when coalesce(u.raw_user_meta_data ->> 'role', '') = 'gerant' then 'manager' else 'cashier' end,
       true
from auth.users u
on conflict (id) do nothing;

-- 3. Nomination de l'admin ----------------------------------------------------
do $$
declare
  v_admin_email text := (select admin_email from _phase1_cfg);
begin
  update public.profiles
     set role = 'admin', active = true
   where lower(email) = lower(v_admin_email);
  if not found then
    raise exception 'Admin introuvable dans profiles (%).', v_admin_email;
  end if;
end $$;

-- 4. Profil automatique pour les nouveaux comptes ----------------------------
--    Rôle cashier, INACTIF : un compte créé (ou inscrit si les inscriptions
--    publiques sont ouvertes) ne donne AUCUN accès tant que l'admin ne l'active pas.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role, active)
  values (new.id, new.email, 'cashier', false)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5. Fonctions d'aide (lues par les politiques RLS) --------------------------
create or replace function public.app_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.is_active_user()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active)
$$;

create or replace function public.is_manager_or_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(public.app_role() in ('admin', 'manager'), false)
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(public.app_role() = 'admin', false)
$$;

revoke all on function public.app_role(), public.is_active_user(),
                       public.is_manager_or_admin(), public.is_admin() from public, anon;
grant execute on function public.app_role(), public.is_active_user(),
                          public.is_manager_or_admin(), public.is_admin() to authenticated;

-- 6. Politiques RLS : on repart de zéro ---------------------------------------
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('profiles','products','clients','sales','stock_movements','stock_batches')
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.products        enable row level security;
alter table public.clients         enable row level security;
alter table public.sales           enable row level security;
alter table public.stock_movements enable row level security;
alter table public.stock_batches   enable row level security;

-- Plus aucun droit pour le rôle anonyme (clé publique) sur les tables métier
revoke all on public.profiles, public.products, public.clients, public.sales,
              public.stock_movements, public.stock_batches from anon;

-- profiles : lecture seule. Chacun lit son profil ; manager/admin lisent tout
-- (pour afficher le nom du vendeur). Aucune écriture directe : uniquement via
-- le trigger et les fonctions admin ci-dessous.
revoke insert, update, delete on public.profiles from authenticated;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_manager_or_admin());

-- products : lecture = tout utilisateur actif ; création / suppression =
-- manager/admin ; modification = manager/admin, ou cashier limité au champ
-- `stock` (garde-fou trigger plus bas).
create policy products_select on public.products for select to authenticated
  using (public.is_active_user());
create policy products_insert on public.products for insert to authenticated
  with check (public.is_manager_or_admin());
create policy products_update on public.products for update to authenticated
  using (public.is_active_user()) with check (public.is_active_user());
create policy products_delete on public.products for delete to authenticated
  using (public.is_manager_or_admin());

-- clients : lecture = actif ; création / suppression = manager/admin ;
-- modification = manager/admin, ou cashier limité à debt / credit.
create policy clients_select on public.clients for select to authenticated
  using (public.is_active_user());
create policy clients_insert on public.clients for insert to authenticated
  with check (public.is_manager_or_admin());
create policy clients_update on public.clients for update to authenticated
  using (public.is_active_user()) with check (public.is_active_user());
create policy clients_delete on public.clients for delete to authenticated
  using (public.is_manager_or_admin());

-- sales : manager/admin voient tout ; un cashier ne voit et n'insère QUE ses
-- ventes (user_id = lui). Annulation (update) : manager/admin uniquement.
-- Aucune suppression (historique comptable conservé).
create policy sales_select on public.sales for select to authenticated
  using (public.is_manager_or_admin() or (public.is_active_user() and user_id = auth.uid()));
create policy sales_insert on public.sales for insert to authenticated
  with check (public.is_manager_or_admin() or (public.is_active_user() and user_id = auth.uid()));
create policy sales_update on public.sales for update to authenticated
  using (public.is_manager_or_admin()) with check (public.is_manager_or_admin());

-- stock_movements : lecture = actif (le calcul FIFO d'épuisement d'un lot lit
-- les mouvements liés au lot, y compris côté cashier) ; ajout = actif (ses
-- ventes) ; jamais de modification ni suppression.
create policy stock_movements_select on public.stock_movements for select to authenticated
  using (public.is_active_user());
create policy stock_movements_insert on public.stock_movements for insert to authenticated
  with check (public.is_active_user());

-- stock_batches : lecture = actif (FIFO à la vente) ; création / suppression =
-- manager/admin ; modification = manager/admin, ou cashier limité à
-- exhausted_at / duration_days (épuisement du lot lors d'une vente).
create policy stock_batches_select on public.stock_batches for select to authenticated
  using (public.is_active_user());
create policy stock_batches_insert on public.stock_batches for insert to authenticated
  with check (public.is_manager_or_admin());
create policy stock_batches_update on public.stock_batches for update to authenticated
  using (public.is_active_user()) with check (public.is_active_user());
create policy stock_batches_delete on public.stock_batches for delete to authenticated
  using (public.is_manager_or_admin());

-- Les ventes enregistrées sans user_id explicite (ex. paiements saisis depuis
-- l'écran Clients) sont rattachées à l'utilisateur connecté.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'sales' and column_name = 'user_id') then
    execute 'alter table public.sales alter column user_id set default auth.uid()';
  end if;
end $$;

-- 7. Garde-fous : colonnes modifiables par un cashier ------------------------
--    (auth.uid() null = éditeur SQL / service role : pas de restriction.)
create or replace function public.guard_cashier_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed text[] := tg_argv;
  v_old jsonb;
  v_new jsonb;
  k text;
begin
  if auth.uid() is null or public.is_manager_or_admin() then
    return new;
  end if;
  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  foreach k in array v_allowed loop
    v_old := v_old - k;
    v_new := v_new - k;
  end loop;
  if v_old is distinct from v_new then
    raise exception 'Action réservée aux managers (champs modifiables par un cashier : %)', array_to_string(v_allowed, ', ')
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_products_cashier on public.products;
create trigger trg_guard_products_cashier
  before update on public.products
  for each row execute function public.guard_cashier_update('stock');

drop trigger if exists trg_guard_clients_cashier on public.clients;
create trigger trg_guard_clients_cashier
  before update on public.clients
  for each row execute function public.guard_cashier_update('debt', 'credit');

drop trigger if exists trg_guard_batches_cashier on public.stock_batches;
create trigger trg_guard_batches_cashier
  before update on public.stock_batches
  for each row execute function public.guard_cashier_update('exhausted_at', 'duration_days');

-- 8. Fonctions réservées à l'admin -------------------------------------------
create or replace function public.list_team()
returns table (
  id uuid, email text, display_name text, role text, active boolean,
  created_at timestamptz, last_sign_in_at timestamptz
)
language plpgsql stable security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then
    raise exception 'Réservé aux administrateurs' using errcode = '42501';
  end if;
  return query
    select p.id, p.email, p.display_name, p.role, p.active, p.created_at, u.last_sign_in_at
      from public.profiles p
      left join auth.users u on u.id = p.id
     order by p.created_at desc;
end;
$$;

create or replace function public.set_user_role(target_user_id uuid, new_role text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Réservé aux administrateurs' using errcode = '42501';
  end if;
  if new_role is null or new_role not in ('admin', 'manager', 'cashier') then
    raise exception 'Rôle invalide : %', coalesce(new_role, 'null');
  end if;
  if target_user_id is null or target_user_id = auth.uid() then
    raise exception 'Tu ne peux pas modifier ton propre rôle';
  end if;
  update public.profiles set role = new_role where id = target_user_id;
  if not found then
    raise exception 'Utilisateur introuvable';
  end if;
  -- Il doit toujours rester au moins un admin actif
  if not exists (select 1 from public.profiles where role = 'admin' and active) then
    raise exception 'Il doit rester au moins un administrateur actif';
  end if;
end;
$$;

create or replace function public.set_user_active(target_user_id uuid, is_active boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Réservé aux administrateurs' using errcode = '42501';
  end if;
  if is_active is null then
    raise exception 'Valeur invalide';
  end if;
  if target_user_id is null or target_user_id = auth.uid() then
    raise exception 'Tu ne peux pas désactiver ton propre compte';
  end if;
  update public.profiles set active = is_active where id = target_user_id;
  if not found then
    raise exception 'Utilisateur introuvable';
  end if;
  if not exists (select 1 from public.profiles where role = 'admin' and active) then
    raise exception 'Il doit rester au moins un administrateur actif';
  end if;
end;
$$;

revoke all on function public.list_team(), public.set_user_role(uuid, text),
                       public.set_user_active(uuid, boolean) from public, anon;
grant execute on function public.list_team(), public.set_user_role(uuid, text),
                          public.set_user_active(uuid, boolean) to authenticated;

-- 9. Suppression de l'ancien dispositif --------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'update_user_role'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;
drop view if exists public.users_view;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VÉRIFICATIONS (à lancer après le script) :
--   select email, role, active from public.profiles order by role;
--   select tablename, policyname, cmd, roles from pg_policies
--    where schemaname = 'public' order by tablename, cmd;
--
-- Limites connues (traitées en phase 2) : un cashier peut encore, via l'API,
-- modifier dette/avoir d'un client et lire le prix d'achat (products.cost) ;
-- la règle « le cashier ne fixe pas les prix de vente » exige la fonction
-- record_sale (phase 2).
-- ═══════════════════════════════════════════════════════════════════════════
