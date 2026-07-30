# Corya — Architecture globale

## Vue d'ensemble

Corya est une plateforme d'accueil téléphonique IA pour cabinets médicaux romands. Ce document décrit l'architecture technique globale, partagée par tous les sub-agents.

## Sous-domaines et responsabilités

| Sous-domaine | Rôle | Stack | Agent responsable |
|---|---|---|---|
| `corya.ch` | Site vitrine marketing | Framer/Astro (TBD) | Non couvert ici |
| `api.corya.ch` | Backend webhook + logique métier | Node.js/Express | `backend-webhook` |
| `app.corya.ch` | Back-office admin interne | Next.js 14 | `frontend-admin` |
| `crm.corya.ch` | CRM prospection interne | Lovable app | Non couvert ici |
| `status.corya.ch` | Page publique de statut | BetterStack | Non couvert ici |
| Supabase (Frankfurt) | DB + Auth + Storage | PostgreSQL 15 | `database-compliance` |

## Flux principal : un appel entrant

```
1. Patient compose le numéro du cabinet
2. Le cabinet a configuré chez son opérateur un renvoi conditionnel 
   (occupé/hors heures) vers un numéro Peoplefone géré par Corya
3. Peoplefone route l'appel vers Retell AI via SIP trunking
4. L'agent Retell (configuré pour ce cabinet) décroche et gère la conversation
5. En fin d'appel, Retell envoie un webhook à api.corya.ch
6. Backend Corya :
   - Identifie le cabinet via le numéro appelé
   - Extrait les données structurées de l'appel
   - Génère un PDF récap
   - Upload le PDF dans Supabase Storage
   - Enregistre l'appel dans la table appels
   - Envoie un email au cabinet avec le PDF joint
7. La secrétaire du cabinet reçoit l'email et rappelle le patient si besoin
```

## Flux secondaire : accès admin

```
1. Fondateur ou père se connecte à app.corya.ch
2. Magic link envoyé à son email pro
3. Après clic, session Supabase créée
4. Middleware Next.js vérifie que l'email est dans admin_users
5. Accès aux dashboards, listes appels, gestion cabinets
6. Toutes les actions loggées dans logs_actions
```

## Communications inter-services

### api.corya.ch ↔ Supabase
- Client Supabase avec service role key (accès complet)
- Aucun accès public direct à Supabase depuis internet

### app.corya.ch ↔ api.corya.ch
- Authentification via JWT Supabase (transmis en header Authorization)
- Backend vérifie le JWT ET que l'email est dans admin_users
- Toutes les mutations passent par l'API, pas directement par Supabase

### app.corya.ch ↔ Supabase (auth uniquement)
- Uniquement pour l'auth (magic link, refresh token)
- Lecture/écriture data toujours via api.corya.ch

### api.corya.ch ↔ Retell
- Webhook entrant : Retell → api.corya.ch (validation signature)
- API sortante : api.corya.ch → Retell (config agents, purge audio)

## Environnements

- **Local dev** : Node backend sur `localhost:3000`, Next front sur `localhost:3001`, Supabase local optionnel ou instance dev
- **Staging** : `api-staging.corya.ch`, `app-staging.corya.ch`, Supabase projet séparé
- **Prod** : `api.corya.ch`, `app.corya.ch`, Supabase projet prod

Aucun cross-environnement (staging ne parle jamais à la DB prod).

## Sécurité globale

- HTTPS/TLS 1.2+ obligatoire partout
- Secrets dans variables d'environnement Jelastic
- Rate limiting sur endpoints publics (webhook 100 req/s, API interne 10 req/s/user)
- Audit trail obligatoire pour toute action admin (`logs_actions`)
- Purges automatiques nLPD (voir `docs/compliance.md`)
