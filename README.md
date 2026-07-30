# Corya Backend

Backend + admin de Corya, la réceptionniste IA suisse pour cabinets médicaux romands.

## Structure du projet

Ce repo héberge :
- Le backend `api.corya.ch` (Node.js/Express, webhook Retell)
- Le back-office `app.corya.ch` (Next.js, admin interne)

## Architecture d'agents Claude Code

Ce projet utilise le système de sub-agents de Claude Code. Un agent principal orchestre trois sub-agents spécialisés :

- **`backend-webhook`** : `api.corya.ch` (Node.js, webhook Retell, PDF, email)
- **`frontend-admin`** : `app.corya.ch` (Next.js, back-office)
- **`database-compliance`** : Supabase schema, RLS, nLPD, purges

Le fondateur interagit avec l'agent principal. Celui-ci délègue aux sub-agents.

## Documents partagés

Tous les agents lisent :
- `docs/architecture.md` : vue d'ensemble système
- `docs/stack.md` : stack technique verrouillé (ne pas modifier sans discussion)
- `docs/compliance.md` : règles nLPD (bible)

## Démarrer

### 1. Installer Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

### 2. Cloner et se placer dans le dossier

```bash
git clone git@github.com:[user]/corya-backend.git
cd corya-backend
```

### 3. Créer `.env.local`

```bash
cp .env.example .env.local
# Remplir avec les vraies valeurs
```

### 4. Lancer Claude Code

```bash
claude
```

Claude Code détecte automatiquement `CLAUDE.md` et les sub-agents dans `.claude/agents/`.

### 5. Première commande

Écris à l'agent principal :

```
Salut. On démarre. Quelle est ta compréhension du projet et par où tu proposes qu'on commence ?
```

L'agent devrait te poser 3 questions d'ouverture et te proposer un plan.

## Configuration externe à faire par le fondateur

Ces éléments sont hors périmètre des agents Claude Code — à faire manuellement :

### Comptes à créer
- [ ] Retell AI : compte + agent basique
- [ ] Peoplefone : compte + numéro 032 + SIP trunk vers Retell
- [ ] Supabase : projet Frankfurt + service key notée
- [ ] Infomaniak : Jelastic env Node.js + Mail Pro (noreply@corya.ch)
- [ ] BetterStack : monitors sur api.corya.ch et app.corya.ch
- [ ] GitHub : repo privé + secrets pour CI/CD

### DNS Infomaniak
- [ ] corya.ch A → IP Infomaniak site vitrine (ou Framer/Astro)
- [ ] api.corya.ch A → IP Jelastic backend
- [ ] app.corya.ch A → IP Jelastic frontend (ou CNAME Vercel EU)
- [ ] status.corya.ch CNAME → BetterStack
- [ ] MX + SPF + DKIM + DMARC pour corya.ch

### Adresses email
- [ ] noreply@corya.ch (SMTP transactionnel)
- [ ] contact@corya.ch (contact commercial)
- [ ] [prénom]@corya.ch (personnel fondateur)

## Structure des dossiers

```
corya-backend/
├── CLAUDE.md                       # Agent principal
├── .claude/
│   └── agents/
│       ├── backend-webhook.md
│       ├── frontend-admin.md
│       └── database-compliance.md
├── docs/
│   ├── architecture.md
│   ├── stack.md
│   └── compliance.md
├── apps/
│   ├── backend/                    # api.corya.ch (créé par backend-webhook)
│   └── admin/                      # app.corya.ch (créé par frontend-admin)
├── supabase/                       # Migrations (créé par database-compliance)
├── .env.example
└── README.md
```

Structure monorepo simple. Peut évoluer vers Turborepo si nécessaire.

## Documents de projet global

Documents stratégiques (à garder ailleurs ou dans un dossier `.corya-docs/` séparé) :
- `corya_contexte_projet.md` : stratégie, équipe, marché
- `corya_recap_humain.md` : plan d'action business
- `corya_architecture_technique.md` : détails techniques complets
- `corya_scripts_cold.md` : scripts commerciaux (père)
- `corya_prompt_lovable_crm.md` : CRM interne prospection

## Licence

Propriétaire — Corya, tous droits réservés.
