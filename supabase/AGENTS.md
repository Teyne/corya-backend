# Règles locales — Supabase

Ces règles complètent le `AGENTS.md` racine pour `supabase/`.

- Lire les migrations précédentes qui définissent les objets modifiés.
- Les nouvelles migrations sont append-only et ordonnées par timestamp ; ne pas réécrire une migration déjà appliquée sans preuve qu'elle ne l'est pas.
- Préférer les transitions atomiques côté SQL, `FOR UPDATE SKIP LOCKED` pour les claims concurrents et des tentatives strictement bornées.
- Verrouiller `search_path` pour les fonctions `SECURITY DEFINER`, puis définir explicitement REVOKE/GRANT.
- RLS deny-by-default sur les tables internes ; accès `service_role` seulement.
- Ne jamais supprimer une ligne métier avant d'avoir matérialisé les suppressions physiques nécessaires.
- Documenter ordre d'application, compatibilité avec le code en place, validation et rollback.
- Ne jamais exécuter `db reset`, `db push` ou une commande distante sans autorisation explicite.
