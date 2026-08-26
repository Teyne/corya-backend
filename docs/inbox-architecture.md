# Corya Inbox — contrat d'architecture Microsoft-first

Statut : proposition prête pour revue avant implémentation

Branche : `codex/inbox-architecture`
Portée : architecture uniquement ; aucune migration ni intégration Microsoft n'est incluse

## 1. Décision produit

Corya Inbox assiste l'équipe dans sa boîte Outlook habituelle. Le produit ne
remplace pas Outlook et ne crée pas une nouvelle file de messages à consulter.

Le MVP :

1. observe une boîte fonctionnelle autorisée ;
2. détecte les nouveaux messages administratifs ;
3. applique les règles du cabinet et une base de connaissances approuvée ;
4. crée une réponse en **brouillon dans Outlook** ;
5. laisse un humain relire, modifier et envoyer depuis Outlook.

Le portail Corya sert uniquement à l'onboarding, la configuration, la base de
connaissances, l'état technique, les métriques et l'audit sans contenu.

Le MVP exclut `Mail.Send`, l'envoi automatique, le transfert, l'ajout de CC, le
déplacement de documents et toute action clinique. Ces capacités deviendront
des workflow packs séparés après validation sur le terrain.

## 2. Principes structurants

- **Un seul produit Corya, un seul backend** : Voice et Inbox partagent les
  primitives d'exploitation, mais pas leurs objets métier.
- **Inbox Core neutre** : les états et règles techniques ne dépendent ni de
  Microsoft ni de la santé.
- **Adaptateur Microsoft isolé** : aucune structure Graph ne traverse le Core.
- **Health Pack configurable** : taxonomie, modèles, règles d'escalade et corpus
  santé sont versionnés par cabinet.
- **Outlook reste l'interface quotidienne** : aucun contenu d'e-mail n'est requis
  dans le portail pour le pilote.
- **Humain responsable** : un brouillon n'est jamais envoyé par Corya.
- **Minimisation** : aucun objet, adresse, nom, contenu ou pièce jointe dans les
  logs, alertes, jobs, métriques ou événements d'audit.
- **Résidence vérifiée, pas présumée** : la Suisse est un gate fournisseur et
  tenant par tenant, pas une propriété implicite de Microsoft 365.

## 3. Frontières des composants

| Composant | Responsabilité | Interdit |
| --- | --- | --- |
| Inbox Core | orchestration, états, déduplication, politiques, métriques, rétention | types Graph, règles médicales |
| Microsoft Graph adapter | authentification, subscriptions, webhooks, Delta, messages, brouillons | logique santé, décision métier |
| Health Pack | catégories santé, abstention, modèles, sources citées, règles d'escalade | secrets, appels Graph, actions autonomes |
| Knowledge service | versions publiées, sélection de passages, provenance, expiration | apprentissage sur les e-mails clients |
| Inbox worker | synchronisation, analyse, génération, renouvellement, purge | réutilisation de `appels` ou de la file Voice |
| Outlook | lecture, édition et envoi humain | état interne Corya |
| Portail | configuration et supervision sans contenu | client mail parallèle |

Contrat fournisseur minimal :

```text
authorize / verifyAccess / disconnect
createSubscription / renewSubscription / deleteSubscription
verifyNotification / syncDelta / getMessage
createReplyDraft / getDraftMetadata
```

Chaque opération externe reçoit un timeout et un `AbortSignal`, normalise les
erreurs en codes constants, respecte `Retry-After` et n'expose jamais la réponse
du fournisseur dans les logs.

## 4. Flux autoritaire

```text
Microsoft Graph notification
  -> validation endpoint / clientState / subscription / tenant
  -> persistance d'un signal technique minimal
  -> réponse 202 rapide
  -> inbox_jobs: sync_mailbox
  -> Delta Query par boîte et dossier
  -> transaction: changements + nouveau deltaLink
  -> inbox_jobs: process_message
  -> Core + Health Pack + connaissance publiée
  -> décision: abstention | revue | brouillon
  -> inbox_jobs: create_draft
  -> brouillon de réponse Outlook
  -> relecture, modification et envoi par l'humain dans Outlook
```

Le webhook n'est jamais une source de contenu ni une preuve qu'un message a été
traité. Il ne fait que déclencher une synchronisation. Delta Query répare les
notifications dupliquées, désordonnées ou manquées.

Les requêtes Graph utilisent systématiquement
`Prefer: IdType="ImmutableId"`. Le curseur `@odata.deltaLink` est opaque, propre
à une boîte et à un dossier, traité comme un secret et n'est avancé que dans la
transaction qui persiste les changements correspondants.

## 5. Modèle de connexion Microsoft

### Choix cible

Pour une boîte partagée de cabinet ou de service :

- identité applicative Microsoft Entra ;
- permission applicative `Mail.ReadWrite` ;
- **aucune permission `Mail.Send`** ;
- Exchange Application RBAC limité explicitement aux boîtes autorisées ;
- consentement et preuve de configuration par un administrateur du tenant.

Le consentement Entra seul est insuffisant : sans RBAC Exchange, une permission
applicative peut couvrir toutes les boîtes du tenant. Le gate d'onboarding doit
prouver un accès réussi à la boîte pilote et un refus sur une boîte hors scope.

Un mode OAuth délégué avec PKCE peut être ajouté plus tard pour une boîte
personnelle, mais ne doit pas dicter le modèle du MVP fonctionnel.

### Secrets

Les certificats, clés, `clientState` et jetons éventuels sont stockés dans un
coffre, référencés par identifiant interne et rotables. Ils n'apparaissent ni
dans les tables exposées au portail, ni dans les jobs, ni dans l'audit.

## 6. Modèle de données conceptuel

Les noms restent conceptuels jusqu'à la migration revue. Toutes les entités
tenant portent `cabinet_id`. Les tables internes sont `REVOKE` pour `anon` et
`authenticated`, avec RLS deny-by-default ; seuls des RPC service-role bornés
les manipulent.

| Entité | Rôle | Contraintes clés |
| --- | --- | --- |
| `inbox_connections` | tenant, fournisseur, mode, état | unique cabinet + fournisseur + tenant ; secret par référence |
| `inbox_mailboxes` | boîtes explicitement autorisées | unique connexion + mailbox id ; type shared/user ; état |
| `inbox_subscriptions` | abonnement Graph et renouvellement | unique external subscription ; clientState secret ; expiration |
| `inbox_sync_cursors` | curseur Delta par dossier | unique connexion + dossier ; génération et fencing |
| `inbox_provider_events` | signal webhook minimal et coalescé | empreinte unique ; aucun payload Graph brut ; rétention courte |
| `inbox_messages` | identité et état technique minimisés | unique connexion + immutable message id ; empreinte de version |
| `inbox_content_objects` | références privées temporaires | chemin déterministe ; date de purge ; jamais public |
| `inbox_attachments` | métadonnées et quarantaine | aucun traitement IA au MVP |
| `inbox_draft_intents` | intention idempotente avant Graph | unique message source + version de politique |
| `inbox_drafts` | identifiant Outlook, changeKey, état | un brouillon actif par intention |
| `inbox_knowledge_sets` | jeu de connaissance par cabinet | version immuable publiée ; statut et auteur |
| `inbox_knowledge_items` | règles, modèles et sources | provenance obligatoire ; activation explicite |
| `inbox_jobs` | file Inbox indépendante | idempotency key ; lease ; retries bornés ; dead letter |
| `inbox_audit_events` | actions allowlistées sans valeurs | acteur, action, cible opaque, timestamp |
| `inbox_usage_counters` | coûts et exploitation | compteurs agrégés sans contenu ni destinataire |
| `inbox_deletions_outbox` | suppression physique prouvable | idempotence ; heartbeat ; preuve terminale |

Une ACL de boîte distincte des rôles globaux sera nécessaire avant une cible
hospitalière multi-service. Pour le premier cabinet à boîte unique, le portail
peut conserver `admin`/`viewer`, puisque le contenu et l'envoi restent dans
Outlook.

La table `public.jobs` actuelle ne doit pas être généralisée pendant le MVP :
elle impose `appel_id NOT NULL` et appartient au contrat Voice. Inbox réplique
les garanties de claim, lease, heartbeat, backoff et dead-letter dans une file
additive, sans faire dépendre un e-mail d'un faux appel.

## 7. États et invariants

Connexion :

```text
pending -> active | degraded | disconnected
active -> degraded | disconnecting
disconnecting -> disconnected
```

Message :

```text
discovered -> quarantined | queued
queued -> analyzing
analyzing -> draft_requested | needs_human_review | abstained | failed
draft_requested -> draft_ready | needs_human_review | failed
* -> expired
```

Brouillon/commande :

```text
intent_created -> creating -> draft_ready | uncertain
uncertain -> reconciled -> draft_ready | needs_human_review
draft_ready -> human_modified | sent_externally | deleted_externally | superseded
```

Invariants obligatoires :

- une notification rejouée ne crée pas deux synchronisations utiles ;
- un changement Delta est persistant avant l'avancement du curseur ;
- deux workers ne possèdent jamais le même lease valide ;
- l'intention de brouillon existe avant l'appel Graph ;
- un seul brouillon Corya est créé par message source et version de politique ;
- un timeout après création potentielle produit `uncertain` et lance une
  réconciliation ; il ne provoque jamais un second `POST` aveugle ;
- après exposition dans Outlook, Corya n'écrase jamais automatiquement le
  brouillon ; une nouvelle génération exige une action explicite ;
- une modification de `changeKey` entraîne une revue, jamais un overwrite ;
- les erreurs persistées sont des codes allowlistés sans donnée métier ;
- Corya ne supprime ni le message source ni le brouillon utilisateur lors de sa
  propre purge.

## 8. Health Pack et base de connaissances

Inbox Core comprend seulement des catégories neutres : demande d'information,
rendez-vous, document, facturation, action manuelle, indéterminé.

Le Health Pack ajoute, par configuration versionnée :

- les catégories et formulations propres au cabinet ;
- les modèles, signatures, en-têtes et procédures existantes ;
- les sources approuvées et leur période de validité ;
- les cas imposant abstention ou revue humaine ;
- les signaux d'urgence potentielle, uniquement pour escalade vers la procédure
  du cabinet, jamais pour triage clinique.

Un e-mail et une pièce jointe sont toujours des entrées non fiables. Ils ne
peuvent pas modifier les règles, choisir un destinataire, ajouter un CC,
déclencher un transfert ou devenir une source de connaissance. Toute réponse
doit être reliée à la version de politique et aux sources utilisées.

## 9. Pièces jointes

Le MVP indexe uniquement les métadonnées minimales nécessaires et ne transmet
aucune pièce jointe à l'IA. Types inattendus, macros, archives, contenus chiffrés
ou tailles excessives sont mis en quarantaine et entraînent une revue humaine.

Une phase ultérieure pourra analyser une allowlist de PDF/images après choix
d'un scanner et d'un traitement IA contractuellement compatibles avec la
résidence suisse. Cette phase requiert un threat model et un gate séparés.

## 10. Rétention, déconnexion et suppression

Politique cible :

- états OAuth consommés/échoués : 24 heures ;
- signaux de webhook techniques : 7 jours au plus ;
- contenu Corya et pièces jointes temporaires : 7 jours par défaut,
  configurable de 1 à 30 jours avec plafond SQL absolu de 30 jours ;
- métadonnées message/décision/brouillon : 30 jours ;
- métriques brutes sans valeur métier : 90 jours ;
- métriques agrégées et audit sans valeurs métier : 24 mois ;
- secrets : jusqu'à rotation ou déconnexion, puis purge prouvée.

L'offboarding suit cet ordre : désactivation locale immédiate, arrêt des jobs,
suppression/expiration des subscriptions, purge des secrets et copies Corya via
outbox, retrait du scope Exchange RBAC par l'administrateur, puis test négatif
d'accès. Un échec reste visible et réessayé de façon bornée.

## 11. Observabilité et coût réel

Par cabinet et période, sans donnée personnelle :

- messages découverts, dédupliqués, quarantinés, analysés et expirés ;
- brouillons créés, modifiés, supprimés, utilisés ou rejetés ;
- latences notification -> sync -> brouillon, p50/p95 ;
- appels Graph, pages Delta, 429, retries, timeouts et dead letters ;
- tokens et coût IA entrée/sortie, octets Storage, coût de scan ;
- temps de support et d'onboarding saisi séparément ;
- taux d'abstention, de revue et d'édition humaine.

Ces compteurs alimentent le calcul design partner. Les caps de volume et de
coût arrêtent l'analyse avant dépassement ; ils ne déclenchent jamais un envoi.

## 12. Résidence et sous-traitants

La promesse correcte est : « traitement Corya configuré en Suisse, avec
résidence Exchange et chaîne de sous-traitants vérifiées pour votre tenant ».
Il ne faut pas promettre « 100 % suisse » avant preuve de chaque maillon :
Exchange, base, Storage, sauvegardes, IA, antivirus, logs et support.

Avant pilote réel, le dossier client contient DPA, finalités, emplacements,
absence d'entraînement, durées de conservation, contrôle d'accès, procédure
d'incident et preuve de résidence du tenant Microsoft.

## 13. Références officielles Microsoft

- [Webhooks Microsoft Graph](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks)
- [Lifecycle notifications](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events)
- [Delta Query pour les messages](https://learn.microsoft.com/en-us/graph/delta-query-messages)
- [Identifiants Outlook immuables](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)
- [Durée des subscriptions](https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0)
- [Créer un brouillon de réponse](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)
- [Exchange Application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
- [Résidence Exchange Online](https://learn.microsoft.com/en-us/microsoft-365/enterprise/m365-dr-workload-exo?view=o365-worldwide)

## 14. Décisions avant le premier code

Le premier agent d'implémentation ne démarre qu'après validation explicite de :

1. boîte partagée Microsoft 365 comme cible du pilote ;
2. identité applicative + Exchange Application RBAC comme mode d'accès ;
3. `Mail.ReadWrite` sans `Mail.Send` ;
4. MVP sans analyse de pièces jointes ni automatisations de déplacement/transfert ;
5. file `inbox_jobs` indépendante de Voice ;
6. rétention contenu de 30 jours maximum ;
7. tenant Microsoft sandbox disponible pour les tests ;
8. fournisseur IA et localisation laissés derrière une interface tant que la
   preuve suisse et le coût réel ne sont pas validés.
