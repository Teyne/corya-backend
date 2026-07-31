# Corya — Règles de conformité nLPD et santé

**Ce document est la bible compliance de Corya. Tous les agents s'y réfèrent.**

## Cadre légal applicable

### Suisse
- **nLPD** (Loi fédérale sur la protection des données révisée, entrée en vigueur 1er septembre 2023)
- **Ordonnance sur la protection des données** (OPDo)
- **Art. 5 nLPD** : données personnelles
- **Art. 5 al. 1 let. c nLPD** : données personnelles sensibles (santé)
- **Art. 8 nLPD** : traitement des données sensibles
- **Art. 22 nLPD** : décisions individuelles automatisées
- **Art. 60 ss nLPD** : sanctions pénales
- **Art. 321 Code pénal suisse** : secret professionnel médical

### UE (si extension future)
- **RGPD** (Règlement 2016/679)
- **EU AI Act** (Règlement 2024/1689) : système IA à haut risque en santé

## Sanctions

- Amendes jusqu'à **CHF 250'000** par violation
- **Responsabilité pénale personnelle** du dirigeant (art. 60 ss nLPD)
- Peines complémentaires possibles (interdiction d'exercer)
- Réputation : publication des sanctions par le PFPDT

## Principes fondamentaux à respecter partout

### 1. Licéité (art. 6 nLPD)
Chaque traitement doit avoir une base légale : consentement, contrat, obligation légale, intérêt légitime.

**Chez Corya** : le traitement des appels est basé sur le consentement du patient (annonce IA au décroché + consentement de continuer) ET sur le contrat avec le cabinet.

### 2. Finalité limitée
Les données collectées pour une finalité ne peuvent servir à une autre.

**Chez Corya** : les données d'un cabinet A ne peuvent jamais servir un cabinet B. Isolation stricte.

### 3. Minimisation
Ne collecter que ce qui est strictement nécessaire.

**Chez Corya** :
- ✓ Collecter : nom, prénom, téléphone, motif court, créneau souhaité
- ✗ Ne PAS collecter : numéro AVS, numéro d'assurance, détails médicaux, historique
- Motif type "consultation de suivi" ou "première consultation" suffit

### 4. Exactitude
Les données doivent être exactes et mises à jour.

**Chez Corya** : les patients peuvent demander correction. Endpoint disponible pour les cabinets.

### 5. Sécurité (art. 8 OPDo)
Mesures techniques et organisationnelles adaptées au risque.

**Chez Corya** :
- Chiffrement au repos (Supabase natif)
- TLS 1.2+ en transit obligatoire
- Auth multi-facteur pour les admins (à ajouter en phase 2)
- Audit trail (`logs_actions`)
- Rotation des secrets (annuelle minimum)
- Pas de secret en dur dans le code

### 6. Transparence (art. 19-21 nLPD)
Les personnes concernées doivent être informées.

**Chez Corya** :
- Annonce IA au décroché OBLIGATOIRE (dès la première seconde de l'appel)
- Politique de confidentialité accessible sur corya.ch
- Coordonnées du responsable du traitement clairement affichées

### 7. Droits des personnes concernées
- Droit d'accès (art. 25)
- Droit de rectification (art. 32)
- Droit à l'effacement (art. 32) — sous 30 jours
- Droit d'opposition (art. 30)

**Chez Corya** : endpoint disponible pour tous ces droits, exercice gratuit et sous 30 jours.

## Règles opérationnelles techniques

### Annonce IA obligatoire

Message à jouer OBLIGATOIREMENT à chaque décroché, avant toute autre interaction :

> "Bonjour, vous êtes bien au cabinet [X]. Je suis l'assistant vocal automatique du cabinet. Comment puis-je vous aider ?"

Aucune configuration d'agent Retell ne peut désactiver cette annonce. C'est un contrôle contractuel.

### Durées de rétention

| Donnée | Durée maximale | Automatisme |
|---|---|---|
| Enregistrement audio | 48h | Purge horaire via pg_cron (`purge_expired_audio`) |
| Transcript complet | 7 jours | Anonymisation quotidienne à 03:00 UTC (`anonymize_old_transcripts`) |
| Nom/prénom patient | 7 jours | Anonymisation quotidienne |
| Téléphone patient | 7 jours | Anonymisation quotidienne |
| Transcript anonymisé | 24 mois | Purge mensuelle |
| Métadonnées appel (durée, résultat) | 24 mois | Purge mensuelle (`purge_ancient_appels`) |
| PDF récap | **30 jours max après création de l'appel** (voir détail ci-dessous) | Purge quotidienne à 03:30 UTC (`purge_old_pdfs`) |
| Logs applicatifs (sans données perso) | 12 mois | Rotation BetterStack |
| Logs audit (`logs_actions`) | 24 mois | Purge mensuelle |

### PDF récap — précisions sur la rétention 30 jours

Le PDF récap contient l'intégralité des données patient de l'appel (nom, prénom, téléphone, motif, transcript verbatim). Il est **plus riche** que la ligne `appels` correspondante, dont les champs patient et le `transcript` brut sont anonymisés dès **J+7** par `anonymize_old_transcripts`. Conserver le PDF au-delà perpétuerait, sous forme binaire dans Storage, exactement ce que la purge J+7 efface en base.

Règle appliquée depuis les migrations `20260731100000_job_claim_and_pdf_purge.sql` et `20260731110000_purge_old_pdfs_cover_unsent.sql` :

- **Cas nominal** — email récap envoyé avec succès : le PDF est purgé **30 jours après `pdf_envoye_at`** (motif d'audit `pdf_purged_30d`).
- **Cas dégradé** — email jamais parti (job `process_appel` en `dead_letter` sur défaillance SMTP prolongée) : le PDF est purgé **30 jours après `appels.created_at`** (motif d'audit distinct `pdf_purged_30d_unsent`, qui permet de détecter en revue les vagues d'échecs SMTP).
- **Garantie borne dure** : aucun PDF ne survit plus de 30 jours après la création de l'appel, quel que soit le sort de l'email. Cette borne évite qu'un job bloqué en dead_letter n'orphelinise un PDF jusqu'à `purge_ancient_appels` (24 mois).
- Purge en deux temps via `file_deletions_outbox` : la fonction SQL enfile un ordre de suppression Storage et met `appels.pdf_url` à NULL ; le worker backend consomme l'outbox et supprime le binaire côté bucket, horodatant `deleted_at` comme preuve d'audit.

Statut du PDF vis-à-vis du patient :

- Le PDF n'est **PAS un livrable long terme destiné au patient**. C'est un artefact opérationnel destiné au cabinet (traitement du dossier, prise de RDV, rappel).
- Le patient qui exerce son droit d'accès (art. 25 nLPD) reçoit ce que Corya détient au moment de la demande. Après J+30 il ne reste plus, côté Corya, que la ligne `appels` avec le `transcript_anonymise` et des métadonnées non identifiantes. Ceci est cohérent avec le principe de minimisation (art. 6 nLPD) et documenté dans la politique de confidentialité.
- Si le cabinet veut conserver plus longtemps le récap, il télécharge le PDF depuis l'email dans la fenêtre de 30 jours et le stocke dans son propre système (le cabinet, en tant que responsable de traitement, choisit sa propre durée de conservation).

Pour une extension future qui offrirait au patient un espace de consultation persistant, prévoir un flux séparé avec un contenu anonymisé aligné sur ce qui reste en base à J+7.

### Ce qui ne doit JAMAIS être loggé

Interdiction absolue de faire apparaître dans les logs (Pino, console, fichier, service tiers) :
- Nom, prénom d'un patient
- Numéro de téléphone d'un patient
- Contenu du transcript
- Données médicales de quelque nature
- Motif d'appel textuel (utiliser un ID de catégorie à la place)

Solution : utiliser `utils/redact.ts` (côté backend) qui remplace ces champs par des placeholders type `[REDACTED]` ou des hashes.

### Sous-traitance (art. 9 nLPD)

Corya utilise des sous-traitants pour le traitement. **Un DPA (Data Processing Agreement) doit être signé avec chacun** :

| Sous-traitant | Rôle | Localisation | DPA à signer |
|---|---|---|---|
| Retell AI | Traitement voice/LLM | US (mais offre EU processing) | Obligatoire |
| Peoplefone | Téléphonie SIP | Suisse | Obligatoire |
| Supabase | DB + Storage + Auth | Zurich (CH) | Obligatoire |
| Infomaniak | Hébergement + email | Suisse | Obligatoire |
| MessageBird / Twilio | SMS | EU / US | Obligatoire |
| BetterStack | Monitoring | EU | Obligatoire |
| ElevenLabs / Cartesia | TTS | US (majoritairement) | Obligatoire |

Un tracking des DPA signés doit exister (Google Sheet ou table dédiée dans Supabase).

### Transferts internationaux (art. 16-18 nLPD)

Si un sous-traitant est hors CH/UE (ex: Retell US), un mécanisme adéquat doit être en place :
- Clauses contractuelles types (CCT) suisses
- Ou pays reconnu comme offrant une protection adéquate

**Retell AI** étant US, il faut :
- Vérifier leur DPA
- Signer les CCT
- Documenter le transfert dans le registre des traitements

### Registre des traitements (art. 12 nLPD)

Corya doit tenir un registre des activités de traitement. Contenu minimum :
- Finalité de chaque traitement
- Catégories de données
- Destinataires
- Durée de conservation
- Mesures de sécurité
- Transferts internationaux le cas échéant

Format : document Word/PDF partagé, mis à jour à chaque nouveau traitement.

### Analyse d'impact (art. 22 nLPD)

Une AIPD (analyse d'impact relative à la protection des données) est **obligatoire** quand :
- Traitement à grande échelle de données sensibles
- Décisions automatisées avec effets juridiques
- Surveillance systématique

**Chez Corya** : à faire dès que le nombre de cabinets clients dépasse 20, ou dès la connexion au DEP.

### Notification de violation (art. 24 nLPD)

En cas de violation de sécurité :
- Notification au PFPDT dans les meilleurs délais
- Notification aux personnes concernées si risque élevé
- Documentation de toute violation dans un registre interne

Procédure à documenter dès la mise en production.

## Article 321 CP : secret médical

Le secret médical (art. 321 CP) protège les informations dont un médecin a connaissance dans l'exercice de sa profession. Ses auxiliaires (y compris les prestataires techniques) sont soumis au même secret.

**Impact pour Corya** :
- Corya est un auxiliaire du médecin, soumis au secret professionnel
- Les employés, sous-traitants, dirigeants sont pénalement responsables
- Violation = jusqu'à 3 ans de prison + amende (art. 321 al. 1 CP)
- Le secret est perpétuel, il continue après cessation de la relation

Mesures :
- Clauses de confidentialité dans tous les contrats de travail et de sous-traitance
- Formation obligatoire à l'entrée en fonction
- Limitation stricte des accès selon le principe "need to know"

## EU AI Act (préparation)

Si Corya étend en UE :
- Un agent vocal en santé est classé **"système à haut risque"**
- Obligations : documentation technique, transparence, supervision humaine, journaux d'exécution
- Enregistrement dans une base UE
- Marquage CE

À anticiper dès la 1ère vente en UE.

## Checklist compliance pour chaque nouveau développement

Avant de merger un PR ou déployer une feature, le sub-agent `database-compliance` doit valider :

- [ ] Aucune donnée patient (nom, tel, motif) dans les logs
- [ ] Durée de rétention respectée
- [ ] RLS activé sur toute nouvelle table
- [ ] Endpoint documenté dans le registre des traitements
- [ ] Contrat sous-traitant OK si nouveau tiers introduit
- [ ] Audit trail en place pour actions admin
- [ ] Test unitaire de non-régression compliance
