# Registre des activités de traitement — Corya

> **Note d'état — 2 août 2026.** BetterStack est envisagé, pas actif confirmé.
> Les suppressions physiques et la purge `logs_actions` sont livrées dans le
> code et les migrations locales, mais ne deviennent effectives qu'après
> migration et déploiement. Les droits sont actuellement traités manuellement.
>
> Le site public séparé utilise Lovable, Cloudflare et, lorsque ses secrets
> runtime sont configurés, Resend pour le formulaire de contact. Une mesure
> d'audience Lovable/Cloudflare est active. Les données de contact ont une
> durée de conservation prévue de 24 mois.

**Version 1.0 — 2026-08-01**

> *Sous réserve de validation juridique. L'art. 12 al. 5 nLPD et l'OPDo prévoient une exemption de registre pour les entreprises de moins de 250 collaborateurs, sauf traitement de données sensibles à grande échelle ou profilage à risque élevé. Corya tient ce registre volontairement, à la fois par prudence et comme élément de réassurance commerciale auprès des cabinets clients.*

---

## Responsable du traitement

- **Raison sociale** : Théo Coudert – Corya (raison individuelle)
- **Adresse publiée** : 2025 Chez-le-Bart (NE), Suisse
- **Contact protection des données** : `info@corya.ch`
- **Contact opérationnel** : `info@corya.ch`
- **Responsable / éditeur** : Théo Coudert

## Champ d'application

Le présent registre couvre les traitements du service **Corya Tea**, agent vocal d'accueil téléphonique destiné aux cabinets médicaux romands, ainsi que le traitement n° 8 du site public `corya.ch`. Il ne couvre pas les traitements internes à Corya en tant qu'employeur.

Les cabinets médicaux clients sont **responsables du traitement** au sens de l'art. 5 let. j nLPD pour les données de leurs patients ; **Corya intervient en qualité de sous-traitant** au sens de l'art. 5 let. k nLPD dans le cadre du contrat de prestation signé avec chaque cabinet. Un contrat de sous-traitance (DPA) est établi avec chaque cabinet et régit les conditions du traitement.

## Sous-traitants ultérieurs de Corya

Corya recourt aux sous-traitants ultérieurs suivants, avec lesquels un contrat de sous-traitance conforme à l'art. 9 nLPD est signé ou en cours de signature :

| Sous-traitant | Rôle fonctionnel | Localisation du traitement | Base du transfert international |
|---|---|---|---|
| Peoplefone SA | Opérateur de téléphonie SIP (routage de l'appel entrant) | Suisse | Non applicable (traitement en Suisse) |
| Retell AI, Inc. | Agent conversationnel (reconnaissance vocale, synthèse vocale, orchestration du dialogue) | États-Unis, avec offre de traitement dans l'UE en cours d'évaluation | **Clauses contractuelles types (CCT) suisses** applicables ; le pays de destination n'est pas au bénéfice d'une décision d'adéquation du Conseil fédéral |
| ElevenLabs Inc. *(ou Cartesia AI, Inc., selon la configuration du cabinet)* | Synthèse vocale (text-to-speech) invoquée par Retell | États-Unis | **Clauses contractuelles types (CCT) suisses**, même motif |
| Supabase Inc. | Base de données PostgreSQL, stockage de fichiers, authentification | **Zurich (Suisse)** — région `eu-central-2` explicitement sélectionnée | Non applicable (traitement en Suisse) |
| Infomaniak Network SA | Hébergement applicatif (Jelastic), serveur de messagerie SMTP sortant | Suisse | Non applicable (traitement en Suisse) |
| BetterStack (Better Stack, s.r.o.) | Supervision applicative, journalisation externe, page de statut publique | Union européenne (République tchèque / Allemagne) | Non applicable (protection adéquate au sens de l'art. 16 nLPD, UE reconnue par le Conseil fédéral) |
| Lovable Labs AB | Construction, hébergement applicatif et mesure technique du site public | Union européenne et infrastructure mondiale | Selon les garanties contractuelles du fournisseur ; à archiver |
| Cloudflare, Inc. | CDN, sécurité et mesure technique du site public | Réseau mondial, traitements possibles aux États-Unis | CCT suisses / garanties contractuelles à archiver |
| Plus Five Five, Inc. (Resend) | Envoi des e-mails du formulaire de contact, si configuré | États-Unis | CCT suisses / garanties contractuelles à archiver |

Les deux transferts vers les États-Unis (Retell AI, ElevenLabs) sont documentés au registre comme point d'attention prioritaire. Aucun autre transfert hors Suisse ou UE n'est effectué à ce jour. Toute donnée de patient traitée en base par Corya est stockée en Suisse (Supabase Zurich). Les données transitant par Retell AI et ElevenLabs sont uniquement celles nécessaires à la conduite de la conversation vocale en temps réel.

## Mesures de sécurité communes à tous les traitements

Les mesures suivantes s'appliquent transversalement, en complément des mesures spécifiques indiquées pour chaque traitement :

- **Chiffrement en transit** : TLS 1.2 minimum obligatoire pour toutes les communications, y compris l'envoi d'emails (STARTTLS exigé, aucun repli en clair autorisé).
- **Chiffrement au repos** : assuré par les plateformes Supabase et Infomaniak.
- **Contrôle d'accès** : accès aux données de production réservé à un nombre restreint de personnes désignées, authentifiées ; aucun mot de passe partagé.
- **Journalisation des actions d'administration** dans un registre interne (traitement n° 5).
- **Purges automatiques** planifiées et surveillées (traitement n° 4), avec preuve d'exécution horodatée.
- **Interdiction absolue** d'inscrire dans les journaux techniques une donnée identifiante de patient (nom, téléphone, motif d'appel textuel, extrait de conversation). Cette règle est appliquée par un mécanisme technique de filtrage systématique.
- **Rotation périodique** des secrets techniques (clés d'accès aux plateformes tierces).
- **Ségrégation stricte** entre les environnements de développement, de préproduction et de production ; aucun croisement de données.
- **Clauses de confidentialité** et rappel du secret professionnel médical (art. 321 CP) dans tous les contrats avec les collaborateurs et sous-traitants.

---

# Traitements

## Traitement n° 1 — Réception et traitement d'appels téléphoniques entrants

**Statut** : actif.

**Finalité** : accueillir les appels téléphoniques adressés à un cabinet médical client lorsque celui-ci n'est pas en mesure de répondre (occupation, hors des heures d'ouverture, débordement), identifier le motif du patient, prendre un rendez-vous lorsque cela est possible ou consigner un message à traiter par la secrétaire du cabinet, et signaler les urgences.

**Base légale** :
- **Contrat** (art. 31 al. 2 let. a nLPD) : exécution du contrat de prestation entre Corya et le cabinet médical, dont le patient est bénéficiaire.
- **Consentement** (art. 6 al. 6 et 31 al. 1 nLPD) : le patient est informé, dès la première seconde de l'appel, qu'il s'adresse à un assistant vocal automatique du cabinet. Le fait de poursuivre la conversation, après cette annonce et la possibilité de raccrocher ou d'être transféré à un humain en cas d'urgence, vaut consentement au traitement pour la finalité annoncée.

**Catégories de données traitées** :
- Numéro de téléphone d'appel (donnée identifiante).
- Enregistrement sonore de la conversation entre le patient et l'assistant vocal.
- Transcription textuelle de cette conversation.
- Nom et prénom communiqués par le patient (le cas échéant).
- Motif de l'appel exprimé par le patient — pouvant relever de la **santé** au sens de l'art. 5 let. c ch. 2 nLPD (donnée personnelle sensible).
- Créneau de rendez-vous souhaité, praticien demandé (le cas échéant).

**Catégories de personnes concernées** : patients (actuels ou potentiels) du cabinet médical client qui composent le numéro renvoyé vers Corya.

**Destinataires** :
- Internes à Corya : personnel technique désigné (accès restreint et journalisé).
- Le cabinet médical client, destinataire du récapitulatif de l'appel (traitement n° 3).
- Sous-traitants ultérieurs mobilisés pour la conduite de la conversation : Peoplefone (routage), Retell AI (traitement conversationnel), ElevenLabs ou Cartesia (synthèse vocale).

**Durée de conservation** : décomposée par catégorie de donnée.
- **Enregistrement audio** : au maximum 48 heures après l'appel. Une purge automatique s'exécute chaque heure et efface l'enregistrement, aussi bien de la base Corya que du serveur de l'opérateur conversationnel (Retell AI).
- **Nom, prénom, numéro de téléphone du patient et transcription textuelle intégrale** : au maximum 7 jours. Une purge automatique quotidienne (03h00 UTC) anonymise ces informations en base.
- **Transcription anonymisée** (transcription dont les identifiants directs ont été retirés) et **métadonnées techniques de l'appel** (date, durée, résultat) : au maximum 24 mois, à des fins d'amélioration continue et de statistiques agrégées. Une purge mensuelle s'exécute le 1er de chaque mois (04h00 UTC).

**Transferts internationaux** : oui, vers les États-Unis (Retell AI et ElevenLabs / Cartesia) pour la durée strictement nécessaire au traitement conversationnel temps réel. Garanties : clauses contractuelles types suisses signées avec chaque sous-traitant américain.

**Mesures de sécurité spécifiques** :
- Annonce d'ouverture obligatoire et contractuellement verrouillée informant le patient de la nature automatisée de l'interlocuteur, dès la première seconde de l'appel. Aucun paramétrage d'agent ne peut désactiver cette annonce.
- Communication téléphonique routée par SIP chiffré.
- Vérification cryptographique de l'authenticité des notifications techniques reçues de l'opérateur conversationnel (signature électronique validée à chaque appel, à défaut de quoi la notification est rejetée).
- Isolation stricte entre les données de deux cabinets clients différents ; aucune donnée n'est jamais partagée d'un cabinet à un autre.
- Minimisation : l'assistant vocal n'est pas conçu pour collecter d'antécédents médicaux détaillés, de numéros d'assurance ou d'identifiants administratifs.

---

## Traitement n° 2 — Génération du récapitulatif d'appel au format PDF

**Statut** : actif.

**Finalité** : produire, immédiatement après chaque appel, un document PDF récapitulatif structuré à destination du cabinet, contenant les informations utiles pour le suivi du patient (rappel, confirmation de rendez-vous, traitement du message laissé).

**Base légale** : contrat (art. 31 al. 2 let. a nLPD), en tant qu'étape opérationnelle du service commandé par le cabinet.

**Catégories de données traitées** : les mêmes que le traitement n° 1, telles qu'elles existent au moment de la génération (l'enregistrement audio n'est pas repris dans le PDF ; la transcription y figure intégralement).

**Catégories de personnes concernées** : patients ayant appelé le cabinet.

**Destinataires** :
- Le cabinet médical client, unique destinataire externe.
- Sous-traitant ultérieur : Supabase (stockage du fichier).

**Durée de conservation** :
- **30 jours après l'envoi effectif du récapitulatif au cabinet**, dans le cas nominal ; ou, à défaut d'envoi (défaillance prolongée du service de messagerie du cabinet destinataire, par exemple), **30 jours après la date de l'appel**. Dans tous les cas, aucun PDF ne survit au-delà de 30 jours après l'appel. Une purge quotidienne s'exécute à 03h30 UTC.
- Le motif de purge est distingué en interne entre « envoi réussi » et « envoi jamais effectué », de manière à permettre la détection d'incidents de messagerie côté cabinet.

**Rationale de la durée** : cette durée est plus courte que celle des métadonnées de l'appel (24 mois) parce que le PDF contient, sous forme binaire, l'ensemble des données patient qui sont par ailleurs anonymisées en base au 7ᵉ jour. Le conserver plus longtemps reviendrait à perpétuer dans un fichier ce que l'anonymisation efface en base.

**Transferts internationaux** : aucun. Le PDF est stocké exclusivement en Suisse (Supabase Zurich).

**Mesures de sécurité spécifiques** :
- Stockage dans un espace de fichiers **privé** (bucket non public), inaccessible sans authentification serveur.
- Chemin de stockage composé exclusivement d'identifiants techniques opaques (aucun nom, aucun numéro de téléphone dans le chemin du fichier).
- Génération du PDF isolée dans un processus applicatif dédié, ce qui limite l'exposition en cas d'incident.

---

## Traitement n° 3 — Transmission du récapitulatif au cabinet médical par courrier électronique

**Statut** : actif.

**Finalité** : notifier le cabinet client, immédiatement après chaque appel, du contenu et du résultat de la conversation, en lui adressant par email le récapitulatif au format PDF ainsi qu'un lien de téléchargement à durée limitée.

**Base légale** : contrat (art. 31 al. 2 let. a nLPD).

**Catégories de données traitées** :
- Adresse email de destination communiquée par le cabinet (adresse professionnelle de la secrétaire ou d'un médecin, telle que déclarée à la souscription).
- Éventuelle adresse email en copie déclarée par le cabinet.
- Corps du message (données de l'appel, en clair dans l'email : nom du cabinet, date, durée, motif court, résultat, action à mener).
- **Pièce jointe : récapitulatif PDF** (traitement n° 2), qui contient les données identifiantes du patient et la transcription intégrale.
- Lien de téléchargement du PDF à durée de vie limitée à 30 minutes.

**Catégories de personnes concernées** :
- Patients (indirectement, en tant qu'auteurs des données transmises).
- Personnel du cabinet destinataire (en tant que titulaire de l'adresse email).

**Destinataires** :
- Le cabinet médical client, destinataire final.
- Sous-traitant ultérieur : Infomaniak (serveur SMTP sortant utilisé par Corya).
- Le serveur de messagerie entrant du cabinet destinataire, qui peut être opéré par tout prestataire de son choix. Le cabinet, en tant que responsable du traitement de ses propres données, choisit son prestataire de messagerie.

**Durée de conservation** :
- Chez Corya : l'email n'est pas conservé après envoi. Seule la trace horodatée « email envoyé avec succès » est conservée en base pour permettre la purge du PDF au 30ᵉ jour (traitement n° 2).
- Chez le cabinet destinataire : la conservation relève de la responsabilité et de la politique propres du cabinet, qui est libre de télécharger et d'archiver le PDF pour la durée qu'il juge nécessaire à son dossier patient.

**Transferts internationaux** : aucun côté Corya. Le prestataire de messagerie de destination utilisé par le cabinet est indépendant de Corya.

**Mesures de sécurité spécifiques** :
- Chiffrement obligatoire de la connexion au serveur de messagerie (STARTTLS exigé) : aucun envoi en clair n'est possible.
- Lien de téléchargement du PDF signé cryptographiquement, expirant après 30 minutes, non devinable, non partageable au-delà de cette fenêtre.
- Le message d'email n'est jamais envoyé deux fois pour le même appel (mécanismes de contrôle d'idempotence).

---

## Traitement n° 4 — Purges et anonymisations automatiques

**Statut** : actif.

**Finalité** : appliquer, sans intervention humaine, les durées de conservation limitées prévues aux traitements n° 1 à n° 3 et n° 7 ; produire une trace vérifiable de chaque suppression.

**Base légale** :
- **Obligation légale** (art. 6 al. 4 nLPD, principe de limitation de la conservation).
- **Intérêt légitime** de Corya à démontrer, en cas de contrôle, l'application effective des durées de rétention affichées.

**Catégories de données traitées** : uniquement des références techniques aux données à supprimer (identifiants internes d'appels, chemins de fichiers dans le stockage). Aucun contenu de patient n'est manipulé dans le cadre de ce traitement ; les données ne sont que **supprimées**.

**Catégories de personnes concernées** : indirectement, l'ensemble des personnes concernées par les traitements n° 1 à n° 3.

**Destinataires** : aucun. Il s'agit d'un traitement interne.

**Durée de conservation** :
- Les données visées sont supprimées ou anonymisées selon les échéances suivantes :

| Type de donnée | Échéance |
|---|---|
| Enregistrement audio (base Corya et serveur de l'opérateur conversationnel) | 48 heures après l'appel |
| Nom, prénom, téléphone du patient, transcription intégrale | 7 jours après l'appel |
| Récapitulatif PDF | 30 jours après l'envoi email ; à défaut, 30 jours après l'appel |
| Métadonnées techniques de l'appel et transcription anonymisée | 24 mois après l'appel |
| Journalisation applicative (voir traitement n° 5) | 12 mois |
| Journalisation des actions d'administration | 24 mois |

- La trace des suppressions (horodatage, motif, identifiant de la donnée supprimée) est conservée à des fins de preuve d'audit et purgée avec la donnée d'origine.

**Transferts internationaux** : aucun (traitement exécuté en Suisse). La suppression physique du fichier audio auprès de l'opérateur conversationnel américain (Retell AI) est déclenchée depuis la Suisse et confirmée avant que la référence ne soit effacée en base.

**Mesures de sécurité spécifiques** :
- Traitement en deux temps pour la suppression des fichiers hébergés en externe : (a) la référence à supprimer est inscrite dans un registre interne de demandes de suppression ; (b) un processus applicatif indépendant exécute la suppression physique et n'efface la référence en base qu'après confirmation.
- Ce mécanisme garantit qu'un incident technique ne peut pas laisser un fichier orphelin non supprimé.
- Surveillance active de l'exécution des tâches de purge : toute défaillance d'une purge planifiée génère une alerte opérationnelle.
- Bornes strictes : aucun mécanisme applicatif ne peut, même en cas de dysfonctionnement, prolonger une durée de conservation au-delà des bornes ci-dessus.

---

## Traitement n° 5 — Journalisation applicative et supervision technique

**Statut** : actif.

**Finalité** : surveiller le bon fonctionnement du service, diagnostiquer les incidents techniques, produire une piste d'audit des actions d'administration, satisfaire aux obligations de sécurité de l'art. 8 OPDo.

**Base légale** : **intérêt légitime** de Corya à assurer la sécurité et la disponibilité de son service (art. 31 al. 1 nLPD), pesé contre l'intérêt des personnes concernées à ne pas voir leurs données instrumentalisées à d'autres fins. Aucune donnée identifiante de patient n'est inscrite dans les journaux techniques ; la balance est donc favorable.

**Catégories de données traitées** :
- **Journaux applicatifs techniques** : horodatages, identifiants techniques opaques (identifiants internes d'appels, identifiants de conversation attribués par l'opérateur conversationnel, identifiants de traitement asynchrone), catégories d'événements, messages d'erreur techniques. **Aucune donnée patient identifiante n'est inscrite** dans ces journaux, en application d'une règle technique de filtrage systématique.
- **Journaux d'actions d'administration** : identifiant du compte administrateur ayant agi, nature de l'action, entité concernée par l'action, adresse IP, en-tête « user-agent » du navigateur, horodatage.
- **Signaux d'état des composants applicatifs** : nom d'hôte technique, identifiant de processus, compteurs d'exécution, horodatages de dernière activité.

**Catégories de personnes concernées** :
- Administrateurs de la plateforme Corya (personnes autorisées à accéder au back-office).
- Patients, uniquement de façon indirecte via des identifiants opaques ne permettant pas leur ré-identification isolée.

**Destinataires** :
- Internes à Corya.
- Sous-traitant ultérieur : BetterStack (agrégation et rétention des journaux applicatifs, alerting).

**Durée de conservation** :
- Journaux applicatifs techniques : 12 mois maximum (rotation gérée par BetterStack).
- Journaux d'actions d'administration : 24 mois maximum.
- Signaux d'état des composants applicatifs : 30 jours après la dernière activité du composant.

**Transferts internationaux** : les journaux applicatifs techniques sont traités par BetterStack au sein de l'Union européenne, qui bénéficie de la reconnaissance de protection adéquate par le Conseil fédéral. Aucun transfert hors UE / CH.

**Mesures de sécurité spécifiques** :
- Règle technique appliquée en amont de l'écriture : les champs susceptibles de contenir une donnée identifiante de patient sont systématiquement remplacés par un placeholder avant journalisation.
- Bornes de longueur strictes sur les champs libres (500 caractères pour les messages d'erreur enregistrés en base) pour limiter la fuite involontaire.
- Accès aux journaux réservé à un cercle restreint et lui-même journalisé.

---

## Traitement n° 6 — Authentification des administrateurs Corya *(traitement PRÉVU, NON ACTIF)*

**Statut** : **prévu, non encore actif à la date de ce registre**. Le mécanisme applicatif d'authentification par lien magique (Supabase Auth) est planifié pour une prochaine étape du projet (session de développement n° 5) et le back-office admin `app.corya.ch` n'est pas exposé à ce jour. Une table technique de comptes administrateurs existe en base pour préparer ce futur déploiement mais n'est référencée par aucun flux d'authentification actif. Cette entrée est publiée par anticipation ; elle sera revue et confirmée lors de la mise en service.

**Finalité (envisagée)** : contrôler l'accès au back-office d'administration de Corya, restreint à un nombre très limité de personnes désignées (fondateur et, le cas échéant, un second administrateur).

**Base légale (envisagée)** :
- **Contrat** (relation entre Corya et son collaborateur / dirigeant).
- **Intérêt légitime** de sécuriser l'accès à des données de santé.

**Catégories de données traitées (envisagées)** :
- Adresse email professionnelle de l'administrateur.
- Nom de l'administrateur.
- Rôle attribué (administrateur / lecteur).
- Horodatage de la dernière connexion.
- Adresse IP et en-tête « user-agent » lors de chaque connexion (via le traitement n° 5).

**Catégories de personnes concernées (envisagées)** : administrateurs Corya (2 à 3 personnes prévues initialement).

**Destinataires (envisagés)** :
- Interne Corya.
- Sous-traitant ultérieur : Supabase (fournisseur du service d'authentification par lien magique et de la messagerie transactionnelle associée) et, à sa suite, Infomaniak pour l'envoi effectif du courrier électronique contenant le lien magique.

**Durée de conservation (envisagée)** : durée de la relation contractuelle avec l'administrateur, puis 12 mois d'archivage à des fins de preuve, puis suppression.

**Transferts internationaux** : aucun prévu (Supabase Zurich et Infomaniak Suisse).

**Mesures de sécurité (à mettre en place lors de l'activation)** :
- Authentification sans mot de passe (lien magique à usage unique, expirant après un délai court).
- **Double authentification à envisager** pour la mise en production (le document interne de conformité prévoit une activation en phase 2).
- Accès conditionné à l'inscription active dans la liste des comptes administrateurs autorisés, vérifiée à chaque requête.
- Toute action d'administration est journalisée (traitement n° 5).

---

## Traitement n° 7 — Stockage sécurisé des documents (bucket privé)

**Statut** : actif.

**Finalité** : héberger de façon sécurisée les récapitulatifs PDF produits par le traitement n° 2, entre leur génération et leur purge, avec accès uniquement par lien signé à durée limitée.

**Base légale** : contrat (art. 31 al. 2 let. a nLPD), en tant que support technique nécessaire aux traitements n° 2 et n° 3.

**Catégories de données traitées** : fichiers PDF contenant les données décrites au traitement n° 2 ; métadonnées techniques du fichier (taille, type, horodatage).

**Catégories de personnes concernées** : patients (contenu du PDF) et personnel du cabinet destinataire (destinataire du lien signé).

**Destinataires** : sous-traitant ultérieur unique — Supabase (Zurich).

**Durée de conservation** : identique au traitement n° 2 (30 jours au maximum après l'appel).

**Transferts internationaux** : aucun. Le stockage est situé en Suisse (Supabase, région de Zurich, `eu-central-2`), sélectionnée à dessein.

**Mesures de sécurité spécifiques** :
- **Bucket privé** : aucun accès public direct au fichier, quel que soit son chemin.
- Accès aux fichiers réservé au service applicatif de Corya, avec des clés d'accès dédiées et protégées.
- Génération à la demande d'un **lien signé à durée limitée** (30 minutes maximum, plafond dur non contournable) pour toute lecture par un destinataire externe (cabinet).
- Chemin de stockage constitué exclusivement d'identifiants techniques opaques (aucun nom de patient, aucun numéro de téléphone).
- Types de fichiers autorisés restreints (uniquement PDF) ; taille maximale plafonnée.
- Suppression des fichiers gérée par le traitement n° 4, avec preuve d'audit horodatée.

---

## Historique des versions

| Version | Date | Modifications |
|---|---|---|
| 1.0 | 2026-08-01 | Création initiale : couverture des 7 traitements post-Session 4. |

Ce registre est révisé à chaque introduction d'un nouveau traitement, à chaque changement de sous-traitant ultérieur, et au minimum une fois par an.
# Traitement n° 8 — Formulaire de contact et mesure d'audience du site public

**État** : actif sur le site public séparé. L'envoi automatisé par Resend est
conditionné à la présence des secrets runtime ; sinon l'interface propose un
repli `mailto:`.

**Finalités** : répondre aux prospects, transmettre une confirmation de prise
en charge, mesurer techniquement l'audience et protéger le site contre les abus.

**Données** : nom, coordonnées et contenu saisis volontairement, métadonnées
techniques anti-abus et identifiant de session de mesure d'audience. Les champs
libres ne doivent pas être utilisés pour transmettre des données médicales.

**Destinataires / sous-traitants** : Corya ; Resend pour l'e-mail lorsque le
connecteur est configuré ; Lovable et Cloudflare pour l'hébergement, la mesure
et la protection technique.

**Conservation** : demandes de contact, 24 mois maximum ; métriques et cookies
techniques selon les durées publiées sur les pages légales du site.

**Mesures** : validation Zod, honeypot, limitation par IP en mémoire, clés
d'idempotence Resend et repli sans transmission automatisée en cas de mauvaise
configuration.
