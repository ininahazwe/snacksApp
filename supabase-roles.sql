-- ============================================
-- DOUCEURS POS — Gestion des rôles
-- Phase 4 : vendeur / gérant
-- ============================================

-- Les rôles sont stockés dans user_metadata de Supabase Auth.
-- Pas de nouvelle table nécessaire.

-- ============================================
-- OPTION A : Créer un utilisateur gérant
-- À exécuter dans Supabase > SQL Editor
-- ============================================

-- NB : Supabase ne permet pas de créer des users via SQL directement.
-- Utilise le dashboard Authentication > Users > Add user
-- puis mets à jour le rôle via SQL :

-- Mettre à jour le rôle d'un utilisateur existant par email :
UPDATE auth.users
SET raw_user_meta_data = raw_user_meta_data || '{"role": "gerant"}'::jsonb
WHERE email = 'gerant@douceurs.com';

-- Mettre à jour le rôle d'un vendeur :
UPDATE auth.users
SET raw_user_meta_data = raw_user_meta_data || '{"role": "vendeur"}'::jsonb
WHERE email = 'vendeur@douceurs.com';

-- ============================================
-- OPTION B : RLS par rôle (optionnel, avancé)
-- Empêche les vendeurs de modifier les produits/stocks
-- directement via l'API (protection backend)
-- ============================================

-- Fonction helper qui lit le rôle du token JWT
CREATE OR REPLACE FUNCTION auth.user_role()
RETURNS text AS $$
  SELECT COALESCE(
    (auth.jwt() -> 'user_metadata' ->> 'role'),
    'vendeur'
  )
$$ LANGUAGE sql STABLE;

-- Les vendeurs peuvent seulement LIRE les produits (pas modifier)
DROP POLICY IF EXISTS "Authenticated full access" ON public.products;

CREATE POLICY "Gérant peut tout faire sur products" ON public.products
  FOR ALL USING (auth.user_role() = 'gerant');

CREATE POLICY "Vendeur peut lire products" ON public.products
  FOR SELECT USING (auth.role() = 'authenticated');

-- Les vendeurs peuvent créer des ventes mais pas les modifier
DROP POLICY IF EXISTS "Authenticated full access" ON public.sales;

CREATE POLICY "Tous peuvent créer des ventes" ON public.sales
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Tous peuvent lire les ventes" ON public.sales
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Seul le gérant modifie les ventes" ON public.sales
  FOR UPDATE USING (auth.user_role() = 'gerant');

CREATE POLICY "Seul le gérant supprime les ventes" ON public.sales
  FOR DELETE USING (auth.user_role() = 'gerant');

-- ============================================
-- RÉSUMÉ DES ACCÈS PAR RÔLE
-- ============================================
-- 
-- VENDEUR :
--   ✅ Scanner + enregistrer une vente
--   ✅ Voir la liste des produits
--   ✅ Voir l'historique de ses ventes
--   ❌ Dashboard (KPIs, stats)
--   ❌ Gérer les clients / dettes
--   ❌ Gérer les stocks
--   ❌ Créer / modifier des produits
--
-- GÉRANT :
--   ✅ Tout
