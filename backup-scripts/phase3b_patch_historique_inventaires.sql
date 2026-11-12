-- ============================================================================
-- Phase 3b — correctif : les inventaires apparaissent dans l'historique
-- de l'écran « Transfers » (onglets Mine / Whole team).
--
-- Contexte : transfers_inbox() ne renvoie que les transferts et les demandes ;
-- un écart d'inventaire (ex. « −5 », motif « other ») n'y était donc pas visible.
-- Ce correctif AJOUTE une fonction de lecture et ne modifie rien d'existant :
-- aucun stock, aucun lot, aucune table. Il peut être rejoué sans risque.
--
-- Prérequis : phase3b_reattribution_inventaire.sql déjà exécuté.
-- Sans ce correctif l'application continue de fonctionner (l'historique
-- n'affiche simplement pas les inventaires).
-- ============================================================================

-- p_all = false : les comptages dont je suis la personne comptée ou l'auteur.
-- p_all = true  : toute l'équipe (managers/admins seulement ; ignoré sinon).
-- Seuls les comptages avec écart sont listés (un comptage exact ne change rien).
create or replace function public.inventory_history(p_all boolean default false)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_all boolean;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  v_all := coalesce(p_all, false) and public.is_manager_or_admin();

  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id)
      from (
        select c.id, c.product_id,
               p.name as product_name, p.emoji as product_emoji, p.color as product_color,
               c.owner_id, public._user_label(c.owner_id) as owner_name,
               c.declared_by, public._user_label(c.declared_by) as declared_by_name,
               c.expected_qty, c.counted_qty, c.delta, c.reason, c.note, c.value_delta,
               c.created_at
          from public.stock_counts c
          join public.products p on p.id = c.product_id
         where c.delta <> 0
           and (v_all or c.owner_id = v_uid or c.declared_by = v_uid)
         order by c.created_at desc, c.id
         limit 60
      ) x), '[]'::jsonb);
end;
$$;

revoke all on function public.inventory_history(boolean) from public, anon, authenticated;
grant execute on function public.inventory_history(boolean) to authenticated;

insert into public.app_migrations (name) values ('phase3b_patch_historique_inventaires')
on conflict (name) do nothing;

notify pgrst, 'reload schema';

-- Vérification (doit renvoyer false) :
--   select has_function_privilege('anon', 'public.inventory_history(boolean)', 'execute');
