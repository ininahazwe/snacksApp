-- ============================================================
-- MIGRATION : archiver l'état actuel + repartir à zéro
-- App : Douceurs POS (projet "Boutique")
-- ============================================================
--
-- Ce script :
--   1. Déplace TOUTES les tables actuelles (products, clients, sales,
--      stock_movements, stock_batches) vers un schéma "archive" —
--      elles restent 100% intactes et consultables (SQL Editor,
--      ou Table Editor > sélecteur de schéma en haut à gauche).
--   2. Recrée des tables vides identiques (structure, contraintes,
--      policies RLS) dans "public" — c'est ce que l'app utilise.
--   3. Recopie UNIQUEMENT les noms des clients dans la nouvelle
--      table clients (dette et crédit repartent à 0, téléphone vide).
--   4. Produits / ventes / mouvements de stock / lots repartent
--      à zéro (catalogue à ressaisir).
--
-- Le schéma "archive" n'est PAS exposé par l'API Supabase (PostgREST
-- n'expose que "public" par défaut) : l'app ne peut pas y toucher,
-- seul quelqu'un avec accès au Dashboard peut le consulter via le
-- SQL Editor ou le Table Editor.
--
-- ⚠️ AVANT DE LANCER CE SCRIPT : fais tourner backup_supabase.sh
-- (dump complet + CSV) au cas où. Ce script est lui-même sûr — il
-- est entouré d'une transaction — mais un filet de sécurité externe
-- ne coûte rien.
--
-- MODE D'EMPLOI :
--   1. Copie tout ce script dans le SQL Editor de Supabase.
--   2. Exécute-le EN ENTIER SAUF la ligne "COMMIT;" tout en bas
--      (sélectionne tout sauf la dernière ligne, ou commente-la).
--   3. Vérifie les résultats des SELECT de contrôle à la fin.
--   4. Si tout est bon : reviens exécuter "COMMIT;" seul.
--      Si quelque chose cloche : exécute "ROLLBACK;" à la place —
--      rien n'aura été modifié.
-- ============================================================

-- ------------------------------------------------------------
-- 0. À FAIRE EN PREMIER, séparément, AVANT de lancer la
--    transaction ci-dessous : vérifier s'il existe des triggers
--    sur ces tables (ex. mise à jour automatique du stock,
--    marquage d'un lot comme épuisé, etc.). "LIKE ... INCLUDING
--    ALL" copie les colonnes, contraintes, valeurs par défaut,
--    index et policies — mais PAS les triggers. S'il y en a, il
--    faudra les recréer à la main sur les nouvelles tables après
--    la migration (Database > Triggers dans le Dashboard donne
--    le code exact de chaque trigger et de la fonction associée).
--
--    select event_object_table, trigger_name, action_timing, event_manipulation
--    from information_schema.triggers
--    where trigger_schema = 'public';
-- ------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 1. Schéma d'archive + déplacement des tables actuelles
-- ------------------------------------------------------------
create schema if not exists archive;

alter table public.stock_movements set schema archive;
alter table public.sales            set schema archive;
alter table public.stock_batches    set schema archive;
alter table public.clients          set schema archive;
alter table public.products         set schema archive;

-- ------------------------------------------------------------
-- 2. Nouvelles tables vides dans public (même structure exacte,
--    contraintes CHECK, valeurs par défaut, clé primaire, index
--    uniques inclus via "LIKE ... INCLUDING ALL")
-- ------------------------------------------------------------
create table public.products (like archive.products including all);
create table public.clients  (like archive.clients  including all);

create table public.stock_batches (like archive.stock_batches including all);
alter table public.stock_batches
  add constraint stock_batches_product_id_fkey
  foreign key (product_id) references public.products(id);

create table public.sales (like archive.sales including all);
alter table public.sales
  add constraint sales_product_id_fkey foreign key (product_id) references public.products(id),
  add constraint sales_client_id_fkey  foreign key (client_id)  references public.clients(id),
  add constraint sales_user_id_fkey    foreign key (user_id)    references auth.users(id),
  add constraint sales_batch_id_fkey   foreign key (batch_id)   references public.stock_batches(id);

create table public.stock_movements (like archive.stock_movements including all);
alter table public.stock_movements
  add constraint stock_movements_product_id_fkey foreign key (product_id) references public.products(id),
  add constraint stock_movements_batch_id_fkey    foreign key (batch_id)   references public.stock_batches(id),
  add constraint stock_movements_sale_id_fkey     foreign key (sale_id)    references public.sales(id);

-- ------------------------------------------------------------
-- 3. RLS : réactiver + recopier automatiquement les policies
--    qui existaient sur les tables archivées
-- ------------------------------------------------------------
alter table public.products         enable row level security;
alter table public.clients          enable row level security;
alter table public.sales            enable row level security;
alter table public.stock_movements  enable row level security;
alter table public.stock_batches    enable row level security;

do $$
declare
  pol record;
begin
  for pol in
    select * from pg_policies
    where schemaname = 'archive'
      and tablename in ('products','clients','sales','stock_movements','stock_batches')
  loop
    execute format(
      'create policy %I on public.%I as %s for %s to %s%s%s',
      pol.policyname,
      pol.tablename,
      pol.permissive,
      pol.cmd,
      array_to_string(pol.roles, ', '),
      case when pol.qual is not null then format(' using (%s)', pol.qual) else '' end,
      case when pol.with_check is not null then format(' with check (%s)', pol.with_check) else '' end
    );
  end loop;
end $$;

-- ------------------------------------------------------------
-- 4. Reprise des clients : uniquement les noms, tout le reste à 0
-- ------------------------------------------------------------
insert into public.clients (name)
select name from archive.clients
order by name;

-- ------------------------------------------------------------
-- 5. Vérifications avant de valider (COMMIT)
-- ------------------------------------------------------------
select 'public.clients (nouveaux, noms repris)' as verif, count(*) from public.clients
union all
select 'public.products (doit être vide)', count(*) from public.products
union all
select 'public.sales (doit être vide)', count(*) from public.sales
union all
select 'archive.clients (historique intact)', count(*) from archive.clients
union all
select 'archive.sales (historique intact)', count(*) from archive.sales;

select policyname, tablename, cmd, roles from pg_policies where schemaname = 'public';

-- ------------------------------------------------------------
-- 6. Valider (ou remplacer par ROLLBACK; pour tout annuler)
-- ------------------------------------------------------------
commit;
