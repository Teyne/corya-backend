# Préflight et déploiement Jelastic

Ce runbook décrit la topologie cible de Corya. Il ne crée aucun environnement
et n'autorise aucune opération Supabase, Retell, Storage ou SMTP.

## Topologie cible

Utiliser deux environnements Jelastic Node.js natifs distincts, sans addon de
base de données. Supabase Postgres et Storage restent externes.

| Environnement | Rôle | Runtime | Ressources d'essai | Exposition |
|---|---|---|---:|---|
| corya-api | API Express et pollers d'alertes | Node.js 24.18.0 | 1 réservé / max 4 dynamiques | HTTPS public |
| corya-worker | jobs, PDF et outbox de suppressions | Node.js 24.18.0 | 1 réservé / max 8 dynamiques | aucune |

Garder exactement un nœud et une instance PM2 par environnement. Le worker
d'essai doit utiliser JOB_BATCH_SIZE=1 pour borner le nombre de pages Chromium
simultanées. Quatre Cloudlets (512 Mio) ont saturé pendant le smoke-test ; dix
rendus séquentiels ont réussi avec huit Cloudlets (1 Gio), pour un pic total
mesuré à 689,4 Mio et sans processus Chromium résiduel.

Ne pas démarrer corya-api et corya-worker dans le même environnement.
N'ajouter ni PostgreSQL, ni autre base, ni bucket dans Jelastic.

## Build et processus

Le dépôt n'est pas un workspace npm. Toutes les commandes npm partent de
apps/backend/.

~~~bash
cd apps/backend
npm ci
npm run build
~~~

Avant le démarrage, exécuter le préflight du rôle. Il lit uniquement
process.env, ne charge aucun fichier dotenv et n'affiche jamais les valeurs.

~~~bash
npm run preflight:jelastic -- --role api
pm2 start ecosystem.config.cjs --only corya-api
~~~

~~~bash
npm run preflight:jelastic -- --role worker
pm2 start ecosystem.config.cjs --only corya-worker
~~~

Les entrypoints compilés sont respectivement dist/index.js et
dist/worker.js. La configuration PM2 démarre une instance en mode fork,
redémarre après crash et accorde 15 secondes à l'API et 30 secondes au worker
pour leurs handlers SIGTERM / SIGINT.

PM2 limite chaque application à max_restarts=10. Après dix redémarrages
rapides, considérer le processus comme indisponible, conserver les logs
techniques sans données métier et déclencher une intervention opérateur ; ne
pas contourner la limite par une boucle de redémarrage externe.

Sans PM2, les commandes applicatives équivalentes restent npm start pour
l'API et npm run worker pour le worker. Le choix PM2 doit être configuré
explicitement dans chaque environnement Jelastic.

La persistance de la sélection --only après redémarrage et redéploiement est
un stop-gate de production. Elle doit être testée dans les environnements
d'essai avant toute mise en service. Pendant ce test, démarrer manuellement
uniquement le rôle attendu et ne jamais accepter que les deux applications du
fichier ecosystem soient démarrées ensemble.

## Variables par environnement

Les valeurs sont injectées dans l'interface Jelastic. Elles ne doivent figurer
ni dans Git, ni dans une archive, ni dans .env.local sur la plateforme.

### API

Le préflight API exige uniquement la présence et, pour quelques champs, la
forme des noms suivants :

~~~text
NODE_ENV
PORT
APP_BASE_URL
CORS_ORIGIN
TRUST_PROXY_HOPS
SUPABASE_URL
SUPABASE_SERVICE_KEY
RETELL_API_KEY
ALERT_EMAIL
HEALTH_DEEP_TOKEN
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_PASSWORD
SMTP_FROM_NAME
SMTP_FROM_EMAIL
~~~

NODE_ENV doit désigner la production. PORT est fourni par Jelastic et l'API
l'écoute directement. Ne jamais le coder en dur. CORS_ORIGIN ne doit pas être
un wildcard ; chaque origine de sa liste séparée par des virgules doit être une
URL HTTPS valide. Le préflight impose HTTPS aux URL de production, puis valide
les formats email et les bornes
de PORT, SMTP_PORT et TRUST_PROXY_HOPS, le booléen SMTP_SECURE et la longueur
minimale de HEALTH_DEEP_TOKEN, sans afficher les valeurs.

Les réglages non secrets de timeouts, alerting, health et rate limiting de
.env.example doivent aussi être revus avant mise en service, même lorsqu'ils
ont une valeur par défaut dans le schéma Zod.

### Worker

Le préflight worker exige :

~~~text
NODE_ENV
APP_BASE_URL
ADMIN_APP_URL
SUPABASE_URL
SUPABASE_SERVICE_KEY
RETELL_API_KEY
ALERT_EMAIL
HEALTH_DEEP_TOKEN
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_PASSWORD
SMTP_FROM_NAME
SMTP_FROM_EMAIL
JOB_BATCH_SIZE
~~~

HEALTH_DEEP_TOKEN reste requis par le schéma de configuration partagé en
production, même si le worker n'expose pas /health/deep. Ajouter les réglages
worker et outbox de .env.example, notamment WORKER_ID, JOB_POLL_INTERVAL_MS,
JOB_STALE_AFTER_SECONDS, WORKER_HEARTBEAT_INTERVAL_MS,
FILE_DELETION_BATCH_SIZE, FILE_DELETION_POLL_INTERVAL_MS et
FILE_DELETION_STALE_AFTER_SECONDS.

Pour l'essai, JOB_BATCH_SIZE vaut exactement 1. Ne pas augmenter cette valeur
avant d'avoir mesuré la mémoire du worker sur plusieurs rendus.

## Tests de préflight dans l'essai

### PORT et santé API

1. Vérifier `PORT` dans le shell. Sur l'environnement natif testé, Jelastic
   ne l'injectait pas ; `PORT=8080` a donc été configuré explicitement.
2. Exécuter le préflight API, puis démarrer uniquement corya-api.
3. Confirmer que le log de démarrage annonce le port attendu, sans secret.
4. Vérifier GET /health sur le routage Jelastic.
5. Réserver /health/deep aux contrôles opérateur avec le header
   X-Health-Token ; ne pas en faire la liveness permanente du load balancer.

### Chromium et mémoire worker

Le smoke-test n'utilise que du HTML synthétique, garde les PDF en mémoire et
n'appelle aucun service Corya :

~~~bash
npm run smoke:puppeteer -- --renders 3 --timeout-ms 15000
~~~

Relever pour chaque rendu duration_ms, pdf_bytes et node_rss_mib, puis
peak_node_rss_mib. Ces valeurs mesurent uniquement le processus Node qui pilote
Puppeteer : elles n'incluent pas la mémoire des processus Chromium et ne
dimensionnent donc pas le worker. Relever en parallèle le pic RAM total du
nœud et du conteneur dans les métriques Jelastic pendant toute l'exécution,
puis répéter après un redémarrage du nœud. Un échec de lancement Chromium, une
croissance de la RAM totale non stabilisée ou une marge mémoire insuffisante
est un stop-gate : ne pas activer le worker et réévaluer une image Docker
contrôlée sur un compte payant.

### Arrêt et redémarrage

1. Exécuter pm2 stop corya-api, qui exerce SIGINT, et vérifier une sortie propre
   avant 15 secondes.
2. Exécuter pm2 stop corya-worker hors charge puis avec une fixture locale
   synthétique, et vérifier une sortie propre avant 30 secondes.
3. Tester séparément SIGTERM via l'arrêt du nœud ou le signal de plateforme,
   sur l'API puis le worker, avec les mêmes délais. Les deux signaux doivent
   exercer les handlers existants, sans suppression réelle ni appel tiers.
4. Redémarrer chaque environnement séparément.
5. Confirmer que seule l'application PM2 sélectionnée avec --only revient.
6. Provoquer uniquement en environnement synthétique les dix redémarrages
   rapides bornés, confirmer que PM2 s'arrête et documenter l'intervention.
7. Confirmer que le worker ne possède aucun endpoint public.

## Ordre de mise en service futur

Cet ordre nécessite des autorisations séparées :

1. confirmer les migrations 20260802000000 à 20260802000003 puis appliquer
   la corrective append-only 20260803000000 ;
2. vérifier get_wave7_contract_version() = 7 ;
3. déployer et valider l'API ;
4. déployer et valider le worker.

L'API et le worker échouent volontairement avant toute activité si le contrat
Wave 7 n'est pas exactement à la version 7.

## Déploiement et rollback

Déployer le même SHA Git dans les deux environnements et conserver le dernier
SHA sain. Ne jamais utiliser une branche flottante comme preuve de version.

En cas d'incident :

1. arrêter ou revenir d'abord au worker sain pour interrompre les nouvelles
   suppressions physiques ;
2. revenir ensuite à l'API saine ;
3. contrôler /health, puis /health/deep avec son header protégé ;
4. vérifier les heartbeats jobs et suppressions avant de réactiver le worker.

Le rollback est applicatif. Ne jamais exécuter de migration descendante :
les migrations Wave 7 sont additives et les binaires antérieurs les tolèrent.
Une suppression Retell ou Storage déjà effectuée et une purge SQL déjà
exécutée ne sont pas annulées par le retour au binaire précédent.

## Checklist de création des environnements d'essai

- Node.js 24.18.0 est sélectionnable pour les deux environnements.
- La commande PM2 --only est disponible pour lancer séparément chaque rôle.
- Les variables sont injectées par environnement, sans fichier dotenv.
- Aucun addon DB n'est sélectionné.
- L'environnement worker n'a aucun endpoint public.
- Les 2 + 6 Cloudlets respectent la limite totale de l'essai.
- Le build npm ci puis npm run build réussit depuis apps/backend.
- Les préflights API et worker échouent sans variable requise et n'en
  affichent aucune valeur.
- Le smoke Chromium séquentiel, la RSS Node et le pic RAM total Jelastic sont
  consignés ; la RSS Node seule n'est jamais utilisée pour dimensionner le
  worker.
- SIGINT via PM2, SIGTERM via la plateforme, max_restarts=10, redémarrage et
  rollback ont chacun un résultat consigné.

Les vérifications de persistance PM2, redémarrage, signaux, mémoire totale et
rollback sont exécutées après la création, dans l'essai. Elles restent des
stop-gates avant toute mise en service de production.
