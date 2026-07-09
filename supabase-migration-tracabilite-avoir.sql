-- ============================================================
-- Traçabilité complète avoir/dette + annulation réversible
-- À exécuter dans : Supabase > SQL Editor
--
-- Contexte : les ventes ne traçaient que "amount", ce qui rendait
-- impossible d'annuler une vente ayant utilisé/généré de l'avoir
-- sans perte d'information. Ce script ajoute les colonnes qui
-- enregistrent explicitement ce que chaque ligne "sales" change
-- chez le client, pour que l'annulation puisse tout défaire
-- exactement (dette + avoir + stock + lot), et que l'historique
-- garde une trace de tout (y compris les ventes annulées).
-- ============================================================

-- 1. Colonnes de traçabilité sur "sales"
-- NOTE : numeric (pas integer) pour matcher clients.debt / clients.credit / sales.amount,
-- qui sont tous en numeric — un integer aurait arrondi les montants à centimes et
-- faussé l'annulation sur des ventes avec décimales.
alter table public.sales
  add column if not exists debt_added          numeric     not null default 0, -- dette générée par cette ligne
  add column if not exists debt_repaid         numeric     not null default 0, -- dette remboursée par cette ligne
  add column if not exists credit_used         numeric     not null default 0, -- avoir consommé par cette ligne
  add column if not exists credit_created      numeric     not null default 0, -- avoir généré par cette ligne
  add column if not exists cancelled_at        timestamptz,                   -- soft delete : la ligne reste visible dans l'historique
  add column if not exists batch_id            uuid references public.stock_batches(id),
  add column if not exists batch_was_exhausted boolean     not null default false; -- CETTE vente a-t-elle épuisé le lot ?

-- 2. Lien vers la vente d'origine sur les mouvements de stock (traçabilité + annulation propre)
alter table public.stock_movements
  add column if not exists sale_id uuid references public.sales(id) on delete set null;

-- 3. Autoriser le nouveau type 'avoir' (conversion de surplus de paiement en avoir).
--    Le nom de la contrainte existante peut différer selon l'historique de la table :
--    on la supprime si trouvée puis on la recrée avec la liste complète des types utilisés
--    par le code (cash, dette, paiement, avoir).
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.sales'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%type%'
  loop
    execute format('alter table public.sales drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.sales
  add constraint sales_type_check check (type in ('cash', 'dette', 'paiement', 'avoir'));

-- 4. Index utiles
create index if not exists idx_sales_cancelled_at    on public.sales (cancelled_at);
create index if not exists idx_stock_movements_saleid on public.stock_movements (sale_id);

-- ============================================================
-- Notes :
-- - Les ventes déjà enregistrées avant ce script ont debt_added /
--   credit_used / credit_created à 0 par défaut : annuler une VIEILLE
--   vente ne restaurera donc pas l'avoir qu'elle avait pu consommer/créer
--   (l'info n'existait pas). Seules les ventes créées après ce script
--   seront annulables sans perte d'information.
-- - "avoir" (surplus converti en crédit) n'existait avant ce script dans
--   aucune trace : convertirSurplusEnAvoir() ne créait aucune ligne
--   "sales". Ce n'est plus le cas après la mise à jour du code associée.
-- ============================================================
