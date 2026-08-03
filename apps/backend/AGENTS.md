# Règles locales — backend

Ces règles complètent le `AGENTS.md` racine pour tout fichier sous `apps/backend/`.

- Lancer npm depuis ce dossier uniquement.
- `src/db/queries.ts` est la seule couche autorisée à parler directement à Supabase.
- Ne jamais inclure nom, prénom, téléphone, motif, transcript, URL audio ou corps de webhook dans les logs ou erreurs persistées.
- Utiliser `toLogFields` pour journaliser une erreur externe et conserver une erreur persistée constante/nettoyée.
- Toute nouvelle opération réseau doit utiliser le timeout approprié.
- Un job doit être idempotent, récupérable après crash et couvert sur succès, retry et état terminal.
- Les tests ne doivent jamais charger `.env.local` ni contacter Supabase, Retell, SMTP ou Chromium réels.
- Validation minimale : test ciblé, puis `npm run type-check` et `npm run lint`. Avant livraison d'une vague : tests unitaires et e2e complets.
