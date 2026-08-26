# Copilote administratif e-mail — architecture cible

## Positionnement

Le copilote administratif e-mail est un **outil d'assistance** pour les
secrétaires et les médecins des cabinets. Il classe les messages entrants,
prépare un brouillon et le rend disponible dans Outlook, sans changer l'outil
quotidien du cabinet. Une personne autorisée du cabinet reste
responsable de la lecture, de la décision et de l'envoi.

Il ne constitue ni un répondeur médical ni un système de décision autonome.
Le MVP ne lit pas une boîte personnelle d'un collaborateur sans délégation
explicite et ne met jamais un e-mail en production sans validation humaine.

## MVP

1. Réception sécurisée d'un e-mail dans une adresse ou une boîte dédiée au
   cabinet, puis contrôle de l'origine et déduplication technique.
2. Classification dans une taxonomie limitée : administratif, rendez-vous,
   document, résultat à faire traiter, urgence potentielle, indéterminé.
3. Extraction d'éléments administratifs minimaux et proposition d'un résumé
   bref ; les éléments incertains restent signalés comme tels.
4. Génération d'un **brouillon**, selon les consignes du cabinet et les
   modèles validés dans le portail.
5. Création d'un brouillon directement dans Outlook ; l'utilisateur le relit,
   le modifie et l'envoie depuis sa boîte professionnelle habituelle.
6. Suivi technique, configuration et piste d'audit minimale dans le portail,
   sans imposer une seconde interface de lecture des e-mails.

Le premier périmètre privilégie les demandes administratives et de
rendez-vous. Un message pouvant évoquer une urgence est mis en évidence et
orienté vers la procédure du cabinet ; le copilote ne l'évalue pas.

## Architecture technique cible

```text
Boîte fonctionnelle Microsoft 365 du cabinet
  -> notification Microsoft Graph, utilisée comme signal uniquement
  -> API Corya : authentification, déduplication, cloisonnement cabinet
  -> Delta Query autoritaire et stockage privé minimisé
  -> file Inbox PostgreSQL idempotente, indépendante de Voice
  -> service de classification et de brouillon, avec timeout et redaction
  -> brouillon de réponse créé dans Outlook
  -> validation, modification et envoi humain dans Outlook
  -> portail Corya : configuration et supervision sans contenu
  -> audit à métadonnées minimales et rétention contrôlée
```

Le design détaillé et les décisions Microsoft-first sont définis dans
[`inbox-architecture.md`](./inbox-architecture.md). Il reprend les fondations
existantes : API Express, claims PostgreSQL atomiques, worker séparé, Storage privé, portail
multi-tenant Supabase et audit portal sans valeurs métier. Les nouveaux
connecteurs et le modèle IA doivent être isolés derrière des interfaces avec
timeout, retries bornés, idempotency key et erreurs redactées. Aucun secret de
boîte, jeton fournisseur ou contenu de message ne doit apparaître dans les
logs, les jobs lisibles par le portail ou les événements d'audit.

### Schéma conceptuel (sans migration proposée)

| Concept | Données minimales | Règle d'accès |
| --- | --- | --- |
| `email_inbound` | cabinet, identifiant fournisseur opaque, horodatages, statut, références privées temporaires | service interne ; aucun contenu dans le portail |
| `email_classification` | catégorie allowlistée, confiance bornée, drapeaux `needs_human_review` / `possible_urgency` | service interne ; métriques agrégées seulement dans le portail |
| `email_draft` | référence au message, identifiant Outlook, `changeKey`, statut technique | corps conservé dans Outlook ; jamais édité dans le portail |
| `email_delivery` | état observé du brouillon Outlook et identifiant fournisseur | aucune capacité d'envoi Corya au MVP |
| `email_attachment` | type, taille, quarantaine et statut de suppression | aucune analyse IA ni accès portail au MVP |
| `email_audit_event` | cabinet, acteur technique, action allowlistée, horodatage, champs modifiés sans valeur | conservation d'audit distincte du contenu |

Toutes ces entités porteront `cabinet_id`, avec RLS deny-by-default et RPC/API
bornées. Les tables internes de jobs, leases, secrets et Storage ne seront pas
exposées au portail.

## Workflow et états

```text
received -> quarantined | queued
queued -> classifying -> draft_ready | needs_human_review | failed
draft_ready -> human_modified | sent_externally | rejected | expired
needs_human_review -> draft_ready | rejected | expired
```

- `quarantined` : expéditeur non autorisé, pièce dangereuse, taille dépassée
  ou contrôle fournisseur incomplet ; aucune analyse IA ni envoi.
- `needs_human_review` : ambiguïté, contenu médical, urgence potentielle,
  destinataire incertain ou confiance insuffisante.
- la création du brouillon est idempotente et ne doit jamais écraser une
  modification humaine observée via `changeKey` ;
- aucun passage automatique de `draft_ready` à un état d'envoi n'existe.

## Confidentialité, secret médical et pièces jointes

Le contenu d'un e-mail, son objet, les noms de fichiers et les pièces jointes
peuvent contenir des données de santé. Ils sont donc traités comme données
sensibles soumises à la nLPD et, pour les professionnels concernés, au secret
médical (art. 321 CP).

- Finalité limitée à la préparation et au traitement administratif demandé par
  le cabinet ; pas d'entraînement, de réutilisation produit ou de profilage.
- Minimise les données envoyées au service IA : pas de pièce jointe ni de
  contenu complet sauf besoin validé ; préférer un extrait redigé et une
  classification déterministe quand possible.
- Choisir un sous-traitant IA avec garanties contractuelles, localisation,
  absence d'entraînement par défaut et DPA compatible ; ce point est un gate
  avant toute mise en service.
- Scanner les pièces jointes, borner taille/type, supprimer les exécutables,
  macros et archives suspectes ; les aperçus se font dans un bac à sable.
- Storage privé, chiffrement en transit, URLs signées courtes ; jamais de lien
  public ni de pièce jointe dans un log ou une alerte.
- Politique cible à valider avec le cabinet : contenu et brouillons supprimés
  rapidement après traitement (par défaut au plus 30 jours), pièces jointes
  selon la même borne ou plus courte, audit sans valeur conservé selon la
  politique existante de 24 mois. Une conservation plus longue relève du
  dossier métier propre du cabinet, pas du copilote.
- Export, suppression, incident et accès opérateur documentés par cabinet.

## Déploiement par cabinet

Chaque activation est isolée : adresse/boîte dédiée ou routage explicite,
`cabinet_id`, membres du portail, rôles, boîtes autorisées, modèles de
réponse, catégories, langue, règles d'escalade et politique de rétention.
Les secrets du connecteur e-mail sont distincts par cabinet,
stockés dans un coffre et rotables sans impact inter-tenant. Le cabinet reste
propriétaire de sa boîte et de l'approbation des brouillons.

Le déploiement initial se fait en mode observation : ingestion + classement,
sans création de brouillon. Après revue d'un échantillon par le cabinet, le
mode `draft-only` crée les brouillons dans Outlook ; l'envoi automatisé reste
hors MVP.

## Indicateurs

- volume reçu, dédupliqué, mis en quarantaine et expiré ;
- délai réception → brouillon et activité humaine observée dans Outlook ;
- taux de modification/rejet humain des brouillons ;
- taux d'escalade, ambiguïté et urgence potentielle ;
- succès, échecs et réessais de création/réconciliation des brouillons ;
- erreurs de cloisonnement (objectif : zéro), incidents de pièce jointe et
  conformité de purge ;
- aucune métrique ne contient de sujet, adresse, nom ou contenu d'e-mail.

## Hors périmètre explicite

- diagnostic, triage médical autonome, conseil médical ou urgence évaluée par
  IA ;
- ordonnance, renouvellement thérapeutique ou transmission de résultat sans
  professionnel ;
- facturation autonome, encaissement ou décision de remboursement ;
- envoi automatique, changement de rendez-vous ou modification de dossier
  sans validation humaine explicite ;
- partage de contenu entre cabinets, entraînement sur les e-mails clients ou
  indexation publique des pièces jointes.

## Phases ultérieures

1. MVP en observation et validation humaine d'envoi.
2. Connecteurs de boîtes supplémentaires, règles par équipe et modèles
   approuvés.
3. Liaison contrôlée au calendrier et au portail pour proposer des actions,
   jamais les exécuter silencieusement.
4. Recherche documentaire privée avec corpus validé du cabinet, citations et
   contrôles d'accès.
5. Automatisations limitées à des cas administratifs répétitifs, seulement
   après mesures, revue nLPD et accord écrit du cabinet.

## Estimation d'onboarding

Pour un cabinet prêt (boîte dédiée, administrateur portail, modèles,
destinataires et politique de rétention fournis), prévoir environ une journée
ouvrée de configuration technique puis une à deux semaines de pilote en mode
observation. L'intégration d'une boîte historique, des pièces jointes
complexes, des règles métiers nombreuses ou une validation juridique allonge
ce délai ; aucun délai ne doit être annoncé comme ferme avant l'audit du
cabinet et du fournisseur e-mail.
