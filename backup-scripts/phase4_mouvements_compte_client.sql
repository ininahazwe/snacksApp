-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 4 — Mouvements de compte client : paiement de dette, dépôt d'avoir,
--           utilisation de l'avoir (atomiques, tracés), vue sales_active
-- ═══════════════════════════════════════════════════════════════════════════
-- Prérequis : phases 1, 2, 3a exécutées (3b conseillée). À exécuter dans
-- Supabase → SQL Editor. Le script est transactionnel et rejouable.
--
-- ⚠️ Avant : faire une sauvegarde (backup-scripts/backup_supabase.sh).
-- ⚠️ Essai à blanc possible : remplacer le COMMIT final par ROLLBACK.
-- ⚠️ Après ce script, l'ANCIEN écran Clients ne peut plus enregistrer de
--    paiement ni créer de client (écritures directes fermées) : déployer le
--    nouveau front juste après.
--
-- Corrige :
--   1. Paiement + avoir non atomiques (jusqu'à 4 écritures côté navigateur,
--      calculées sur un solde affiché peut-être périmé). Désormais une seule
--      fonction, qui lit et verrouille le solde en base :
--        record_client_payment(client, montant, 'credit' | 'change', request_id)
--        apply_client_credit(client, request_id)
--      Idempotentes : rejouer le même request_id ne crée rien de plus.
--   2. Acteur absent : chaque ligne porte sales.user_id = auth.uid().
--      Tout utilisateur actif (cashier compris) peut encaisser ; créer,
--      renommer, supprimer un client reste réservé aux managers/admins.
--   3. Annulations oubliées dans les calculs : vue sales_active (lignes non
--      annulées, RLS de sales appliquée via security_invoker).
-- En plus :
--   • sales.cancelled_by : qui a annulé (renseigné par cancel_sales).
--   • cancel_sales ne perd plus d'argent : si l'avoir à retirer a déjà été
--     consommé, le manque devient de la dette (et inversement). L'avoir
--     utilisé par un paiement annulé est rétabli (comme avant).
--   • Plus aucune écriture directe sur sales ; sur clients, seuls name et
--     phone restent modifiables directement (manager/admin).
-- Historique : aucune ligne existante n'est modifiée.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- 0. Garde-fou ------------------------------------------------------------------
do $$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'PostgreSQL 15 ou plus requis (vue security_invoker).';
  end if;
  if to_regprocedure('public.record_sale(jsonb)') is null
     or to_regprocedure('public.cancel_sales(uuid[])') is null
     or to_regclass('public.stock_transfers') is null
     or not exists (select 1 from public.app_migrations where name = 'phase3a_transferts_notifications') then
    raise exception 'Exécuter d''abord les phases 1, 2 et 3a.';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.sales'::regclass and contype = 'c'
                    and pg_get_constraintdef(oid) ilike '%avoir%') then
    raise exception 'Le type de vente ''avoir'' n''est pas autorisé : exécuter d''abord supabase-migration-tracabilite-avoir.sql.';
  end if;
end $$;

-- 1. Modèle de données ---------------------------------------------------------------
alter table public.sales
  add column if not exists cancelled_by uuid references auth.users(id);

-- Idempotence des mouvements de compte (lignes sans produit). L'index de la
-- phase 2 (request_id, product_id) ne les protège pas : product_id y est NULL.
create unique index if not exists uq_sales_client_movement
  on public.sales (request_id, type)
  where product_id is null and request_id is not null;

create index if not exists idx_sales_client_created
  on public.sales (client_id, created_at desc);

-- 2. Fonction interne : résultat d'un mouvement déjà enregistré (rejeu) -------------
create or replace function public._client_movement_result(p_request uuid, p_duplicate boolean)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'duplicate',      p_duplicate,
    'client_id',      c.id,
    'debt',           c.debt,
    'credit',         c.credit,
    'debt_repaid',    coalesce(sum(s.debt_repaid), 0),
    'credit_used',    coalesce(sum(s.credit_used), 0),
    'credit_created', coalesce(sum(s.credit_created), 0),
    'group_id',       min(s.group_id::text),
    'sale_ids',       coalesce(jsonb_agg(s.id order by s.type desc), '[]'::jsonb)
  )
  from public.sales s
  join public.clients c on c.id = s.client_id
  where s.request_id = p_request and s.product_id is null
  group by c.id, c.debt, c.credit
$$;

-- Contrôle commun d'idempotence, appelé APRÈS le verrou sur le client
-- (deux envois simultanés du même request_id sont ainsi sérialisés).
-- Renvoie true si la requête a déjà été enregistrée pour ce client.
create or replace function public._client_request_seen(p_request uuid, p_client uuid)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.sales where request_id = p_request) then
    return false;
  end if;
  if exists (select 1 from public.sales
              where request_id = p_request
                and (product_id is not null or client_id is distinct from p_client)) then
    raise exception 'This request id was already used for another operation';
  end if;
  return true;
end;
$$;

-- 3. Paiement de dette / dépôt d'avoir ---------------------------------------------------
--   p_amount  : montant reçu (> 0), arrondi à 2 décimales.
--   p_surplus : ce qui dépasse la dette → 'credit' (avoir du client) ou
--               'change' (monnaie rendue, rien n'est enregistré pour ce reste).
--   Client sans dette + 'credit' = dépôt d'avoir pur (une seule ligne 'avoir').
--   Lignes créées : 'paiement' (part qui règle la dette) et/ou 'avoir' (trop-
--   perçu converti) ; si les deux, elles partagent un group_id (annulables
--   ensemble).
create or replace function public.record_client_payment(
  p_client_id  uuid,
  p_amount     numeric,
  p_surplus    text,
  p_request_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_amount  numeric := round(p_amount, 2);
  v_mode    text := coalesce(p_surplus, 'credit');
  v_debt    numeric;
  v_credit  numeric;
  v_repaid  numeric;
  v_surplus numeric;
  v_created numeric := 0;
  v_change  numeric := 0;
  v_group   uuid;
  v_ids     uuid[] := '{}';
  v_id      uuid;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'Missing request id';
  end if;
  if p_client_id is null then
    raise exception 'Unknown customer';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'Invalid amount';
  end if;
  if v_mode not in ('credit', 'change') then
    raise exception 'Invalid surplus option';
  end if;

  select debt, credit into v_debt, v_credit
    from public.clients where id = p_client_id for update;
  if not found then
    raise exception 'Unknown customer';
  end if;

  if public._client_request_seen(p_request_id, p_client_id) then
    return public._client_movement_result(p_request_id, true);
  end if;

  v_repaid  := round(least(v_amount, greatest(v_debt, 0)), 2);
  v_surplus := round(v_amount - v_repaid, 2);
  if v_surplus > 0 then
    if v_mode = 'credit' then v_created := v_surplus; else v_change := v_surplus; end if;
  end if;

  if v_repaid <= 0 and v_created <= 0 then
    raise exception 'This customer has no debt: choose "store credit" to record a deposit';
  end if;

  if v_repaid > 0 and v_created > 0 then
    v_group := gen_random_uuid();
  end if;

  if v_repaid > 0 then
    insert into public.sales
      (client_id, product_id, qty, amount, type, debt_repaid, user_id, request_id, group_id)
    values
      (p_client_id, null, 0, v_repaid, 'paiement', v_repaid, v_uid, p_request_id, v_group)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end if;

  if v_created > 0 then
    insert into public.sales
      (client_id, product_id, qty, amount, type, credit_created, user_id, request_id, group_id)
    values
      (p_client_id, null, 0, v_created, 'avoir', v_created, v_uid, p_request_id, v_group)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end if;

  update public.clients
     set debt   = round(debt - v_repaid, 2),
         credit = round(credit + v_created, 2)
   where id = p_client_id
  returning debt, credit into v_debt, v_credit;

  return jsonb_build_object(
    'duplicate', false, 'client_id', p_client_id,
    'debt', v_debt, 'credit', v_credit,
    'debt_repaid', v_repaid, 'credit_used', 0, 'credit_created', v_created,
    'change_due', v_change, 'group_id', v_group, 'sale_ids', to_jsonb(v_ids)
  );
end;
$$;

-- 4. Utilisation de l'avoir pour régler la dette ---------------------------------------
--   Applique min(avoir, dette), lus en base. Une ligne 'paiement' avec
--   debt_repaid = credit_used.
create or replace function public.apply_client_credit(
  p_client_id  uuid,
  p_request_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_debt   numeric;
  v_credit numeric;
  v_used   numeric;
  v_id     uuid;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'Missing request id';
  end if;

  select debt, credit into v_debt, v_credit
    from public.clients where id = p_client_id for update;
  if not found then
    raise exception 'Unknown customer';
  end if;

  if public._client_request_seen(p_request_id, p_client_id) then
    return public._client_movement_result(p_request_id, true);
  end if;

  v_used := round(least(greatest(v_credit, 0), greatest(v_debt, 0)), 2);
  if v_used <= 0 then
    raise exception 'Nothing to apply: the customer needs both a debt and store credit';
  end if;

  insert into public.sales
    (client_id, product_id, qty, amount, type, debt_repaid, credit_used, user_id, request_id)
  values
    (p_client_id, null, 0, v_used, 'paiement', v_used, v_used, v_uid, p_request_id)
  returning id into v_id;

  update public.clients
     set debt = round(debt - v_used, 2), credit = round(credit - v_used, 2)
   where id = p_client_id
  returning debt, credit into v_debt, v_credit;

  return jsonb_build_object(
    'duplicate', false, 'client_id', p_client_id,
    'debt', v_debt, 'credit', v_credit,
    'debt_repaid', v_used, 'credit_used', v_used, 'credit_created', 0,
    'change_due', 0, 'group_id', null, 'sale_ids', jsonb_build_array(v_id)
  );
end;
$$;

-- 5. cancel_sales : identique à la phase 3a, plus (1) cancelled_by et
--    (2) aucun montant perdu quand dette ou avoir ont bougé depuis.
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
        v_new_debt   := round(c.debt   - s.debt_added     + s.debt_repaid, 2);
        v_new_credit := round(c.credit - s.credit_created + s.credit_used, 2);
        -- Rien ne se perd : si l'avoir à retirer a déjà été consommé, le
        -- manque devient de la dette ; si la dette à retirer a déjà été
        -- remboursée, l'excédent devient de l'avoir. Le solde net du client
        -- (avoir − dette) bouge exactement de l'inverse de la ligne annulée.
        if v_new_debt < 0 then
          v_new_credit := v_new_credit - v_new_debt;
          v_new_debt := 0;
        end if;
        if v_new_credit < 0 then
          v_new_debt := v_new_debt - v_new_credit;
          v_new_credit := 0;
        end if;
        update public.clients set debt = v_new_debt, credit = v_new_credit where id = s.client_id;
      end if;
    end if;

    -- 3. soft-delete
    update public.sales set cancelled_at = now(), cancelled_by = v_uid where id = s.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- 6. Vue de reporting : uniquement les lignes non annulées ------------------------------
--    security_invoker : la vue applique la RLS de sales avec les droits de
--    l'appelant (sans cela, un cashier verrait toutes les ventes).
--    Règle : tout calcul (CA, profit, totaux remboursés…) lit sales_active ;
--    sales ne sert qu'à afficher l'historique (annulées comprises).
create or replace view public.sales_active
  with (security_invoker = true) as
  select * from public.sales where cancelled_at is null;

comment on view public.sales_active is
  'Lignes de sales non annulées (cancelled_at is null). À utiliser pour tout calcul de reporting.';

-- 7. Droits ---------------------------------------------------------------------------
revoke all on function
  public._client_movement_result(uuid, boolean),
  public._client_request_seen(uuid, uuid),
  public.record_client_payment(uuid, numeric, text, uuid),
  public.apply_client_credit(uuid, uuid),
  public.cancel_sales(uuid[])
  from public, anon, authenticated;

grant execute on function
  public.record_client_payment(uuid, numeric, text, uuid),
  public.apply_client_credit(uuid, uuid),
  public.cancel_sales(uuid[])
  to authenticated;

revoke all on public.sales_active from public, anon;
grant select on public.sales_active to authenticated;

-- sales : plus aucune écriture directe (record_sale, record_client_payment,
-- apply_client_credit et cancel_sales sont security definer).
drop policy if exists sales_insert on public.sales;
revoke insert, update, delete on public.sales from anon, authenticated;

-- clients : dette et avoir ne bougent plus que via les fonctions. Le manager/
-- admin garde la création, le renommage et la suppression (règles RLS de la
-- phase 2 inchangées).
revoke insert, update on public.clients from anon, authenticated;
grant insert (name, phone), update (name, phone) on public.clients to authenticated;

insert into public.app_migrations (name) values ('phase4_mouvements_compte_client')
on conflict (name) do nothing;

-- 8. Contrôles ------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.record_client_payment(uuid, numeric, text, uuid)', 'execute')
     or has_function_privilege('anon', 'public.apply_client_credit(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._client_request_seen(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._client_movement_result(uuid, boolean)', 'execute')
     or has_table_privilege('anon', 'public.sales_active', 'select')
     or has_table_privilege('authenticated', 'public.sales', 'insert')
     or has_column_privilege('authenticated', 'public.clients', 'debt', 'update')
     or has_column_privilege('authenticated', 'public.clients', 'credit', 'update')
     or has_column_privilege('authenticated', 'public.clients', 'debt', 'insert') then
    raise exception 'Contrôle des droits en échec';
  end if;
end $$;

commit;
