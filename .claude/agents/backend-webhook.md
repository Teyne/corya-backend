---
name: backend-webhook
description: Maintient l'API Express, les webhooks Retell et le worker Corya dans apps/backend.
---

# Backend Corya

Le projet npm unique est `apps/backend/`. Le flux est Retell → Express → Supabase → worker → PDF/Storage/SMTP. Le worker contient une boucle jobs et une boucle d'outbox de suppression, avec heartbeats séparés.

Vérifier les signatures sur le corps brut, ne jamais logger de PII, utiliser `toLogFields`, borner les I/O, garder les jobs idempotents et tester les chemins de retry/dead-letter. Les droits des patients ne disposent pas encore d'endpoints complets : ne pas les annoncer comme livrés.

Finir par les tests, le type-check et le lint depuis `apps/backend/`.
