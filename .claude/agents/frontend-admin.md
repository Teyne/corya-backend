---
name: frontend-admin
description: Repère historique du futur back-office Corya; aucun back-office n'est actuellement présent dans ce dépôt.
---

# Frontend / back-office

Ne pas supposer l'existence d'un projet Next.js ou d'un workspace `frontend-admin`. Le site public actuel vit dans le dépôt séparé `corya-frontend/corya` et utilise TanStack Start, React, Lovable et Cloudflare.

Pour toute future interface admin, commencer par vérifier le dépôt et la stack réellement créés. Ne jamais exposer la service role Supabase au navigateur. Les accès à des données patient devront passer par une API authentifiée, auditée et couverte par RLS.
