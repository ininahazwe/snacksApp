-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 2 — Stock par utilisateur (détenteur), prix d'achat par lot,
--           ventes / annulations / approvisionnements atomiques
-- ═══════════════════════════════════════════════════════════════════════════
-- Prérequis : la phase 1 (phase1_roles_securite.sql) est exécutée.
-- À exécuter UNE FOIS dans Supabase → SQL Editor, puis déployer le nouveau
-- front AUSSITÔT (l'ancien front écrit directement dans les tables, ce que ce
-- script interdit désormais).
--
-- ⚠️ Avant : faire une sauvegarde (backup-scripts/backup_supabase.sh).
-- ⚠️ Essai à blanc possible : remplacer le COMMIT final par ROLLBACK ; le script
--    vérifie lui-même la cohérence du stock et s'arrête en cas d'écart.
--
-- Décisions appliquées :
--   • tout le stock existant est attribué à dessouassijean1@gmail.com ;
--   • le prix d'achat des lots existants = products.cost (à corriger au fil
--     des vrais approvisionnements) ;
--   • un cashier ne fixe pas le prix de vente (il vend au prix catalogue ou à
--     un prix RÉDUIT avec motif, comme aujourd'hui) ;
--   • une vente hors-ligne n'est jamais rejetée : si le stock du vendeur a
--     changé entre-temps, elle est enregistrée et marquée « à vérifier ».
--
-- Ce que fait ce script :
--   1. étend stock_batches (propriétaire, prix d'achat, reste par lot),
--      sales (coût réel, à-vérifier, idempotence), stock_movements (acteur) ;
--   2. crée stock_holdings (stock détenu par utilisateur) ;
--   3. migre le stock existant vers le détenteur initial et vérifie la
--      cohérence (somme des lots = stock détenu = products.stock) ;
--   4. crée les fonctions atomiques : record_sale, cancel_sales,
--      record_restock, adjust_stock, stock_overview ;
--   5. interdit toute écriture directe sur le stock / les lots / les
--      mouvements, et verrouille products.stock ;
--   6. resserre les règles d'accès : un cashier ne modifie plus rien
--      directement (ni produits, ni clients, ni ventes).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- 0. Détenteur initial + garde-fous -------------------------------------------
create temp table _phase2_cfg on commit drop as
  select 'dessouassijean1@gmail.com'::text as holder_email;

do $$
declare v_email text := (select holder_email from _phase2_cfg);
begin
  if to_regclass('public.profiles') is null or to_regprocedure('public.is_manager_or_admin()') is null then
    raise exception 'La phase 1 doit être exécutée avant la phase 2.';
  end if;
  if not exists (
    select 1 from public.profiles
     where lower(email) = lower(v_email) and active and role in ('manager', 'admin')
  ) then
    raise exception 'Le détenteur initial (%) doit être un manager ou admin actif.', v_email;
  end if;
end $$;

create table if not exists public.app_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
alter table public.app_migrations enable row level security;
revoke all on public.app_migrations from anon, authenticated;

-- 1. Extension du schéma --------------------------------------------------------
alter table public.stock_batches
  add column if not exists owner_id        uuid references auth.users(id),
  add column if not exists unit_cost       numeric,
  add column if not exists origin          text not null default 'restock'
        check (origin in ('restock', 'transfer', 'reassignment', 'initial', 'adjustment')),
  add column if not exists parent_batch_id uuid references public.stock_batches(id),
  add column if not exists remaining_qty   integer not null default 0 check (remaining_qty >= 0);

create index if not exists idx_stock_batches_owner_product
  on public.stock_batches (owner_id, product_id, received_at) where remaining_qty > 0;

alter table public.stock_movements
  add column if not exists actor_id  uuid references auth.users(id),
  add column if not exists holder_id uuid references auth.users(id);

alter table public.sales
  add column if not exists cost_amount     numeric,
  add column if not exists needs_review    boolean not null default false,
  add column if not exists unfulfilled_qty integer not null default 0,
  add column if not exists request_id      uuid;

-- Idempotence : rejouer la même requête (ex. file hors-ligne) ne duplique pas une vente
create unique index if not exists uq_sales_request_product
  on public.sales (request_id, product_id) where request_id is not null;

create table if not exists public.stock_holdings (
  owner_id   uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  qty        integer not null default 0 check (qty >= 0),
  reserved   integer not null default 0 check (reserved >= 0 and reserved <= qty),
  updated_at timestamptz not null default now(),
  primary key (owner_id, product_id)
);
alter table public.stock_holdings enable row level security;

-- 2. Migration du stock existant ------------------------------------------------
--    Chaque produit : products.stock est la vérité (stock physique). Les lots
--    non épuisés se partagent ce stock du plus récent au plus ancien (le FIFO
--    consomme d'abord les plus anciens), dans la limite de leur reste estimé.
--    Ce qui n'est couvert par aucun lot devient un lot « initial » de
--    régularisation. NB : l'ancien calcul du reste d'un lot comptait deux fois
--    la réception ; le reste estimé ci-dessous l'exclut.
do $$
declare
  v_email  text := (select holder_email from _phase2_cfg);
  v_holder uuid;
  r_p record;
  r_b record;
  v_left int;
  v_alloc int;
  v_init_count int := 0;
begin
  if exists (select 1 from public.app_migrations where name = 'phase2_stock_migration') then
    raise notice 'Migration du stock déjà appliquée : étape ignorée.';
    return;
  end if;

  select id into v_holder from public.profiles where lower(email) = lower(v_email);

  -- lots déjà épuisés : historique, propriété du détenteur initial, reste 0
  update public.stock_batches b
     set owner_id = v_holder, unit_cost = p.cost, origin = 'restock', remaining_qty = 0
    from public.products p
   where p.id = b.product_id and b.exhausted_at is not null and b.owner_id is null;

  for r_p in select id, stock, cost from public.products loop
    v_left := greatest(r_p.stock, 0);

    for r_b in
      select b.id,
             b.received_qty + coalesce((
               select sum(m.delta) from public.stock_movements m
                where m.batch_id = b.id and m.reason is distinct from 'reception_carton'
             ), 0) as est
        from public.stock_batches b
       where b.product_id = r_p.id and b.exhausted_at is null and b.owner_id is null
       order by b.received_at desc, b.id
    loop
      v_alloc := least(v_left, greatest(r_b.est, 0));
      update public.stock_batches
         set owner_id = v_holder, unit_cost = r_p.cost, origin = 'restock', remaining_qty = v_alloc
       where id = r_b.id;
      v_left := v_left - v_alloc;
    end loop;

    -- lots actifs dont plus rien ne reste : on les clôture
    update public.stock_batches
       set exhausted_at = now(),
           duration_days = round(extract(epoch from (now() - received_at)) / 86400)::int
     where product_id = r_p.id and exhausted_at is null and remaining_qty = 0;

    -- stock non couvert par un lot → lot « initial » de régularisation
    if v_left > 0 then
      insert into public.stock_batches
        (product_id, received_qty, received_at, owner_id, unit_cost, origin, remaining_qty)
      values
        (r_p.id, v_left,
         coalesce((select min(received_at) from public.stock_batches where product_id = r_p.id), now()) - interval '1 second',
         v_holder, r_p.cost, 'initial', v_left);
      v_init_count := v_init_count + 1;
    end if;

    if r_p.stock > 0 then
      insert into public.stock_holdings (owner_id, product_id, qty)
      values (v_holder, r_p.id, r_p.stock)
      on conflict (owner_id, product_id) do update set qty = excluded.qty;
    end if;
  end loop;

  insert into public.app_migrations (name) values ('phase2_stock_migration');
  raise notice 'Stock initial attribué à % ; % produit(s) avec lot de régularisation.', v_email, v_init_count;
end $$;

-- Tous les lots ont désormais un propriétaire
alter table public.stock_batches alter column owner_id set not null;

-- Contrôle de cohérence : somme des lots = stock détenu = products.stock
do $$
declare v_bad text;
begin
  select string_agg(format('%s (stock %s, détenu %s, lots %s)', p.name, p.stock, coalesce(h.q, 0), coalesce(b.q, 0)), ' ; ')
    into v_bad
    from public.products p
    left join (select product_id, sum(qty) q from public.stock_holdings group by 1) h on h.product_id = p.id
    left join (select product_id, sum(remaining_qty) q from public.stock_batches group by 1) b on b.product_id = p.id
   where p.stock <> coalesce(h.q, 0) or coalesce(h.q, 0) <> coalesce(b.q, 0);
  if v_bad is not null then
    raise exception 'Incohérence de stock après migration (corrige products.stock puis relance) : %', v_bad;
  end if;
end $$;

-- 3. Fonctions internes ---------------------------------------------------------
create or replace function public._try_uuid(p text)
returns uuid
language plpgsql immutable
as $$
begin
  return p::uuid;
exception when others then
  return null;
end;
$$;

-- Autorise (pour la transaction en cours) les écritures sur products.stock
create or replace function public._stock_rpc_on()
returns void
language plpgsql
as $$
begin
  perform set_config('app.stock_rpc', '1', true);
end;
$$;

-- Répartit un montant sur des lignes au prorata de leur poids ; le reste
-- d'arrondi va à la dernière ligne (même règle que l'ancien code du panier).
create or replace function public._split_prorata(p_total numeric, p_weights numeric[])
returns numeric[]
language plpgsql immutable
as $$
declare
  n int := coalesce(array_length(p_weights, 1), 0);
  w numeric := 0;
  s numeric[] := '{}';
  acc numeric := 0;
  v numeric;
  i int;
begin
  if n = 0 then return '{}'; end if;
  for i in 1..n loop w := w + p_weights[i]; end loop;
  if p_total = 0 or w = 0 then
    for i in 1..n loop s := s || 0::numeric; end loop;
    return s;
  end if;
  for i in 1..n loop
    v := round(p_total * (p_weights[i] / w), 2);
    s := s || v;
    acc := acc + v;
  end loop;
  s[n] := round(s[n] + (p_total - acc), 2);
  return s;
end;
$$;

-- Consomme p_qty unités chez p_owner en FIFO (lots les plus anciens d'abord),
-- journalise un mouvement par lot, met à jour le stock détenu et products.stock.
create or replace function public._consume_stock(
  p_owner uuid, p_product uuid, p_qty int, p_sale uuid, p_reason text
)
returns table (o_cost numeric, o_first_batch uuid, o_first_exhausted boolean)
language plpgsql security definer
set search_path = public
as $$
declare
  v_left int := p_qty;
  v_take int;
  v_cost numeric := 0;
  v_first uuid;
  v_firstex boolean := false;
  r record;
begin
  if p_qty <= 0 then
    return query select 0::numeric, null::uuid, false;
    return;
  end if;

  for r in
    select id, remaining_qty, unit_cost
      from public.stock_batches
     where owner_id = p_owner and product_id = p_product and remaining_qty > 0
     order by received_at, created_at, id
       for update
  loop
    exit when v_left = 0;
    v_take := least(v_left, r.remaining_qty);
    update public.stock_batches
       set remaining_qty = remaining_qty - v_take,
           exhausted_at  = case when remaining_qty - v_take = 0 then now() else exhausted_at end,
           duration_days = case when remaining_qty - v_take = 0
                                then round(extract(epoch from (now() - received_at)) / 86400)::int
                                else duration_days end
     where id = r.id;
    insert into public.stock_movements (product_id, batch_id, sale_id, delta, reason, actor_id, holder_id)
    values (p_product, r.id, p_sale, -v_take, p_reason, auth.uid(), p_owner);
    v_cost := v_cost + v_take * coalesce(r.unit_cost, 0);
    if v_first is null then
      v_first := r.id;
      v_firstex := (r.remaining_qty - v_take = 0);
    end if;
    v_left := v_left - v_take;
  end loop;

  if v_left > 0 then
    raise exception 'Incohérence de stock (lots) pour le produit %', p_product;
  end if;

  update public.stock_holdings
     set qty = qty - p_qty, updated_at = now()
   where owner_id = p_owner and product_id = p_product;
  update public.products set stock = stock - p_qty where id = p_product;

  return query select v_cost, v_first, v_firstex;
end;
$$;

-- 4. Fonctions métier exposées --------------------------------------------------

-- 4a. Vente (1 ou plusieurs lignes) : tout ou rien -----------------------------
-- p_payload = {
--   request_id, group_id, offline, client_id, payment_type ('cash'|'dette'),
--   credit_applied, cash_received, save_change_as_credit,
--   lines: [ { product_id, qty, unit_price (optionnel, prix RÉDUIT), discount_reason } ]
-- }
create or replace function public.record_sale(p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_type    text := p_payload ->> 'payment_type';
  v_client  uuid := public._try_uuid(p_payload ->> 'client_id');
  v_request uuid := public._try_uuid(p_payload ->> 'request_id');
  v_offline boolean := coalesce((p_payload ->> 'offline')::boolean, false);
  v_lines   jsonb := p_payload -> 'lines';
  v_n       int;
  v_group   uuid;
  v_pids    uuid[] := '{}';
  v_names   text[] := '{}';
  v_qtys    int[] := '{}';
  v_pcosts  numeric[] := '{}';
  v_totals  numeric[] := '{}';
  v_origs   numeric[] := '{}';
  v_reasons text[] := '{}';
  v_total   numeric := 0;
  v_ccredit numeric := 0;
  v_cdebt   numeric := 0;
  v_applied numeric := 0;
  v_due     numeric;
  v_debt    numeric;
  v_change  numeric := 0;
  v_received numeric;
  v_debts   numeric[];
  v_used    numeric[];
  v_created numeric[];
  v_i       int;
  v_el      jsonb;
  v_prod    record;
  v_qty     int;
  v_unit    numeric;
  v_sale_id uuid;
  v_avail   int;
  v_fulfil  int;
  v_unf     int;
  v_cost    numeric;
  v_batch   uuid;
  v_bex     boolean;
  v_out     jsonb := '[]'::jsonb;
  v_review  boolean := false;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_type is null or v_type not in ('cash', 'dette') then
    raise exception 'Invalid payment type';
  end if;
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'The sale has no items';
  end if;
  v_n := jsonb_array_length(v_lines);
  if v_n > 60 then
    raise exception 'Too many items in one sale';
  end if;

  -- Idempotence : même requête déjà enregistrée → on renvoie le résultat existant
  if v_request is not null and exists (select 1 from public.sales where request_id = v_request) then
    return jsonb_build_object(
      'duplicate', true,
      'lines', coalesce((select jsonb_agg(jsonb_build_object('sale_id', id, 'product_id', product_id, 'qty', qty))
                           from public.sales where request_id = v_request), '[]'::jsonb)
    );
  end if;

  v_group := coalesce(public._try_uuid(p_payload ->> 'group_id'),
                      case when v_n > 1 then gen_random_uuid() else null end);

  -- Passe 1 : prix et totaux, calculés ICI (jamais fiés au client)
  v_i := 0;
  for v_el in select value from jsonb_array_elements(v_lines) loop
    v_i := v_i + 1;
    v_qty := coalesce((v_el ->> 'qty')::int, 0);
    if v_qty <= 0 then raise exception 'Invalid quantity'; end if;
    select id, name, price, cost into v_prod
      from public.products where id = public._try_uuid(v_el ->> 'product_id');
    if not found then raise exception 'Unknown product'; end if;
    if v_prod.id = any (v_pids) then raise exception 'The same product appears twice in the sale'; end if;

    v_unit := v_prod.price;
    if v_el ->> 'unit_price' is not null then
      v_unit := (v_el ->> 'unit_price')::numeric;
      if v_unit < 0 or v_unit >= v_prod.price then
        raise exception 'Invalid discounted price for "%"', v_prod.name;
      end if;
      v_origs := v_origs || round(v_prod.price * v_qty, 2);
    else
      v_origs := v_origs || null::numeric;
    end if;

    v_pids    := v_pids || v_prod.id;
    v_names   := v_names || v_prod.name;
    v_qtys    := v_qtys || v_qty;
    v_pcosts  := v_pcosts || coalesce(v_prod.cost, 0);
    v_totals  := v_totals || round(v_unit * v_qty, 2);
    v_reasons := v_reasons || nullif(btrim(coalesce(v_el ->> 'discount_reason', '')), '');
    v_total   := v_total + round(v_unit * v_qty, 2);
  end loop;

  -- Client (verrouillé) : dette / avoir
  if v_client is not null then
    select debt, credit into v_cdebt, v_ccredit from public.clients where id = v_client for update;
    if not found then raise exception 'Unknown customer'; end if;
  end if;
  if v_type = 'dette' and v_client is null then
    raise exception 'A customer is required for a debt sale';
  end if;

  v_applied := case when v_client is not null
                    then round(least(greatest(coalesce((p_payload ->> 'credit_applied')::numeric, 0), 0), v_ccredit, v_total), 2)
                    else 0 end;
  v_due  := round(v_total - v_applied, 2);
  v_debt := case when v_type = 'dette' then v_due else 0 end;

  v_received := (p_payload ->> 'cash_received')::numeric;
  if v_type = 'cash' and v_client is not null
     and coalesce((p_payload ->> 'save_change_as_credit')::boolean, false)
     and v_received is not null and v_received > v_due then
    v_change := round(v_received - v_due, 2);
  end if;

  v_debts   := public._split_prorata(v_debt, v_totals);
  v_used    := public._split_prorata(v_applied, v_totals);
  v_created := public._split_prorata(v_change, v_totals);

  -- Passe 2 : enregistrement, ligne par ligne
  for v_i in 1..v_n loop
    v_sale_id := gen_random_uuid();

    select qty - reserved into v_avail
      from public.stock_holdings
     where owner_id = v_uid and product_id = v_pids[v_i]
       for update;
    v_avail  := coalesce(v_avail, 0);
    v_fulfil := least(v_qtys[v_i], greatest(v_avail, 0));
    v_unf    := v_qtys[v_i] - v_fulfil;
    if v_unf > 0 and not v_offline then
      raise exception 'Not enough stock of "%": you hold % unit(s)', v_names[v_i], v_avail;
    end if;
    if v_unf > 0 then v_review := true; end if;

    insert into public.sales
      (id, group_id, product_id, client_id, user_id, qty, amount, type,
       debt_added, credit_used, credit_created, original_amount, discount_reason,
       request_id, needs_review, unfulfilled_qty)
    values
      (v_sale_id, v_group, v_pids[v_i], v_client, v_uid, v_qtys[v_i],
       round(v_totals[v_i] - v_used[v_i], 2), v_type,
       v_debts[v_i], v_used[v_i], v_created[v_i], v_origs[v_i], v_reasons[v_i],
       v_request, v_unf > 0, v_unf);

    perform public._stock_rpc_on();
    select o_cost, o_first_batch, o_first_exhausted into v_cost, v_batch, v_bex
      from public._consume_stock(v_uid, v_pids[v_i], v_fulfil, v_sale_id,
                                 case when v_offline then 'vente (sync hors-ligne)' else 'vente' end);

    update public.sales
       set cost_amount = round(coalesce(v_cost, 0) + v_unf * v_pcosts[v_i], 2),
           batch_id = v_batch,
           batch_was_exhausted = coalesce(v_bex, false)
     where id = v_sale_id;

    v_out := v_out || jsonb_build_object(
      'sale_id', v_sale_id, 'product_id', v_pids[v_i], 'qty', v_qtys[v_i],
      'amount', round(v_totals[v_i] - v_used[v_i], 2), 'unfulfilled_qty', v_unf);
  end loop;

  if v_client is not null and (v_debt <> 0 or v_change - v_applied <> 0) then
    update public.clients
       set debt   = round(debt + v_debt, 2),
           credit = round(credit + v_change - v_applied, 2)
     where id = v_client;
  end if;

  return jsonb_build_object(
    'duplicate', false, 'group_id', v_group, 'total', v_total, 'amount_due', v_due,
    'credit_applied', v_applied, 'credit_created', v_change, 'debt_added', v_debt,
    'needs_review', v_review, 'lines', v_out);
end;
$$;

-- 4b. Annulation de ventes (manager/admin) : le stock revient chez le détenteur d'origine
create or replace function public.cancel_sales(p_sale_ids uuid[])
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_count int := 0;
  s record;
  m record;
  v_batch record;
  v_has_mov boolean;
  v_new_debt numeric;
  v_new_credit numeric;
  c record;
begin
  if v_uid is null or not public.is_manager_or_admin() then
    raise exception 'Only managers can cancel sales' using errcode = '42501';
  end if;

  perform public._stock_rpc_on();

  for s in
    select * from public.sales
     where id = any (p_sale_ids) and cancelled_at is null
     order by created_at, id
       for update
  loop
    -- 1. stock : défaire les mouvements de CETTE vente, lot par lot
    if s.product_id is not null then
      v_has_mov := false;
      for m in
        select id, batch_id, delta from public.stock_movements
         where sale_id = s.id and delta < 0
      loop
        v_has_mov := true;
        select id, owner_id, exhausted_at into v_batch from public.stock_batches where id = m.batch_id for update;
        if found then
          update public.stock_batches
             set remaining_qty = remaining_qty + (-m.delta), exhausted_at = null, duration_days = null
           where id = v_batch.id;
          insert into public.stock_holdings (owner_id, product_id, qty)
          values (v_batch.owner_id, s.product_id, -m.delta)
          on conflict (owner_id, product_id)
            do update set qty = public.stock_holdings.qty + excluded.qty, updated_at = now();
          update public.products set stock = stock + (-m.delta) where id = s.product_id;
          insert into public.stock_movements (product_id, batch_id, sale_id, delta, reason, actor_id, holder_id)
          values (s.product_id, v_batch.id, s.id, -m.delta, 'Sale cancelled', v_uid, v_batch.owner_id);
        end if;
      end loop;

      -- Anciennes ventes sans mouvement lié : on rend la quantité au lot d'origine
      -- (ou, à défaut, à la personne qui annule).
      if not v_has_mov and (s.qty - coalesce(s.unfulfilled_qty, 0)) > 0 then
        if s.batch_id is not null and exists (select 1 from public.stock_batches where id = s.batch_id) then
          select id, owner_id into v_batch from public.stock_batches where id = s.batch_id for update;
          update public.stock_batches
             set remaining_qty = remaining_qty + (s.qty - coalesce(s.unfulfilled_qty, 0)),
                 exhausted_at = null, duration_days = null
           where id = v_batch.id;
          insert into public.stock_holdings (owner_id, product_id, qty)
          values (v_batch.owner_id, s.product_id, s.qty - coalesce(s.unfulfilled_qty, 0))
          on conflict (owner_id, product_id)
            do update set qty = public.stock_holdings.qty + excluded.qty, updated_at = now();
          update public.products set stock = stock + (s.qty - coalesce(s.unfulfilled_qty, 0)) where id = s.product_id;
          insert into public.stock_movements (product_id, batch_id, sale_id, delta, reason, actor_id, holder_id)
          values (s.product_id, v_batch.id, s.id, s.qty - coalesce(s.unfulfilled_qty, 0), 'Sale cancelled', v_uid, v_batch.owner_id);
        else
          insert into public.stock_batches
            (product_id, received_qty, owner_id, unit_cost, origin, remaining_qty)
          select s.product_id, s.qty - coalesce(s.unfulfilled_qty, 0), v_uid, p.cost, 'adjustment', s.qty - coalesce(s.unfulfilled_qty, 0)
            from public.products p where p.id = s.product_id
          returning id into v_batch;
          insert into public.stock_holdings (owner_id, product_id, qty)
          values (v_uid, s.product_id, s.qty - coalesce(s.unfulfilled_qty, 0))
          on conflict (owner_id, product_id)
            do update set qty = public.stock_holdings.qty + excluded.qty, updated_at = now();
          update public.products set stock = stock + (s.qty - coalesce(s.unfulfilled_qty, 0)) where id = s.product_id;
          insert into public.stock_movements (product_id, batch_id, sale_id, delta, reason, actor_id, holder_id)
          values (s.product_id, v_batch.id, s.id, s.qty - coalesce(s.unfulfilled_qty, 0), 'Sale cancelled', v_uid, v_uid);
        end if;
      end if;
    end if;

    -- 2. dette / avoir du client : inverse exact des 4 valeurs enregistrées
    if s.client_id is not null
       and (s.debt_added <> 0 or s.debt_repaid <> 0 or s.credit_used <> 0 or s.credit_created <> 0) then
      select debt, credit into c from public.clients where id = s.client_id for update;
      if found then
        v_new_debt   := round(greatest(0, c.debt   - s.debt_added   + s.debt_repaid), 2);
        v_new_credit := round(greatest(0, c.credit - s.credit_created + s.credit_used), 2);
        update public.clients set debt = v_new_debt, credit = v_new_credit where id = s.client_id;
      end if;
    end if;

    -- 3. soft-delete
    update public.sales set cancelled_at = now() where id = s.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- 4c. Approvisionnement : un lot chez l'utilisateur, avec prix d'achat ----------
create or replace function public.record_restock(p_product_id uuid, p_qty int, p_unit_cost numeric)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_batch uuid;
  v_mine int;
  v_total int;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Invalid quantity'; end if;
  if p_unit_cost is null or p_unit_cost < 0 then raise exception 'The purchase price is required'; end if;
  perform 1 from public.products where id = p_product_id for update;
  if not found then raise exception 'Unknown product'; end if;

  perform public._stock_rpc_on();

  insert into public.stock_batches (product_id, received_qty, owner_id, unit_cost, origin, remaining_qty)
  values (p_product_id, p_qty, v_uid, round(p_unit_cost, 2), 'restock', p_qty)
  returning id into v_batch;

  insert into public.stock_movements (product_id, batch_id, delta, reason, actor_id, holder_id)
  values (p_product_id, v_batch, p_qty, 'reception_carton', v_uid, v_uid);

  insert into public.stock_holdings (owner_id, product_id, qty)
  values (v_uid, p_product_id, p_qty)
  on conflict (owner_id, product_id)
    do update set qty = public.stock_holdings.qty + excluded.qty, updated_at = now();

  update public.products
     set stock = stock + p_qty,
         cost  = case when public.is_manager_or_admin() then round(p_unit_cost, 2) else cost end
   where id = p_product_id
  returning stock into v_total;

  select qty into v_mine from public.stock_holdings where owner_id = v_uid and product_id = p_product_id;
  return jsonb_build_object('batch_id', v_batch, 'stock_total', v_total, 'my_qty', v_mine);
end;
$$;

-- 4d. Ajustement manuel du stock total (manager/admin) --------------------------
--     La différence est appliquée au stock DÉTENU par la personne qui ajuste.
create or replace function public.adjust_stock(p_product_id uuid, p_new_total int)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_prod record;
  v_delta int;
  v_mine int;
  v_batch uuid;
begin
  if v_uid is null or not public.is_manager_or_admin() then
    raise exception 'Only managers can adjust stock' using errcode = '42501';
  end if;
  if p_new_total is null or p_new_total < 0 then raise exception 'Invalid stock value'; end if;

  select id, stock, cost into v_prod from public.products where id = p_product_id for update;
  if not found then raise exception 'Unknown product'; end if;

  v_delta := p_new_total - v_prod.stock;
  if v_delta = 0 then
    return jsonb_build_object('stock_total', v_prod.stock);
  end if;

  perform public._stock_rpc_on();
  select coalesce(qty, 0) into v_mine from public.stock_holdings
   where owner_id = v_uid and product_id = p_product_id for update;
  v_mine := coalesce(v_mine, 0);

  if v_delta > 0 then
    insert into public.stock_batches (product_id, received_qty, owner_id, unit_cost, origin, remaining_qty)
    values (p_product_id, v_delta, v_uid, v_prod.cost, 'adjustment', v_delta)
    returning id into v_batch;
    insert into public.stock_movements (product_id, batch_id, delta, reason, actor_id, holder_id)
    values (p_product_id, v_batch, v_delta, 'Manual adjustment', v_uid, v_uid);
    insert into public.stock_holdings (owner_id, product_id, qty)
    values (v_uid, p_product_id, v_delta)
    on conflict (owner_id, product_id)
      do update set qty = public.stock_holdings.qty + excluded.qty, updated_at = now();
    update public.products set stock = stock + v_delta where id = p_product_id;
  else
    if v_mine < -v_delta then
      raise exception 'You hold only % unit(s) of this product: the other units belong to other holders.', v_mine;
    end if;
    perform 1 from public._consume_stock(v_uid, p_product_id, -v_delta, null, 'Manual adjustment');
  end if;

  return jsonb_build_object('stock_total', p_new_total);
end;
$$;

-- 4e. Vue d'ensemble : qui détient quoi (tout utilisateur actif) -----------------
create or replace function public.stock_overview()
returns table (product_id uuid, owner_id uuid, owner_name text, qty int, reserved int)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select h.product_id, h.owner_id,
           coalesce(nullif(btrim(p.display_name), ''), split_part(p.email, '@', 1)),
           h.qty, h.reserved
      from public.stock_holdings h
      join public.profiles p on p.id = h.owner_id
     where h.qty > 0
     order by h.product_id, h.qty desc;
end;
$$;

revoke all on function
  public._try_uuid(text), public._stock_rpc_on(), public._split_prorata(numeric, numeric[]),
  public._consume_stock(uuid, uuid, int, uuid, text),
  public.record_sale(jsonb), public.cancel_sales(uuid[]),
  public.record_restock(uuid, int, numeric), public.adjust_stock(uuid, int), public.stock_overview()
  from public, anon, authenticated;
grant execute on function
  public.record_sale(jsonb), public.cancel_sales(uuid[]),
  public.record_restock(uuid, int, numeric), public.adjust_stock(uuid, int), public.stock_overview()
  to authenticated;

-- 5. Verrou : products.stock ne bouge que via les fonctions ---------------------
create or replace function public.guard_products_stock()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null or coalesce(current_setting('app.stock_rpc', true), '') = '1' then
    return new;   -- éditeur SQL / service role / fonction métier
  end if;
  if tg_op = 'INSERT' then
    new.stock := 0;                               -- le stock initial passe par record_restock
  elsif new.stock is distinct from old.stock then
    raise exception 'Stock can only be changed through stock operations (restock, sale, adjustment)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_products_stock on public.products;
create trigger trg_guard_products_stock
  before insert or update on public.products
  for each row execute function public.guard_products_stock();

-- Les garde-fous « cashier » de la phase 1 sont remplacés : un cashier ne modifie plus rien directement
drop trigger if exists trg_guard_products_cashier on public.products;
drop trigger if exists trg_guard_clients_cashier  on public.clients;
drop trigger if exists trg_guard_batches_cashier  on public.stock_batches;
drop function if exists public.guard_cashier_update();

-- 6. Règles d'accès (RLS) -------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
     where schemaname = 'public'
       and tablename in ('products','clients','sales','stock_movements','stock_batches','stock_holdings')
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

revoke all on public.stock_holdings from anon;
revoke insert, update, delete on public.stock_holdings, public.stock_batches, public.stock_movements from authenticated;
revoke update, delete on public.sales from authenticated;

-- products / clients : lecture par tout utilisateur actif ; écriture manager/admin seulement
create policy products_select on public.products for select to authenticated using (public.is_active_user());
create policy products_insert on public.products for insert to authenticated with check (public.is_manager_or_admin());
create policy products_update on public.products for update to authenticated
  using (public.is_manager_or_admin()) with check (public.is_manager_or_admin());
create policy products_delete on public.products for delete to authenticated using (public.is_manager_or_admin());

create policy clients_select on public.clients for select to authenticated using (public.is_active_user());
create policy clients_insert on public.clients for insert to authenticated with check (public.is_manager_or_admin());
create policy clients_update on public.clients for update to authenticated
  using (public.is_manager_or_admin()) with check (public.is_manager_or_admin());
create policy clients_delete on public.clients for delete to authenticated using (public.is_manager_or_admin());

-- sales : un cashier lit ses ventes ; les ventes s'enregistrent et s'annulent via
-- record_sale / cancel_sales. Le manager/admin peut encore insérer des lignes
-- de règlement (écran Clients).
create policy sales_select on public.sales for select to authenticated
  using (public.is_manager_or_admin() or (public.is_active_user() and user_id = auth.uid()));
create policy sales_insert on public.sales for insert to authenticated
  with check (public.is_manager_or_admin());

-- stock : lecture seule. Un cashier ne voit que ses lots (et leur coût) ; le
-- stock des autres passe par stock_overview().
create policy stock_batches_select on public.stock_batches for select to authenticated
  using (public.is_manager_or_admin() or owner_id = auth.uid());
create policy stock_movements_select on public.stock_movements for select to authenticated
  using (public.is_manager_or_admin() or actor_id = auth.uid() or holder_id = auth.uid());
create policy stock_holdings_select on public.stock_holdings for select to authenticated
  using (public.is_manager_or_admin() or owner_id = auth.uid());

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VÉRIFICATIONS APRÈS COUP :
--   select p.name, p.stock, h.owner, h.qty
--     from public.products p
--     left join (select product_id, string_agg(owner_id::text, ',') owner, sum(qty) qty
--                  from public.stock_holdings group by 1) h on h.product_id = p.id
--    order by p.name;
--   select origin, count(*), sum(remaining_qty) from public.stock_batches group by 1;
--
-- Limites connues (phase 3 ou suivantes) :
--   • un cashier peut encore lire products.cost (prix d'achat de référence du
--     catalogue) ; ses propres lots ont leur prix réel dans stock_batches ;
--   • transferts, demandes de stock, réattribution, notifications, inventaire
--     et écarts : phase 3 (stock_holdings.reserved est déjà prévu) ;
--   • l'approvisionnement exige d'être en ligne.
-- ═══════════════════════════════════════════════════════════════════════════
