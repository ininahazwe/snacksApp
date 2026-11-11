-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3b — Réattribution du stock par un manager, inventaire et écarts
--            par détenteur
-- ═══════════════════════════════════════════════════════════════════════════
-- Prérequis : la phase 3a (phase3a_transferts_notifications.sql) est exécutée.
-- À exécuter dans Supabase → SQL Editor. Le script est rejouable.
--
-- ⚠️ Avant : faire une sauvegarde (backup-scripts/backup_supabase.sh).
-- ⚠️ Essai à blanc possible : remplacer le COMMIT final par ROLLBACK.
--
-- Comme pour la phase 3a, l'ancien front continue de fonctionner après ce
-- script : on peut exécuter le SQL d'abord, puis déployer le front.
--
-- Règles appliquées (spec, sections 4 et 7 ; décisions du 11 nov. 2026) :
--   • Inventaire : un utilisateur compte un produit de SON stock. S'il y a un
--     écart, il est appliqué TOUT DE SUITE avec un motif (casse, péremption,
--     perte, vol, erreur de comptage, autre) ; les managers/admins sont
--     prévenus et voient les écarts par personne.
--   • Un cashier ne peut déclarer que des MANQUES. Un excédent (plus d'unités
--     que prévu) ne peut être enregistré que par un manager/admin ; il entre
--     au prix d'achat du catalogue (products.cost).
--   • Un manager/admin peut compter le stock de quelqu'un d'autre (la personne
--     est prévenue).
--   • On ne compte pas un produit dont des unités sont « en transit » (transfert
--     en attente) : il faut d'abord que le transfert soit accepté, refusé ou
--     annulé — sinon on ne sait pas si ces unités sont encore sur place.
--   • Réattribution (manager/admin) : déplace tout ou partie du stock d'une
--     personne vers une autre SANS acceptation, au même prix d'achat. Sert au
--     départ d'un vendeur (le compte source peut être désactivé). Les
--     transferts en attente de la personne source sont réduits ou annulés si
--     nécessaire ; les deux parties sont prévenues ; tout est tracé dans
--     l'historique des transferts (kind = 'reassignment').
--
-- Verrous : même règle que la phase 3a (produit d'abord, dans l'ordre des
-- identifiants, puis stock détenu, transfert, lots).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- 0. Garde-fou ------------------------------------------------------------------
do $$
begin
  if to_regclass('public.stock_transfers') is null
     or to_regprocedure('public._move_stock(uuid, uuid, uuid, int, uuid, text)') is null
     or to_regprocedure('public.transfers_inbox(boolean)') is null then
    raise exception 'La phase 3a doit être exécutée avant la phase 3b.';
  end if;
end $$;

-- 1. Schéma ---------------------------------------------------------------------
-- Déclarations d'inventaire. delta = compté − attendu (négatif = manque).
-- value_delta = valeur de l'écart au prix d'achat des lots (négatif = perte).
create table if not exists public.stock_counts (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id),
  declared_by  uuid not null references auth.users(id),
  product_id   uuid not null references public.products(id),
  expected_qty integer not null check (expected_qty >= 0),
  counted_qty  integer not null check (counted_qty >= 0),
  delta        integer not null,
  reason       text check (reason is null or reason in
                 ('damaged', 'expired', 'lost', 'stolen', 'count_error', 'found', 'other')),
  note         text,
  value_delta  numeric not null default 0,
  client_ref   uuid,
  created_at   timestamptz not null default now(),
  check (delta = counted_qty - expected_qty),
  check (delta = 0 or reason is not null)
);

create index if not exists idx_stock_counts_owner   on public.stock_counts (owner_id, created_at desc);
create index if not exists idx_stock_counts_product on public.stock_counts (owner_id, product_id, created_at desc);
create unique index if not exists uq_stock_counts_client_ref on public.stock_counts (client_ref) where client_ref is not null;

-- Qui a fait l'opération (utile pour une réattribution : ni l'expéditeur ni le bénéficiaire)
alter table public.stock_transfers
  add column if not exists created_by uuid references auth.users(id);
update public.stock_transfers set created_by = from_user where created_by is null;

create index if not exists idx_stock_movements_holder on public.stock_movements (holder_id, created_at desc);

-- 2. Fonctions de la phase 3a mises à jour ------------------------------------------

-- 2a. _transfer_json : ajoute l'auteur de l'opération (réattribution)
create or replace function public._transfer_json(t public.stock_transfers)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'status', t.status,
    'product_id', t.product_id, 'product_name', p.name, 'product_emoji', p.emoji, 'product_color', p.color,
    'qty', t.qty, 'qty_sent', t.qty_sent, 'qty_accepted', t.qty_accepted,
    'from_user', t.from_user, 'from_name', public._user_label(t.from_user),
    'to_user', t.to_user, 'to_name', public._user_label(t.to_user),
    'created_by', coalesce(t.created_by, t.from_user),
    'created_by_name', public._user_label(coalesce(t.created_by, t.from_user)),
    'note', t.note, 'refusal_reason', t.refusal_reason, 'request_id', t.request_id,
    'created_at', t.created_at, 'responded_at', t.responded_at, 'expires_at', t.expires_at)
  from public.products p where p.id = t.product_id;
$$;

-- 2b. _cap_pending_transfers : même logique que la phase 3a, avec la cause.
--     'offline_sale' (défaut, appelé par record_sale) : la marchandise a été
--     vendue hors-ligne ; expéditeur, bénéficiaire et managers sont prévenus.
--     'reassignment' : le stock est réattribué par un manager ; seul le
--     bénéficiaire du transfert est prévenu ici (l'expéditeur reçoit le
--     récapitulatif de la réattribution).
drop function if exists public._cap_pending_transfers(uuid, uuid, int);

create or replace function public._cap_pending_transfers(
  p_owner uuid, p_product uuid, p_needed int, p_cause text default 'offline_sale'
)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  t record;
  m record;
  v_left  int := p_needed;
  v_take  int;
  v_freed int := 0;
  v_payload jsonb;
begin
  if p_needed is null or p_needed <= 0 then return 0; end if;

  for t in
    select id, qty, to_user from public.stock_transfers
     where from_user = p_owner and product_id = p_product and status = 'pending'
     order by created_at desc, id
       for update
  loop
    exit when v_left = 0;
    v_take := least(v_left, t.qty);
    if v_take = t.qty then
      update public.stock_transfers
         set status = 'cancelled', responded_at = now(),
             refusal_reason = case when p_cause = 'reassignment'
               then 'The sender''s stock was reassigned by a manager before the transfer was accepted'
               else 'Sold by the sender while offline, before the transfer was accepted' end
       where id = t.id;
    else
      update public.stock_transfers set qty = qty - v_take where id = t.id;
    end if;

    v_payload := public._transfer_payload(t.id)
                 || jsonb_build_object('qty_sold', v_take, 'qty_left', t.qty - v_take, 'cause', p_cause);
    perform public._notify(t.to_user, 'transfer_capped', v_payload);
    if p_cause is distinct from 'reassignment' then
      perform public._notify(p_owner, 'transfer_capped', v_payload);
      for m in
        select id from public.profiles
         where active and role in ('manager', 'admin') and id not in (p_owner, t.to_user)
      loop
        perform public._notify(m.id, 'transfer_capped', v_payload);
      end loop;
    end if;

    v_left  := v_left - v_take;
    v_freed := v_freed + v_take;
  end loop;

  if v_freed > 0 then
    update public.stock_holdings
       set reserved = greatest(reserved - v_freed, 0), updated_at = now()
     where owner_id = p_owner and product_id = p_product;
  end if;
  return v_freed;
end;
$$;

-- 2c. transfers_inbox : identique à la phase 3a ; l'historique « Mine » inclut
--     aussi les réattributions que j'ai faites pour d'autres personnes.
create or replace function public.transfers_inbox(p_all boolean default false)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_all boolean;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  perform public._expire_stale();
  v_all := coalesce(p_all, false) and public.is_manager_or_admin();

  return jsonb_build_object(
    'incoming', coalesce((
      select jsonb_agg(public._transfer_json(t) order by t.created_at)
        from public.stock_transfers t
       where t.to_user = v_uid and t.status = 'pending'), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(public._transfer_json(t) order by t.created_at)
        from public.stock_transfers t
       where t.from_user = v_uid and t.status = 'pending'), '[]'::jsonb),
    'requests_in', coalesce((
      select jsonb_agg(public._request_json(r) order by r.created_at)
        from public.stock_requests r
       where r.target_user = v_uid and r.status = 'pending'), '[]'::jsonb),
    'requests_out', coalesce((
      select jsonb_agg(public._request_json(r) order by r.created_at)
        from public.stock_requests r
       where r.requester = v_uid and r.status = 'pending'), '[]'::jsonb),
    'history_transfers', coalesce((
      select jsonb_agg(public._transfer_json(x) order by coalesce(x.responded_at, x.created_at) desc)
        from (select * from public.stock_transfers t
               where (t.status <> 'pending' or v_all)
                 and (v_all or t.from_user = v_uid or t.to_user = v_uid or t.created_by = v_uid)
                 and not (t.status = 'pending' and (t.from_user = v_uid or t.to_user = v_uid))
               order by coalesce(t.responded_at, t.created_at) desc
               limit 80) x), '[]'::jsonb),
    'history_requests', coalesce((
      select jsonb_agg(public._request_json(x) order by coalesce(x.responded_at, x.created_at) desc)
        from (select * from public.stock_requests r
               where (r.status <> 'pending' or v_all)
                 and (v_all or r.requester = v_uid or r.target_user = v_uid)
                 and not (r.status = 'pending' and (r.requester = v_uid or r.target_user = v_uid))
               order by coalesce(r.responded_at, r.created_at) desc
               limit 80) x), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id, 'type', n.type, 'payload', n.payload,
               'read_at', n.read_at, 'created_at', n.created_at) order by n.created_at desc)
        from (select * from public.notifications
               where user_id = v_uid
               order by created_at desc
               limit 40) n), '[]'::jsonb)
  );
end;
$$;

-- 3. Inventaire -------------------------------------------------------------------
-- p_counted = nombre d'unités réellement comptées pour ce produit.
-- p_owner   = personne dont on compte le stock (soi-même par défaut ; un
--             manager/admin peut compter le stock de quelqu'un d'autre).
-- p_reason  = obligatoire s'il y a un écart : damaged | expired | lost | stolen
--             | count_error | other (manque) ; found | count_error | other
--             (excédent, manager/admin seulement). p_note obligatoire si 'other'.
create or replace function public.declare_inventory(
  p_product uuid, p_counted int,
  p_reason text default null, p_note text default null,
  p_owner uuid default null, p_client_ref uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_owner  uuid := coalesce(p_owner, auth.uid());
  v_mgr    boolean;
  v_prod   record;
  v_qty    int;
  v_res    int;
  v_delta  int;
  v_value  numeric := 0;
  v_batch  uuid;
  v_id     uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_payload jsonb;
  m record;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  v_mgr := public.is_manager_or_admin();
  if v_owner <> v_uid and not v_mgr then
    raise exception 'You can only count your own stock' using errcode = '42501';
  end if;

  if p_client_ref is not null then
    select id into v_id from public.stock_counts where client_ref = p_client_ref;
    if found then
      return jsonb_build_object('duplicate', true, 'count_id', v_id);
    end if;
  end if;

  if p_counted is null or p_counted < 0 then raise exception 'Invalid quantity'; end if;
  if not exists (select 1 from public.profiles where id = v_owner) then
    raise exception 'Unknown user';
  end if;

  select id, name, emoji, cost into v_prod from public.products where id = p_product for update;   -- verrou produit
  if not found then raise exception 'Unknown product'; end if;

  select qty, reserved into v_qty, v_res
    from public.stock_holdings
   where owner_id = v_owner and product_id = p_product
     for update;
  v_qty := coalesce(v_qty, 0);
  v_res := coalesce(v_res, 0);
  v_delta := p_counted - v_qty;

  if v_delta = 0 then
    v_reason := null;                       -- comptage conforme : rien à corriger
  else
    if v_res > 0 then
      raise exception '% unit(s) of "%" are in transit to a colleague: wait for the answer or cancel the transfer before counting this product',
        v_res, v_prod.name;
    end if;
    if v_delta > 0 and not v_mgr then
      raise exception 'You counted more than expected (% instead of %). Only a manager can record a surplus: ask a manager to check.',
        p_counted, v_qty using errcode = '42501';
    end if;
    if v_reason is null then
      raise exception 'A reason is required when the count differs from the expected stock';
    end if;
    if v_delta < 0 and v_reason not in ('damaged', 'expired', 'lost', 'stolen', 'count_error', 'other') then
      raise exception 'Invalid reason for a shortage';
    end if;
    if v_delta > 0 and v_reason not in ('found', 'count_error', 'other') then
      raise exception 'Invalid reason for a surplus';
    end if;
    if v_reason = 'other' and v_note is null then
      raise exception 'Please describe the reason';
    end if;
  end if;

  perform public._stock_rpc_on();

  if v_delta < 0 then
    -- Manque : sorti des lots de la personne (FIFO), valorisé au prix d'achat réel
    select o_cost into v_value
      from public._consume_stock(v_owner, p_product, -v_delta, null, 'inventory_' || v_reason);
    v_value := -coalesce(v_value, 0);
  elsif v_delta > 0 then
    -- Excédent (manager/admin) : lot d'ajustement au prix d'achat du catalogue
    insert into public.stock_batches (product_id, received_qty, owner_id, unit_cost, origin, remaining_qty)
    values (p_product, v_delta, v_owner, coalesce(v_prod.cost, 0), 'adjustment', v_delta)
    returning id into v_batch;
    insert into public.stock_movements (product_id, batch_id, delta, reason, actor_id, holder_id)
    values (p_product, v_batch, v_delta, 'inventory_' || v_reason, v_uid, v_owner);
    insert into public.stock_holdings (owner_id, product_id, qty)
    values (v_owner, p_product, v_delta)
    on conflict (owner_id, product_id)
      do update set qty = public.stock_holdings.qty + excluded.qty, updated_at = now();
    update public.products set stock = stock + v_delta where id = p_product;
    v_value := round(v_delta * coalesce(v_prod.cost, 0), 2);
  end if;

  insert into public.stock_counts
    (owner_id, declared_by, product_id, expected_qty, counted_qty, delta, reason, note, value_delta, client_ref)
  values
    (v_owner, v_uid, p_product, v_qty, p_counted, v_delta, v_reason, v_note, round(v_value, 2), p_client_ref)
  returning id into v_id;

  -- Écart : les managers/admins sont prévenus, ainsi que la personne si un
  -- manager a compté son stock à sa place.
  if v_delta <> 0 then
    v_payload := jsonb_build_object(
      'count_id', v_id, 'product_id', p_product, 'product_name', v_prod.name, 'product_emoji', v_prod.emoji,
      'owner', v_owner, 'owner_name', public._user_label(v_owner),
      'declared_by', v_uid, 'declared_by_name', public._user_label(v_uid),
      'expected_qty', v_qty, 'counted_qty', p_counted, 'delta', v_delta,
      'reason', v_reason, 'note', v_note, 'value_delta', round(v_value, 2));
    for m in
      select id from public.profiles
       where active and role in ('manager', 'admin') and id not in (v_uid, v_owner)
    loop
      perform public._notify(m.id, 'inventory_discrepancy', v_payload);
    end loop;
    if v_owner <> v_uid then
      perform public._notify(v_owner, 'inventory_discrepancy', v_payload);
    end if;
  end if;

  return jsonb_build_object(
    'duplicate', false, 'count_id', v_id, 'expected_qty', v_qty, 'counted_qty', p_counted,
    'delta', v_delta, 'value_delta', round(v_value, 2));
end;
$$;

-- 4. Réattribution (manager/admin) ---------------------------------------------------
-- p_product null  → tout le stock de p_from (tous les produits) ;
-- p_qty null      → tout le stock de p_from pour ce produit ;
-- sinon           → p_qty unités de ce produit.
-- Appliquée sans acceptation. Le compte source peut être inactif (départ).
create or replace function public.reassign_stock(
  p_from uuid, p_to uuid,
  p_product uuid default null, p_qty int default null,
  p_note text default null, p_client_ref uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_pids  uuid[];
  v_pid   uuid;
  v_prod  record;
  v_qty   int;
  v_res   int;
  v_n     int;
  v_tid   uuid;
  v_first boolean := true;
  v_items jsonb := '[]'::jsonb;
  v_total int := 0;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_payload jsonb;
begin
  if v_uid is null or not public.is_manager_or_admin() then
    raise exception 'Only managers can reassign stock' using errcode = '42501';
  end if;

  if p_client_ref is not null then
    if exists (select 1 from public.stock_transfers where client_ref = p_client_ref) then
      return jsonb_build_object('duplicate', true);
    end if;
  end if;

  if p_from is null or p_to is null or p_from = p_to then
    raise exception 'Choose two different people';
  end if;
  if not exists (select 1 from public.profiles where id = p_from) then
    raise exception 'Unknown user';
  end if;
  if not exists (select 1 from public.profiles where id = p_to and active) then
    raise exception 'The person receiving the stock must have an active account';
  end if;
  if p_qty is not null and (p_product is null or p_qty <= 0) then
    raise exception 'Invalid quantity';
  end if;
  if p_product is not null and not exists (select 1 from public.products where id = p_product) then
    raise exception 'Unknown product';
  end if;

  -- Produits concernés, puis verrou par produit dans l'ordre des identifiants
  select coalesce(array_agg(product_id order by product_id), '{}') into v_pids
    from public.stock_holdings
   where owner_id = p_from and qty > 0 and (p_product is null or product_id = p_product);
  perform 1 from public.products where id = any (v_pids) order by id for update;
  perform public._expire_stale();

  foreach v_pid in array v_pids loop
    select name, emoji into v_prod from public.products where id = v_pid;

    -- Verrous : stocks détenus des deux personnes (ordre fixe)
    insert into public.stock_holdings (owner_id, product_id, qty)
    values (p_to, v_pid, 0)
    on conflict (owner_id, product_id) do nothing;
    perform 1 from public.stock_holdings
      where product_id = v_pid and owner_id in (p_from, p_to)
      order by owner_id
        for update;

    select qty, reserved into v_qty, v_res
      from public.stock_holdings where owner_id = p_from and product_id = v_pid;
    v_qty := coalesce(v_qty, 0);
    v_res := coalesce(v_res, 0);
    v_n   := coalesce(p_qty, v_qty);
    if v_n > v_qty then
      raise exception '% holds only % unit(s) of "%"', public._user_label(p_from), v_qty, v_prod.name;
    end if;
    continue when v_n <= 0;

    -- Si le stock libre ne suffit pas, on prend sur les unités réservées :
    -- les transferts en attente de la personne sont réduits ou annulés.
    if v_n > v_qty - v_res then
      perform public._cap_pending_transfers(p_from, v_pid, v_n - (v_qty - v_res), 'reassignment');
    end if;

    insert into public.stock_transfers
      (from_user, to_user, product_id, qty, qty_sent, qty_accepted, status, kind,
       note, created_by, client_ref, responded_at)
    values
      (p_from, p_to, v_pid, v_n, v_n, v_n, 'accepted', 'reassignment',
       v_note, v_uid, case when v_first then p_client_ref end, now())
    returning id into v_tid;
    v_first := false;

    perform public._move_stock(p_from, p_to, v_pid, v_n, v_tid, 'reassignment');

    update public.stock_holdings
       set qty = qty - v_n, updated_at = now()
     where owner_id = p_from and product_id = v_pid;
    update public.stock_holdings
       set qty = qty + v_n, updated_at = now()
     where owner_id = p_to and product_id = v_pid;

    v_items := v_items || jsonb_build_object(
      'product_id', v_pid, 'product_name', v_prod.name, 'product_emoji', v_prod.emoji, 'qty', v_n);
    v_total := v_total + v_n;
  end loop;

  if v_total = 0 then
    raise exception '% has no stock to reassign', public._user_label(p_from);
  end if;

  v_payload := jsonb_build_object(
    'from_user', p_from, 'from_name', public._user_label(p_from),
    'to_user', p_to, 'to_name', public._user_label(p_to),
    'by', v_uid, 'by_name', public._user_label(v_uid),
    'note', v_note, 'total_qty', v_total, 'product_count', jsonb_array_length(v_items),
    'items', v_items);
  if p_from <> v_uid then perform public._notify(p_from, 'stock_reassigned', v_payload); end if;
  if p_to   <> v_uid then perform public._notify(p_to,   'stock_reassigned', v_payload); end if;

  return jsonb_build_object('duplicate', false, 'total_qty', v_total,
                            'product_count', jsonb_array_length(v_items), 'items', v_items);
end;
$$;

-- 5. Lecture : responsabilité par détenteur ----------------------------------------------

-- Une ligne par personne : unités détenues, valeur (au prix d'achat des lots),
-- écarts des 30 derniers jours. Manager/admin : toute l'équipe (comptes actifs,
-- et comptes inactifs qui détiennent encore du stock). Cashier : sa ligne.
create or replace function public.holders_summary()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mgr boolean;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  v_mgr := public.is_manager_or_admin();

  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.active desc, x.units desc, x.name)
      from (
        select p.id as user_id, public._user_label(p.id) as name, p.role, p.active,
               coalesce(h.units, 0)    as units,
               coalesce(h.reserved, 0) as reserved,
               coalesce(h.products, 0) as products,
               round(coalesce(b.value, 0), 2) as value,
               coalesce(c.discrepancies, 0)   as discrepancies_30d,
               coalesce(c.short_units, 0)     as short_units_30d,
               round(coalesce(c.short_value, 0), 2) as short_value_30d,
               coalesce(c.surplus_units, 0)   as surplus_units_30d,
               lc.last_count_at
          from public.profiles p
          left join (select owner_id, sum(qty) as units, sum(reserved) as reserved,
                            count(*) filter (where qty > 0) as products
                       from public.stock_holdings group by 1) h on h.owner_id = p.id
          left join (select owner_id, sum(remaining_qty * coalesce(unit_cost, 0)) as value
                       from public.stock_batches where remaining_qty > 0 group by 1) b on b.owner_id = p.id
          left join (select owner_id,
                            count(*) filter (where delta <> 0) as discrepancies,
                            -sum(delta) filter (where delta < 0) as short_units,
                            -sum(value_delta) filter (where delta < 0) as short_value,
                            sum(delta) filter (where delta > 0) as surplus_units
                       from public.stock_counts
                      where created_at > now() - interval '30 days' group by 1) c on c.owner_id = p.id
          left join (select owner_id, max(created_at) as last_count_at
                       from public.stock_counts group by 1) lc on lc.owner_id = p.id
         where (v_mgr or p.id = v_uid)
           and (p.active or coalesce(h.units, 0) > 0)
      ) x), '[]'::jsonb);
end;
$$;

-- Détail d'une personne : stock détenu par produit (avec valeur et dernier
-- comptage), derniers comptages, journal de ses mouvements de stock.
-- Soi-même, ou n'importe qui pour un manager/admin.
create or replace function public.holder_detail(p_owner uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid := coalesce(p_owner, auth.uid());
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_owner <> v_uid and not public.is_manager_or_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'user_id', v_owner,
    'name', public._user_label(v_owner),
    'holdings', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.product_name)
        from (
          select h.product_id, p.name as product_name, p.emoji as product_emoji, p.color as product_color,
                 h.qty, h.reserved,
                 round(coalesce((select sum(b.remaining_qty * coalesce(b.unit_cost, 0))
                                   from public.stock_batches b
                                  where b.owner_id = h.owner_id and b.product_id = h.product_id
                                    and b.remaining_qty > 0), 0), 2) as value,
                 (select max(c.created_at) from public.stock_counts c
                   where c.owner_id = h.owner_id and c.product_id = h.product_id) as last_count_at
            from public.stock_holdings h
            join public.products p on p.id = h.product_id
           where h.owner_id = v_owner and h.qty > 0
        ) x), '[]'::jsonb),
    'counts', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
        from (
          select c.id, c.product_id, p.name as product_name, p.emoji as product_emoji, p.color as product_color,
                 c.expected_qty, c.counted_qty, c.delta, c.reason, c.note, c.value_delta,
                 c.declared_by, public._user_label(c.declared_by) as declared_by_name, c.created_at
            from public.stock_counts c
            join public.products p on p.id = c.product_id
           where c.owner_id = v_owner
           order by c.created_at desc
           limit 60
        ) x), '[]'::jsonb),
    'movements', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id)
        from (
          select m.id, m.product_id, p.name as product_name, p.emoji as product_emoji,
                 m.delta, m.reason, m.created_at,
                 m.actor_id, public._user_label(m.actor_id) as actor_name,
                 (m.sale_id is not null) as is_sale, (m.transfer_id is not null) as is_transfer
            from public.stock_movements m
            left join public.products p on p.id = m.product_id
           where m.holder_id = v_owner
           order by m.created_at desc, m.id
           limit 120
        ) x), '[]'::jsonb)
  );
end;
$$;

-- 6. Droits -------------------------------------------------------------------------
revoke all on function
  public._transfer_json(public.stock_transfers),
  public._cap_pending_transfers(uuid, uuid, int, text),
  public.transfers_inbox(boolean),
  public.declare_inventory(uuid, int, text, text, uuid, uuid),
  public.reassign_stock(uuid, uuid, uuid, int, text, uuid),
  public.holders_summary(), public.holder_detail(uuid)
  from public, anon, authenticated;

grant execute on function
  public.transfers_inbox(boolean),
  public.declare_inventory(uuid, int, text, text, uuid, uuid),
  public.reassign_stock(uuid, uuid, uuid, int, text, uuid),
  public.holders_summary(), public.holder_detail(uuid)
  to authenticated;

-- 7. Règles d'accès (RLS) : lecture seule, écritures uniquement via les fonctions ------
alter table public.stock_counts enable row level security;
revoke all on public.stock_counts from anon, authenticated;
grant select on public.stock_counts to authenticated;

drop policy if exists stock_counts_select on public.stock_counts;
create policy stock_counts_select on public.stock_counts for select to authenticated
  using (public.is_manager_or_admin()
         or (public.is_active_user() and (owner_id = auth.uid() or declared_by = auth.uid())));

insert into public.app_migrations (name) values ('phase3b_reattribution_inventaire')
on conflict (name) do nothing;

-- Contrôles de cohérence : stock, lots, réservations
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
    raise warning 'Stock incohérent, à examiner (ce script ne modifie pas le stock) : %', v_bad;
  end if;
end $$;

commit;

-- Demande à l'API Supabase (PostgREST) de relire le schéma : les nouvelles
-- fonctions sont appelables tout de suite.
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- VÉRIFICATIONS APRÈS COUP :
--   select has_table_privilege('anon', 'public.stock_counts', 'select');                 -- false
--   select has_function_privilege('anon', 'public.holders_summary()', 'execute');        -- false
--   select has_function_privilege('authenticated',
--          'public._cap_pending_transfers(uuid, uuid, int, text)', 'execute');           -- false
--   -- écarts par personne sur 30 jours :
--   select public._user_label(owner_id), count(*), sum(delta), sum(value_delta)
--     from public.stock_counts
--    where delta <> 0 and created_at > now() - interval '30 days' group by 1;
-- ═══════════════════════════════════════════════════════════════════════════
