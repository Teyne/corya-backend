# Guide agents — Corya backend

Ce dépôt contient un seul projet npm dans `apps/backend/`. Toujours lancer npm depuis ce dossier. Le site public est séparé dans `../corya-frontend/corya/`; aucun back-office Next.js n'existe ici.

Avant une modification, lire `README.md`, `docs/architecture.md`, `.claude/session4-decisions.md`, les migrations concernées et les tests du module. Ne jamais appliquer une migration distante, déployer ou manipuler GitHub sans demande explicite.

Contraintes permanentes :

- aucune donnée patient dans les logs, erreurs persistées ou alertes ; utiliser `toLogFields` ;
- tout I/O externe doit être borné par un timeout ;
- transitions concurrentes par RPC/guards et opérations idempotentes ;
- les suppressions physiques passent par l'outbox et possèdent leur heartbeat ;
- préserver la réponse rapide du webhook tout en documentant le risque d'acquittement avant persistance ;
- valider avec `npm test -- --run`, `npm run type-check` et `npm run lint`.

Les prompts de sessions et anciennes descriptions d'agents sont des traces historiques. En cas de contradiction, le code courant, les migrations non appliquées et `docs/architecture.md` priment.
