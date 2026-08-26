# Corya Inbox — passation à un autre poste ou agent

Ce document est le point d'entrée opérationnel pour reprendre Corya Inbox sans
avoir accès à la conversation Codex qui a produit l'architecture.

## État transmis

- Dépôt : backend Corya existant, partagé avec Voice.
- Branche Inbox : `codex/inbox-architecture`.
- Branche de transfert général du poste : `codex/workstation-handoff` ; elle
  contient `docs/workstation-handoff.md` et les instructions `AGENTS.md`
  actualisées. Elle reste séparée pour préserver l'historique des travaux.
- Socle de branche : `origin/main` au moment du cadrage.
- Commit d'architecture : `a66c443` (`docs: define Corya Inbox architecture`).
- État fonctionnel : **architecture seulement**. Aucun connecteur Microsoft,
  schéma Inbox, worker Inbox ou appel IA n'est encore implémenté.
- Voice reste le produit fonctionnel existant et ne doit pas être régressé.

## Lecture obligatoire, dans cet ordre

1. `AGENTS.md` — règles d'orchestration et de sécurité du dépôt.
2. `README.md` — flux réel et commandes du backend.
3. `docs/architecture.md` — architecture déployable actuelle.
4. `.claude/session4-decisions.md` — divergences historiques et contrats réels.
5. `docs/inbox-architecture.md` — contrat produit et technique Inbox.
6. `docs/inbox-implementation-plan.md` — vagues, responsabilités et gates.
7. `docs/email-copilot-architecture.md` — synthèse fonctionnelle.
8. Les migrations et tests cités par les documents avant toute modification.

Le code courant et les migrations non appliquées priment toujours sur une
ancienne conversation, un prompt ou une hypothèse de l'agent.

Si la branche Inbox n'intègre pas encore la branche de transfert général,
consulter son guide sans changer de branche avec :

```text
git show origin/codex/workstation-handoff:docs/workstation-handoff.md
```

## Décisions déjà prises

- L'utilisateur travaille dans Outlook ; Corya ne fournit pas un second client
  mail.
- Corya crée un brouillon de réponse dans Outlook ; l'humain le relit, le
  modifie et l'envoie.
- Le MVP n'obtient pas `Mail.Send`.
- Microsoft Graph est le premier adaptateur, mais Inbox Core reste indépendant
  du fournisseur et du secteur.
- Le webhook Graph est seulement un signal ; Delta Query est la source de
  vérité et répare les événements manqués ou rejoués.
- L'accès cible une boîte partagée avec identité applicative et Exchange
  Application RBAC limité aux boîtes explicitement autorisées.
- `Prefer: IdType="ImmutableId"` est requis pour les messages et brouillons.
- La file Voice `public.jobs` n'est pas réutilisable : `appel_id` y est
  obligatoire. Inbox reçoit une file additive `inbox_jobs` avec leases,
  fencing, retries bornés, heartbeat et dead-letter propres.
- `cabinet_id` reste la clé tenant d'intégration. Il est résolu côté backend et
  ne constitue jamais une preuve d'autorisation fournie par le client.
- Le Health Pack contient la personnalisation santé ; Inbox Core garde une
  taxonomie neutre.
- Les pièces jointes ne sont pas transmises à l'IA au MVP.
- Transfert, CC, classement et déplacement automatiques sont reportés à des
  workflow packs ultérieurs.
- Rétention du contenu Corya : 7 jours par défaut, configurable de 1 à 30 jours
  avec plafond SQL absolu de 30 jours.
- Aucun message source ni brouillon Outlook n'est supprimé par la purge Corya.

## Contraintes non négociables

- Aucune donnée patient dans les logs, alertes, erreurs persistées, fixtures ou
  sorties d'agent.
- Aucun objet, adresse, nom, corps, pièce jointe, identifiant Graph ou
  `deltaLink` dans les logs et métriques.
- `deltaLink`, `clientState`, jetons et clés PKCE sont traités comme secrets.
- Tout I/O externe possède timeout et annulation.
- Une création de brouillon dont le résultat est ambigu passe à `uncertain` et
  est réconciliée ; aucun second `POST` aveugle.
- Une modification humaine de `changeKey` n'est jamais écrasée.
- Toutes les tables internes sont RLS deny-by-default et révoquées pour
  `anon`/`authenticated` ; les RPC sensibles sont réservés au `service_role`.
- Toute suppression physique passe par une outbox avec heartbeat et preuve.
- Aucune migration distante, connexion de boîte réelle, mise en production,
  fusion ou push supplémentaire sans autorisation explicite.

## Gate avant le premier code

Le propriétaire doit encore valider explicitement les huit choix listés dans
la section « Décisions avant le premier code » de
`docs/inbox-architecture.md`. Il faut en particulier disposer d'un tenant
Microsoft sandbox et démontrer :

- accès autorisé à la boîte pilote ;
- refus d'accès à une boîte hors scope ;
- absence de `Mail.Send` ;
- Geo Exchange et chaîne de sous-traitants documentés.

Tant que ce gate n'est pas validé, l'agent peut analyser et améliorer la
documentation, mais ne doit pas créer de migration ou de code Inbox.

## Première mission d'implémentation après autorisation

Commencer uniquement par la **Vague 1 — fondations de données** de
`docs/inbox-implementation-plan.md` : migrations additives, RPC fencées,
RLS/ACL, tests SQL locaux et feature flag désactivé. Ne pas commencer
l'adaptateur Graph en parallèle.

La zone d'écriture est alors limitée aux nouvelles migrations Inbox et à leurs
tests SQL. Un agent `database_compliance` conçoit ou relit les migrations ; un
relecteur sécurité et un relecteur QA restent indépendants. Le thread principal
contrôle le diff avant la vague suivante.

## Validation requise

Depuis `apps/backend/` :

```text
npm test -- --run
npm run test:e2e
npm run type-check
npm run lint
```

Pour la base locale, utiliser un Supabase jetable, appliquer toutes les
migrations et exécuter les invariants Inbox. Ne jamais pointer le script de
test SQL vers une base distante.

Avant tout commit :

```text
git diff --check
git status --short --branch
```

## Reprise sur un autre ordinateur

Après installation de Git, Node.js, Supabase CLI et Codex :

```text
git clone <URL_DU_DEPOT_PRIVE>
cd corya-backend
git fetch origin
git switch --track origin/codex/inbox-architecture
cd apps/backend
npm ci
```

Si la branche locale existe déjà, utiliser simplement
`git switch codex/inbox-architecture` puis `git pull --ff-only`.

Les deux branches `origin/codex/inbox-architecture` et
`origin/codex/workstation-handoff` appartiennent au même dépôt backend. Il n'est
pas nécessaire de créer un dépôt Inbox séparé.

Ne pas copier le dossier global `.codex` d'un poste à l'autre : il peut contenir
des sessions et informations d'authentification locales. Les instructions
durables nécessaires au projet sont versionnées dans le dépôt.

## Prompt de reprise recommandé

```text
Tu reprends Corya Inbox comme agent d'implémentation sous le contrôle du thread
principal. Lis AGENTS.md puis les huit documents/familles de fichiers indiqués
dans docs/inbox-agent-handoff.md. Résume les invariants et l'état réel avant de
proposer un changement. Ne code rien tant que le gate « Décisions avant le
premier code » n'est pas explicitement validé. Quand il le sera, limite-toi à
la Vague 1 et ne modifie ni Voice ni la file public.jobs.
```

## Points encore ouverts

- fournisseur IA suisse : Infomaniak est prioritaire, mais API, DPA,
  localisation effective, absence d'entraînement et coûts restent à vérifier ;
- choix opérationnel du scanner de pièces jointes pour une phase ultérieure ;
- seuils commerciaux définitifs après mesures design partner ;
- ACL de boîtes plus fine avant une cible hospitalière multi-service.
