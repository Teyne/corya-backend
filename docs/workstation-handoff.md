# Reprise de Corya sur un autre poste

État de référence : 26 août 2026, fuseau Europe/Zurich.

Ce document permet de reprendre le développement sans copier le poste actuel
ni l'historique brut des conversations. Il ne contient aucun secret. Les états
distants (déploiements, intégrations et versions publiées) doivent être
revalidés au début d'une nouvelle session.

## 1. Dépôts et disposition locale

Disposition recommandée sous un dossier `Corya/dev` :

```text
Corya/dev/
├── corya-backend/
├── corya-backend-inbox/              worktree du backend
├── corya-frontend/corya/             site public corya.ch
└── corya-portal-client/
    └── corya-patient-connect/        portail.corya.ch
```

| Projet | Dépôt GitHub | Révision validée au 26 août 2026 |
| --- | --- | --- |
| Backend, API, worker, migrations | `Teyne/corya-backend` | `4711fc9b27f0` sur `origin/main` avant le présent handoff |
| Portail cabinet | `Teyne/corya-patient-connect` | `cfe1fc9e2241` sur `origin/main` |
| Site public | `Teyne/la-fabrique-digital` | `e75b40328eb0` sur `origin/main` |
| Architecture Corya Inbox | worktree de `Teyne/corya-backend` | branche `codex/inbox-architecture` |

Le site public est un dépôt séparé. Le portail est également un dépôt séparé.
Le dossier Inbox n'est pas un quatrième dépôt : c'est un worktree du backend.

## 2. Installation sur le nouveau poste

Installer d'abord Git, Node.js, npm, Bun, Docker Desktop, Supabase CLI, Codex et
une distribution OpenSSH. Configurer GitHub avec une clé SSH ou Git Credential
Manager, puis exécuter dans PowerShell :

```powershell
New-Item -ItemType Directory -Force "$HOME\Desktop\Corya\dev" | Out-Null
Set-Location "$HOME\Desktop\Corya\dev"

git clone https://github.com/Teyne/corya-backend.git corya-backend

New-Item -ItemType Directory -Force corya-frontend | Out-Null
git clone https://github.com/Teyne/la-fabrique-digital.git corya-frontend\corya

New-Item -ItemType Directory -Force corya-portal-client | Out-Null
git clone https://github.com/Teyne/corya-patient-connect.git corya-portal-client\corya-patient-connect

Set-Location corya-backend
git fetch --all --prune
git worktree add ..\corya-backend-inbox origin/codex/inbox-architecture
```

Installer ensuite les dépendances :

```powershell
Set-Location "$HOME\Desktop\Corya\dev\corya-backend\apps\backend"
npm ci

Set-Location "$HOME\Desktop\Corya\dev\corya-portal-client\corya-patient-connect"
bun install --frozen-lockfile

Set-Location "$HOME\Desktop\Corya\dev\corya-frontend\corya"
bun install --frozen-lockfile
```

Si le handoff n'a pas encore été fusionné dans `main`, récupérer sa branche
indiquée dans le rapport final du poste d'origine avant de commencer.

## 3. Secrets et accès à transférer séparément

Git ne doit jamais contenir les éléments suivants :

- fichiers `.env.local` ou autres `.env` réels ;
- clé SSH privée Jelastic ;
- service-role Supabase ou jeton Supabase CLI ;
- clés Retell, Cal.com, Twilio ou SMTP ;
- secrets HMAC, certificats, mots de passe ou exports du Gestionnaire
  d'identifiants Windows ;
- historique brut de conversation contenant des identifiants opérationnels.

Les remettre sur le nouveau poste depuis le gestionnaire de mots de passe ou
les consoles officielles, puis se reconnecter manuellement à GitHub, Supabase,
Jelastic, Retell, Twilio, Cal.com, Infomaniak, Lovable et Cloudflare. Les
sessions du navigateur et du terminal ne sont pas transférées par Git.

Le skill Graphify, ses hooks et `graphify-out/` sont locaux et volontairement
absents de Git. Réinstaller le skill sur le nouveau poste puis régénérer le
graphe si nécessaire ; ne pas copier aveuglément ces artefacts générés.

Pour Jelastic, copier la clé privée par un canal chiffré vers
`$HOME\.ssh\corya-jelastic-ed25519`, vérifier ses permissions, puis charger la
clé dans `ssh-agent`. Ne jamais afficher ni envoyer son contenu dans un chat.

## 4. État fonctionnel à revalider

Le flux principal versionné est :

```text
Retell -> webhook Express signé -> Supabase -> worker
       -> PDF privé -> e-mail Infomaniak
```

État connu au moment du handoff :

- API et worker Jelastic séparés, contrôlés par PM2 ;
- `/health` et `/health/deep` validés lors du dernier contrôle ;
- portail `portail.corya.ch` actif avec Supabase Auth et isolation tenant ;
- webhook Retell `call_analyzed`, PDF et e-mail de récapitulatif validés ;
- calendrier Cal.com relié par OAuth par cabinet ;
- registre et réconciliation Cal.com versionnés ;
- Retell et le numéro Twilio configurés pour la démonstration contrôlée ;
- Corya Inbox reste une architecture séparée, sans implémentation ni connexion
  Microsoft réelle.

Ces constats ne sont pas des preuves permanentes. Refaire les contrôles de
santé, de branche, de migration et d'intégration avant toute opération réelle.

## 5. Invariants de sécurité

- aucune donnée patient dans les logs, alertes, erreurs persistées, fixtures ou
  rapports d'agents ;
- erreurs externes redactées et I/O bornées par timeout ;
- idempotence, retries bornés et transitions concurrentes sûres ;
- suppressions physiques via outbox et heartbeat ;
- migrations append-only ;
- aucun secret dans Git, les URL, les captures ou les prompts ;
- aucune migration distante, publication, suppression, fusion ou déploiement
  sans autorisation explicite ;
- environnement actuel limité à une démonstration contrôlée, sans vrai patient.

## 6. Contrôles locaux de reprise

Dans chaque dépôt :

```powershell
git status --short
git branch --show-current
git fetch --all --prune
git rev-list --left-right --count HEAD..."@{upstream}"
```

Dans `corya-backend/apps/backend` :

```powershell
npm test -- --run
npm run test:e2e
npm run type-check
npm run lint
npm run build
```

Avant tout commit backend :

```powershell
git diff --check
git status --short
```

Les tests SQL utilisent uniquement une base Supabase locale jetable après
`supabase start` et `supabase db reset`. Ne jamais exécuter les scripts
d'invariants contre une base distante.

## 7. Travaux prioritaires après la reprise

1. Revalider les trois dépôts, les migrations effectivement appliquées et les
   deux processus Jelastic.
2. Terminer le test contrôlé du calendrier OAuth par cabinet, puis révoquer
   l'ancienne clé Cal.com de démonstration seulement après preuve du nouveau
   chemin.
3. Reprendre les essais Retell quand les crédits sont disponibles : recherche
   de plusieurs créneaux, absence de silence après un outil, réservation,
   numéro de rappel et cohérence PDF/e-mail/base.
4. Préparer l'onboarding d'un premier cabinet : numéro, agent Retell, connexion
   calendrier, membres du portail, destinataires, procédures et rollback.
5. Pour Corya Inbox, valider les huit décisions de
   `docs/inbox-architecture.md` avant la première migration. L'architecture ne
   vaut pas autorisation de connecter Microsoft ni de traiter des e-mails réels.

## 8. Reprendre le contexte Codex

Le projet, les commits et ce document sont portables. Une tâche Codex peut
rester associée au poste ou à son environnement local ; son terminal, ses
sessions web, ses secrets et son répertoire ne suivent pas automatiquement.

Sur le nouveau poste, se connecter au même compte Codex. Si la tâche apparaît
dans l'historique, l'ouvrir depuis le nouveau clone et lui faire relire ce
document. Sinon, créer une nouvelle tâche dans `corya-backend` avec ce message :

```text
Reprends Corya depuis docs/workstation-handoff.md. Lis entièrement AGENTS.md,
README.md, docs/architecture.md, .claude/session4-decisions.md et les migrations
concernées avant toute action. Vérifie les dépôts et l'état distant en lecture
seule. Ne révèle aucun secret et ne réalise aucune opération distante sans mon
autorisation explicite.
```

Ne pas exporter l'historique brut de cette tâche dans Git. Les décisions utiles
doivent être synthétisées dans la documentation versionnée et expurgée.
