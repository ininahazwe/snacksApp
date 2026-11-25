-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 5 — Page Sales par utilisateur : annulation réservée à l'admin pour
--           les ventes des autres
-- ═══════════════════════════════════════════════════════════════════════════
-- Prérequis : phase 4 (phase4_mouvements_compte_client.sql) exécutée.
-- À exécuter dans Supabase → SQL Editor. Transactionnel et rejouable.
--
-- ⚠️ Avant : faire une sauvegarde (backup-scripts/backup_supabase.sh).
-- ⚠️ Essai à blanc possible : remplacer le COMMIT final par ROLLBACK.
--
-- Décisions (25 nov. 2026) :
--   • Page Sales : chaque manager et cashier ne voit que ses propres ventes,
--     l'admin voit tout. C'est un filtre de l'écran : les règles de lecture
--     (RLS) ne changent pas ; le Dashboard et le calcul de profit d'un
--     manager restent à l'échelle de l'équipe.
--   • Annulation : l'admin annule tout ; un manager n'annule que ses propres
--     lignes (ventes, paiements, avoirs qu'il a enregistrés) ; un cashier
--     n'annule rien (inchangé).
-- Seule cancel_sales change (identique à la phase 4 + le contrôle ci-dessus).
-- L'ancien front continue de fonctionner : un manager qui tente d'annuler la
-- vente d'un autre reçoit un message d'erreur.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- 0. Garde-fou ------------------------------------------------------------------
do $$
begin
  -- On vérifie la présence des objets de la phase 4 (et non sa seule
  -- inscription dans app_migrations : la première version du script phase 4
  -- ne s'y inscrivait pas).
  if to_regprocedure('public.record_client_payment(uuid, numeric, text, uuid)') is null
     or to_regprocedure('public.apply_client_credit(uuid, uuid)') is null
     or to_regclass('public.sales_active') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'sales'
                       and column_name = 'cancelled_by') then
    raise exception 'Exécuter d''abord la phase 4 (phase4_mouvements_compte_client.sql).';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'Fonction is_admin() absente : exécuter d''abord la phase 1.';
  end if;
end $$;

-- 1. cancel_sales : identique à la phase 4, plus la règle d'annulation par auteur -----
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

  -- Phase 5 : un manager n'annule que ses propres lignes (sales.user_id) ;
  -- les lignes d'un autre utilisateur, ou sans vendeur enregistré (historique),
  -- sont réservées à l'admin. Tout ou rien : rien n'est annulé si une seule
  -- ligne demandée n'est pas autorisée.
  if not public.is_admin() and exists (
       select 1 from public.sales
        where id = any (p_sale_ids)
          and cancelled_at is null
          and user_id is distinct from v_uid) then
    raise exception 'Only the admin can cancel another user''s sale' using errcode = '42501';
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


-- 2. Droits (inchangés, réaffirmés) -------------------------------------------------
revoke all on function public.cancel_sales(uuid[]) from public, anon, authenticated;
grant execute on function public.cancel_sales(uuid[]) to authenticated;

-- Index pour la page Sales filtrée par vendeur et par dates
create index if not exists idx_sales_user_created on public.sales (user_id, created_at desc);

-- La phase 4 est en place (vérifié plus haut) : on l'inscrit si ce n'est pas fait
insert into public.app_migrations (name) values ('phase4_mouvements_compte_client'), ('phase5_ventes_par_utilisateur')
on conflict (name) do nothing;

-- 3. Contrôle ----------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.cancel_sales(uuid[])', 'execute') then
    raise exception 'Contrôle des droits en échec';
  end if;
end $$;

commit;
