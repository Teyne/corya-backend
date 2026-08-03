# Organisation des agents Codex pour Corya

## Principe

Le thread principal reste l'architecte. Les agents ne prennent pas de décision produit finale et ne publient rien seuls. Ils reçoivent un mandat borné, travaillent en parallèle lorsque leurs fichiers ne se chevauchent pas, puis rendent une synthèse au principal.

```text
Architecte principal
├── corya_explorer              lecture et cartographie
├── privacy_security_reviewer   revue indépendante
├── qa_reviewer                 tests et risques
├── backend_implementer         écrivain TypeScript exclusif
├── database_compliance         écrivain SQL exclusif
└── release_operator            préparation / publication autorisée
```

## Workflow recommandé

1. L'architecte reformule l'objectif et fixe les critères d'acceptation.
2. `corya_explorer` trace le flux réel.
3. Si nécessaire, sécurité, DB et QA analysent en parallèle, en lecture seule autant que possible.
4. L'architecte tranche et attribue des fichiers sans chevauchement à un seul écrivain.
5. L'écrivain implémente et teste son périmètre.
6. QA et sécurité relisent le diff final en parallèle.
7. L'architecte exécute lui-même la validation globale et présente le bilan.
8. `release_operator` n'intervient qu'après autorisation explicite de commit, push, migration ou déploiement.

## Prompt CLI — développement d'une fonctionnalité

```text
Tu es l'architecte principal Corya. Délègue d'abord à corya_explorer la cartographie du flux concerné. En parallèle, demande à privacy_security_reviewer et qa_reviewer d'identifier les invariants et risques. Attends leurs synthèses, propose un plan, puis confie l'implémentation à un seul agent écrivain. Relis le diff, lance toutes les validations prévues par AGENTS.md et rends un bilan avec les opérations distantes encore manuelles.
```

## Prompt CLI — changement Supabase + backend

```text
Utilise database_compliance pour concevoir la migration et son contrat, et corya_explorer pour localiser les consommateurs TypeScript. Attends les deux résultats. Attribue les migrations uniquement à database_compliance et le TypeScript uniquement à backend_implementer, sans édition parallèle du même fichier. Fais relire le diff final par privacy_security_reviewer et qa_reviewer avant validation globale.
```

## Prompt CLI — revue avant production

```text
N'effectue aucune écriture. Lance corya_explorer, privacy_security_reviewer, qa_reviewer et release_operator en parallèle pour auditer la branche contre main. Attends tous les résultats, déduplique les constats et classe-les en bloquant, important ou amélioration. Donne ensuite un go/no-go justifié et la checklist manuelle de déploiement.
```

## Utilisation dans Codex CLI

Ouvrir le dépôt puis démarrer Codex. Les agents projet sont chargés depuis `.codex/agents/`. Demander explicitement la délégation dans le prompt ; utiliser `/agent` ou `/subagents` pour inspecter les threads actifs. Les règles racine et celles du sous-dossier courant sont chargées automatiquement depuis les fichiers `AGENTS.md`.

La limite est fixée à quatre sous-agents simultanés. Cela permet les revues parallèles sans multiplier excessivement le coût ni les conflits. Le modèle principal peut rester plus profond ; les analyses auxiliaires utilisent principalement `gpt-5.6-terra`, tandis que les deux agents écrivains utilisent `gpt-5.6-sol`.
