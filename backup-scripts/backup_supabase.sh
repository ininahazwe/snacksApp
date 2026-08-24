#!/usr/bin/env bash
# ============================================================
# Sauvegarde complète Supabase — avant remise à zéro de la BD
# App : Douceurs POS (projet "Boutique")
# ============================================================
#
# Prérequis :
#   - Client PostgreSQL installé en local (pg_dump, psql)
#       macOS :  brew install postgresql
#   - La chaîne de connexion à ta base Supabase :
#       Dashboard Supabase > Project Settings > Database > Connection string > URI
#     (utilise de préférence la "Session pooler" si tu es en IPv4)
#
# Usage :
#   export SUPABASE_DB_URL="postgresql://postgres.xxxx:MOTDEPASSE@xxxx.pooler.supabase.com:5432/postgres"
#   ./backup_supabase.sh
#
set -euo pipefail

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "Erreur : la variable SUPABASE_DB_URL n'est pas définie."
  echo "Trouve la chaîne de connexion dans Supabase > Project Settings > Database."
  exit 1
fi

STAMP=$(date +%Y%m%d_%H%M%S)
OUTDIR="backup_supabase_${STAMP}"
mkdir -p "$OUTDIR/csv"

echo "1/4 — Sauvegarde complète (schéma + données + policies RLS + triggers)..."
pg_dump "$SUPABASE_DB_URL" --no-owner --no-privileges -f "$OUTDIR/backup_complet.sql"

echo "2/4 — Sauvegarde du schéma seul (structure, utile pour recréer une BD identique)..."
pg_dump "$SUPABASE_DB_URL" --no-owner --no-privileges --schema-only -f "$OUTDIR/schema_seul.sql"

echo "3/4 — Export CSV des tables (archive lisible, pratique pour la compta / un tableur)..."
TABLES=(products clients sales stock_movements stock_batches)
for T in "${TABLES[@]}"; do
  echo "   -> $T.csv"
  psql "$SUPABASE_DB_URL" -c "\copy public.$T TO '$OUTDIR/csv/${T}.csv' WITH CSV HEADER"
done

echo "4/4 — Vérification rapide des fichiers générés..."
ls -lh "$OUTDIR" "$OUTDIR/csv"

echo ""
echo "✅ Sauvegarde terminée dans : $OUTDIR"
echo "   Copie ce dossier à au moins 2 endroits différents (ex. Google Drive + disque local)"
echo "   AVANT de toucher à la base de production."
