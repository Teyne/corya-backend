'use strict';

const common = {
  cwd: __dirname,
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  watch: false,
  restart_delay: 5_000,
  min_uptime: '30s',
  max_restarts: 10,
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'corya-api',
      script: 'dist/server.js',
      // The API runtime force-exits after 10 seconds if graceful shutdown stalls.
      kill_timeout: 15_000,
    },
    {
      ...common,
      name: 'corya-worker',
      script: 'dist/worker.js',
      // worker.ts allows in-flight jobs up to 25 seconds before force-exit.
      kill_timeout: 30_000,
    },
  ],
};
