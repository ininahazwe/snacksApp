# 🍬 Douceurs POS

Application de point de vente PWA pour petit commerce de sucreries.

## Stack
- **Frontend** : React + Vite + PWA
- **Backend** : Supabase (PostgreSQL + Auth)
- **Déploiement** : Vercel

---

## 🚀 Installation en 4 étapes

### Étape 1 — Cloner et installer
```bash
# Dans ton terminal, dans le dossier où tu veux le projet
cd ~/Documents
# Copier le dossier douceurs-pos ici, puis :
cd douceurs-pos
npm install
```

### Étape 2 — Créer le projet Supabase
1. Va sur [supabase.com](https://supabase.com) → **New project**
2. Donne un nom : `douceurs-pos`
3. Choisis un mot de passe fort pour la DB → **Create project** (attendre ~2 min)
4. Va dans **SQL Editor** → colle tout le contenu de `supabase-schema.sql` → **Run**
5. Va dans **Project Settings > API** et copie :
   - `Project URL`
   - `anon public` key

### Étape 3 — Configurer les variables d'environnement
```bash
# Dans le dossier du projet
cp .env.example .env
```
Ouvre `.env` et remplace les valeurs :
```
VITE_SUPABASE_URL=https://XXXXXXXXXX.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...
```

### Étape 4 — Créer le premier utilisateur
1. Dans Supabase → **Authentication > Users** → **Add user**
2. Email : `gerant@douceurs.com` / mot de passe de ton choix
3. Dans **User metadata**, ajoute : `{ "role": "gerant" }`

---

## 💻 Lancer en développement
```bash
npm run dev
# Ouvre http://localhost:5173
```

---

## 🌐 Déployer sur Vercel
```bash
# 1. Pousser sur GitHub
git init
git add .
git commit -m "Initial commit - Phase 1"
git remote add origin https://github.com/TON_USER/douceurs-pos.git
git push -u origin main

# 2. Sur vercel.com → New Project → importer depuis GitHub
# 3. Dans Environment Variables, ajouter :
#    VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY
# 4. Deploy !
```

---

## 📁 Structure du projet
```
src/
├── context/
│   └── AuthContext.jsx     ← État global auth (user, role, login, logout)
├── lib/
│   └── supabase.js         ← Client Supabase singleton
├── components/
│   └── ProtectedRoute.jsx  ← Protection des routes
├── views/
│   ├── LoginPage.jsx       ← Page de connexion
│   ├── Dashboard.jsx       ← Vue principale (KPIs + ventes récentes)
│   ├── VentesView.jsx      ← Phase 2
│   ├── ProduitsView.jsx    ← Phase 2
│   ├── ClientsView.jsx     ← Phase 3
│   └── StocksView.jsx      ← Phase 3
├── App.jsx                 ← Router + Layout + Navigation
├── main.jsx                ← Point d'entrée
└── index.css               ← Reset CSS global
```

---

## 🗺 Roadmap
- [x] **Phase 1** — Fondations : Auth + DB + Déploiement
- [ ] **Phase 2** — Ventes + Scan code-barres + Open Food Facts
- [ ] **Phase 3** — Dashboard complet + Stocks + Dettes
- [ ] **Phase 4** — PWA offline + Rôles vendeur/gérant
- [ ] **Phase 5** — Optionnel : reconnaissance visuelle, SMS, impression
