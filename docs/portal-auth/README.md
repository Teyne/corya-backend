# Portail Corya — cadrage authentification et isolation des cabinets

Statut : plan d'architecture. Ce document n'autorise aucune migration distante,
aucun déploiement, commit, push ou merge.

## Objectif

Connecter progressivement le portail cabinet au backend Corya avec :

- une authentification Supabase vérifiée côté serveur ;
- une isolation stricte entre cabinets ;
- deux rôles initiaux, `admin` et `viewer` ;
- des réponses API minimales, sans exposition des tables internes ;
- une traçabilité sans donnée patient dans les logs ;
- une revue indépendante avant toute mise en service.

Le portail concerné est le dépôt frère :
`../corya-portal-client/corya-patient-connect`.

## État constaté au 6 août 2026

Ces constats doivent être revalidés par l'architecte avant implémentation :

- l'API Express expose actuellement `/webhooks` et `/health`, pas d'API
  d'administration ;
- le client Supabase du backend utilise la clé de service et contourne donc la
  RLS ; chaque endpoint administratif devra authentifier et autoriser
  explicitement la requête, ou utiliser un client borné à l'appelant ;
- `admin_users` représente aujourd'hui des opérateurs internes Corya et ne doit
  pas devenir implicitement la table des membres de cabinet ;
- `is_admin_user()` s'appuie sur l'e-mail du JWT et ne porte pas l'isolation par
  cabinet ;
- les anciennes politiques permissives donnent un accès trop large aux
  cabinets, appels, utilisateurs, journaux et PDF. Ajouter une politique plus
  restrictive ne suffit pas : les politiques permissives se combinent par
  `OR`, elles doivent être remplacées ;
- le portail de démonstration ne doit conserver ni session ni donnée d'appel
  dans `localStorage` ou `sessionStorage` ;
- les tables de jobs, outbox, heartbeats et crons restent exclusivement
  internes au service.

## Décision d'architecture obligatoire

Avant tout code, l'architecte compare et consigne une seule option :

### Option A — session SSR par cookie

Le portail TanStack Start gère le cycle de session avec `@supabase/ssr`, PKCE et
des cookies sécurisés. Les routes serveur du portail appellent ensuite l'API.
Cette option réduit l'exposition des jetons au navigateur, mais impose de
concevoir précisément les cookies inter-origines, la rotation, le cache et la
protection CSRF.

### Option B — Bearer stateless

Le portail transmet un access token Supabase dans `Authorization`. L'API le
vérifie avec une primitive officielle (`getClaims(jwt)`, `getUser(jwt)` ou le
package serveur approprié), puis reconfirme l'appartenance active au cabinet.
Cette option simplifie une API sur un domaine séparé, mais le stockage et le
renouvellement du jeton côté portail doivent rester compatibles avec
l'interdiction de stockage navigateur persistant.

### Critères de décision

- domaines finaux du portail et de l'API ;
- compatibilité TanStack Start / Cloudflare du package retenu ;
- absence de jeton dans le stockage persistant, les URL et les logs ;
- protection CSRF réelle si des cookies authentifiants sont utilisés ;
- vérification cryptographique du JWT, de `iss`, `exp`, `sub` et du projet ;
- rotation/expiration et comportement de déconnexion ;
- coût opérationnel et simplicité d'audit.

Ne jamais décoder un JWT sans vérifier sa signature. Ne jamais baser
l'autorisation sur l'e-mail seul. Les références officielles de départ sont :

- <https://supabase.com/docs/guides/auth/choosing-a-server-package>
- <https://supabase.com/docs/reference/javascript/auth-getclaims>
- <https://supabase.com/docs/reference/javascript/auth-getuser>
- <https://supabase.com/docs/guides/auth/server-side/advanced-guide>

## Modèle d'autorisation cible

Le modèle à confirmer par migration locale est une relation dédiée, distincte
des opérateurs Corya :

`cabinet_memberships(cabinet_id, user_id, role, actif, created_at, updated_at)`

Invariants minimaux :

- `user_id` référence `auth.users.id` ;
- clé unique ou primaire sur `(cabinet_id, user_id)` ;
- un membre inactif n'obtient aucun accès ;
- `viewer` lit uniquement les données explicitement exposées ;
- `admin` gère les membres de son cabinet dans les limites prévues ;
- le dernier administrateur actif d'un cabinet ne peut être supprimé ou
  rétrogradé, y compris sous concurrence ;
- l'identité repose sur `auth.uid()`, jamais sur l'e-mail ;
- les politiques historiques globales sont supprimées ou remplacées dans la
  même migration ;
- un PDF privé n'est signé qu'après autorisation sur le cabinet et l'appel ;
- l'URL signée n'est ni loggée ni persistée.

## Projection API minimale

L'API ne doit pas exposer les lignes Supabase brutes. La première vague se
limite aux contrats nécessaires au portail, par exemple :

- session/utilisateur courant et cabinets autorisés ;
- liste paginée d'appels d'un cabinet autorisé ;
- détail minimal d'un appel autorisé ;
- création à la demande d'une URL PDF courte après contrôle d'accès ;
- lecture/gestion bornée des membres, réservée au rôle approprié.

Les DTO excluent systématiquement : hash de téléphone, payload Retell brut,
transcription/audio si non explicitement requis et autorisé, métadonnées
internes, jobs, leases, outbox et secrets. Même une valeur masquée reste une
donnée personnelle et doit être justifiée.

## Ordre de réalisation

1. **Décision** — analyse en lecture seule, décision ADR et contrats proposés.
2. **Base locale** — migration et tests SQL d'isolation, sans application
   distante.
3. **Backend** — middleware d'authentification, contexte d'autorisation, DTO et
   endpoints bornés, avec tests.
4. **Portail** — session selon l'ADR, garde de route réelle, client API et états
   d'erreur, sans données réelles.
5. **Revue** — sécurité/nLPD, QA, tests croisés et inspection du diff.
6. **Opérations** — seulement après un GO distinct : migration distante,
   provisioning, déploiement API, déploiement portail et smoke tests.

## Gates

### Gate A — architecture

- ADR cookie/Bearer validée ;
- diagramme de confiance et liste des secrets ;
- contrats API et matrice de rôles validés ;
- stratégie de provisioning initial définie.

### Gate B — local

- tests SQL prouvent l'isolation cabinet A/B, membre absent/inactif,
  `viewer`/`admin`, multi-cabinet, dernier admin et Storage ;
- tests backend couvrent jeton absent/invalide/expiré, cabinet non autorisé,
  rôle insuffisant et absence de fuite ;
- tests portail couvrent connexion/déconnexion, refresh/expiration, garde des
  routes et erreurs réseau ;
- aucun secret, PII ou donnée réelle dans le diff et les sorties.

### Gate C — préproduction/pilote

- migration appliquée avec contrôle post-migration ;
- membres pilotes provisionnés explicitement ;
- CORS, cookies/CSRF ou Bearer vérifiés sur les domaines finaux ;
- journalisation et rétention contrôlées ;
- rollback opérationnel documenté.

## Hors périmètre de cette vague

- correction du worker de purge Retell ;
- correction éventuelle du lease fencing des jobs ;
- connexion calendrier, SMS, transfert téléphonique ou nouvelle logique Retell ;
- ajout de données patient dans les fixtures ;
- migration distante ou déploiement implicite.
