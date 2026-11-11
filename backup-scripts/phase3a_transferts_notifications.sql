-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3a — Transferts de stock entre utilisateurs, demandes de stock,
--            notifications (pastille + boîte « Transfers »)
-- ═══════════════════════════════════════════════════════════════════════════
-- Prérequis : la phase 2 (phase2_stock_par_utilisateur.sql) est exécutée.
-- À exécuter dans Supabase → SQL Editor. Le script est rejouable.
--
-- ⚠️ Avant : faire une sauvegarde (backup-scripts/backup_supabase.sh).
-- ⚠️ Essai à blanc possible : remplacer le COMMIT final par ROLLBACK.
--
-- Contrairement à la phase 2, l'ancien front continue de fonctionner après ce
-- script (rien n'est retiré) : on peut exécuter le SQL d'abord, puis déployer
-- le front.
--
-- Règles appliquées (spec, sections 4 à 6) :
--   • Envoi : la quantité est RÉSERVÉE chez l'expéditeur (« en transit »,
--     invendable) ; rien n'est débité tant que le bénéficiaire n'a pas accepté.
--   • Acceptation totale ou partielle : les unités acceptées quittent les lots
--     de l'expéditeur (FIFO) et deviennent des lots du bénéficiaire, au MÊME
--     prix d'achat ; le reste revient à l'expéditeur.
--   • Refus : motif obligatoire. Annulation : par l'expéditeur, tant que le
--     transfert est en attente. Sans réponse après 72 h : expiration, le stock
--     de l'expéditeur n'est pas débité et il en est prévenu.
--   • Demande de stock : un utilisateur demande une quantité à un collègue qui
--     détient le produit ; celui-ci répond par un transfert ou décline (motif).
--   • Vente hors-ligne synchronisée au-delà du stock libre : la marchandise
--     est déjà partie, donc la vente prend sur les unités réservées ; les
--     transferts en attente concernés sont plafonnés (ou annulés s'il ne reste
--     rien) et expéditeur, bénéficiaire et managers sont prévenus.
--   • Toutes les écritures passent par des fonctions atomiques ; aucune
--     écriture directe sur les nouvelles tables.
--
-- Verrous (pour éviter les interblocages entre opérations simultanées) :
-- toute opération qui touche au stock d'un produit verrouille d'abord la
-- ligne du produit (dans l'ordre des identifiants s'il y en a plusieurs),
-- puis le stock détenu, puis le transfert, puis les lots. record_sale et
-- cancel_sales (phase 2) sont mis à jour ici pour suivre la même règle.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- 0. Garde-fou ------------------------------------------------------------------
do $$
begin
  if to_regclass('public.stock_holdings') is null
     or to_regprocedure('public.record_sale(jsonb)') is null
     or to_regprocedure('public._consume_stock(uuid, uuid, int, uuid, text)') is null then
    raise exception 'La phase 2 doit être exécutée avant la phase 3a.';
  end if;
end $$;

-- 1. Tables ---------------------------------------------------------------------
create table if not exists public.stock_requests (
  id             uuid primary key default gen_random_uuid(),
  requester      uuid not null references auth.users(id),
  target_user    uuid not null references auth.users(id),
  product_id     uuid not null references public.products(id),
  qty            integer not null check (qty > 0),
  note           text,
  status         text not null default 'pending'
                 check (status in ('pending', 'fulfilled', 'declined', 'cancelled', 'expired')),
  decline_reason text,
  client_ref     uuid,
  created_at     timestamptz not null default now(),
  responded_at   timestamptz,
  expires_at     timestamptz not null default (now() + interval '72 hours'),
  check (requester <> target_user)
);

-- qty      = quantité actuellement proposée / réservée chez l'expéditeur
-- qty_sent = quantité envoyée à l'origine (qty peut baisser si l'expéditeur a
--            vendu hors-ligne une partie du stock réservé)
create table if not exists public.stock_transfers (
  id             uuid primary key default gen_random_uuid(),
  from_user      uuid not null references auth.users(id),
  to_user        uuid not null references auth.users(id),
  product_id     uuid not null references public.products(id),
  qty            integer not null check (qty > 0),
  qty_sent       integer not null check (qty_sent > 0),
  qty_accepted   integer check (qty_accepted is null or qty_accepted >= 0),
  status         text not null default 'pending'
                 check (status in ('pending', 'accepted', 'partially_accepted', 'refused', 'cancelled', 'expired')),
  kind           text not null default 'transfer' check (kind in ('transfer', 'reassignment')),
  note           text,
  refusal_reason text,
  request_id     uuid references public.stock_requests(id),
  client_ref     uuid,
  created_at     timestamptz not null default now(),
  responded_at   timestamptz,
  expires_at     timestamptz not null default (now() + interval '72 hours'),
  check (from_user <> to_user)
);

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

alter table public.stock_movements
  add column if not exists transfer_id uuid references public.stock_transfers(id);

create index if not exists idx_transfers_to_pending   on public.stock_transfers (to_user)    where status = 'pending';
create index if not exists idx_transfers_from_pending on public.stock_transfers (from_user, product_id) where status = 'pending';
create index if not exists idx_transfers_expiry       on public.stock_transfers (expires_at) where status = 'pending';
create index if not exists idx_transfers_parties      on public.stock_transfers (from_user, to_user, created_at desc);
create unique index if not exists uq_transfers_client_ref on public.stock_transfers (client_ref) where client_ref is not null;

create index if not exists idx_requests_target_pending on public.stock_requests (target_user) where status = 'pending';
create index if not exists idx_requests_expiry         on public.stock_requests (expires_at)  where status = 'pending';
create index if not exists idx_requests_parties        on public.stock_requests (requester, target_user, created_at desc);
create unique index if not exists uq_requests_client_ref on public.stock_requests (client_ref) where client_ref is not null;

create index if not exists idx_notifications_user   on public.notifications (user_id, created_at desc);
create index if not exists idx_notifications_unread on public.notifications (user_id) where read_at is null;

-- 2. Fonctions internes -----------------------------------------------------------
create or replace function public._user_label(p_user uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(nullif(btrim(display_name), ''), split_part(email, '@', 1))
       from public.profiles where id = p_user),
    'Unknown');
$$;

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
    'note', t.note, 'refusal_reason', t.refusal_reason, 'request_id', t.request_id,
    'created_at', t.created_at, 'responded_at', t.responded_at, 'expires_at', t.expires_at)
  from public.products p where p.id = t.product_id;
$$;

create or replace function public._request_json(r public.stock_requests)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', r.id, 'status', r.status,
    'product_id', r.product_id, 'product_name', p.name, 'product_emoji', p.emoji, 'product_color', p.color,
    'qty', r.qty,
    'requester', r.requester, 'requester_name', public._user_label(r.requester),
    'target_user', r.target_user, 'target_name', public._user_label(r.target_user),
    'note', r.note, 'decline_reason', r.decline_reason,
    'created_at', r.created_at, 'responded_at', r.responded_at, 'expires_at', r.expires_at)
  from public.products p where p.id = r.product_id;
$$;

create or replace function public._transfer_payload(p_transfer uuid)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select public._transfer_json(t) from public.stock_transfers t where t.id = p_transfer;
$$;

create or replace function public._notify(p_user uuid, p_type text, p_payload jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if p_user is null then return; end if;
  insert into public.notifications (user_id, type, payload)
  values (p_user, p_type, coalesce(p_payload, '{}'::jsonb));
end;
$$;

-- Expiration paresseuse (72 h) : appelée au début de chaque lecture / action,
-- et par pg_cron s'il est disponible. Ne bloque jamais : une ligne déjà
-- verrouillée par une autre opération est simplement traitée au passage suivant.
create or replace function public._expire_stale()
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  t record;
  r record;
  v_qty int;
  v_n int := 0;
begin
  for t in
    select id, from_user, product_id from public.stock_transfers
     where status = 'pending' and expires_at <= now()
     order by created_at, id
  loop
    perform 1 from public.products where id = t.product_id for update skip locked;
    if not found then continue; end if;
    perform 1 from public.stock_holdings
      where owner_id = t.from_user and product_id = t.product_id
        for update skip locked;
    if not found then continue; end if;
    select qty into v_qty from public.stock_transfers
     where id = t.id and status = 'pending'
       for update skip locked;
    if not found then continue; end if;

    update public.stock_holdings
       set reserved = greatest(reserved - v_qty, 0), updated_at = now()
     where owner_id = t.from_user and product_id = t.product_id;
    update public.stock_transfers set status = 'expired', responded_at = now() where id = t.id;
    perform public._notify(t.from_user, 'transfer_expired', public._transfer_payload(t.id));
    v_n := v_n + 1;
  end loop;

  for r in
    select id from public.stock_requests
     where status = 'pending' and expires_at <= now()
     order by created_at, id
       for update skip locked
  loop
    update public.stock_requests set status = 'expired', responded_at = now() where id = r.id;
    perform public._notify(
      (select requester from public.stock_requests where id = r.id), 'request_expired',
      (select public._request_json(q) from public.stock_requests q where q.id = r.id));
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

-- Déplace p_qty unités des lots de p_from (FIFO) vers de nouveaux lots de p_to,
-- au même prix d'achat (parent_batch_id garde le lien). Le total du produit
-- (products.stock) ne change pas. Les stocks détenus sont mis à jour par l'appelant.
create or replace function public._move_stock(
  p_from uuid, p_to uuid, p_product uuid, p_qty int, p_transfer uuid, p_origin text
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_left int := p_qty;
  v_take int;
  v_new  uuid;
  r record;
begin
  if p_qty <= 0 then return; end if;

  for r in
    select id, remaining_qty, unit_cost
      from public.stock_batches
     where owner_id = p_from and product_id = p_product and remaining_qty > 0
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
    insert into public.stock_movements (product_id, batch_id, delta, reason, actor_id, holder_id, transfer_id)
    values (p_product, r.id, -v_take, 'transfer_out', auth.uid(), p_from, p_transfer);

    insert into public.stock_batches
      (product_id, received_qty, owner_id, unit_cost, origin, parent_batch_id, remaining_qty)
    values (p_product, v_take, p_to, r.unit_cost, p_origin, r.id, v_take)
    returning id into v_new;
    insert into public.stock_movements (product_id, batch_id, delta, reason, actor_id, holder_id, transfer_id)
    values (p_product, v_new, v_take, 'transfer_in', auth.uid(), p_to, p_transfer);

    v_left := v_left - v_take;
  end loop;

  if v_left > 0 then
    raise exception 'Incohérence de stock (lots) pour le produit %', p_product;
  end if;
end;
$$;

-- Vente hors-ligne au-delà du stock libre : libère jusqu'à p_needed unités
-- réservées par des transferts en attente de p_owner (les plus récents d'abord).
-- L'appelant (record_sale) détient déjà le verrou sur le stock détenu.
create or replace function public._cap_pending_transfers(p_owner uuid, p_product uuid, p_needed int)
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
             refusal_reason = 'Sold by the sender while offline, before the transfer was accepted'
       where id = t.id;
    else
      update public.stock_transfers set qty = qty - v_take where id = t.id;
    end if;

    v_payload := public._transfer_payload(t.id)
                 || jsonb_build_object('qty_sold', v_take, 'qty_left', t.qty - v_take);
    perform public._notify(p_owner,   'transfer_capped', v_payload);
    perform public._notify(t.to_user, 'transfer_capped', v_payload);
    for m in
      select id from public.profiles
       where active and role in ('manager', 'admin') and id not in (p_owner, t.to_user)
    loop
      perform public._notify(m.id, 'transfer_capped', v_payload);
    end loop;

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

-- 3. Transferts -------------------------------------------------------------------

-- 3a. Envoi : réserve la quantité chez l'expéditeur. p_request = demande de
--     stock à laquelle ce transfert répond (facultatif). p_client_ref =
--     identifiant d'idempotence (rejouer la même requête ne réserve pas deux fois).
create or replace function public.send_transfer(
  p_to uuid, p_product uuid, p_qty int,
  p_note text default null, p_request uuid default null, p_client_ref uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_id    uuid;
  v_name  text;
  v_avail int;
  v_req   record;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if p_client_ref is not null then
    select id into v_id from public.stock_transfers where client_ref = p_client_ref;
    if found then
      return jsonb_build_object('duplicate', true, 'transfer_id', v_id);
    end if;
  end if;

  if p_qty is null or p_qty <= 0 then raise exception 'Invalid quantity'; end if;
  if p_to is null or p_to = v_uid then raise exception 'Choose a colleague to send stock to'; end if;
  if not exists (select 1 from public.profiles where id = p_to and active) then
    raise exception 'This user cannot receive stock (inactive account)';
  end if;
  select name into v_name from public.products where id = p_product for update;   -- verrou produit
  if not found then raise exception 'Unknown product'; end if;
  perform public._expire_stale();

  select qty - reserved into v_avail
    from public.stock_holdings
   where owner_id = v_uid and product_id = p_product
     for update;
  v_avail := coalesce(v_avail, 0);
  if p_qty > v_avail then
    raise exception 'Not enough stock of "%": you can send at most % unit(s)', v_name, v_avail;
  end if;

  if p_request is not null then
    select * into v_req from public.stock_requests where id = p_request for update;
    if not found or v_req.target_user <> v_uid or v_req.requester <> p_to or v_req.product_id <> p_product then
      raise exception 'This request does not match the transfer';
    end if;
    if v_req.status <> 'pending' then
      raise exception 'This request is no longer pending';
    end if;
  end if;

  update public.stock_holdings
     set reserved = reserved + p_qty, updated_at = now()
   where owner_id = v_uid and product_id = p_product;

  insert into public.stock_transfers
    (from_user, to_user, product_id, qty, qty_sent, note, request_id, client_ref)
  values
    (v_uid, p_to, p_product, p_qty, p_qty, nullif(btrim(coalesce(p_note, '')), ''), p_request, p_client_ref)
  returning id into v_id;

  if p_request is not null then
    update public.stock_requests set status = 'fulfilled', responded_at = now() where id = p_request;
  end if;

  return jsonb_build_object('duplicate', false, 'transfer_id', v_id,
                            'expires_at', (select expires_at from public.stock_transfers where id = v_id));
end;
$$;

-- 3b. Réponse du bénéficiaire : 'accept' (p_qty facultatif = acceptation
--     partielle) ou 'refuse' (p_reason obligatoire).
create or replace function public.respond_transfer(
  p_transfer uuid, p_action text, p_qty int default null, p_reason text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  t        public.stock_transfers;
  v_q      int;
  v_hold   int;
  v_status text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('accept', 'refuse') then
    raise exception 'Invalid action';
  end if;
  if p_action = 'refuse' and v_reason is null then
    raise exception 'A reason is required to refuse a transfer';
  end if;

  select * into t from public.stock_transfers where id = p_transfer;
  if not found or t.to_user <> v_uid then
    raise exception 'Transfer not found';
  end if;

  -- Verrous : produit, stocks détenus (ordre fixe), puis transfert
  perform 1 from public.products where id = t.product_id for update;
  if p_action = 'accept' then
    insert into public.stock_holdings (owner_id, product_id, qty)
    values (v_uid, t.product_id, 0)
    on conflict (owner_id, product_id) do nothing;
  end if;
  perform 1 from public.stock_holdings
    where product_id = t.product_id and owner_id in (t.from_user, v_uid)
    order by owner_id
      for update;
  select * into t from public.stock_transfers where id = p_transfer for update;

  if t.status <> 'pending' then
    raise exception 'This transfer is no longer pending (%)', t.status;
  end if;

  -- Délai dépassé : on l'expire ici (sans lever d'erreur, pour que l'expiration soit enregistrée)
  if t.expires_at <= now() then
    update public.stock_holdings
       set reserved = greatest(reserved - t.qty, 0), updated_at = now()
     where owner_id = t.from_user and product_id = t.product_id;
    update public.stock_transfers set status = 'expired', responded_at = now() where id = t.id;
    perform public._notify(t.from_user, 'transfer_expired', public._transfer_payload(t.id));
    return jsonb_build_object('status', 'expired');
  end if;

  if p_action = 'refuse' then
    update public.stock_holdings
       set reserved = greatest(reserved - t.qty, 0), updated_at = now()
     where owner_id = t.from_user and product_id = t.product_id;
    update public.stock_transfers
       set status = 'refused', refusal_reason = v_reason, responded_at = now()
     where id = t.id;
    perform public._notify(t.from_user, 'transfer_refused', public._transfer_payload(t.id));
    return jsonb_build_object('status', 'refused');
  end if;

  -- Acceptation
  v_q := coalesce(p_qty, t.qty);
  if v_q <= 0 or v_q > t.qty then
    raise exception 'Invalid quantity: accept between 1 and % unit(s)', t.qty;
  end if;
  select qty into v_hold from public.stock_holdings
   where owner_id = t.from_user and product_id = t.product_id;
  v_q := least(v_q, coalesce(v_hold, 0));          -- défensif : jamais plus que le stock réel
  if v_q <= 0 then
    raise exception 'The sender no longer holds this stock';
  end if;

  perform public._move_stock(t.from_user, v_uid, t.product_id, v_q, t.id, 'transfer');

  update public.stock_holdings
     set qty = qty - v_q, reserved = greatest(reserved - t.qty, 0), updated_at = now()
   where owner_id = t.from_user and product_id = t.product_id;
  update public.stock_holdings
     set qty = qty + v_q, updated_at = now()
   where owner_id = v_uid and product_id = t.product_id;

  v_status := case when v_q = t.qty then 'accepted' else 'partially_accepted' end;
  update public.stock_transfers
     set status = v_status, qty_accepted = v_q, responded_at = now()
   where id = t.id;
  perform public._notify(t.from_user, 'transfer_accepted',
    public._transfer_payload(t.id) || jsonb_build_object('qty_returned', t.qty - v_q));

  return jsonb_build_object('status', v_status, 'qty_accepted', v_q, 'qty_returned', t.qty - v_q);
end;
$$;

-- 3c. Annulation par l'expéditeur, tant que le transfert est en attente
create or replace function public.cancel_transfer(p_transfer uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  t     public.stock_transfers;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into t from public.stock_transfers where id = p_transfer;
  if not found or t.from_user <> v_uid then
    raise exception 'Transfer not found';
  end if;

  perform 1 from public.products where id = t.product_id for update;
  perform 1 from public.stock_holdings
    where owner_id = t.from_user and product_id = t.product_id
      for update;
  select * into t from public.stock_transfers where id = p_transfer for update;
  if t.status <> 'pending' then
    raise exception 'This transfer is no longer pending (%)', t.status;
  end if;

  update public.stock_holdings
     set reserved = greatest(reserved - t.qty, 0), updated_at = now()
   where owner_id = t.from_user and product_id = t.product_id;
  update public.stock_transfers set status = 'cancelled', responded_at = now() where id = t.id;
  perform public._notify(t.to_user, 'transfer_cancelled', public._transfer_payload(t.id));
  return jsonb_build_object('status', 'cancelled');
end;
$$;

-- 4. Demandes de stock --------------------------------------------------------------
create or replace function public.request_stock(
  p_target uuid, p_product uuid, p_qty int, p_note text default null, p_client_ref uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_id    uuid;
  v_avail int;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if p_client_ref is not null then
    select id into v_id from public.stock_requests where client_ref = p_client_ref;
    if found then
      return jsonb_build_object('duplicate', true, 'request_id', v_id);
    end if;
  end if;

  if p_qty is null or p_qty <= 0 then raise exception 'Invalid quantity'; end if;
  if p_target is null or p_target = v_uid then raise exception 'Choose a colleague to ask'; end if;
  if not exists (select 1 from public.profiles where id = p_target and active) then
    raise exception 'This user cannot be asked for stock (inactive account)';
  end if;
  perform 1 from public.products where id = p_product for update;   -- verrou produit
  if not found then raise exception 'Unknown product'; end if;
  perform public._expire_stale();

  select qty - reserved into v_avail
    from public.stock_holdings where owner_id = p_target and product_id = p_product;
  if coalesce(v_avail, 0) <= 0 then
    raise exception '% has no available stock of this product', public._user_label(p_target);
  end if;
  if exists (
    select 1 from public.stock_requests
     where requester = v_uid and target_user = p_target and product_id = p_product and status = 'pending'
  ) then
    raise exception 'You already have a pending request for this product with %', public._user_label(p_target);
  end if;

  insert into public.stock_requests (requester, target_user, product_id, qty, note, client_ref)
  values (v_uid, p_target, p_product, p_qty, nullif(btrim(coalesce(p_note, '')), ''), p_client_ref)
  returning id into v_id;

  return jsonb_build_object('duplicate', false, 'request_id', v_id);
end;
$$;

-- Le destinataire décline (motif obligatoire). Pour accepter, il envoie un
-- transfert avec send_transfer(..., p_request => id de la demande).
create or replace function public.decline_request(p_request uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  r        public.stock_requests;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'A reason is required to decline a request';
  end if;
  select * into r from public.stock_requests where id = p_request for update;
  if not found or r.target_user <> v_uid then
    raise exception 'Request not found';
  end if;
  if r.status <> 'pending' then
    raise exception 'This request is no longer pending (%)', r.status;
  end if;
  update public.stock_requests
     set status = 'declined', decline_reason = v_reason, responded_at = now()
   where id = r.id;
  perform public._notify(r.requester, 'request_declined',
    (select public._request_json(q) from public.stock_requests q where q.id = r.id));
  return jsonb_build_object('status', 'declined');
end;
$$;

create or replace function public.cancel_request(p_request uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  r     public.stock_requests;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into r from public.stock_requests where id = p_request for update;
  if not found or r.requester <> v_uid then
    raise exception 'Request not found';
  end if;
  if r.status <> 'pending' then
    raise exception 'This request is no longer pending (%)', r.status;
  end if;
  update public.stock_requests set status = 'cancelled', responded_at = now() where id = r.id;
  return jsonb_build_object('status', 'cancelled');
end;
$$;

-- 5. Lecture : boîte « Transfers », pastille, collègues -------------------------------

-- p_all = true : un manager/admin voit l'historique de tout le monde.
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
                 and (v_all or t.from_user = v_uid or t.to_user = v_uid)
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

-- Pastille : ce qui attend une action de ma part + les nouvelles non lues
create or replace function public.transfers_badge()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_in  int;
  v_req int;
  v_unread int;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  perform public._expire_stale();
  select count(*) into v_in  from public.stock_transfers where to_user = v_uid and status = 'pending';
  select count(*) into v_req from public.stock_requests  where target_user = v_uid and status = 'pending';
  select count(*) into v_unread from public.notifications where user_id = v_uid and read_at is null;
  return jsonb_build_object('incoming', v_in, 'requests', v_req, 'unread', v_unread,
                            'total', v_in + v_req + v_unread);
end;
$$;

create or replace function public.mark_notifications_read()
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_n int;
begin
  if v_uid is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  update public.notifications set read_at = now() where user_id = v_uid and read_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Collègues actifs (pour choisir le bénéficiaire d'un transfert)
create or replace function public.list_colleagues()
returns table (id uuid, name text, role text)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select p.id, public._user_label(p.id), p.role
      from public.profiles p
     where p.active and p.id <> auth.uid()
     order by 2;
end;
$$;

-- 6. Fonctions de la phase 2 mises à jour --------------------------------------------

-- 6a. record_sale : identique à la phase 2, plus (1) le verrou par produit et
--     (2) le plafonnement des transferts en attente quand une vente hors-ligne
--     dépasse le stock libre du vendeur.
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
  v_freed   int;
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

  -- Verrou par produit, dans l'ordre des identifiants : deux ventes (ou une vente
  -- et un transfert) simultanées sur les mêmes produits passent l'une après l'autre
  perform 1 from public.products where id = any (v_pids) order by id for update;

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
      raise exception 'Not enough stock of "%": you can sell % unit(s) (stock reserved for pending transfers is not sellable)', v_names[v_i], v_avail;
    end if;
    -- Phase 3a : vente hors-ligne au-delà du stock libre. La marchandise est
    -- déjà partie : on prend sur les unités réservées à des transferts en
    -- attente, qui sont plafonnés d'autant (les parties sont prévenues).
    if v_unf > 0 then
      v_freed  := public._cap_pending_transfers(v_uid, v_pids[v_i], v_unf);
      v_fulfil := v_fulfil + v_freed;
      v_unf    := v_unf - v_freed;
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

-- 6b. adjust_stock : identique à la phase 2, mais un retrait ne peut pas toucher
--     aux unités réservées pour un transfert en attente.
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
  select coalesce(qty - reserved, 0) into v_mine from public.stock_holdings
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
      raise exception 'You can remove at most % unit(s) of this product: the rest belongs to other holders or is reserved for pending transfers.', v_mine;
    end if;
    perform 1 from public._consume_stock(v_uid, p_product_id, -v_delta, null, 'Manual adjustment');
  end if;

  return jsonb_build_object('stock_total', p_new_total);
end;
$$;

-- 6c. cancel_sales : identique à la phase 2, plus le verrou par produit.
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

  -- Verrou par produit, dans l'ordre des identifiants (même règle que record_sale)
  perform 1 from public.products
    where id in (select product_id from public.sales where id = any (p_sale_ids) and product_id is not null)
    order by id
      for update;

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

-- 7. Droits -------------------------------------------------------------------------
revoke all on function
  public._user_label(uuid), public._transfer_json(public.stock_transfers),
  public._request_json(public.stock_requests), public._transfer_payload(uuid),
  public._notify(uuid, text, jsonb), public._expire_stale(),
  public._move_stock(uuid, uuid, uuid, int, uuid, text),
  public._cap_pending_transfers(uuid, uuid, int),
  public.send_transfer(uuid, uuid, int, text, uuid, uuid),
  public.respond_transfer(uuid, text, int, text),
  public.cancel_transfer(uuid),
  public.request_stock(uuid, uuid, int, text, uuid),
  public.decline_request(uuid, text), public.cancel_request(uuid),
  public.transfers_inbox(boolean), public.transfers_badge(),
  public.mark_notifications_read(), public.list_colleagues(),
  public.record_sale(jsonb), public.adjust_stock(uuid, int), public.cancel_sales(uuid[])
  from public, anon, authenticated;

grant execute on function
  public.send_transfer(uuid, uuid, int, text, uuid, uuid),
  public.respond_transfer(uuid, text, int, text),
  public.cancel_transfer(uuid),
  public.request_stock(uuid, uuid, int, text, uuid),
  public.decline_request(uuid, text), public.cancel_request(uuid),
  public.transfers_inbox(boolean), public.transfers_badge(),
  public.mark_notifications_read(), public.list_colleagues(),
  public.record_sale(jsonb), public.adjust_stock(uuid, int), public.cancel_sales(uuid[])
  to authenticated;

-- 8. Règles d'accès (RLS) : lecture seule, écritures uniquement via les fonctions ------
alter table public.stock_transfers enable row level security;
alter table public.stock_requests  enable row level security;
alter table public.notifications   enable row level security;

revoke all on public.stock_transfers, public.stock_requests, public.notifications from anon, authenticated;
grant select on public.stock_transfers, public.stock_requests, public.notifications to authenticated;

drop policy if exists stock_transfers_select on public.stock_transfers;
create policy stock_transfers_select on public.stock_transfers for select to authenticated
  using (public.is_manager_or_admin() or (public.is_active_user() and (from_user = auth.uid() or to_user = auth.uid())));

drop policy if exists stock_requests_select on public.stock_requests;
create policy stock_requests_select on public.stock_requests for select to authenticated
  using (public.is_manager_or_admin() or (public.is_active_user() and (requester = auth.uid() or target_user = auth.uid())));

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());

-- 9. Expiration automatique (facultatif) ------------------------------------------------
--    Si l'extension pg_cron est activée, on programme l'expiration toutes les
--    heures. Sinon l'expiration reste « paresseuse » : elle est appliquée dès
--    qu'un utilisateur ouvre l'appli ou agit sur un transfert.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule(jobid) from cron.job where jobname = 'expire_stale_transfers';
      perform cron.schedule('expire_stale_transfers', '7 * * * *', 'select public._expire_stale()');
      raise notice 'pg_cron : expiration des transferts programmée toutes les heures.';
    exception when others then
      raise notice 'pg_cron présent mais non programmable (%) : expiration paresseuse uniquement.', sqlerrm;
    end;
  else
    raise notice 'pg_cron absent : expiration paresseuse uniquement (suffisant).';
  end if;
end $$;

insert into public.app_migrations (name) values ('phase3a_transferts_notifications')
on conflict (name) do nothing;

-- Contrôle : les réservations correspondent aux transferts en attente
do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from public.stock_holdings h
   where h.reserved <> coalesce((
           select sum(t.qty) from public.stock_transfers t
            where t.from_user = h.owner_id and t.product_id = h.product_id and t.status = 'pending'), 0);
  if v_bad > 0 then
    raise exception 'Incohérence : % ligne(s) de stock détenu ont une réservation sans transfert en attente.', v_bad;
  end if;
end $$;

commit;

-- Demande à l'API Supabase (PostgREST) de relire le schéma : les nouvelles
-- fonctions sont appelables tout de suite.
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- VÉRIFICATIONS APRÈS COUP :
--   select has_table_privilege('anon', 'public.stock_transfers', 'select');           -- false
--   select has_function_privilege('anon', 'public.transfers_badge()', 'execute');     -- false
--   select status, count(*), sum(qty) from public.stock_transfers group by 1;
--   -- réservations = transferts en attente (doit renvoyer 0 ligne) :
--   select h.* from public.stock_holdings h
--    where h.reserved <> coalesce((select sum(t.qty) from public.stock_transfers t
--            where t.from_user = h.owner_id and t.product_id = h.product_id and t.status = 'pending'), 0);
--
-- Reste pour la phase 3b : réattribution par le manager (kind = 'reassignment'),
-- inventaire et écarts par détenteur.
-- ═══════════════════════════════════════════════════════════════════════════
