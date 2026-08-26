# Corya Inbox — plan d'implémentation et gates

Ce plan séquence le travail après validation de
[`inbox-architecture.md`](./inbox-architecture.md). Il ne constitue pas une
autorisation de coder, de migrer une base distante, de connecter un tenant ou
de déployer.

## Règles d'exécution

- branche de travail courte depuis `main`, dans un worktree Inbox dédié ;
- une seule IA écrit une zone de fichiers à la fois ;
- revues DB, sécurité et QA indépendantes avant chaque merge ;
- migrations seulement additives et testées sur Supabase local ;
- aucun secret réel ou contenu patient en fixture, log ou sortie d'agent ;
- aucun push, merge, migration distante ou déploiement sans accord explicite.

## Vague 0 — preuves externes et environnement de test

Livrables :

- tenant Microsoft sandbox isolé et boîte partagée synthétique ;
- principal Entra de test, `Mail.ReadWrite` sans `Mail.Send` ;
- scope Exchange Application RBAC : accès `200` sur boîte pilote, `403` hors scope ;
- preuve du Geo Exchange du tenant ;
- choix provisoire du fournisseur IA derrière une interface, sans engagement
  commercial de résidence non démontré ;
- dataset synthétique Inbox, sans patient réel.

Gate : aucune ligne de connecteur n'est écrite tant que le modèle de permission
et le test négatif RBAC ne sont pas reproductibles.

## Vague 1 — fondations de données

Responsabilité : agent base de données/compliance.

Livrables :

- migration additive des connexions, subscriptions, curseurs, messages minimisés,
  intents de brouillon, drafts, jobs, audit, compteurs et outbox ;
- RPC atomiques de claim/complete/fail avec lease et fencing ;
- contraintes d'idempotence et transitions d'état ;
- RLS deny-by-default, grants/revokes et accès portail borné ;
- crons de renouvellement, purge et health avec rétention documentée ;
- tests d'invariants SQL sur Supabase local.

Gate : `supabase db reset` et tous les tests d'isolation à deux tenants sont
verts. Le schéma Voice et sa file `jobs` restent inchangés.

## Vague 2 — contrat Core et faux fournisseur

Responsabilité : agent backend.

Livrables :

- types Core neutres et machine d'états ;
- interface provider injectable ;
- faux provider déterministe ;
- worker Inbox et heartbeat propres ;
- déduplication, retries, timeouts, codes d'erreur et métriques ;
- aucun modèle Microsoft hors adaptateur.

Gate : tests de crash/reclaim, deux workers, replay, expiration et dead-letter
verts ; aucune régression Voice.

## Vague 3 — adaptateur Microsoft Graph

Responsabilité : agent backend, zone Microsoft uniquement.

Livrables :

- provisioning/validation de connexion applicative ;
- validation d'endpoint, `clientState`, notification et lifecycle ;
- subscription et renouvellement avant sept jours ;
- synchronisation Delta par dossier avec IDs immuables ;
- gestion 429/`Retry-After`, 5xx, timeout, cursor invalide et resync ;
- création/réconciliation d'un seul brouillon de réponse ;
- déconnexion et suppression des subscriptions.

Gate : contrats JSON Microsoft versionnés, tests de duplication/désordre et
tenant sandbox verts. Vérification explicite qu'aucun appel `send` n'existe.

## Vague 4 — Health Pack et connaissance

Responsabilité : agent backend puis revue sécurité/produit.

Livrables :

- taxonomie neutre Core et surcouche santé ;
- versions publiées des modèles et sources ;
- abstention, revue obligatoire et provenance des réponses ;
- protections contre prompt injection et mélange inter-tenant ;
- caps de coût et compteurs IA par cabinet ;
- pièces jointes exclues du modèle au MVP.

Gate : dataset synthétique versionné ; 100 % des cas dangereux ou sans source
aboutissent à abstention/revue, jamais à une action automatique.

## Vague 5 — portail de configuration

Responsabilité : backend puis dépôt frontend séparé.

Livrables :

- état connexion/boîte/subscription et action de déconnexion ;
- gestion versions de connaissance et règles ;
- métriques agrégées, audit sans contenu et état des purges ;
- aucun écran de lecture quotidienne des e-mails.

Gate : tests RLS à deux tenants, droits admin/viewer et audit des mutations.

## Vague 6 — pilote design partner

Déroulé :

1. observation sans création de brouillon ;
2. comparaison hors production des décisions et formulations ;
3. activation `draft-only` pour un petit volume borné ;
4. mesure quatre à six semaines ;
5. décision de poursuivre, corriger ou arrêter.

Go `draft-only` :

- zéro fuite inter-tenant, secret ou contenu dans les logs ;
- zéro double brouillon sur la batterie replay/race ;
- zéro overwrite d'une édition humaine ;
- tous les I/O bornés, retries plafonnés et dead letters alertées ;
- purge Corya démontrée ;
- coût par message et charge support mesurables.

Pause immédiate : accès hors scope, envoi automatique, overwrite humain,
double brouillon non réconcilié, purge silencieusement en échec ou coût dépassant
le cap convenu.

## Matrice de tests minimale

| Niveau | Couverture obligatoire |
| --- | --- |
| Unitaires | mapping Graph, états Core, redaction, timeouts, erreurs, coûts |
| Contrats | validation webhook, notifications dupliquées, Delta, tombstones, draft |
| Worker | leases, fencing, reclaim, crash checkpoints, dead-letter, throttling |
| SQL local | contraintes, RPC, RLS deux tenants, outbox, crons, rétention |
| IA | citations, abstention, injection, isolement corpus, non-régression |
| E2E hermétique | notification -> Delta -> décision -> faux draft -> replay |
| Sandbox Microsoft | RBAC, subscription, lifecycle, Delta, draft Outlook, conflit humain |

Validation complète depuis `apps/backend/` :

```text
npm test -- --run
npm run test:e2e
npm run type-check
npm run lint
```

La suite sandbox reste explicitement opt-in et ne cible jamais une boîte réelle.

## Répartition proposée à l'IA d'implémentation

Le thread principal reste architecte et arbitre. L'IA externe reçoit une vague
à la fois, des fichiers propriétaires explicites, les invariants de sécurité et
les commandes de validation. Elle rend : constat initial, diff limité, tests,
risques résiduels et points nécessitant décision. Le thread principal contrôle
le diff et les résultats avant d'autoriser la vague suivante.

Le premier passage au code correspondra à la **Vague 1**. Il sera annoncé
explicitement à l'utilisateur avant toute modification.
