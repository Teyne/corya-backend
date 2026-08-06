# Orchestration Claude — portail authentifié

## Principe

Le chat principal Claude est l'architecte. Il ne délègue pas la responsabilité
finale : il choisit l'architecture, découpe les vagues, attribue les fichiers,
arbitre les contradictions, inspecte tous les diffs et rend le bilan.

Quatre sous-agents de projet sont définis dans `.claude/agents/` :

| Agent | Responsabilité | Écriture autorisée |
| --- | --- | --- |
| `portal-auth-database` | schéma, migrations, RLS, Storage, invariants SQL | `supabase/migrations/`, `supabase/tests/`, documentation DB attribuée |
| `portal-auth-backend` | authentification API, autorisation, DTO, endpoints et tests | `apps/backend/src/`, `apps/backend/tests/`, documentation API attribuée |
| `portal-auth-frontend` | session et intégration du portail | dépôt `corya-patient-connect` uniquement |
| `portal-auth-reviewer` | revue indépendante sécurité/nLPD/QA | aucune écriture |

Les sous-agents ne créent pas d'autres agents.

## Démarrage

Depuis le dépôt backend, donner aussi accès au dépôt portail :

```powershell
cd "C:\Users\theo-\Desktop\Corya\dev\corya-backend"
claude --add-dir "..\corya-portal-client\corya-patient-connect"
```

Les agents projet sont découverts automatiquement dans `.claude/agents/`.
Utiliser `/agents` dans Claude Code pour vérifier leur présence.

## Règles de concurrence

- maximum quatre sous-agents actifs ;
- les analyses en lecture seule peuvent s'exécuter en parallèle ;
- un seul agent écrivain par zone à la fois ;
- aucun fichier n'est confié à deux agents écrivains ;
- la migration précède le backend qui en dépend ;
- le contrat API précède l'intégration frontend ;
- le reviewer intervient après chaque vague et à la fin ;
- si un agent rencontre une modification non attribuée, il s'arrête et la
  signale au lieu de la remplacer.

## Cycle obligatoire

### 0. Préflight en lecture seule

L'architecte :

1. lit `AGENTS.md`, `README.md`, `docs/architecture.md`,
   `.claude/session4-decisions.md`, le présent dossier, les migrations et tests
   concernés ;
2. exécute `git status --short` dans les deux dépôts ;
3. demande aux quatre agents une analyse indépendante, sans modification ;
4. vérifie les versions réellement installées et la documentation officielle ;
5. synthétise une ADR et attend le GO utilisateur si le choix change
   matériellement l'architecture.

### 1. Vague base

L'architecte donne à `portal-auth-database` la propriété exclusive des fichiers
SQL listés dans sa mission. Le reviewer relit ensuite la migration et les tests.
Rien n'est appliqué à distance.

### 2. Vague backend

Après stabilisation du contrat DB, `portal-auth-backend` implémente une vague
atomique. L'architecte inspecte le diff, lance les validations backend puis fait
relire au reviewer.

### 3. Vague frontend

Après stabilisation du contrat API, `portal-auth-frontend` travaille uniquement
dans le dépôt portail. Il n'invente aucun endpoint. L'architecte inspecte le
diff, lance les validations du portail puis fait relire au reviewer.

### 4. Revue intégrée

Le reviewer contrôle les deux dépôts : isolation, rôles, secrets, PII, erreurs,
timeouts, CORS, CSRF/cookies ou Bearer, URL signées, tests négatifs et docs.
L'architecte vérifie lui-même chaque finding prioritaire.

## Contrat de rendu de chaque agent

Chaque agent retourne une synthèse courte :

1. constat et hypothèses ;
2. fichiers/symboles inspectés ou modifiés ;
3. invariants couverts ;
4. validations exactes et résultats ;
5. risques résiduels ;
6. décision `GO`, `GO sous conditions` ou `STOP` ;
7. action suivante recommandée.

Il n'affiche jamais de secret, token, PII, payload patient ou URL signée.

## Validations minimales

Backend, depuis `apps/backend/` :

```powershell
npm test -- --run
npm run test:e2e
npm run type-check
npm run lint
```

Puis à la racine :

```powershell
git diff --check
git status --short
```

Portail, depuis le dépôt portail :

```powershell
bun install --frozen-lockfile
bun run lint
bun run type-check
bun run build
bun test
bun audit
git diff --check
git status --short
```

Les tests distants, migrations, déploiements, commits, push et merges nécessitent
chacun l'autorisation explicite correspondant à l'action.
