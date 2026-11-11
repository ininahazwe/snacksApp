-- ============================================================
-- CORRECTIF DE SÉCURITÉ URGENT (11 nov. 2026)
-- À exécuter dans : Supabase > SQL Editor
--
-- Ferme les accès les plus dangereux SANS changer le comportement de
-- l'appli pour les utilisateurs connectés (ventes, écran Team, restock).
-- Le vrai correctif (rôles dans une table protégée, règles d'accès par
-- rôle sur toutes les tables) est la phase 1 de
-- claude/spec-roles-stock-par-utilisateur.
--
-- Constats (audit des définitions collées par l'utilisateur) :
-- 1. update_user_role : pour un appelant non connecté, le rôle lu dans le
--    JWT vaut NULL ; "NULL != 'gerant'" vaut NULL et le IF ne lève aucune
--    exception -> la vérification est contournée. La fonction est
--    SECURITY DEFINER et, par défaut, exécutable avec la clé anon
--    (publique, présente dans le bundle de l'appli).
-- 2. users_view (e-mails, dernière connexion de tous les comptes) est
--    probablement lisible avec la clé anon.
-- 3. stock_batches : les politiques select/update sont "using (true)" sans
--    "to authenticated" -> elles s'appliquent aussi aux anonymes.
--
-- NON corrigé ici (phase 1) : le rôle est lu dans user_metadata, que
-- l'utilisateur peut modifier lui-même ; tout utilisateur connecté a
-- encore un accès complet à products, sales, clients et stock_movements.
--
-- Script idempotent : peut être rejoué sans risque.
-- ============================================================

-- 1. update_user_role : refus si non connecté, comparaison sûre face à NULL,
--    search_path fixé, exécution réservée aux utilisateurs connectés.
create or replace function public.update_user_role(target_user_id uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null
     or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') <> 'gerant' then
    raise exception 'Access denied: only managers can change roles';
  end if;

  if new_role not in ('gerant', 'vendeur') then
    raise exception 'Invalid role: must be gerant or vendeur';
  end if;

  update auth.users
  set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('role', new_role)
  where id = target_user_id;
end;
$$;

revoke execute on function public.update_user_role(uuid, text) from public, anon;
grant  execute on function public.update_user_role(uuid, text) to authenticated;

-- 2. users_view : plus lisible sans connexion (l'écran Team reste utilisable
--    par les utilisateurs connectés).
revoke all on public.users_view from public, anon;
grant select on public.users_view to authenticated;

-- 3. stock_batches : politiques limitées aux utilisateurs connectés
--    (mêmes conditions qu'avant, seul le public visé change).
drop policy if exists stock_batches_select on public.stock_batches;
drop policy if exists stock_batches_update on public.stock_batches;

create policy stock_batches_select on public.stock_batches
  for select to authenticated using (true);

create policy stock_batches_update on public.stock_batches
  for update to authenticated using (true) with check (true);
