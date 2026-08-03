# Corya — orchestration Codex

Le thread principal est l'architecte et le seul responsable du résultat final. Il clarifie l'objectif, découpe le travail, choisit les agents, arbitre les contradictions, contrôle le diff et rend le bilan à l'utilisateur.

## Délégation attendue

Pour toute tâche non triviale, évaluer explicitement ce qui peut être délégué. Utiliser les agents projet dans `.codex/agents/` quand leurs travaux sont indépendants et apportent un vrai gain : exploration, documentation officielle, sécurité/nLPD, base de données, tests ou revue.

- Par défaut, lancer en parallèle les analyses en lecture seule.
- Ne laisser qu'un seul agent modifier une même zone du dépôt à la fois.
- Ne jamais confier le même fichier à deux agents écrivains en parallèle.
- Les agents rendent une synthèse courte : constat, preuves avec chemins/symboles, risques, validation et action recommandée.
- Le thread principal vérifie lui-même les conclusions importantes avant de modifier, merger, déployer ou annoncer la réussite.
- Les sous-agents ne créent pas d'autres agents sauf demande explicite du thread principal.
- Pour une petite correction localisée, travailler directement si la délégation coûterait plus qu'elle ne rapporte.

## Source de vérité

Lire d'abord `README.md`, `docs/architecture.md`, `.claude/session4-decisions.md`, les migrations concernées et les tests du module. Le code courant et les migrations non appliquées priment sur les anciens prompts. Le frontend public vit dans le dépôt séparé `../corya-frontend/corya/`.

## Contraintes permanentes

- Aucune donnée patient dans les logs, alertes, erreurs persistées, fixtures ou sorties d'agents.
- Utiliser les helpers de redaction et `toLogFields` pour les erreurs externes.
- Borner tout I/O externe par un timeout.
- Garantir idempotence, retries bornés et transitions concurrentes sûres.
- Les suppressions physiques passent par l'outbox et son heartbeat.
- Ne jamais appliquer une migration distante, déployer, pousser, merger ou contacter un tiers sans autorisation explicite.
- Préserver les modifications utilisateur et éviter tout changement hors périmètre.

## Validation

Depuis `apps/backend/` :

```bash
npm test -- --run
npm run test:e2e
npm run type-check
npm run lint
```

Le thread principal doit aussi exécuter `git diff --check` et examiner `git status` avant tout commit.

## Équipe disponible

- `corya_explorer` : cartographie et diagnostic en lecture seule.
- `backend_implementer` : implémentation TypeScript ciblée.
- `database_compliance` : migrations Supabase, rétention et conformité DB.
- `privacy_security_reviewer` : revue sécurité, PII, nLPD et secrets.
- `qa_reviewer` : stratégie de tests et validation indépendante.
- `release_operator` : préparation Git/déploiement, uniquement avec autorisation externe explicite.

Le fonctionnement détaillé et les prompts prêts à l'emploi sont dans `docs/codex-orchestration.md`.
