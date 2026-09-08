-- ============================================================
-- Achat multi-produits (panier) — regroupement des lignes de vente
-- À exécuter dans : Supabase > SQL Editor
--
-- Contexte : jusqu'ici, une "vente" = une ligne dans `sales` liée à un
-- seul produit. Pour permettre d'enregistrer un achat de plusieurs
-- produits en une fois (même client, même paiement, même reçu), on
-- ajoute une colonne `group_id` : toutes les lignes d'un même panier
-- partagent le même `group_id`. Une vente classique (1 produit, via
-- SaleModal) garde `group_id = null` — comportement inchangé, aucune
-- ligne existante à migrer.
--
-- Chaque ligne reste par ailleurs complète et indépendante (son propre
-- lot FIFO, sa propre part de dette/avoir), ce qui permet d'annuler
-- soit une seule ligne du panier, soit tout le panier d'un coup, avec
-- la logique d'annulation déjà existante (VentesView.handleConfirmCancel)
-- sans aucune modification de cette logique.
-- ============================================================

alter table public.sales
  add column if not exists group_id uuid;

create index if not exists idx_sales_group_id on public.sales (group_id);
