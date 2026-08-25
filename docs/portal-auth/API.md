# API portail cabinet

Base : `/admin`. Cette API est réservée au BFF TanStack. Toutes les requêtes
portent un Bearer Supabase strict. `X-Corya-Cabinet-Id` est facultatif et ne
sélectionne qu'une membership active de l'utilisateur authentifié.

Toutes les réponses portent `Cache-Control: private, no-store`. Les erreurs
sont bornées : `unauthorized`, `authentication_unavailable`, `forbidden`,
`invalid_request`, `not_found`, `conflict` ou `internal_server_error`.

## Endpoints

| Méthode | Chemin | Rôle | Réponse |
|---|---|---|---|
| GET | `/me` | viewer/admin | utilisateur courant, cabinet sélectionné et `practices` actives (`id`, `name`, `role`) |
| GET | `/dashboard?period=7d\|30d\|90d` | viewer/admin | métriques, volumes, résultats et appels récents |
| GET | `/calls` | viewer/admin | appels paginés, `pageSize` 1–100 |
| GET | `/calls/:id` | viewer/admin | détail minimal, sans transcript |
| POST | `/calls/:id/pdf-url` | viewer/admin | `{ url, expiresIn: 300 }` après contrôle du path privé |
| GET | `/integrations` | viewer/admin | état projeté des intégrations |
| GET/PATCH | `/settings` | lecture tous, écriture admin | configuration cabinet allowlistée |
| GET | `/team` | viewer/admin | identifiant, rôle, statut; les adresses des autres membres ne sont visibles que par un admin du cabinet |
| POST | `/team/invitations` | admin | invitation Supabase Auth puis membership tenant-scopée auditée |
| PATCH | `/team/:userId` | admin | exactement un changement : `role` ou `status=disabled` |
| GET | `/security/status` | viewer/admin | politique de rétention et services exposables |
| GET/PATCH | `/assistant` | lecture tous, écriture admin | projection stricte de l'assistant |

Filtres `/calls` : `outcome`,
`practitionerId`, `summaryStatus`, `period`, `sort`, `page`, `pageSize`. Les
motifs libres ne sont jamais renvoyés : ils deviennent une catégorie
administrative (`Rendez-vous`, `Facturation`, `Ordonnance`, `Message`, `Suivi`
ou `Autre demande`). Le paramètre `search` est conservé pour la compatibilité
du client mais seule la valeur vide est acceptée : même masqué, le numéro est
une donnée personnelle et n'est plus chargé ni exposé. `maskedNumber` contient
la constante `Numéro non exposé`.

Le détail d'appel retourne `transcript: []` et `transcriptState: unavailable`
(état honnête : la projection ne charge pas le transcript); il n'expose
ni transcript brut/anonymisé, ni donnée patient, hash appelant, audio, path/URL
PDF, identifiant Retell, job, lease, outbox ou secret. La route PDF vérifie le
format exact `{cabinet_id}/{yyyy-mm}/{appel_id}.pdf`, crée une URL de cinq
minutes et ne la persiste ni ne la journalise.

Le dashboard est calculé par `get_portal_dashboard_snapshot` dans une seule
lecture SQL cohérente. La RPC renvoie les agrégats exacts et cinq appels récents
sur une projection minimale; elle ne charge ni numéro, donnée patient,
transcript, audio, identifiant Retell ou path PDF. Une indisponibilité de ce
snapshot renvoie `503 dashboard_unavailable` plutôt que des métriques partielles.

Les réglages portail sont rangés sous `config_agent.portal.settings` et
`config_agent.portal.assistant`. Les autres clés existantes sont conservées
mais jamais projetées. La RPC `apply_portal_cabinet_patch_with_audit` verrouille
la ligne cabinet, contrôle `updated_at`, fusionne le delta allowlisté et inscrit
l'audit dans la même transaction. L'API réessaie au plus trois conflits de
sérialisation avec une version fraîche, puis renvoie `409 conflict`. L'audit ne
contient que le cabinet, l'UUID Auth de l'acteur, l'action et les noms allowlistés
des champs modifiés : aucune valeur, adresse e-mail, adresse IP, en-tête ou
token. Un PATCH idempotent sans changement n'appelle pas la RPC et ne crée pas
d'événement.

Les mutations d'équipe passent par
`apply_portal_membership_mutation_with_audit`. La RPC reverifie le rôle admin
dans la transaction, refuse l'auto-rétrogradation et l'auto-désactivation, et
le trigger `cabinet_requires_active_admin` protège le dernier administrateur
actif sous concurrence. L'audit ne conserve que l'action et `role`/`status` ;
jamais l'adresse invitée. Les appels Supabase Auth sont bornés par le timeout
Auth du backend et le lien d'invitation revient sur `/auth/callback` du portail.

`/security/status` reflète les migrations exécutables : métadonnées d'appel au
maximum 24 mois, transcript brut et données identifiantes 7 jours, audio 48 h,
PDF privé 30 jours. Aucun état de service simulé n'est présenté comme une
télémétrie réelle.

## Validation SQL locale uniquement

Les invariants tenant sont exécutables exclusivement sur le Supabase local
jetable, après `supabase start` et `supabase db reset` :

```powershell
$LocalPortalDb = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
if (([uri]$LocalPortalDb.Replace('postgresql:', 'http:')).Host -notin @('127.0.0.1', 'localhost')) { throw 'loopback_required' }
psql $LocalPortalDb -v ON_ERROR_STOP=1 -f supabase/tests/portal_tenant_rls_invariants.sql
psql $LocalPortalDb -v ON_ERROR_STOP=1 -f supabase/tests/portal_audit_events_invariants.sql
psql $LocalPortalDb -v ON_ERROR_STOP=1 -f supabase/tests/portal_team_management_invariants.sql
powershell -File supabase/tests/portal_tenant_rls_concurrency.ps1
```

Ne jamais remplacer cette cible par une base distante.
