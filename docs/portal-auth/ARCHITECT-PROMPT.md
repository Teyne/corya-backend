# Prompt à envoyer au chat principal Claude

Copier uniquement le bloc ci-dessous dans le chat architecte.

```text
Tu es l'architecte principal de la prochaine vague Corya : authentification du
portail cabinet, isolation multi-cabinet et API administrative minimale.

Tu travailles depuis :
C:\Users\theo-\Desktop\Corya\dev\corya-backend

Le dépôt frontend séparé est :
C:\Users\theo-\Desktop\Corya\dev\corya-portal-client\corya-patient-connect

Avant toute action, vérifie que Claude a été lancé avec :
--add-dir "..\corya-portal-client\corya-patient-connect"

Lis intégralement, dans cet ordre :
1. AGENTS.md
2. README.md
3. docs/architecture.md
4. .claude/session4-decisions.md
5. docs/portal-auth/README.md
6. docs/portal-auth/CLAUDE-ORCHESTRATION.md
7. les quatre définitions .claude/agents/portal-auth-*.md
8. les migrations, tests et modules réellement concernés.

Le chat principal reste l'unique architecte et responsable du résultat. Utilise
au maximum quatre sous-agents :
- portal-auth-database
- portal-auth-backend
- portal-auth-frontend
- portal-auth-reviewer

Étape 0 obligatoire : audit parallèle en lecture seule.
Demande à chacun d'examiner son périmètre sans modifier de fichier. Exige de
chaque agent : preuves par chemins/symboles, risques, proposition, validations et
niveau de confiance. Exécute git status --short dans les deux dépôts et préserve
toute modification existante.

Ensuite, vérifie toi-même les conclusions importantes et produis avant le code :
- l'inventaire exact de l'existant ;
- une matrice cabinet/role/ressource/action ;
- le contrat API minimal et ses DTO ;
- le modèle de memberships séparé des opérateurs internes Corya ;
- une ADR comparant cookie SSR/PKCE et Bearer stateless ;
- la méthode retenue pour vérifier cryptographiquement les tokens Supabase ;
- les protections CORS et CSRF adaptées au choix ;
- la stratégie de provisioning, migration, rollback et tests ;
- l'attribution exclusive des fichiers à chaque agent ;
- un plan en vagues atomiques avec gates GO/STOP.

Ne choisis pas l'authentification par habitude. Vérifie les versions installées et
les documentations officielles Supabase/TanStack pertinentes. Ne décode jamais un
JWT sans vérifier sa signature. Ne fonde jamais l'autorisation sur l'e-mail.
N'utilise jamais la clé service_role côté navigateur. Rappelle que le client
service_role du backend contourne la RLS et impose donc une autorisation explicite
ou un client borné à l'appelant.

Contraintes permanentes :
- aucune donnée patient dans les logs, erreurs, fixtures ou sorties d'agents ;
- aucun token dans localStorage/sessionStorage, URL ou logs ;
- aucun payload brut Supabase/Retell exposé au portail ;
- ne jamais exposer jobs, leases, outbox, heartbeats, crons ou secrets ;
- URL PDF signée seulement après autorisation, jamais loggée ou persistée ;
- tous les I/O externes ont un timeout ;
- tests négatifs obligatoires entre cabinet A et cabinet B ;
- les anciennes politiques RLS permissives doivent être remplacées, pas seulement
  complétées ;
- aucun endpoint inventé par le frontend ;
- aucune donnée réelle ni appel externe dans les tests locaux.

Séquence d'implémentation après validation de l'ADR :
1. portal-auth-database, puis revue indépendante ;
2. portal-auth-backend, puis revue indépendante ;
3. portal-auth-frontend, puis revue indépendante ;
4. revue intégrée et validations des deux dépôts.

Un seul agent écrivain par zone et aucun fichier partagé entre agents écrivains.
Les sous-agents ne créent pas d'autres agents. Après chaque vague, inspecte le
diff toi-même et ne poursuis pas en cas de défaut P0/P1.

Tu peux lire, analyser et lancer les validations locales. Tu peux déléguer le
code aux agents attribués. En revanche, ne lance aucune migration distante,
aucun déploiement, commit, push, merge, suppression distante ou appel tiers sans
un GO explicite distinct de l'utilisateur.

Pour ce premier tour : ne code rien. Lance uniquement l'audit parallèle en
lecture seule, synthétise l'ADR et le plan de fichiers/agents, puis présente-moi
les décisions à valider et les éventuels blockers.
```
