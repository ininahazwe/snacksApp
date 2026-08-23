-- ============================================================
-- MIGRATION : vente à prix réduit (produit endommagé / cassé)
-- App : Douceurs POS (projet "Boutique")
-- ============================================================
--
-- Ajoute deux colonnes à `sales` pour tracer une vente enregistrée à
-- prix réduit (ex. biscuits cassés) :
--
--   - original_amount : ce que la vente aurait coûté au prix catalogue
--     (qty × prix normal du produit). NULL si la vente n'est PAS à
--     prix réduit — c'est cette valeur NULL/non-NULL qui sert de
--     marqueur "vente réduite" partout dans le code applicatif.
--   - discount_reason : motif de la réduction, saisi librement par le
--     vendeur (ex. "biscuits cassés"). Optionnel, peut rester NULL
--     même sur une vente réduite.
--
-- Le code applicatif (SaleModal, VentesView, ClientsView, Dashboard,
-- reçu imprimé) lit ces deux colonnes pour afficher le prix d'origine
-- barré + le nouveau prix partout où la vente apparaît.
--
-- Sûr à exécuter plusieurs fois (IF NOT EXISTS) et sans impact sur les
-- ventes existantes (nouvelles colonnes nullables, pas de valeur par
-- défaut à recalculer).
--
-- À exécuter dans : Supabase > SQL Editor.
-- ============================================================

alter table public.sales
  add column if not exists original_amount integer,
  add column if not exists discount_reason text;

comment on column public.sales.original_amount is
  'Montant plein (qty × prix catalogue) avant réduction. NULL = vente sans réduction.';
comment on column public.sales.discount_reason is
  'Motif de la réduction (ex. "biscuits cassés"), optionnel.';
