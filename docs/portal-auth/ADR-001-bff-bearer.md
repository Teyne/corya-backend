# ADR-001 — Session SSR/PKCE au portail, Bearer vers Express

Statut : accepté pour l'implémentation locale du 6 août 2026. Cette décision
n'autorise ni migration distante ni déploiement.

## Décision

Le portail TanStack Start conserve la session Supabase côté serveur avec PKCE
et des cookies `HttpOnly`, `Secure`, `SameSite=Lax`, host-only. Le navigateur
n'appelle que son BFF same-origin. Le BFF transmet l'access token courant à
Express dans `Authorization: Bearer …` et ne le place jamais dans une URL, une
réponse navigateur, `localStorage` ou `sessionStorage`.

Express ne lit aucun cookie d'authentification. Il valide le JWT par la
primitive officielle Supabase Auth `getUser(jwt)` au moyen d'un second client
anon sans persistance ni refresh de session. L'appel et le fetch sous-jacent
sont bornés par `TIMEOUT_AUTH_MS`. L'absence de `SUPABASE_ANON_KEY` rend
uniquement `/admin` indisponible (`503`), sans empêcher l'API webhook ou le
worker de démarrer.

Après validation du token, chaque requête relit une membership active dans
`cabinet_memberships`. En l'absence de sélecteur, l'ordre `cabinet_id ASC`
rend le choix multi-cabinet déterministe. Le BFF peut fournir
`X-Corya-Cabinet-Id`, mais cette valeur n'est acceptée qu'après preuve d'une
membership active correspondante. Le rôle relu en base gouverne les mutations.
Le client service-role n'est utilisé qu'après ces contrôles.

## Limites de confiance

```text
Navigateur ── cookie HttpOnly ──> BFF TanStack
Navigateur <── DTO sans secret ── BFF TanStack
                                  │
                                  └── Bearer Supabase ──> Express /admin
                                                          │ getUser(jwt)
                                                          │ membership active
                                                          └ service_role DB/Storage
```

Secrets serveur : clé anon dans le BFF et Express, clé service-role uniquement
dans Express. La clé anon n'est pas un secret d'autorisation, mais elle reste
hors du bundle navigateur conformément au modèle retenu. CORS ne constitue
jamais une autorisation. Comme Express n'emploie pas de cookie, il n'ajoute pas
de mécanisme CSRF à `/admin`; la protection CSRF de la session cookie appartient
au BFF same-origin.

## Conséquences

- Toute réponse `/admin` est `Cache-Control: private, no-store`.
- Token absent, malformé, invalide ou expiré : `401 unauthorized` générique.
- Auth indisponible ou timeout : `503 authentication_unavailable` générique.
- Membership absente/inactive ou rôle insuffisant : `403 forbidden`.
- Ressource d'un autre cabinet : `404 not_found`, sans oracle IDOR.
- Aucun token, URL signée ou numéro masqué n'est journalisé.
