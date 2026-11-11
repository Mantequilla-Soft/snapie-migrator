// pm2 start ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'snapie-migrator',
    script: 'src/index.js',
    instances: 1,            // one process: the job queue and SQLite state are not shared
    exec_mode: 'fork',
    max_memory_restart: '1G',
    kill_timeout: 30000,     // let an in-flight stage finish its cleanup
    env: { NODE_ENV: 'production' },
  }],
};
